// The room on the fediverse, part 1: one read-only account, @room@<the room's host>, that anyone on
// Mastodon (or any ActivityPub server) can follow. It is a Group actor with a WebFinger address, an
// outbox, an inbox and a followers count. Its outbox carries the room's public chat lines only: never a
// line said to one person, a private note, a draft, a notebook, or the room check's test lines.
// A follow is checked (an HTTP Signature from the follower's own server, over a Digest of the body),
// accepted with a signed Accept, and each new public line then goes to every follower's server, signed,
// in the background, so a slow server never holds the room up. Nothing flows back into the room: the
// inbox takes Follow and Undo, and ignores everything else.
// Every address comes from PUBLIC_URL. Followers keep the address they followed, and a temporary
// tunnel's address changes on restart, so announce the account only once the room has a fixed address.
// What it keeps, in the data folder: its RSA key (made once, never in the repository), its followers,
// and a record of every delivery and every inbox request (when, what, the other server's host, status
// and timing; never anyone's words). ACTIVITYPUB=0 turns it off.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { publicFetch } from './resolver.js'
import { splitLayers } from '../shared/layers.js'
import { NAME_OF } from '../shared/types.js'

const AS = 'https://www.w3.org/ns/activitystreams', PUBLIC = AS + '#Public'
const AP_TYPE = 'application/activity+json', LD_TYPE = 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"'
export const HANDLE = 'room' // the account's name; it stays the same for the life of the room
const PAGE = 20 // lines per outbox page: about what a server reads when someone first opens the account
const MAX_BODY = 64 * 1024 // a Follow or an Undo is well under 2 KB
// followers kept: every follower's server gets each new line, so this is where sending would start to
// cost the room more than its own conversation does; past it a follow is turned down (Reject), politely
const MAX_FOLLOWERS = 2000
const MAX_QUEUE = 5000 // deliveries waiting at once; past it a delivery is dropped and recorded, so a dead server can't fill the room's memory
const WORKERS = 4 // deliveries at once
const TIMEOUT_MS = 8000 // per request to another server (the public fetch holds to the same)
const RETRIES_MS = [60_000, 10 * 60_000, 60 * 60_000] // a server that is down gets the line again after a minute, ten minutes and an hour, then the room gives up and records it
const SKEW_MS = 60 * 60_000 // how far a signed request's Date may be from the room's clock
const KEYS_KEPT = 500, KEY_TTL_MS = 60 * 60_000 // other servers' keys, remembered for an hour
const LOOKUPS_PER_MINUTE = 60 // key lookups the inbox may cause; past it the sender is asked to try again shortly
const RECORD_MAX_BYTES = 1_000_000 // then the record moves to activitypub-record.jsonl.1 and a new one starts

class Refused extends Error { constructor (status, why) { super(why); this.status = status } }
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const originOf = (u) => { try { return new URL(u).origin } catch { return null } }
const hostOf = (u) => { try { return new URL(u).host.slice(0, 200) } catch { return null } }
const idOf = (x) => (typeof x === 'string' ? x : x?.id)
/** An address on the actor's own server, or null: the room never posts anywhere a follower merely names. */
const onActorsServer = (u, actor) => (typeof u === 'string' && /^https?:\/\//.test(u) && originOf(u) === originOf(actor) ? u : null)
const whyOf = (err) => String(err?.name === 'TimeoutError' ? 'timeout' : err?.cause?.code ?? err?.message ?? err).slice(0, 160)

/** keyId, algorithm, headers and signature from a Signature header, or null. */
export function parseSignature (h) {
  const out = {}
  for (const m of String(h ?? '').matchAll(/(\w+)="([^"]*)"/g)) out[m[1]] = m[2]
  return out.keyId && out.signature ? out : null
}
/** Whether a signature verifies against a PEM public key (RSA, as Mastodon uses, or Ed25519). */
function verifies (pem, data, signature) {
  try { const k = createPublicKey(pem); return verify(k.asymmetricKeyType === 'ed25519' ? null : 'sha256', data, k, signature) } catch { return false }
}
const digestOf = (body) => 'SHA-256=' + createHash('sha256').update(body).digest('base64')
/** Whether a Digest header (one or more "ALG=value") holds the body's SHA-256. */
function digestMatches (header, body) {
  const want = digestOf(body).slice(8)
  return String(header ?? '').split(',').some((d) => { const i = d.indexOf('='); return i > 0 && d.slice(0, i).trim().toLowerCase() === 'sha-256' && d.slice(i + 1).trim() === want })
}
const readRaw = (req) => new Promise((resolve, reject) => {
  let size = 0; const chunks = []
  req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new Refused(413, 'an activity is at most 64 KB')); req.destroy() } else chunks.push(c) })
  req.on('end', () => resolve(Buffer.concat(chunks)))
  req.on('error', reject)
})

export class ActivityPub {
  #key = null
  constructor ({ ctx, dataDir, fetch = publicFetch }) {
    this.ctx = ctx; this.fetch = fetch
    mkdirSync(dataDir, { recursive: true })
    this.files = { key: join(dataDir, 'activitypub-key.pem'), followers: join(dataDir, 'activitypub-followers.json'), record: join(dataDir, 'activitypub-record.jsonl') }
    this.followers = new Map() // actor id -> { inbox, sharedInbox, follow, of (the room's account they followed), since }
    try { if (existsSync(this.files.followers)) this.followers = new Map(Object.entries(JSON.parse(readFileSync(this.files.followers, 'utf8')))) } catch (err) { console.error('activitypub followers:', err.message) }
    this.queue = []; this.active = 0; this.timer = null; this.stopped = false
    this.keys = new Map(); this.lookups = []; this.recent = []
  }

  get base () { return this.ctx.config.publicUrl || '' }
  get enabled () { return Boolean(originOf(this.base)) && this.ctx.config.activitypub !== false }
  get actor () { return `${this.base}/ap/${HANDLE}` }
  get host () { return new URL(this.base).host }

  /** The room's RSA key for HTTP Signatures, made once and kept in the data folder (only the host can read it). */
  key () {
    if (this.#key) return this.#key
    if (!existsSync(this.files.key)) {
      const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
      writeFileSync(this.files.key, privateKey, { mode: 0o600 })
    }
    const priv = createPrivateKey(readFileSync(this.files.key, 'utf8'))
    this.#key = { private: priv, publicPem: createPublicKey(priv).export({ type: 'spki', format: 'pem' }) }
    return this.#key
  }

  // ---- what the room shows the fediverse

  /** A line everyone sees in Talk: a note to the whole room, not to one person, not the room check's, not from someone who has left. */
  isPublic (e) {
    if (NAME_OF[e.type] !== 'note' || e.document.recipient) return false
    const skip = this.ctx.check?.dids() ?? []
    if (skip.includes(e.author) || skip.includes(e.onBehalfOf)) return false
    return !this.ctx.log.state.participants.get(e.onBehalfOf)?.left
  }

  lines () { return this.ctx.log.entries.filter((e) => this.isPublic(e)) }
  /** Followers of the account at today's address. Those who followed an earlier one (a tunnel that changed) get nothing: to their server this is a stranger. */
  current () { return [...this.followers.values()].filter((f) => f.of === this.actor) }
  noteId (e) { return `${this.base}/ap/notes/${e.hash}` }

  /** One line as a Note: who said it, then its plain layer (never the technical one), its photos, links to its files. */
  note (e) {
    const st = this.ctx.log.state, d = e.document, p = d.payload, base = this.base
    const who = st.nameOf(e.author), boss = st.nameOf(e.onBehalfOf)
    const name = e.onBehalfOf !== e.author && !who.includes(boss) ? `${who} (for ${boss})` : who
    const placeholder = (p.media?.length && p.text === '(a photo)') || (p.files?.length && p.text === '(a file)')
    const paras = (placeholder ? '' : splitLayers(p.text, p.tech).short).split(/\n{2,}/).map((x) => esc(x.trim()).replace(/\n/g, '<br>')).filter(Boolean)
    const files = (p.files ?? []).map((f) => `<a href="${esc(`${base}/media/${f.sha256}?name=${encodeURIComponent(f.name)}`)}">${esc(f.name)}</a>`)
    const content = [`<p><strong>${esc(name)}</strong>${paras.length ? ': ' + paras[0] : ''}</p>`, ...paras.slice(1).map((x) => `<p>${x}</p>`), files.length ? `<p>${files.join(' · ')}</p>` : ''].join('')
    const parent = d.threadId ? this.ctx.log.byDocId.get(d.threadId) : null
    return {
      id: this.noteId(e), type: 'Note', attributedTo: this.actor, published: e.timestamp,
      to: [PUBLIC], cc: [`${this.actor}/followers`], url: `${base}/#tab=talk`,
      inReplyTo: parent && this.isPublic(parent) ? this.noteId(parent) : null, content,
      ...(p.media?.length ? { attachment: p.media.map((m) => ({ type: 'Document', mediaType: m.type, url: `${base}/media/${m.sha256}`, width: m.w, height: m.h })) } : {}),
    }
  }

  create (e) { const note = this.note(e); return { id: `${note.id}/activity`, type: 'Create', actor: this.actor, published: note.published, to: note.to, cc: note.cc, object: note } }

  actorDoc () {
    const name = this.ctx.config.workspaceName
    return {
      '@context': [AS, 'https://w3id.org/security/v1'],
      id: this.actor, type: 'Group', preferredUsername: HANDLE, name, url: this.base,
      summary: `<p>The public conversation of the ${esc(name)} room, where people and their AI agents work out interop between their projects. Only lines said to the whole room come here: lines to one person, private notes and drafts stay in the room. This account only posts, so replies here don't reach the room. To take part, <a href="${esc(this.base)}">join the room</a>.</p>`,
      inbox: `${this.actor}/inbox`, outbox: `${this.actor}/outbox`, followers: `${this.actor}/followers`,
      manuallyApprovesFollowers: false,
      publicKey: { id: `${this.actor}#main-key`, owner: this.actor, publicKeyPem: this.key().publicPem },
    }
  }

  webfinger (resource) {
    const r = String(resource ?? '').trim(), acct = `acct:${HANDLE}@${this.host}`
    if (r.toLowerCase() !== acct.toLowerCase() && r !== this.actor) return null
    return { subject: acct, aliases: [this.actor], links: [{ rel: 'self', type: AP_TYPE, href: this.actor }, { rel: 'http://webfinger.net/rel/profile-page', type: 'text/html', href: this.base }] }
  }

  /** The outbox: the count and links to its pages, or one page, newest first. */
  outbox (page) {
    const id = `${this.actor}/outbox`, lines = this.lines(), pages = Math.max(1, Math.ceil(lines.length / PAGE))
    if (page == null) return { '@context': AS, id, type: 'OrderedCollection', totalItems: lines.length, first: `${id}?page=1`, last: `${id}?page=${pages}` }
    const n = Math.max(1, Number.parseInt(page, 10) || 1), end = Math.max(0, lines.length - (n - 1) * PAGE)
    return {
      '@context': AS, id: `${id}?page=${n}`, type: 'OrderedCollectionPage', partOf: id,
      orderedItems: lines.slice(Math.max(0, end - PAGE), end).reverse().map((e) => this.create(e)),
      ...(n < pages ? { next: `${id}?page=${n + 1}` } : {}), ...(n > 1 ? { prev: `${id}?page=${n - 1}` } : {}),
    }
  }

  /** For /api/info: the account's address and how sending is going (counts only). */
  summary () {
    if (!this.enabled) return null
    const out = this.recent.filter((r) => r.dir === 'out')
    const temporary = /trycloudflare\.com$|ngrok/i.test(new URL(this.base).hostname) // the temporary tunnels views.info names
    return {
      address: `@${HANDLE}@${this.host}`, actor: this.actor, followers: this.current().length, waiting: this.queue.length,
      recent: { delivered: out.filter((r) => r.ok).length, failed: out.filter((r) => !r.ok).length },
      ...(temporary ? { temporary: 'This address changes when the room restarts, and followers would lose the room: share it once the room has a fixed address.' } : {}),
    }
  }

  // ---- HTTP

  async handle (req, res, url) {
    const path = url.pathname, accept = String(req.headers.accept ?? '')
    const reply = (status, body, type = /ld\+json/.test(accept) && !/activity\+json/.test(accept) ? LD_TYPE : AP_TYPE) => {
      if (res.headersSent || res.destroyed) return
      res.writeHead(status, { 'content-type': type, 'access-control-allow-origin': '*', vary: 'accept' })
      res.end(JSON.stringify(body))
    }
    if (!this.enabled) return reply(404, { error: 'this room has no public address yet (PUBLIC_URL), so it cannot be followed' }, 'application/json; charset=utf-8')
    if (path === '/.well-known/webfinger') {
      const j = this.webfinger(url.searchParams.get('resource'))
      return j ? reply(200, j, 'application/jrd+json; charset=utf-8') : reply(404, { error: `no account by that name here; try acct:${HANDLE}@${this.host}` }, 'application/json; charset=utf-8')
    }
    if (path === `/ap/${HANDLE}/inbox`) return req.method === 'POST' ? this.inbox(req, reply) : reply(405, { error: 'POST activities here' })
    if (req.method !== 'GET' && req.method !== 'HEAD') return reply(405, { error: 'read only' })
    if (path === `/ap/${HANDLE}`) {
      if (/text\/html/.test(accept) && !/json/.test(accept)) { res.writeHead(302, { location: `${this.base}/#tab=talk` }); return res.end() } // a person opening the link gets the room
      return reply(200, this.actorDoc())
    }
    if (path === `/ap/${HANDLE}/outbox`) return reply(200, this.outbox(url.searchParams.get('page')))
    if (path === `/ap/${HANDLE}/followers`) return reply(200, { '@context': AS, id: `${this.actor}/followers`, type: 'OrderedCollection', totalItems: this.current().length }) // a count only: who follows stays with the room's host
    const m = /^\/ap\/notes\/([0-9a-f]{64})$/.exec(path), e = m && this.ctx.log.byHash.get(m[1])
    if (e && this.isPublic(e)) return reply(200, { '@context': AS, ...this.note(e) })
    return reply(404, { error: 'not found' })
  }

  /** The inbox: a signed Follow is accepted, a signed Undo of it ends it, anything else is ignored. */
  async inbox (req, reply) {
    let activity = null
    try {
      const raw = await readRaw(req)
      try { activity = JSON.parse(raw.toString('utf8')) } catch { throw new Refused(400, 'the body is not JSON') }
      const actor = idOf(activity?.actor), them = await this.checkSigned(req, raw, actor)
      const type = activity.type, object = activity.object
      if (type === 'Follow' && idOf(object) === this.actor) return this.follow(activity, actor, them, reply)
      if (type === 'Undo' && (object?.type === 'Follow' || typeof object === 'string')) {
        const known = this.followers.get(actor)
        const ours = typeof object === 'string' ? object === known?.follow : idOf(object.actor) === actor && idOf(object.object) === this.actor
        if (ours && this.followers.delete(actor)) this.saveFollowers()
        this.keep({ dir: 'in', type: 'Undo', ok: true, status: 202, host: hostOf(actor) })
        return reply(202, { ok: true })
      }
      this.keep({ dir: 'in', type: String(type ?? 'none').slice(0, 40), ok: true, status: 202, host: hostOf(actor), why: 'ignored: nothing flows back into the room' })
      return reply(202, { ok: true, note: 'This account only posts; nothing sent here reaches the room.' })
    } catch (err) {
      const status = err instanceof Refused ? err.status : 500
      if (!(err instanceof Refused)) console.error('activitypub inbox:', err)
      this.keep({ dir: 'in', type: String(activity?.type ?? 'none').slice(0, 40), ok: false, status, host: hostOf(idOf(activity?.actor)), why: whyOf(err) })
      return reply(status, { error: err instanceof Refused ? err.message : 'something went wrong on our side' })
    }
  }

  follow (activity, actor, them, reply) {
    const inbox = onActorsServer(them.inbox, actor), shared = onActorsServer(them.endpoints?.sharedInbox, actor)
    if (!inbox) throw new Refused(400, 'your account has no inbox on its own server')
    const known = this.followers.get(actor), full = !known && this.followers.size >= MAX_FOLLOWERS
    if (!full) { this.followers.set(actor, { inbox, ...(shared ? { sharedInbox: shared } : {}), follow: idOf(activity), of: this.actor, since: known?.since ?? new Date().toISOString() }); this.saveFollowers() }
    const what = full ? 'Reject' : 'Accept'
    this.deliver(inbox, JSON.stringify({ '@context': AS, id: `${this.actor}#${what.toLowerCase()}s/${randomUUID()}`, type: what, actor: this.actor, object: { id: idOf(activity), type: 'Follow', actor, object: this.actor } }), { what })
    this.keep({ dir: 'in', type: 'Follow', ok: !full, status: 202, host: hostOf(actor), ...(full ? { why: 'the room has as many followers as it can send to' } : {}) })
    return reply(202, { ok: true })
  }

  /** The sender's verified actor document, or a refusal: signed by a key of the actor's own server, over the target, host, date and digest. */
  async checkSigned (req, raw, actor) {
    const sig = parseSignature(req.headers.signature)
    if (!sig) throw new Refused(401, 'unsigned: this inbox takes only requests signed by the sender\'s server (HTTP Signatures)')
    const names = String(sig.headers ?? 'date').toLowerCase().split(/\s+/).filter(Boolean)
    for (const h of ['(request-target)', 'host', 'date', 'digest']) if (!names.includes(h)) throw new Refused(401, `the signature must cover ${h}`)
    const date = Date.parse(req.headers.date ?? '')
    if (!Number.isFinite(date) || Math.abs(Date.now() - date) > SKEW_MS) throw new Refused(401, 'the Date header is missing or too far from now')
    if (!digestMatches(req.headers.digest, raw)) throw new Refused(401, 'the Digest header does not match the body')
    if (!originOf(actor) || originOf(sig.keyId) !== originOf(actor)) throw new Refused(401, 'the signing key must be on the actor\'s own server')
    // the sender signed the address it posted to: this room's public host, whatever a proxy calls it on the way in
    const signed = Buffer.from(names.map((h) => (h === '(request-target)' ? `${h}: ${req.method.toLowerCase()} ${req.url}` : h === 'host' ? `host: ${this.host}` : `${h}: ${req.headers[h] ?? ''}`)).join('\n'))
    const signature = Buffer.from(sig.signature, 'base64')
    let key = await this.keyOf(sig.keyId, actor)
    if (!verifies(key.pem, signed, signature) && key.cached) key = await this.keyOf(sig.keyId, actor, { fresh: true }) // its server may have a new key
    if (!verifies(key.pem, signed, signature)) throw new Refused(401, 'the signature does not verify')
    return key.actorDoc
  }

  /** The public key behind a keyId, and its owner's actor document; remembered for an hour. */
  async keyOf (keyId, actor, { fresh = false } = {}) {
    const hit = this.keys.get(keyId)
    if (hit && !fresh && Date.now() - hit.at < KEY_TTL_MS) return { ...hit, cached: true }
    const doc = await this.getJson(keyId.split('#')[0])
    const k = [doc?.publicKey].flat().find((x) => x?.id === keyId) ?? (doc?.id === keyId && doc.publicKeyPem ? doc : null)
    if (!k?.publicKeyPem) throw new Refused(401, 'no key with that id at the sender\'s server')
    if (idOf(k.owner ?? doc.id) !== actor) throw new Refused(401, 'that key belongs to someone else')
    const actorDoc = doc.id === actor ? doc : await this.getJson(actor)
    if (actorDoc?.id !== actor) throw new Refused(401, 'the sender\'s account could not be read')
    const got = { pem: k.publicKeyPem, actorDoc, at: Date.now() }
    this.keys.delete(keyId); this.keys.set(keyId, got)
    if (this.keys.size > KEYS_KEPT) this.keys.delete(this.keys.keys().next().value)
    return got
  }

  /** A signed GET of another server's document (some servers answer only signed requests). */
  async getJson (url) {
    const now = Date.now()
    this.lookups = this.lookups.filter((t) => t > now - 60_000)
    if (this.lookups.length >= LOOKUPS_PER_MINUTE) throw new Refused(429, 'busy: try again in a minute')
    this.lookups.push(now)
    let res
    try { res = await this.fetch(url, { headers: { accept: `${AP_TYPE}, ${LD_TYPE}`, 'user-agent': this.agent(), ...this.signature('get', url) }, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) }) } catch (err) { throw new Refused(503, `could not reach the sender's server to check its signature: ${whyOf(err)}`) }
    if (!res.ok) throw new Refused(res.status >= 500 || res.status === 429 ? 503 : 401, `could not read the sender's key (its server answered ${res.status})`)
    try { return await res.json() } catch { throw new Refused(401, 'the sender\'s key is not JSON') }
  }

  agent () { return `we-play-interop (+${this.base})` }

  /** HTTP Signature headers for a request from the room (draft-cavage-12, the way Mastodon signs and checks). */
  signature (method, url, body) {
    const u = new URL(url), date = new Date().toUTCString(), digest = body === undefined ? null : digestOf(body)
    const values = { '(request-target)': `${method} ${u.pathname}${u.search}`, host: u.host, date, digest }
    const names = ['(request-target)', 'host', 'date', ...(digest ? ['digest'] : [])]
    const sig = sign('sha256', Buffer.from(names.map((n) => `${n}: ${values[n]}`).join('\n')), this.key().private).toString('base64')
    return { date, ...(digest ? { digest } : {}), signature: `keyId="${this.actor}#main-key",algorithm="rsa-sha256",headers="${names.join(' ')}",signature="${sig}"` }
  }

  // ---- sending

  /** A new public line goes to every follower's server once (a shared inbox once for all its people). */
  onEntry (e) {
    if (!this.enabled || !this.followers.size || !this.isPublic(e)) return
    const inboxes = new Set(this.current().map((f) => f.sharedInbox ?? f.inbox))
    if (!inboxes.size) return
    const body = JSON.stringify({ '@context': AS, ...this.create(e) })
    for (const inbox of inboxes) this.deliver(inbox, body, { what: 'Create', line: e.seq })
  }

  /** Queue one signed POST; it goes out in the background and never holds the room up. */
  deliver (inbox, body, meta) {
    if (this.queue.length >= MAX_QUEUE) return this.keep({ dir: 'out', what: meta.what, line: meta.line ?? null, host: hostOf(inbox), ok: false, why: 'the queue was full' })
    this.queue.push({ inbox, body, ...meta, attempt: 0, due: Date.now() })
    this.pump()
  }

  pump () {
    clearTimeout(this.timer); this.timer = null
    if (this.stopped) return
    const now = Date.now()
    while (this.active < WORKERS) {
      const i = this.queue.findIndex((j) => j.due <= now)
      if (i < 0) break
      const job = this.queue.splice(i, 1)[0]
      this.active++
      this.send(job).catch((err) => console.error('activitypub delivery:', err)).finally(() => { this.active--; this.pump() })
    }
    if (this.active < WORKERS && this.queue.length) { // nothing due now: wake for the next retry
      this.timer = setTimeout(() => this.pump(), Math.max(50, Math.min(...this.queue.map((j) => j.due)) - now))
      this.timer.unref?.()
    }
  }

  async send (job) {
    const t0 = Date.now(); job.attempt++
    let status = null, error = null
    try {
      const res = await this.fetch(job.inbox, { method: 'POST', headers: { 'content-type': AP_TYPE, accept: AP_TYPE, 'user-agent': this.agent(), ...this.signature('post', job.inbox, job.body) }, body: job.body, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) })
      status = res.status
      await res.arrayBuffer().catch(() => null)
    } catch (err) { error = whyOf(err) }
    const ok = status !== null && status >= 200 && status < 300
    const again = !ok && !this.stopped && job.attempt <= RETRIES_MS.length && this.queue.length < MAX_QUEUE && (status === null || status === 408 || status === 429 || status >= 500)
    this.keep({ dir: 'out', what: job.what, line: job.line ?? null, host: hostOf(job.inbox), attempt: job.attempt, ok, status, ms: Date.now() - t0, ...(error ? { why: error } : {}), ...(again ? { retryInSeconds: RETRIES_MS[job.attempt - 1] / 1000 } : {}) })
    if (again) { job.due = Date.now() + RETRIES_MS[job.attempt - 1]; this.queue.push(job) }
  }

  saveFollowers () {
    try { writeFileSync(this.files.followers, JSON.stringify(Object.fromEntries(this.followers)), { mode: 0o600 }) } catch (err) { console.error('activitypub followers:', err.message) }
  }

  /** Every delivery and inbox request, kept: when, what, the other server's host, status and timing; never anyone's words. */
  keep (r) {
    const line = { at: new Date().toISOString(), ...r }
    this.recent.push(line); if (this.recent.length > 200) this.recent.shift()
    try {
      if (existsSync(this.files.record) && statSync(this.files.record).size > RECORD_MAX_BYTES) renameSync(this.files.record, this.files.record + '.1')
      appendFileSync(this.files.record, JSON.stringify(line) + '\n', { mode: 0o600 })
    } catch (err) { console.error('activitypub record:', err.message) }
  }

  /** Deliveries still waiting are not kept across a restart; each one is recorded as not sent. */
  stop () {
    this.stopped = true; clearTimeout(this.timer)
    for (const j of this.queue.splice(0)) this.keep({ dir: 'out', what: j.what, line: j.line ?? null, host: hostOf(j.inbox), attempt: j.attempt, ok: false, why: 'the room stopped before it went out' })
  }
}
