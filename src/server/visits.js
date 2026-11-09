// Join QR: a short link for one visit. A newcomer's page asks for one and shows it as a QR code. A phone
// camera opens it into the page's join flow; a wallet that asks for JSON gets what the room offers behind
// it, as a W3C VCALM interaction answer: the room's DID and a DIDComm v2 out-of-band invitation made for
// this visit. A link opens once, then runs out. Links live in memory only: they hold nobody's data, change
// nothing in the room's log, and are worth nothing after a restart.
import { randomBytes, randomUUID } from 'node:crypto'

// Ten minutes: time to find a phone and scan, and short enough that a photo of the screen, or a link left
// in a phone's history, soon stops working. The page asks for a fresh one before it runs out, so the person
// at the screen never waits on it.
export const VISIT_MS = 10 * 60_000
// A live link is a few hundred bytes; 5,000 of them (about a megabyte) is far more people than scan at once,
// so a flood can fill memory only up to there. Past it the oldest goes first, so a fresh page always gets a
// link that works.
export const MAX_VISITS = 5000
// New links from one address in a minute. A page asks about once every ten minutes, so this lets a whole
// event behind one network load the page together, while one script can't churn the store by itself.
export const PER_IP_PER_MINUTE = 60
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz' // Crockford's base32: no i, l, o or u to misread
export const CODE_RE = /^[0-9a-hjkmnp-tv-z]{8}$/
export const OOB_TYPE = 'https://didcomm.org/out-of-band/2.0/invitation'

/** Eight characters, 40 random bits: unguessable while a link lives, short enough for a small QR code. */
const newCode = () => [...randomBytes(8)].map((b) => ALPHABET[b & 31]).join('')

export class Visits {
  constructor ({ ttlMs = VISIT_MS, max = MAX_VISITS, perIpPerMinute = PER_IP_PER_MINUTE, now = Date.now } = {}) {
    Object.assign(this, { ttlMs, max, perIpPerMinute, now })
    this.byCode = new Map() // code -> { code, expiresAt, invitation, usedAt }, oldest first (one lifetime for all, so also soonest to run out first)
    this.recent = new Map() // address -> { since, n }: links it made in the current minute
    this.sweptAt = 0
    // what happened to the links, with no addresses: whether people scan the code, and with a camera or a wallet
    this.counts = { made: 0, openedByPage: 0, openedByWallet: 0, ranOutUnused: 0, refusedUsed: 0, refusedGone: 0, limited: 0, dropped: 0 }
  }

  /** A new link for one visit, or null when this address asked for too many this minute. */
  make (ip = '') {
    const t = this.now()
    this.sweep(t)
    const r = this.recent.get(ip)
    if (r && t - r.since < 60_000) {
      if (r.n >= this.perIpPerMinute) { this.counts.limited++; return null }
      r.n++
    } else this.recent.set(ip, { since: t, n: 1 })
    while (this.byCode.size >= this.max) { this.byCode.delete(this.byCode.keys().next().value); this.counts.dropped++ }
    let code
    do code = newCode(); while (this.byCode.has(code))
    const v = { code, expiresAt: t + this.ttlMs, invitation: randomUUID(), usedAt: null }
    this.byCode.set(code, v); this.counts.made++
    return v
  }

  /** The first open answers with the visit and marks it used; after that, or once it ran out, it says why not. */
  open (code, by = 'page') {
    const t = this.now(), v = this.look(code, t)
    if (!v) { this.counts.refusedGone++; return { why: 'gone' } }
    if (v.usedAt) { this.counts.refusedUsed++; return { why: 'used' } }
    v.usedAt = t; this.counts[by === 'wallet' ? 'openedByWallet' : 'openedByPage']++
    return { visit: v }
  }

  /** What an open would find, without using the link (for HEAD, which link checkers and previews send). */
  peek (code) { const v = this.look(code, this.now()); return !v ? 'gone' : v.usedAt ? 'used' : 'live' }

  look (code, t) {
    this.sweep(t)
    const v = this.byCode.get(code)
    return v && v.expiresAt > t ? v : null
  }

  /** Drops links that ran out (a used one stays until then, so a second open hears "used"), and last minute's counters. */
  sweep (t = this.now()) {
    for (const v of this.byCode.values()) {
      if (v.expiresAt > t) break
      if (!v.usedAt) this.counts.ranOutUnused++
      this.byCode.delete(v.code)
    }
    if (t - this.sweptAt < 60_000) return
    for (const [ip, r] of this.recent) if (t - r.since >= 60_000) this.recent.delete(ip)
    this.sweptAt = t
  }

  view () { return { live: this.byCode.size, minutes: this.ttlMs / 60_000, counts: { ...this.counts } } }
}

/** The DIDComm v2 out-of-band invitation for one visit (DIDComm Messaging v2, "Out Of Band Messages"). */
export const invitation = ({ id, from, name }) => ({ type: OOB_TYPE, id, from, body: { goal_code: 'join', goal: `Join ${name}`, accept: ['didcomm/v2'] } })

/** The invitation as a URL: the room's page, with the invitation's whitespace-free JSON base64url-encoded in `_oob`. */
export const oobUrl = (base, inv) => `${base}/?_oob=${Buffer.from(JSON.stringify(inv)).toString('base64url')}`

/** The link the page shows as a QR code: /j/<code> with the visit's invitation in `_oob`, the form a DIDComm
 * wallet (Keyring) reads straight off a scanned URL. `iuv=1` stays for a VCALM wallet, which asks the link
 * for JSON instead; a phone camera just opens it into the join flow. */
export const joinUrl = ({ base, did, name, visit }) => {
  const inv = invitation({ id: visit.invitation, from: did, name })
  return `${base}/j/${visit.code}?_oob=${Buffer.from(JSON.stringify(inv)).toString('base64url')}&iuv=1`
}

/** What a wallet gets for a link: the VCALM interaction answer (`protocols`), plus the room's DID and the invitation itself. */
export function interaction ({ base, did, name, visit }) {
  const inv = invitation({ id: visit.invitation, from: did, name })
  return { protocols: { didcomm: oobUrl(base, inv) }, did, invitation: inv, expiresAt: new Date(visit.expiresAt).toISOString() }
}
