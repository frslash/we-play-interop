// Wallet sign-in: the room's side of the auth/oob exchange a wallet starts by scanning a trigger link.
//
// What it is for: a person approves, in their own wallet, a key this page's browser just made. After that the room
// can say which DID is at the page, and the page never held that person's long-term key. Nothing here writes to the
// room's log, and a session key cannot speak in the room yet (docs/wallet-sign-in.md says what that would take).
//
// The six tasks arrive through the room's Trust Task door (ctx.door), which has already checked each document's size,
// age, recipient, signature and id. This file is the part after that: one request's life, who may take each step and
// with which key, and what each refusal says. It follows OpenVTC's vti-oob-server at the commit the room builds from,
// step for step (src/tasks.rs for the order of checks and the words of each refusal, record.rs for the states, the two
// clocks and the limits, util.rs for the link, the match number, the network comparison and the digest, host.rs for
// what a service decides for itself). Where the room decides for itself, the comment says so.
//
//   pending ─claim→ claimed ─prove→ identified ─respond(approve)→ approved ─redeem→ consumed
//   declined (a failed step, or the person said no) · cancelled · expired: all three are ends
//
// Everything is in memory: bounded, swept, and worth nothing after a restart (a sign-in is redone in a minute).
import { randomBytes, randomInt } from 'node:crypto'
import { isIP } from 'node:net'
import { keyFromDidDocument } from '../shared/chain.js'
import { toHex } from '../shared/crypto.js'
import {
  AMR, CLAIM_SECONDS, DECISION_SECONDS, DEFAULT_LINK_HOST, MATCH_NUMBER, NEVER_DELEGATED, OOB, REQUEST_ID, SERVED, SESSION_EXT, SIGN_IN_FLOW, TASK_FAMILY,
  checkLinkHost, contextDigest, epochOf, isEd25519DidKey, linkRoom, rfc3339, sameContextDigest,
} from '../shared/signin.js'
import { ACCEPT_MS, HTTPS_SERVICE, SKEW_MS, checkTask, responseTo, sameDid, signTask, verifyTask } from '../shared/trusttask.js'
import { roomDidStatus } from './roomdid.js'

// A refusal is thrown as the door's own Refusal(code, message, details), and an answer this file signed itself
// carries the door's SIGNED mark (both from src/server/door.js).
import { Refusal, SIGNED } from './door.js'
export { Refusal, SIGNED }

// Four of the six answers are the room's attestations: a wallet checks them against the room's DID document
// (assertionMethod) before it shows the person anything, and the grant is bound to the exact signed bytes of one of
// them. So this file signs those itself and hands the door a finished document carrying SIGNED, which the door
// sends as it is. (A door that signed them again, or for another purpose, would break both.)

// ── limits, each with what it protects ──────────────────────────────────────────────────────────────────────────────
// A finished request stays this long, so a document that arrives late still hears how it ended instead of "no such
// request" (OpenVTC keeps it for its acceptance window, ten minutes).
export const ENDED_RETENTION_SECONDS = 600
// Codes one address may have open and unscanned at once. A page shows one; a household behind one address, a few.
// It is what stops one script from filling the store with codes nobody will scan (OpenVTC's T17).
export const MAX_PENDING_PER_ADDRESS = 5
// Polls one address may hold open at once: each holds a connection for up to 25 seconds.
export const MAX_POLLS_PER_ADDRESS = 8
// How long a poll is held before it answers "not yet", so the page learns of a change at once without asking every second.
export const REDEEM_HOLD_MS = 25_000
// Requests the room remembers at once, finished ones included. One is about 2 KB, so this is about 10 MB at the very
// most, and far more sign-ins than happen in ten minutes. Past it a new code is refused for a minute rather than an
// older one dropped: dropping one would break a sign-in a person is in the middle of.
export const MAX_REQUESTS = 5000
// Sessions the room remembers. Past it the oldest goes, and that browser signs in again.
export const MAX_SESSIONS = 5000
// The longest a browser key stands for a person on one approval, whatever the wallet's grant says. It stands for
// "a tab left open on a shared computer should not still be you tomorrow". The grant's own end wins when it is sooner.
export const SESSION_MAX_SECONDS = 12 * 3600
// Different reasons the audit counts by name. They are fixed strings in this file (and the gate's); the cap is only so
// that a gate returning made-up reasons cannot grow the table.
const MAX_REASONS = 64
const STATUS_MS = 30_000 // how long a read of the room's DID log is trusted before it is read again
const SWEEP_MS = 5_000 // the store is swept at most this often, when something arrives

const FINAL = new Set(['consumed', 'declined', 'cancelled', 'expired'])
const DECISION_OPEN = new Set(['claimed', 'identified', 'approved'])
const STAGES = ['requested', 'claimed', 'proved', 'approved', 'declined', 'redeemed', 'cancelled', 'expired', 'proofFailed']
/** The refusals one task declares for itself; every other one belongs to the family (tasks.rs:87). */
const TASK_CODES = new Set(['claim:alreadyClaimed', 'prove:numberMismatch', 'redeem:declined', 'redeem:pending', 'request:modeUnsupported', 'request:purposeUnsupported', 'respond:contextMismatch'])
const code = (task, local) => TASK_CODES.has(`${task}:${local}`) ? `auth/oob/${task}:${local}` : `auth/oob:${local}`
const no = (task, local, message, details) => new Refusal(code(task, local), message, details)

const notFound = (task) => no(task, 'requestNotFound', 'no such sign-in request')
const expired = (task) => no(task, 'requestExpired', 'this sign-in request has expired; refresh the code on the website and scan again')
// One answer for an identity the room does not accept, a bad signature, a stale or replayed document, or a mismatched
// lock: which of them it was is not the caller's to learn (OpenVTC's T15).
const notAuthorized = (task) => no(task, 'notAuthorized', 'this sign-in was not authorised')
const malformed = (message) => new Refusal('malformedRequest', message)

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
/** A payload that is exactly these members (the task schemas are closed: additionalProperties false). */
const only = (p, required, optional = []) => isObj(p) && required.every((k) => k in p) && Object.keys(p).every((k) => required.includes(k) || optional.includes(k))
const extOk = (ext) => ext === undefined || (isObj(ext) && Object.keys(ext).length > 0 && Object.keys(ext).every((k) => /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/.test(k)))

/** Browser family and operating system from a User-Agent, never the string itself (util.rs:124). */
export function browserAndOs (ua = '') {
  const u = String(ua ?? ''), has = (...xs) => xs.some((x) => u.includes(x))
  const browser = has('Edg/') ? 'Edge' : has('OPR/', 'Opera') ? 'Opera' : has('Firefox/', 'FxiOS/') ? 'Firefox' : has('Chrome/', 'CriOS/', 'Chromium/') ? 'Chrome' : has('Safari/') ? 'Safari' : 'unknown'
  const os = has('iPhone', 'iPad') ? 'iOS' : has('Android') ? 'Android' : has('Mac OS X', 'Macintosh') ? 'macOS' : has('Windows') ? 'Windows' : has('CrOS') ? 'ChromeOS' : has('Linux') ? 'Linux' : 'unknown'
  return { browser, os }
}

/** The part of an address that is compared: all of an IPv4 address, the first 64 bits of an IPv6 one. null when it is not an address. */
function networkOf (ip) {
  const s = String(ip ?? '').replace(/^\[|\]$/g, '').replace(/%.*$/, '')
  const kind = isIP(s)
  if (kind === 4) return '4:' + s
  if (kind !== 6) return null
  let text = s
  const quad = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text) // an IPv4 address written inside an IPv6 one
  if (quad) text = quad[1] + ((+quad[2] << 8) | +quad[3]).toString(16) + ':' + ((+quad[4] << 8) | +quad[5]).toString(16)
  const [head, tail] = text.split('::'), a = head ? head.split(':') : [], b = tail ? tail.split(':') : []
  const groups = (text.includes('::') ? [...a, ...new Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b] : a).map((g) => parseInt(g, 16))
  if (groups.length !== 8 || groups.some(Number.isNaN)) return null
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) return `4:${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}` // ::ffff:a.b.c.d is that IPv4 address
  return '6:' + groups.slice(0, 4).map((g) => g.toString(16)).join(':')
}
/**
 * Whether the page and the wallet reached the room from the same network: true, false, or "unknown" when either
 * address is missing or one is IPv4 and the other IPv6 (one machine can use both, so that says nothing). The wallet
 * shows it to the person as a hint; the addresses themselves never leave the room (util.rs:107).
 */
export function sameNetwork (start, approver) {
  const a = networkOf(start), b = networkOf(approver)
  if (!a || !b || a[0] !== b[0]) return 'unknown'
  return a === b
}

const hostnameOf = (host) => String(host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase()
const LOOPBACK = (h) => h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127(\.\d+){3}$/.test(h)

export class SignIn {
  /**
   * identity: the room's key. resolver: the room's DID resolver (for the person's DID). log: the room's log, read
   * only (who is a person here, and their name). readDid: what the room's own DID says now ({ did, document }).
   * gate(stage, did): who may sign in (see #defaultGate). signingScope: the task families a grant may let the browser
   * key sign for; none, until the room's people decide a session key may speak here. door(): the room's Trust Task
   * door once there is one; the six tasks are put on it the first time it is found, wherever in the room's start it is made.
   */
  constructor ({ identity, config, resolver, log = null, now = Date.now, holdMs = REDEEM_HOLD_MS, gate = null, signingScope = null, readDid = null, doorPath = '/trust-tasks', door = null }) {
    // what the room offers to let a browser key sign for is fixed here, and can never include signing in, access or consent
    if (signingScope !== null && (!Array.isArray(signingScope) || !signingScope.length || signingScope.length > 8 || new Set(signingScope).size !== signingScope.length ||
      !signingScope.every((f) => typeof f === 'string' && f.length <= 128 && TASK_FAMILY.test(f) && !NEVER_DELEGATED.some((x) => f === x || f.startsWith(x + '/'))))) throw new Error('signingScope: one to eight task families, none of them under ' + NEVER_DELEGATED.join(', '))
    Object.assign(this, { identity, config, resolver, log, now, holdMs, signingScope, doorPath, findDoor: door })
    this.linkHost = config.signInLinkHost || DEFAULT_LINK_HOST
    this.gate = gate ?? ((stage, did) => this.#defaultGate(stage, did))
    this.readDid = readDid ?? (() => roomDidStatus({ dataDir: config.dataDir, file: config.didLogFile }))
    this.status = { did: null, document: null, at: -Infinity }
    this.requests = new Map() // requestId -> the request, oldest first
    this.sessions = new Map() // the browser's key (K_b) -> { subject, sessionEndsAt, grant, … }, oldest first
    this.carried = new Map() // id of an identify or grant already used -> when it may be forgotten (ms). At most two per request, kept about eleven minutes, so the requests' own cap bounds it
    this.polls = { open: new Set(), perAddress: new Map() }
    this.waiters = new Map() // requestId -> the polls waiting on it
    this.registered = false // true once the six tasks are on the room's door
    this.stopped = false
    this.sweptAt = -Infinity
    // What happened, with nobody's name, key or address in it: how many requests reached each stage, how many times
    // each refusal was given, and why requests were declined. "requested" far above "claimed" means codes are shown
    // and not scanned (a wallet that cannot read them, or cannot find the room); "claimed" far above "proved" with
    // reasons under declinedFor says which check stops people.
    this.counts = { stages: Object.fromEntries(STAGES.map((s) => [s, 0])), refused: {}, declinedFor: {} }
  }

  seconds () { return Math.floor(this.now() / 1000) }

  // ── who the room is in this exchange ──────────────────────────────────────────────────────────────────────────────
  /** Puts the six tasks on the room's door, once, as soon as the room has one. */
  attach () { if (!this.registered) { const door = this.findDoor?.(); if (door) registerSignIn(door, { signIn: this }) } }

  /** Re-reads the room's DID log at most every 30 seconds. */
  async refresh (force = false) {
    this.attach()
    if (!force && this.now() - this.status.at < STATUS_MS) return this.status
    let s = null; try { s = await this.readDid() } catch {}
    this.status = { did: s?.did ?? null, document: s?.document ?? null, at: this.now() }
    return this.status
  }

  /** The DID a link names and every document is addressed to: the room's did:webvh when it has one, else its did:key. */
  /**
   * Who sign-in signs as, and the DID a link names. With the room's door it is whoever the door answers as first: the
   * did:webvh only once that DID's document holds the room's key (door.identities() checks that), else the did:key. A
   * did:webvh whose document does not hold the key would sign answers no one can verify; didDocument() still reports it.
   * Without a door (sign-in on its own), the DID log's did:webvh as read here.
   */
  #asOf () { const door = this.findDoor?.(); return door?.identities ? door.identities()[0] : null }
  get did () { return this.#asOf()?.did ?? this.status.did ?? this.identity.did }
  get me () { const w = this.#asOf(); if (w) return w; const did = this.did; return { did, seed: this.identity.seed, verificationMethod: did === this.identity.did ? this.identity.verificationMethod : `${did}#room` } }
  get name () { const n = String(this.config.workspaceName ?? '').trim().slice(0, 128); return n || this.did.slice(0, 128) }

  /**
   * The one origin a request may come from (OpenVTC's T19): the origin of PUBLIC_URL; without one, the Origin header
   * counts only when it names the very host the request was sent to (a page calling its own server).
   */
  portalOrigin (http) {
    let o = null
    if (this.config.publicUrl) { try { o = new URL(this.config.publicUrl).origin } catch { return null } }
    else {
      if (!http?.origin || !http?.host) return null
      let u; try { u = new URL(http.origin) } catch { return null }
      o = u.host.toLowerCase() === String(http.host).toLowerCase() ? u.origin : null
    }
    return this.#originAllowed(o) ? o : null
  }

  /**
   * The schema (the origin in step 1) allows https only, and a real wallet refuses anything else. The room departs from
   * that in one place, on purpose and for local trial only: outside production it also takes http://localhost or
   * http://127.0.0.1 (an address on this machine), so the page can be tried without a certificate. In production an
   * origin that is not https is never answered, whatever PUBLIC_URL or the Origin header says.
   */
  #originAllowed (o) {
    if (!o) return false
    let u; try { u = new URL(o) } catch { return false }
    return u.protocol === 'https:' || (!this.config.production && u.protocol === 'http:' && LOOPBACK(hostnameOf(u.host)))
  }

  /**
   * `request` and `redeem` are answered only on the https door. The room's own rule on top of OpenVTC's: a room that
   * is not in production also answers on this machine's own address, so the page can be tried and tested locally.
   * A real wallet will not finish there (its key holder signs a grant only for an https origin).
   */
  #onDoor (http) { return Boolean(http) && (http.https === true || (!this.config.production && LOOPBACK(hostnameOf(http.host)))) }

  /** Why a real wallet would refuse this room's code, from the room's own DID document as it is published. */
  didDocument () {
    const doc = this.status.document, did = this.status.did ?? this.did // the DID the log says, whatever the room signs as now
    if (!doc) return { status: 'missing', missing: [HTTPS_SERVICE, 'SignInPortal'], why: 'the room has no did:webvh yet (it needs PUBLIC_URL); a did:key cannot say where a wallet should send anything' }
    const missing = [], origin = this.portalOrigin(null)
    const ofType = (t) => (doc.service ?? []).filter((s) => (Array.isArray(s.type) ? s.type : [s.type]).includes(t)).map((s) => (typeof s.serviceEndpoint === 'string' ? s.serviceEndpoint : s.serviceEndpoint?.uri)).filter((e) => typeof e === 'string')
    const sameOrigin = (e) => { try { return new URL(e).origin === origin } catch { return false } }
    // the endpoint is the base: a wallet posts to <base>/trust-tasks, so the base must lead to the room's door
    if (!origin || !ofType(HTTPS_SERVICE).some((e) => e.replace(/\/+$/, '') + '/trust-tasks' === origin + this.doorPath)) missing.push(HTTPS_SERVICE)
    // the wallet compares this entry's origin with the origin the room signs into its first answer
    if (!origin || !ofType('SignInPortal').some(sameOrigin)) missing.push('SignInPortal')
    try { if (toHex(keyFromDidDocument(doc, did, `${did}#room`, 'assertionMethod')) !== toHex(this.identity.publicKey)) missing.push('assertionMethod') } catch { missing.push('assertionMethod') }
    return missing.length ? { status: 'missing', missing } : { status: 'ok' }
  }

  /** Whether sign-in can be offered at all, and if not, why (in words a person hosting the room can act on). */
  #off () {
    this.attach()
    const why = []
    if (!this.registered) why.push('the room\'s Trust Task door is not running, so there is nowhere to send the documents')
    let portalHost = ''; try { portalHost = this.config.publicUrl ? new URL(this.config.publicUrl).hostname : '' } catch {}
    const host = checkLinkHost(this.linkHost, portalHost); if (host) why.push(host)
    const room = linkRoom({ linkHost: this.linkHost, did: this.did })
    if (!room.fits) why.push(`the room's DID is too long for a sign-in code: the link would be ${room.bytes} bytes and a code holds ${room.max}, so with this link host a DID may be ${room.didMayBe} bytes at most`)
    return why
  }

  // ── the store ─────────────────────────────────────────────────────────────────────────────────────────────────────
  /** The state as of now: a request past its clock has expired, whether or not anything has written that down. */
  stateOf (r, t = this.seconds()) {
    if (r.state === 'pending' && t >= r.claimDeadline) return 'expired'
    if (DECISION_OPEN.has(r.state) && (r.decisionDeadline == null || t >= r.decisionDeadline)) return 'expired'
    return r.state
  }

  #end (r, state, t = this.seconds()) { r.state = state; r.startNetwork = null; r.endedAt ??= t; this.#wake(r.requestId) } // the page's address is dropped the moment a request ends
  #wake (id) { const ws = this.waiters.get(id); if (!ws) return; this.waiters.delete(id); for (const w of ws) w(true) }
  /**
   * Resolves true when the request changes, false after ms. The timer is a real, referenced one: a held poll is a
   * person's browser waiting for an answer, and it is answered when the hold ends, never dropped because nothing
   * else happened to keep the room running (an unref'd timer here let Node 22's test runner see an empty event loop
   * under a poll that was still waiting). At shutdown, stop() answers every held poll at once, so no hold delays it.
   */
  #wait (id, ms) {
    return new Promise((resolve) => {
      const ws = this.waiters.get(id) ?? new Set(); this.waiters.set(id, ws)
      const done = (v) => { clearTimeout(timer); ws.delete(done); if (!ws.size && this.waiters.get(id) === ws) this.waiters.delete(id); resolve(v) }
      const timer = setTimeout(() => done(false), Math.max(0, ms))
      ws.add(done)
    })
  }

  #audit (stage, reason) {
    this.counts.stages[stage]++
    if (reason) this.#count(this.counts.declinedFor, reason)
  }

  #count (table, key) { const k = key in table || Object.keys(table).length < MAX_REASONS ? key : 'other'; table[k] = (table[k] ?? 0) + 1 }
  /** Called for every refusal a task gives (registerSignIn wraps the handlers with it). */
  countRefusal (err) { if (err instanceof Refusal) this.#count(this.counts.refused, String(err.code)) }

  /** Writes down an expiry the clock already decided. True when this call was the one that ended it. */
  #settleExpiry (r) {
    if (FINAL.has(r.state) || this.stateOf(r) !== 'expired') return false
    this.#end(r, 'expired'); this.#audit('expired')
    return true
  }

  /** Ends requests whose clock ran out, drops the ones that ended long enough ago, and forgets used documents and ended sessions. */
  sweep (force = false) {
    const ms = this.now(), t = Math.floor(ms / 1000)
    if (!force && ms - this.sweptAt < SWEEP_MS) return
    this.sweptAt = ms
    for (const r of this.requests.values()) {
      this.#settleExpiry(r)
      if (r.endedAt != null && t - r.endedAt > ENDED_RETENTION_SECONDS) this.requests.delete(r.requestId)
    }
    for (const [id, until] of this.carried) if (until < ms) this.carried.delete(id)
    for (const [key, s] of this.sessions) if (s.endsAt <= t) this.sessions.delete(key)
  }

  /** End a request as declined after a failed step by whoever holds it: one attempt per request. Only from the state the caller read. */
  #decline (r, from, reason, told = null, message = null) {
    if (r.state !== from) return
    r.declineReason = told; r.declineMessage = told ? message : null
    this.#end(r, 'declined'); this.#audit('proofFailed', reason)
  }

  /** A finished answer, signed as the room's attestation. */
  #attest (request, payload) {
    const me = this.me, doc = signTask(responseTo(request, payload, me.did), me, { purpose: 'assertionMethod' })
    return Object.defineProperty(doc, SIGNED, { value: true })
  }

  /**
   * Who may sign in, asked at four points with the DID that is signing in: 'known' (before its DID is looked up or
   * its signature read), 'proved' (it has shown the DID is its own), 'decided' (it approved) and 'redeem' (the page
   * collects). Answers { ok: true } or { ok: false, reason, told?, message? }: reason is for the room's own counts;
   * told and message reach the wallet and the page, and only once the DID is proved.
   *
   * The room's own rule (OpenVTC leaves this to each service): the room is open, so anyone whose DID the room can
   * read may sign in, joined or not. Not the room itself, not an agent (an agent acts by its person's permission, it
   * does not sit at the page), and not an account that was replaced by a new key.
   */
  #defaultGate (stage, did) {
    if (typeof did !== 'string' || !/^did:(key|webvh|peer):[A-Za-z0-9._:%-]+$/.test(did) || did.length > 2048) return { ok: false, reason: 'a DID the room cannot read' }
    if (sameDid(did, this.did) || did === this.identity.did) return { ok: false, reason: 'the room\'s own DID' }
    const p = this.log?.state?.participants?.get(did)
    if (p?.kind === 'agent') return { ok: false, reason: 'an agent\'s DID', told: 'agent', message: 'This DID belongs to an agent in this room. Agents act with their person\'s permission; they do not sign in as a person.' }
    if (p?.replacedBy) return { ok: false, reason: 'a replaced account', told: 'replaced', message: 'This account was replaced by a new key. Sign in with that one.' }
    return { ok: true }
  }

  /**
   * A document a person's DID signed, carried inside the wallet's own: checked as the door checks any document (its
   * type, who it is for, its age, a proof by its own issuer for exactly this purpose) and used once. Returns null, or
   * why not (for the room's counts only).
   */
  async verifyCarried (received, type, issuer, purpose) {
    if (!isObj(received)) return 'not a Trust Task document'
    if (received.type !== type) return 'wrong carried document type'
    if (received.issuer !== issuer) return 'carried document issuer mismatch'
    const ms = this.now(), me = this.did
    const basic = checkTask(received, { me, now: ms })
    if (!basic.ok) return basic.code === 'wrongRecipient' ? 'carried document not addressed to this room' : basic.code === 'expired' ? 'carried document is stale' : 'not a Trust Task document'
    if (!isObj(received.proof)) return 'carried document is unsigned'
    if (received.proof.proofPurpose !== purpose) return 'carried document signed for the wrong purpose'
    const v = await verifyTask(received, { keyFor: (d, vm, pp) => this.resolver.keyFor(d, vm, pp), me, now: ms, purposes: [purpose] })
    if (!v.ok) return 'carried document proof does not verify'
    if (v.signer !== issuer) return 'carried document signed by another DID'
    if (this.carried.has(received.id)) return 'carried document replayed'
    const until = Date.parse(received.expiresAt ?? '')
    this.carried.set(received.id, (Number.isNaN(until) ? Date.parse(received.issuedAt) + ACCEPT_MS : until) + SKEW_MS) // remembered for as long as the document itself would still be accepted
    return null
  }

  /** Before any proof is read: both keys of the exchange are Ed25519 did:keys made for it, and nothing else is looked at (OpenVTC's T21). */
  precheck (doc) {
    const task = SERVED.find((t) => OOB[t] === doc?.type)
    if (!task || isEd25519DidKey(doc.issuer)) return undefined
    return no(task, 'keyUnsupported', 'the issuer must be an Ed25519 did:key generated for this exchange')
  }

  #checked (doc) { const r = this.precheck(doc); if (r) throw r; this.sweep() }

  // ── request: the browser opens a request under its new key ────────────────────────────────────────────────────────
  async request ({ doc, payload, signer, http }) {
    this.#checked(doc)
    if (!this.#onDoor(http)) throw new Refusal('permissionDenied', 'auth/oob/request is accepted only over HTTPS')
    if (typeof payload?.purpose === 'string' && payload.purpose !== 'login') throw no('request', 'purposeUnsupported', `purpose \`${payload.purpose.slice(0, 40)}\` is not served; v1 serves \`login\``)
    if (typeof payload?.mode === 'string' && payload.mode !== 'scan') throw no('request', 'modeUnsupported', `mode \`${payload.mode.slice(0, 40)}\` is not served; v1 serves \`scan\``)
    if (!only(payload, ['purpose', 'mode'], ['ext']) || payload.purpose !== 'login' || payload.mode !== 'scan' || !extOk(payload.ext)) throw malformed('payload: { purpose: "login", mode: "scan" }')
    // an OpenVTC community has two sessions to ask for (member, admin); the room has one, and says so rather than
    // hand out a session the page did not ask for. Any other member of ext is not the room's to read.
    if (payload.ext && SESSION_EXT in payload.ext) throw malformed(`ext["${SESSION_EXT}"]: this room has one kind of sign-in`)
    await this.refresh()
    const off = this.#off()
    if (off.length) throw new Refusal('unavailable', `wallet sign-in is not available in this room: ${off[0]}`)
    // only the room's own page may open a request, so another website cannot start one through a person's browser;
    // the origin kept here is the one the wallet is shown and compares with the room's SignInPortal
    const origin = this.portalOrigin(http)
    if (!origin || origin !== http.origin) throw new Refusal('permissionDenied', 'auth/oob/request is accepted only from this room\'s own page')
    const t = this.seconds(), address = String(http.ip ?? '')
    let open = 0
    for (const r of this.requests.values()) if (r.startNetwork === address && this.stateOf(r, t) === 'pending') open++
    if (open >= MAX_PENDING_PER_ADDRESS) throw no('request', 'rateLimited', 'too many sign-in codes are open from this network; use one or wait for it to expire')
    if (this.requests.size >= MAX_REQUESTS) { this.sweep(true); if (this.requests.size >= MAX_REQUESTS) throw no('request', 'rateLimited', 'this room has too many sign-ins under way; try again in a minute', { retryAfter: 60 }) }
    let requestId; do requestId = randomBytes(16).toString('base64url'); while (this.requests.has(requestId)) // 128 random bits: also the exchange's nonce
    const r = {
      requestId, state: 'pending', startKey: signer, startNetwork: address, approverKey: null, purpose: 'login', mode: 'scan', origin,
      matchNumber: null, matchNumberDelivered: false,
      requester: { location: 'unknown', ...browserAndOs(http.userAgent), createdAt: rfc3339(t) }, // no location: the room keeps no address database and asks no one else
      identifiedDid: null, step2Digest: null, step1: null, createdAt: t, claimDeadline: t + CLAIM_SECONDS, decisionDeadline: null, grant: null, endedAt: null, signingScope: null, declineReason: null, declineMessage: null,
    }
    this.requests.set(requestId, r); this.#audit('requested')
    return { requestId, claimClosesAt: rfc3339(r.claimDeadline) }
  }

  // ── claim: a wallet scans the code and takes the request, with a key made for this one scan ───────────────────────
  async claim ({ doc, payload, signer }) {
    this.#checked(doc)
    if (!only(payload, ['requestId'], ['ext']) || !REQUEST_ID.test(payload.requestId) || !extOk(payload.ext)) throw malformed('payload: { requestId }')
    if (doc.parentThreadId !== payload.requestId) throw malformed('parentThreadId must equal payload.requestId (VTI-LNK-054)')
    const r = this.requests.get(payload.requestId)
    if (!r) throw notFound('claim')
    const taken = () => no('claim', 'alreadyClaimed', 'this code was already used by another device') // no details: a second scanner learns nothing about the first
    const state = this.stateOf(r)
    if (state === 'expired') { this.#settleExpiry(r); throw expired('claim') }
    if (state !== 'pending') throw taken()
    await this.refresh()
    const t = this.seconds(), decisionDeadline = t + DECISION_SECONDS
    // step 1: who the room is, where the sign-in will be used and for what. Nothing about the browser yet.
    const step1 = { requestId: r.requestId, service: { did: this.did, name: this.name }, origin: r.origin, purpose: r.purpose, decisionClosesAt: rfc3339(decisionDeadline) }
    const answer = this.#attest(doc, step1) // signed before the lock is taken, so a request is never claimed with no answer to show for it
    if (this.stateOf(r) !== 'pending') throw taken()
    Object.assign(r, { state: 'claimed', approverKey: signer, matchNumber: String(randomInt(100)).padStart(2, '0'), decisionDeadline, step1 })
    this.#wake(r.requestId); this.#audit('claimed')
    return answer
  }

  // ── prove: the wallet carries the person's own statement, with the number from the screen ─────────────────────────
  async prove ({ doc, payload, signer, http }) {
    this.#checked(doc)
    if (!only(payload, ['identify'], ['ext']) || !isObj(payload.identify) || !extOk(payload.ext)) throw malformed('payload: { identify: a signed auth/oob/identify document }')
    const identify = payload.identify, hint = doc.parentThreadId ?? identify.payload?.requestId
    const r = typeof hint === 'string' ? this.requests.get(hint) : null
    if (!r) throw notFound('prove')
    // 1. the outer document is from the key that scanned, and the request is claimed and inside its window.
    //    A stranger's failure changes nothing.
    if (r.approverKey !== signer) throw no('prove', 'notClaimant', 'this device does not hold this sign-in request')
    const state = this.stateOf(r)
    if (state === 'expired') { this.#settleExpiry(r); throw expired('prove') }
    if (state !== 'claimed') throw notAuthorized('prove') // one attempt per request
    // from here every failure ends the request
    const fail = (reason) => { this.#decline(r, 'claimed', reason); return notAuthorized('prove') }
    // 2. the carried statement names this request and this key
    const member = identify.issuer, p = identify.payload
    if (typeof member !== 'string' || !only(p, ['requestId', 'approverKey', 'enteredNumber']) || !REQUEST_ID.test(p.requestId) || !isEd25519DidKey(p.approverKey) || !MATCH_NUMBER.test(p.enteredNumber)) throw fail('identify is malformed')
    if (p.requestId !== r.requestId || p.approverKey !== signer) throw fail('identify names another request or lock')
    // 3. may this DID sign in at all: decided from what the room already knows, before its DID is looked up
    const known = await this.gate('known', member)
    if (!known.ok) throw fail(known.reason)
    // 4. the person's signature, for authentication, on a document that is fresh, for this room, and not used before
    const bad = await this.verifyCarried(identify, OOB.identify, member, 'authentication')
    if (bad) throw fail(bad)
    // 5. the number the person typed
    if (p.enteredNumber !== r.matchNumber) { this.#decline(r, 'claimed', 'wrong number'); throw no('prove', 'numberMismatch', 'that is not the number on the screen; refresh the code on the website and scan again') }
    // 5a. the DID is proved to be theirs, so a refusal may now say why, to the wallet and to the page
    const proved = await this.gate('proved', member)
    if (!proved.ok) {
      if (!proved.told) throw fail(proved.reason)
      this.#decline(r, 'claimed', proved.reason, proved.told, proved.message)
      throw no('prove', 'notAuthorized', proved.message ?? 'this sign-in was not authorised', { reason: proved.told })
    }
    // 6. step 2: step 1 again, word for word, plus the browser's key and what the room saw of the browser
    if (!r.step1) throw new Refusal('internalError', 'claimed request has no step 1')
    const step2 = { ...r.step1, sessionKey: r.startKey, requester: { ...r.requester, sameNetwork: sameNetwork(r.startNetwork, http?.ip) }, identifiedAs: member, ...(this.signingScope ? { signingScope: [...this.signingScope] } : {}) }
    const answer = this.#attest(doc, step2)
    if (this.stateOf(r) !== 'claimed' || r.approverKey !== signer) throw expired('prove')
    Object.assign(r, { state: 'identified', identifiedDid: member, step2Digest: contextDigest(answer), signingScope: this.signingScope ? [...this.signingScope] : null })
    this.#wake(r.requestId); this.#audit('proved')
    return answer
  }

  // ── respond: the wallet carries the person's decision, bound to exactly what they were shown ──────────────────────
  async respond ({ doc, payload, signer }) {
    this.#checked(doc)
    if (!only(payload, ['grant'], ['ext']) || !isObj(payload.grant) || !extOk(payload.ext)) throw malformed('payload: { grant: a signed auth/oob/grant document }')
    const grantDoc = payload.grant, hint = doc.parentThreadId ?? grantDoc.payload?.requestId
    const r = typeof hint === 'string' ? this.requests.get(hint) : null
    if (!r) throw notFound('respond')
    const decided = () => no('respond', 'alreadyDecided', 'this sign-in request has already been decided')
    // 1. the key that scanned, a request whose person is identified, inside the window
    if (r.approverKey !== signer) throw no('respond', 'notClaimant', 'this device does not hold this sign-in request')
    const state = this.stateOf(r)
    if (state === 'expired') { this.#settleExpiry(r); throw expired('respond') }
    if (state === 'claimed') throw notAuthorized('respond')
    if (state !== 'identified') throw decided()
    const member = r.identifiedDid
    if (!member) throw notAuthorized('respond')
    const fail = (reason) => { this.#decline(r, 'identified', reason); return notAuthorized('respond') }
    // 2. the grant is the identified DID's own, signed as an attestation, fresh, and not used before
    if (grantDoc.issuer !== member) throw fail('grant from another identity')
    const bad = await this.verifyCarried(grantDoc, OOB.grant, member, 'assertionMethod')
    if (bad) throw fail(bad)
    const g = grantDoc.payload, notAfter = epochOf(g?.sessionEndsAt)
    const scopeOk = (s) => s === undefined || (Array.isArray(s) && s.length >= 1 && s.length <= 8 && new Set(s).size === s.length && s.every((f) => typeof f === 'string' && f.length <= 128 && TASK_FAMILY.test(f)))
    if (!only(g, ['requestId', 'decision', 'sessionKey', 'approverKey', 'origin', 'contextDigest', 'sessionEndsAt'], ['signingScope']) || !['approve', 'decline'].includes(g.decision) || notAfter === null || !scopeOk(g.signingScope) ||
      ![g.requestId, g.sessionKey, g.approverKey, g.origin, g.contextDigest].every((x) => typeof x === 'string')) throw fail('grant payload is malformed')
    // 3-4. the same key that scanned, the same browser key, the same origin, the same screen of facts, and exactly
    //      the signing the room offered (none unless the room offers some): no more, no less, in the same order
    const sameScope = JSON.stringify(g.signingScope ?? null) === JSON.stringify(r.signingScope ?? null)
    if (g.requestId !== r.requestId || g.approverKey !== signer || g.sessionKey !== r.startKey || g.origin !== r.origin || !sameContextDigest(r.step2Digest, g.contextDigest) || !sameScope) {
      this.#decline(r, 'identified', 'grant context mismatch')
      throw no('respond', 'contextMismatch', 'the grant does not match this sign-in request')
    }
    const approve = g.decision === 'approve'
    if (approve) {
      if (notAfter <= this.seconds()) throw fail('grant sessionEndsAt has passed')
      // 5. still someone who may sign in, now
      const ok = await this.gate('decided', member)
      if (!ok.ok) {
        if (!ok.told) throw fail(ok.reason)
        this.#decline(r, 'identified', ok.reason, ok.told, ok.message)
        throw no('respond', 'notAuthorized', ok.message ?? 'this sign-in was not authorised', { reason: ok.told })
      }
    }
    // 6. decide, once
    if (this.stateOf(r) !== 'identified' || r.approverKey !== signer) throw decided()
    r.grant = grantDoc
    if (approve) { r.state = 'approved'; this.#wake(r.requestId) } else this.#end(r, 'declined')
    this.#audit(approve ? 'approved' : 'declined')
    return this.#attest(doc, { status: approve ? 'approved' : 'declined' }) // never anything a session could be made from: that goes to the browser's key alone
  }

  // ── cancel: the browser, or the wallet that scanned, gives the request up ─────────────────────────────────────────
  async cancel ({ doc, payload, signer }) {
    this.#checked(doc)
    if (!only(payload, ['requestId'], ['ext']) || !REQUEST_ID.test(payload.requestId) || !extOk(payload.ext)) throw malformed('payload: { requestId }')
    const r = this.requests.get(payload.requestId)
    if (!r) throw notFound('cancel')
    if (r.startKey !== signer && r.approverKey !== signer) throw notAuthorized('cancel')
    if (FINAL.has(r.state)) throw no('cancel', 'alreadyDecided', 'this sign-in request has already ended')
    if (this.stateOf(r) === 'expired') { this.#settleExpiry(r); throw expired('cancel') }
    this.#end(r, 'cancelled'); this.#audit('cancelled')
    return this.#attest(doc, { status: 'cancelled' })
  }

  // ── redeem: the browser asks, and waits, and in the end collects ──────────────────────────────────────────────────
  async redeem ({ doc, payload, signer, http }) {
    this.#checked(doc)
    if (!this.#onDoor(http)) throw new Refusal('permissionDenied', 'auth/oob/redeem is served only over HTTPS')
    if (!only(payload, ['requestId'], ['ext']) || !REQUEST_ID.test(payload.requestId) || !extOk(payload.ext)) throw malformed('payload: { requestId }')
    const id = payload.requestId, first = this.requests.get(id)
    if (!first) throw notFound('redeem')
    if (first.startKey !== signer) throw no('redeem', 'notStarter', 'only the browser that started this sign-in can redeem it')
    // one poll is held open per request; a second one on the same request is answered at once instead
    const address = String(http.ip ?? '')
    let held = false
    if (!this.polls.open.has(id)) {
      const n = this.polls.perAddress.get(address) ?? 0
      if (n >= MAX_POLLS_PER_ADDRESS) throw no('redeem', 'rateLimited', 'too many sign-in polls are open from this network')
      this.polls.open.add(id); this.polls.perAddress.set(address, n + 1); held = true
    }
    try {
      const until = Date.now() + this.holdMs, entry = this.stateOf(first)
      for (let last = false; ;) {
        const r = this.requests.get(id)
        if (!r) throw notFound('redeem')
        const state = this.stateOf(r)
        if (state === 'approved') return await this.#collect(r)
        if (state === 'consumed') throw no('redeem', 'alreadyDecided', 'this sign-in has already been used')
        if (state === 'declined') throw no('redeem', 'declined', (r.declineReason && r.declineMessage) || 'the sign-in was declined', { state: 'declined', ...(r.declineReason ? { reason: r.declineReason } : {}) })
        if (state === 'cancelled') throw no('redeem', 'declined', 'the sign-in was cancelled', { state: 'cancelled' })
        if (state === 'expired') { this.#settleExpiry(r); throw expired('redeem') }
        // pending, claimed or identified: answer at once when something changed since this poll began, or when the
        // number has not reached the screen yet; otherwise wait for a change
        const owed = state === 'claimed' && !r.matchNumberDelivered
        if (state !== entry || owed || !held || last) {
          if (r.matchNumber) r.matchNumberDelivered = true
          throw no('redeem', 'pending', 'waiting for the wallet; poll again', { state, ...(r.matchNumber ? { matchNumber: r.matchNumber } : {}) }) // the number goes only to the browser that started the request
        }
        last = !(await this.#wait(id, until - Date.now())) || this.stopped
      }
    } finally {
      if (held) { this.polls.open.delete(id); const n = (this.polls.perAddress.get(address) ?? 1) - 1; if (n > 0) this.polls.perAddress.set(address, n); else this.polls.perAddress.delete(address) }
    }
  }

  /** approved → consumed, once; then what the room keeps for the browser's key: who approved it, until when, and their signed grant. */
  async #collect (r) {
    if (this.stateOf(r) !== 'approved') throw no('redeem', 'alreadyDecided', 'this sign-in has already been used')
    this.#end(r, 'consumed') // spent, whatever happens next
    const subject = r.identifiedDid, t = this.seconds(), notAfter = epochOf(r.grant?.payload?.sessionEndsAt) ?? t
    if (!subject || notAfter <= t) throw notAuthorized('redeem')
    const still = await this.gate('redeem', subject) // asked again now, not remembered from two minutes ago
    if (!still.ok) {
      this.#audit('proofFailed', still.reason)
      if (!still.told) throw notAuthorized('redeem')
      throw no('redeem', 'declined', still.message ?? 'the sign-in was declined', { state: 'declined', reason: still.told })
    }
    const endsAt = Math.min(notAfter, t + SESSION_MAX_SECONDS), p = this.log?.state?.participants?.get(subject)
    const displayName = (p?.kind === 'human' && typeof p.name === 'string' && p.name ? p.name : subject).slice(0, 128) // a name only when this DID has joined the room under one
    this.sessions.delete(r.startKey)
    while (this.sessions.size >= MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value)
    this.sessions.set(r.startKey, { sessionKey: r.startKey, subject, displayName, endsAt, origin: r.origin, grant: r.grant })
    this.#audit('redeemed')
    return { subject, displayName, sessionEndsAt: rfc3339(endsAt), amr: [...AMR] }
  }

  // ── what the room says about all this ─────────────────────────────────────────────────────────────────────────────
  /**
   * What the room holds for a browser key that a person approved, or null: who, until when, and the person's own
   * signed grant, so anyone can check it without taking the room's word (the grant names this key, the room's origin
   * and its end, and is signed by the person's DID for assertionMethod).
   */
  session (key) {
    const s = this.sessions.get(String(key ?? ''))
    if (!s) return null
    if (s.endsAt <= this.seconds()) { this.sessions.delete(s.sessionKey); return null }
    return { sessionKey: s.sessionKey, subject: s.subject, displayName: s.displayName, sessionEndsAt: rfc3339(s.endsAt), amr: [...AMR], origin: s.origin, grant: s.grant, mayWrite: false }
  }

  /**
   * What a page (or any program starting a sign-in) needs to draw the code. `vtcDid` is the same DID under the name
   * OpenVTC's own client reads from a community's GET /v1/member/sign-in/config; the room is not a community.
   */
  configView () {
    const off = this.#off(), room = linkRoom({ linkHost: this.linkHost, did: this.did })
    return {
      on: off.length === 0, ...(off.length ? { why: off } : {}),
      serviceDid: this.did, vtcDid: this.did, name: this.name, linkHost: this.linkHost, flow: SIGN_IN_FLOW,
      trustTasks: this.doorPath, didDocument: this.didDocument(), link: { bytes: room.bytes, max: room.max, fits: room.fits },
      claimSeconds: CLAIM_SECONDS, decisionSeconds: DECISION_SECONDS,
    }
  }

  /** For /api/info: whether it is on, what a wallet would trip over, and the counts. No request, key, DID of a person or address. */
  view () {
    this.sweep()
    if (this.now() - this.status.at >= STATUS_MS) this.refresh().catch(() => {}) // read between requests, so the next look is current
    const c = this.configView()
    let open = 0; for (const r of this.requests.values()) if (!FINAL.has(r.state)) open++
    return {
      on: c.on, ...(c.why ? { why: c.why } : {}), did: c.serviceDid, linkHost: c.linkHost, flow: c.flow, trustTasks: c.trustTasks, didDocument: c.didDocument, link: c.link,
      sessionsMayWrite: false, signingScope: this.signingScope ?? [],
      windows: { claimSeconds: CLAIM_SECONDS, decisionSeconds: DECISION_SECONDS, sessionMaxHours: SESSION_MAX_SECONDS / 3600 },
      open, sessions: this.sessions.size,
      counts: { ...this.counts.stages }, refused: { ...this.counts.refused }, declinedFor: { ...this.counts.declinedFor },
    }
  }

  /**
   * GET /api/signin/config (also at <any base>/member/sign-in/config, where OpenVTC's client looks),
   * GET /api/signin/session?key=<the browser key's did:key>, GET /api/signin. Reads only. False when the path is not one of these.
   */
  async handle (req, res, path, q, send) {
    const config = path === '/api/signin/config' || path.endsWith('/member/sign-in/config')
    if (!config && path !== '/api/signin/session' && path !== '/api/signin') return false
    const headers = { 'cache-control': 'no-store' }
    if (req.method !== 'GET' && req.method !== 'HEAD') { send(res, 405, { error: 'GET' }, { ...headers, allow: 'GET' }); return true }
    await this.refresh()
    if (config) send(res, 200, this.configView(), headers)
    else if (path === '/api/signin') send(res, 200, this.view(), headers)
    else {
      this.sweep()
      const s = isEd25519DidKey(q?.key) ? this.session(q.key) : null
      if (s) send(res, 200, s, headers); else send(res, 404, { error: 'no sign-in is held for that key (key: the did:key the browser made; a session ends when its person\'s grant does, and with a restart of the room)' }, headers)
    }
    return true
  }

  /** Lets every waiting poll go (the room is stopping). */
  stop () { this.stopped = true; for (const id of [...this.waiters.keys()]) this.#wake(id) }
}

/**
 * Put the six tasks on the room's Trust Task door. Each takes requests signed for authentication, by the browser's
 * key or the wallet's. `precheck` is offered to the door to run before it reads a proof (the same check runs again
 * inside each task, for a door that does not take it).
 */
export function registerSignIn (door, ctx) {
  const s = ctx.signIn
  for (const task of SERVED) {
    door.register(OOB[task], async (args) => { try { return await s[task](args) } catch (e) { s.countRefusal(e); throw e } }, { purposes: ['authentication'], precheck: (doc) => s.precheck(doc) })
  }
  s.registered = true
  if (typeof door.path === 'string' && door.path.startsWith('/')) s.doorPath = door.path
  return s
}

