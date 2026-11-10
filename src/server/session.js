// Who is signed in. A session is a cookie holding 32 random bytes; the room keeps only their SHA-256, with the
// person's DID and when it began and ends. The cookie never holds a name or a DID, and nothing here reaches a log.
//   __Host-inwove_session  HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=30 days   (the __Host- prefix makes the browser insist on Secure,
//                          no Domain and Path=/, so a sibling subdomain cannot plant or overwrite it; a new value on every sign-in)
// Sessions are read from memory (loaded at start, written through to the database), so the gate costs no query.
// Challenges (for a key sign-in, a passkey sign-in and a passkey registration) are 32 random bytes, single use, good
// for two minutes, and kept only in memory: a restart just makes the person ask again.
import { createHash, randomBytes } from 'node:crypto'

export const COOKIE = '__Host-inwove_session'
export const SESSION_DAYS = 30
export const SESSION_MS = SESSION_DAYS * 86400_000
export const CHALLENGE_MS = 2 * 60_000
const MAX_PER_PERSON = 20 // a person's phone, laptop and a few more; past this the oldest goes, so a sign-in loop cannot grow the table
const MAX_CHALLENGES = 5000 // what one room's sign-ins in two minutes could never reach; past this new ones are refused until old ones lapse

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex')
const idOf = (hash) => sha('session id|' + hash).slice(0, 16)
const SEEN_SAVE_MS = 10 * 60_000 // a last-seen time is exact in memory and written through no more often than this: the gate costs no query per request

/** The session cookie's value in a Cookie header, or null. Only a well-formed value is returned (43 base64url characters). */
export function tokenFromCookie (header) {
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i < 0 || part.slice(0, i).trim() !== COOKIE) continue
    const v = part.slice(i + 1).trim()
    return /^[A-Za-z0-9_-]{43}$/.test(v) ? v : null
  }
  return null
}

/** The Set-Cookie value that starts a session, or (token null) clears it. */
export function setCookie (token) {
  return token
    ? `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`
    : `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`
}

export class Sessions {
  constructor ({ db, now = Date.now }) {
    Object.assign(this, { db, now })
    this.byHash = new Map() // token hash -> { did, created, expires, seen, saved }: `seen` is the last look, `saved` the last time it reached the database
    this.onEnd = null // called with a DID when all of its sessions are deleted: the page's live connections for it close
  }

  async load () {
    const t = this.now()
    await this.db.query('delete from sessions where expires_ms <= $1', [t])
    const { rows } = await this.db.query('select token_hash, did, created_ms, expires_ms, last_seen_ms from sessions')
    for (const r of rows) { const seen = r.last_seen_ms == null ? Number(r.created_ms) : Number(r.last_seen_ms); this.byHash.set(r.token_hash, { did: r.did, created: Number(r.created_ms), expires: Number(r.expires_ms), seen, saved: seen }) }
  }

  /** A new session for a person: { token, expiresAt }. The token is shown once, to the browser, as the cookie. */
  async create (did) {
    const t = this.now(), token = randomBytes(32).toString('base64url'), h = sha(token)
    const mine = [...this.byHash].filter(([, s]) => s.did === did).sort((a, b) => a[1].created - b[1].created)
    for (const [old] of mine.slice(0, Math.max(0, mine.length - MAX_PER_PERSON + 1))) await this.#drop(old)
    const s = { did, created: t, expires: t + SESSION_MS, seen: t, saved: t }
    await this.db.query('insert into sessions (token_hash, did, created_ms, expires_ms, last_seen_ms) values ($1,$2,$3,$4,$5)', [h, did, s.created, s.expires, t])
    this.byHash.set(h, s)
    return { token, expiresAt: new Date(s.expires).toISOString() }
  }

  /** Who this cookie value is, or null: unknown, ended, or out of date (an expired one is deleted here, on the lookup). */
  lookup (token) {
    if (typeof token !== 'string') return null
    const h = sha(token), s = this.byHash.get(h)
    if (!s) return null
    const t = this.now()
    if (s.expires <= t) { this.#drop(h).catch(() => {}); return null }
    s.seen = t // when a person last used it (shown to them in "Where you're signed in"); written through at most every ten minutes
    if (t - s.saved >= SEEN_SAVE_MS) { s.saved = t; this.db.query('update sessions set last_seen_ms = $2 where token_hash = $1', [h, t]).catch(() => {}) }
    return { did: s.did, expiresAt: new Date(s.expires).toISOString() }
  }

  async end (token) { if (typeof token === 'string') await this.#drop(sha(token)) }

  /** Delete every session a person has (they left, were replaced, or signed out). */
  async deleteFor (did) {
    await this.db.query('delete from sessions where did = $1', [did])
    for (const [h, s] of this.byHash) if (s.did === did) this.byHash.delete(h)
    this.onEnd?.(did)
  }

  /** A person's own sessions, newest first: { id, createdAt, lastSeenAt, current }. `id` is not the cookie and cannot become it (a hash of the stored hash). */
  list (did, currentToken = null) {
    const here = typeof currentToken === 'string' ? sha(currentToken) : null
    return [...this.byHash].filter(([, s]) => s.did === did).sort((a, b) => b[1].created - a[1].created)
      .map(([h, s]) => ({ id: idOf(h), createdAt: new Date(s.created).toISOString(), lastSeenAt: new Date(s.seen).toISOString(), current: h === here }))
  }

  /** End one of a person's own sessions by its listed id. True when it was theirs and is gone; never touches anyone else's. */
  async endById (did, id) {
    for (const [h, s] of this.byHash) if (s.did === did && typeof id === 'string' && id.length === 16 && idOf(h) === id) { await this.#drop(h); return true }
    return false
  }

  count (did) { let n = 0; for (const s of this.byHash.values()) if (s.did === did) n++; return n }

  async #drop (h) { this.byHash.delete(h); await this.db.query('delete from sessions where token_hash = $1', [h]) }
}

/** Single-use challenges: issue(meta) gives one, take(challenge, kind) uses it up or returns null (unknown, used, stale, or for another purpose). */
export class Challenges {
  constructor ({ now = Date.now, ttlMs = CHALLENGE_MS } = {}) { Object.assign(this, { now, ttlMs }); this.held = new Map() }

  /** { challenge, expiresAt } or null when the room is holding too many (the caller answers 429). */
  issue (kind, meta = {}) {
    const t = this.now()
    if (this.held.size >= MAX_CHALLENGES) { for (const [c, v] of this.held) if (v.until <= t) this.held.delete(c); if (this.held.size >= MAX_CHALLENGES) return null }
    const challenge = randomBytes(32).toString('base64url')
    this.held.set(challenge, { kind, meta, until: t + this.ttlMs })
    return { challenge, expiresAt: new Date(t + this.ttlMs).toISOString() }
  }

  /** The meta given at issue, once; null for anything that is not a live challenge of this kind. A wrong guess keeps the real one alive. */
  take (challenge, kind) {
    if (typeof challenge !== 'string') return null
    const v = this.held.get(challenge)
    if (!v || v.kind !== kind) return null
    this.held.delete(challenge)
    return v.until > this.now() ? v.meta : null
  }
}

/** A steady allowance per key (an address): hit(key) is false once the key has used `max` in `windowMs`. Memory stays small: lapsed keys are dropped. */
export class Limiter {
  constructor ({ max, windowMs = 60_000, maxKeys = 20_000, now = Date.now }) { Object.assign(this, { max, windowMs, maxKeys, now }); this.hits = new Map() }

  hit (key) {
    const t = this.now(), recent = (this.hits.get(key) ?? []).filter((x) => x > t - this.windowMs)
    if (recent.length >= this.max) { this.hits.set(key, recent); return false }
    if (!this.hits.has(key) && this.hits.size >= this.maxKeys) { for (const [k, v] of this.hits) if (!v.some((x) => x > t - this.windowMs)) this.hits.delete(k); if (this.hits.size >= this.maxKeys) return false }
    recent.push(t); this.hits.set(key, recent)
    return true
  }
}
