// The room's Trust Task door: one https address where another project's software hands the room a signed, standard
// Trust Task document and gets a signed answer back (OpenVTC's pnm and cnm, a trust agent, a community, an RLTP peer,
// any agent with a Trust Task library). It is the https binding those projects share: POST <base>/trust-tasks, where
// <base> is the TrustTaskHTTPS service in the room's DID document. No token: the document's own proof says who asks.
//
// A document goes through the steps OpenVTC's door takes, in its order (vti-trust-task-server/src/spine.rs at the
// commit the room builds from):
//   1 size, before anything is parsed · 2 parse · 3 fresh, and addressed to the room · 4 its proof, by its issuer ·
//   5 the signer is let in (a rate limit) · 6 its id has not been taken (the duplicate-id record) · 7 the task runs ·
//   8 the answer is signed, a refusal as much as a result (sign.rs).
// A refusal is a trust-task-error document with a shared code (reject.rs); its HTTP status is the binding's table
// (statusFor in src/shared/trusttask.js). Three answers carry no signed document: 202 (the same document is
// still running), 204 (it ran, and its answer was not kept) and 429 (slow down, with Retry-After). The 429 of the
// per-signer limit is empty, as upstream's trust task server answers it (spine.rs); the 429 of the per-address limit
// has a small JSON body, as OpenVTC's community gives for its per-address limiter (vtc-service/src/routing/rate_limit.rs):
// { error: 'rate_limited', limiter, message, retry_after_secs }, with the x-rate-limit-source header.
//
// Where the room is stricter than a task's own specification, on purpose: every document needs a proof (a ping's
// specification asks for none; the room has no other way to know who is asking, and its rate limit is per signer),
// and a stated expiresAt is honoured for an hour, not thirty days (HORIZON_MS says why). Discovery states both.
//
// Other parts of the room add tasks with door.register(); nothing here knows what they do. A task that changes
// anything must only ever be reached through this door's checks or through log.accept: there is no unsigned way in.
import { canonicalize, sha256, toHex } from '../shared/crypto.js'
import { SIGNING_RELATIONSHIPS, ed25519Multikey } from '../shared/did.js'
import { TYPES, WHO } from '../shared/types.js'
import { ACCEPT_MS, CODES, MAX_DOCUMENT_BYTES, SKEW_MS, SPEC, acceptedUntil, checkTask, instant, refusalTo, responseTo, sameDid, signTask, statusFor, typeUri, verifyTask } from '../shared/trusttask.js'
import { TaskError } from './log.js'
import { trustTaskBase } from './roomdid.js'

// The tasks every door answers, at the versions OpenVTC serves at the room's pin: discovery 0.4 and the older 0.3
// (vti-common/src/trust_task/discovery.rs; 0.1 is no longer answered there), ping 0.2 (vti-specs-core
// trust-tasks/messaging/ping/0.2.bundle.json; 0.1 is gone, its answer said serverTime where 0.2 says respondedAt).
export const DISCOVERY = typeUri('trust-task-discovery', '0.4')
export const DISCOVERY_0_3 = typeUri('trust-task-discovery', '0.3')
export const PING = typeUri('messaging/ping', '0.2')
/** The Trust Tasks framework release the room's documents follow (the one its refusal type, trust-task-error/0.6, belongs to). */
export const FRAMEWORK_VERSION = '0.6.0'

// How long after it was written a document's own expiresAt is honoured. OpenVTC's services honour thirty days and
// keep their record of accepted ids on disk for as long. The room's record is in memory (see Accepted), and a record
// has to outlive every document it guards, so the room honours an hour: long enough for a document to wait out a
// relay or a retry, short enough that the record empties within the hour. A sender reads this from discovery
// (acceptanceWindow.expiryHorizonSeconds) and writes a fresh document instead of sending one older than that.
export const HORIZON_MS = 3600_000
const MINUTE = 60_000
const MAX_PATTERNS = 16 // discovery's request schema: at most 16 patterns
// Answers kept for a redelivery, all together: about 4 MB of the room's memory (a small container). Past it an
// answer is not kept, and a redelivery of its document gets 204: done, nothing to send again.
const MAX_RECORDED_BYTES = 4 * 1024 * 1024
// a request, or something a person attests; never keyAgreement. Upstream also accepts capabilityInvocation and
// capabilityDelegation (vta-sdk/src/trust_task_proof/purpose.rs); the room does not, on purpose: nothing here takes
// a capability, and every purpose it accepts is one more way for a proof to be read as something it was not meant for.
const PURPOSES = ['authentication', 'assertionMethod']
const EXTENDED = /^[a-z][a-z0-9]*(-[a-z0-9]+)*(\/[a-z][a-z0-9]*(-[a-z0-9]+)*)*:[a-z][a-zA-Z0-9_]*$/ // a task's own code, "<family>:<local>", in the form RLTP's reader holds one to (lib/src/adapters/vti-mediator.ts)
const OPAQUE = 'the room could not complete this task; nothing was wrong with the document itself' // never the cause: that goes to the host's log
/**
 * The mark on an answer a task signed itself (wallet sign-in's attestations: a wallet checks them for assertionMethod,
 * and a grant is bound to their exact bytes). The door sends such an answer as it is, once it has checked that it
 * answers this document and is signed as one of the room's own DIDs; signing it again would break both.
 */
export const SIGNED = Symbol.for('wpi.trusttask.signedAnswer')

/** What a task throws to say no: a shared code (or its own "<family>:<local>"), words for a person, small details for a program. */
export class Refusal extends Error {
  constructor (code, message, details, { retryable, retryAfter } = {}) {
    super(message); this.name = 'Refusal'; this.code = code; this.details = details; this.retryable = retryable; this.retryAfter = retryAfter
  }
}

/** So many a minute for each key (an address, a signer), counted minute by minute. take() gives 0 for "go ahead", else the seconds to wait. */
class Limiter {
  constructor (perMinute, maxKeys = 50_000) { this.perMinute = perMinute; this.maxKeys = maxKeys; this.hits = new Map(); this.swept = 0 } // maxKeys: the counters themselves stay small (a few MB) under a flood of made-up keys
  take (key, now) {
    if (now - this.swept >= MINUTE) { for (const [k, h] of this.hits) if (now - h.at >= MINUTE) this.hits.delete(k); this.swept = now }
    let h = this.hits.get(key)
    if (!h || now - h.at >= MINUTE) {
      if (!h && this.hits.size >= this.maxKeys) return 60
      h = { at: now, n: 0 }; this.hits.set(key, h)
    }
    if (h.n >= this.perMinute) return Math.max(1, Math.ceil((h.at + MINUTE - now) / 1000))
    h.n++
    return 0
  }
}

/**
 * The duplicate-id record: which document ids the door has accepted, each with the digest of the whole document
 * (proof included) and, once its task has run, the signed answer. The same document again gets that answer and does
 * not run twice; a different document under a used id is idConflict. An id is claimed before its task runs, so two
 * deliveries at once cannot both run; a task that refuses gives the id back, so a corrected document may use it.
 * Keyed by the id alone, never by who sent it (OpenVTC: vti-trust-task-server/src/accepted.rs).
 *
 * It lives in memory and is bounded: a record is dropped when its document could no longer be accepted anyway
 * (acceptedUntil), and when the record is full the door answers `unavailable` instead of forgetting a live id,
 * because a forgotten id is a replay that runs twice.
 * WHAT A RESTART LOSES: every record. A document accepted before a restart and sent again after it, still inside
 * its window, runs its task again. For the tasks the room ships that is harmless: discovery and ping change
 * nothing, and a line for the room's log is caught by the log's own index of document ids, which is on disk. A
 * task another part of the room registers that changes anything must itself be safe to run twice for one doc.id,
 * or keep its own lasting record.
 */
class Accepted {
  constructor ({ maxRecords, maxBytes }) { this.max = maxRecords; this.maxBytes = maxBytes; this.records = new Map(); this.bytes = 0; this.swept = 0 }
  #drop (id, r) { this.bytes -= r.body?.length ?? 0; this.records.delete(id) }
  sweep (now) { for (const [id, r] of this.records) if (r.until <= now) this.#drop(id, r); this.swept = now }
  /** { fresh: record } to run it · { duplicate: record } · { conflict: true } · { full: true } */
  claim (id, digest, until, now) {
    if (now - this.swept >= (this.records.size >= this.max ? 1000 : MINUTE)) this.sweep(now)
    const seen = this.records.get(id)
    if (seen && seen.until > now) return seen.digest === digest ? { duplicate: seen } : { conflict: true }
    if (seen) this.#drop(id, seen)
    if (this.records.size >= this.max) return { full: true }
    const r = { digest, until, done: false, body: null }
    this.records.set(id, r)
    return { fresh: r }
  }
  completed (id, r, body) {
    if (this.records.get(id) !== r) return
    r.done = true
    if (body && this.bytes + body.length <= this.maxBytes) { r.body = body; this.bytes += body.length }
  }
  release (id, r) { if (this.records.get(id) === r && !r.done) this.records.delete(id) }
}

/** A value as it will go over the wire (a Date becomes its text, an undefined member goes), or nothing if it cannot: what is signed has to be exactly what is sent. */
const plain = (v) => { try { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)) } catch { return undefined } }
/** The type a document is routed by: a request may say so with "#request" (Trust Tasks 4.4.1); its answer is the bare type + "#response". */
const routed = (type) => (typeof type === 'string' && type.endsWith('#request') ? type.slice(0, -'#request'.length) : type)
/** A type address without its trailing version: https://…/messaging/ping/0.2 and urn:…:input:note:0.1 both have one. */
const familyOf = (uri) => /^(.+)[/:]\d+\.\d+$/.exec(String(uri))?.[1] ?? null

export class Door {
  /**
   * ctx: the room (identity, log.resolver, join, config). The limits, and what each protects:
   *  - an address sends at most `perAddressPerMinute` documents a minute, counted before anything is read: reading a
   *    document can make the room fetch its signer's did:webvh log from another host and check a signature, and one
   *    address must not be able to keep the room doing that. Default 8 x RATE_PER_MINUTE (240): several people's
   *    agents, or one community's server speaking for its members, share an address.
   *  - a signer sends at most `perSignerPerMinute` a minute, counted once its proof has verified and before its id
   *    is taken (so a document told to slow down keeps its id for the retry): one key must not crowd the tasks or
   *    the record. Default 2 x RATE_PER_MINUTE (60): twice what the log lets a person write, so someone writing
   *    lines meets the log's own limit, with its own words, first.
   *  - the record holds at most `maxRecords` ids: a quarter more than one address can send, at its limit, in the
   *    longest time a record is kept (an hour and the slack). About 18,000 ids by default, a few MB. Only tasks that
   *    change something are recorded (register's `once`): discovery and ping are not, so the record is filled only by
   *    signed documents of tasks that change something, which the per-signer limit and the log's own limits also bound.
   */
  constructor ({ ctx, now = Date.now, perSignerPerMinute, perAddressPerMinute, maxRecords, maxRecordedBytes = MAX_RECORDED_BYTES }) {
    const rate = ctx.config?.ratePerMinute ?? 30
    this.ctx = ctx; this.now = now; this.handlers = new Map()
    this.limits = { perSignerPerMinute: perSignerPerMinute ?? 2 * rate, perAddressPerMinute: perAddressPerMinute ?? 8 * rate }
    this.limits.rememberedIds = maxRecords ?? Math.ceil(1.25 * this.limits.perAddressPerMinute * (HORIZON_MS + SKEW_MS) / MINUTE)
    this.signers = new Limiter(this.limits.perSignerPerMinute); this.addresses = new Limiter(this.limits.perAddressPerMinute)
    this.accepted = new Accepted({ maxRecords: this.limits.rememberedIds, maxBytes: maxRecordedBytes })
    // what the door did since the room started: counts and outcomes only, never who or what
    this.counts = { since: new Date(now()).toISOString(), received: 0, answered: 0, refused: {}, duplicates: { answeredAgain: 0, stillRunning: 0, doneNothingKept: 0 }, rateLimited: { address: 0, signer: 0 }, answeredByType: {} }
  }

  /**
   * Serve a task. `typeUri` is its full address. `handler({ doc, payload, signer, http: { origin, base, host, ip,
   * userAgent, https } })` returns the answer's payload (an object), or a whole answer it signed itself and marked
   * with SIGNED, or throws new Refusal(code, message, details). `origin` is the Origin header the sender's browser put on
   * the request ('' when there was none: wallets and servers send none); `base` is the room's own address. `signer` is
   * the DID whose proof verified; it is the document's issuer. `purposes`: the proof purposes this task takes
   * (a request is signed for authentication; something a person attests, an approval or a grant, for assertionMethod).
   * `record: false` for an answer that must not be kept or sent twice (it carries a secret): a redelivery gets 204.
   * `once: false` (default true) leaves the document's id out of the duplicate-id record: the task simply runs each
   * time it is sent, and the door never answers 202 or 204 for it or keeps its answer. Only for a task that changes
   * nothing, so running twice is harmless; it keeps such documents from filling the record.
   * `listed: false` keeps the address out of serves() and discovery (a type that is only ever refused here).
   * `precheck(doc)`: the task's own gate before any proof is read (and so before a signer's DID is fetched), after the
   * document is known to be fresh and for the room; it returns a Refusal to refuse, or nothing (OpenVTC's sign-in
   * refuses any signer but an Ed25519 did:key there, vti-oob-server T21).
   */
  register (typeUri, handler, { purposes = PURPOSES, record = true, listed = true, precheck = null, once = true } = {}) {
    if (typeof typeUri !== 'string' || !typeUri || typeUri.length > 300 || typeUri.includes('#')) throw new Error('a task is registered under its full type address, without a #fragment')
    if (typeof handler !== 'function') throw new Error(`${typeUri}: a task needs a handler`)
    if (!Array.isArray(purposes) || !purposes.length || !purposes.every((p) => SIGNING_RELATIONSHIPS.includes(p))) throw new Error(`${typeUri}: purposes are some of ${SIGNING_RELATIONSHIPS.join(', ')}`)
    if (this.handlers.has(typeUri)) throw new Error(`${typeUri} is already served`) // two parts of the room claiming one task is a mistake to see at start, not at the first document
    if (precheck !== null && typeof precheck !== 'function') throw new Error(`${typeUri}: precheck is a function`)
    this.handlers.set(typeUri, { handler, purposes, record, listed, precheck, once })
    return this
  }

  /** The addresses of the tasks served, sorted (what discovery lists). */
  serves () { return [...this.handlers].filter(([, t]) => t.listed).map(([uri]) => uri).sort() }

  /**
   * The DIDs the room answers to, each with what it signs as; the one it prefers first. Its did:webvh once that
   * DID's document carries the room's key (before that, an answer signed as it would not verify), and always its
   * did:key. join-route.js re-reads the room's DID log, at most every 30 seconds.
   */
  identities () {
    const id = this.ctx.identity, own = { did: id.did, seed: id.seed, verificationMethod: id.verificationMethod }
    const s = this.ctx.join?.status, webvh = this.ctx.join?.did
    const held = webvh && webvh !== id.did && s?.did === webvh && s.roomKey === ed25519Multikey(id.publicKey)
    return held ? [{ did: webvh, seed: id.seed, verificationMethod: `${webvh}#room` }, own] : [own]
  }

  #signed (doc, as) { return JSON.stringify(signTask(doc, as)) } // for authentication, as every answer is (sign.rs)

  #refuse (request, r, as) {
    const code = CODES.includes(r.code) || EXTENDED.test(String(r.code)) ? r.code : 'internalError' // a task that throws a code no reader knows has a bug: say so as one
    if (code !== r.code) console.error(`door: a task refused with ${JSON.stringify(String(r.code).slice(0, 80))}, which is not a Trust Task code`)
    const key = code in this.counts.refused || Object.keys(this.counts.refused).length < 64 ? code : 'other'
    this.counts.refused[key] = (this.counts.refused[key] ?? 0) + 1
    const until = typeof r.retryAfter === 'string' && Number.isFinite(Date.parse(r.retryAfter)) ? r.retryAfter : undefined // a time, or left out: a reader that holds an error to its schema drops one with a bad member
    const wait = until ? Math.ceil((Date.parse(until) - this.now()) / 1000) : 0
    const body = this.#signed(refusalTo(request, code === r.code ? { ...r, details: plain(r.details), retryAfter: until } : { code, message: OPAQUE }, as.did), as)
    return { status: statusFor(code), body, ...(wait > 0 ? { headers: { 'retry-after': String(wait) } } : {}) }
  }

  #unsupported (type) {
    const family = familyOf(type), served = family ? [...this.handlers.keys()].filter((uri) => familyOf(uri) === family).sort() : []
    // the two are told apart, as upstream does (reject.rs unsupported_type_or_version): a served family at another version names what is served
    if (served.length) return { code: 'unsupportedVersion', message: `unsupported version: ${type}. This room serves ${served.join(', ')}`, details: { requestedType: type, servedVersions: served } }
    return { code: 'unsupportedType', message: `unsupported type: ${type}`, details: { requestedType: type } }
  }

  #refusalOf (err, type) {
    if (err instanceof Refusal || err instanceof TaskError) return { code: err.code, message: err.message, details: err.details, retryable: err.retryable, retryAfter: err.retryAfter }
    console.error(`door: ${type} failed: ${err?.name ?? 'error'} ${String(err?.stack ?? '').split('\n').slice(1, 4).map((l) => l.trim()).join(' | ')}`) // where, never what: a message can carry someone's words
    return { code: 'internalError', message: OPAQUE }
  }

  /**
   * One document in, one answer out: { status, body, headers? }. `raw` is the body exactly as it arrived (a Buffer);
   * `body` is the signed answer as JSON text, '' for the answers that carry no document (202, 204, the per-signer 429), or the small JSON of the per-address 429.
   * `http`: { origin, base, host, ip, userAgent, https } for the task, and `bytes` / `cut` when the caller stopped reading
   * a body that was too large (the size is then what it counted, and "more than" that).
   */
  async handle (raw, http = {}) {
    const now = this.now(), c = this.counts
    c.received++
    await this.ctx.join?.refresh?.().catch(() => {})
    const mine = this.identities(), first = mine[0]
    const slow = (kind, seconds) => { c.rateLimited[kind]++; return { status: 429, body: '', headers: { 'retry-after': String(seconds) } } } // the signer's: empty, as upstream
    const slowAddress = (seconds) => { // the address's: the body and header OpenVTC's community gives; the source says 'room', a name no program is asked to match
      c.rateLimited.address++
      return { status: 429, body: JSON.stringify({ error: 'rate_limited', limiter: 'address', message: 'too many documents from this address; wait and send again', retry_after_secs: seconds }), headers: { 'retry-after': String(seconds), 'x-rate-limit-source': 'room' } }
    }

    // before the steps, the transport's own limit: so many documents a minute from one address
    const wait = this.addresses.take(String(http.ip || 'unknown'), now)
    if (wait) return slowAddress(wait)

    // 1. size, before anything in the body is parsed. The refusal answers no document: nothing in the body was believed.
    const bytes = Math.max(raw?.length ?? 0, Number(http.bytes) || 0)
    if (bytes > MAX_DOCUMENT_BYTES) return this.#refuse(null, { code: 'malformedRequest', message: `the document is ${http.cut ? 'more than ' : ''}${bytes} bytes; the room accepts at most ${MAX_DOCUMENT_BYTES}`, details: { maxBytes: MAX_DOCUMENT_BYTES } }, first)

    // 2. parse. The proof is checked over this value as it arrived, never over a copy the room rebuilt.
    let doc
    try { doc = JSON.parse((Buffer.isBuffer(raw) ? raw : Buffer.from(raw ?? '')).toString('utf8')) } catch { return this.#refuse(null, { code: 'malformedRequest', message: 'the body did not parse as a Trust Task document (JSON)' }, first) }

    // 3. its shape, that it is fresh, that it names the room; 4. its proof, by a key its issuer lists for the purpose
    const type = routed(doc?.type), task = typeof type === 'string' ? this.handlers.get(type) : undefined
    const as = mine.find((i) => sameDid(i.did, doc?.recipient)) ?? first // the room answers as the DID it was addressed by
    if (task?.precheck) { // the task's own gate, before the proof: only for a document that is fresh and for the room
      const basic = checkTask(doc, { me: mine.map((i) => i.did), now, horizonMs: HORIZON_MS })
      if (!basic.ok) return this.#refuse(doc, basic, as)
      const pre = task.precheck(doc)
      if (pre) return this.#refuse(doc, this.#refusalOf(pre, type), as)
    }
    let v
    try { v = await verifyTask(doc, { keyFor: (did, vm, purpose) => this.ctx.log.resolver.keyFor(did, vm, purpose), me: mine.map((i) => i.did), now, horizonMs: HORIZON_MS, purposes: task?.purposes ?? PURPOSES }) } catch (err) {
      if (!(err instanceof RangeError)) throw err
      v = { ok: false, code: 'malformedRequest', message: 'the document is nested too deeply to check its proof' } // thousands of levels inside 64 KiB: nothing honest looks like that
    }
    // A proof that is present and does not verify is proofInvalid (422) here; upstream answers permissionDenied (403)
    // for it, because its verifier's failure is an Unauthorized error (vti-trust-task-server/src/verify.rs, mapped by
    // reject.rs app_error_to_reject). The code is what a client reads; the room keeps the more exact one.
    if (!v.ok) return this.#refuse(doc, v, as)
    const signer = v.signer

    // 5. the signer is let in: after its proof, before its id is taken
    const hold = this.signers.take(signer, now)
    if (hold) return slow('signer', hold)

    // a type this door does not serve: refused here, with nothing kept for it
    if (!task) return this.#refuse(doc, this.#unsupported(type), as)

    // 6. the duplicate-id record, claimed before the task runs
    const claim = task.once ? this.accepted.claim(doc.id, toHex(sha256(canonicalize(doc))), acceptedUntil(doc, { horizonMs: HORIZON_MS }), now) : { fresh: null } // `once: false`: nothing is claimed, the task just runs
    if (claim.duplicate) { // never a failure: it already happened
      const r = claim.duplicate
      if (r.body) { c.duplicates.answeredAgain++; return { status: 200, body: r.body } }
      if (!r.done) { c.duplicates.stillRunning++; return { status: 202, body: '' } }
      c.duplicates.doneNothingKept++; return { status: 204, body: '' }
    }
    if (claim.conflict) return this.#refuse(doc, { code: 'idConflict', message: 'a different document with this id was already accepted: a new document needs a new id' }, as)
    if (claim.full) return this.#refuse(doc, { code: 'unavailable', message: 'the room is holding as many accepted documents as it can remember; send this again in a minute', retryAfter: instant(now + MINUTE) }, as) // closed, not forgetful

    // 7. the task; 8. its answer, signed. A refusal gives the id back, so a corrected document may use it.
    let body
    try {
      const said = await task.handler({ doc, payload: doc.payload, signer, http: { origin: String(http.origin ?? ''), base: String(http.base ?? ''), host: String(http.host ?? ''), ip: String(http.ip ?? ''), userAgent: String(http.userAgent ?? ''), https: Boolean(http.https) } }) ?? {} // a task with nothing to say acknowledges with {}
      if (said?.[SIGNED]) { // signed by the task itself: sent as it is, if it is this document's answer and the room's own
        if (said.type !== `${type}#response` || said.threadId !== responseTo(doc, {}, as.did).threadId || said.recipient !== doc.issuer || !said.proof || !mine.some((i) => sameDid(i.did, said.issuer))) throw new Error('a task signed an answer that is not the room\'s answer to this document')
        body = JSON.stringify(said)
      } else {
        const payload = plain(said)
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('a task answers with an object')
        body = this.#signed(responseTo({ ...doc, type }, payload, as.did), as)
      }
    } catch (err) {
      if (claim.fresh) this.accepted.release(doc.id, claim.fresh)
      return this.#refuse(doc, this.#refusalOf(err, type), as)
    }
    if (claim.fresh) this.accepted.completed(doc.id, claim.fresh, task.record ? body : null)
    c.answered++; c.answeredByType[type] = (c.answeredByType[type] ?? 0) + 1
    return { status: 200, body }
  }

  /** The room is restarting: the "try again soon" every other route gives, as a signed refusal a Trust Task client can read. */
  busy (seconds) {
    this.counts.received++
    return this.#refuse(null, { code: 'unavailable', message: `the room is restarting; send this again in ${seconds} seconds`, retryAfter: instant(this.now() + seconds * 1000) }, this.identities()[0])
  }

  /** For /api/info: where the door is, what it serves and takes, and what it did since the room started (counts only). */
  info (origin = this.ctx.config?.publicUrl || '') {
    const base = trustTaskBase(origin), s = this.ctx.join?.status
    return {
      address: `${base}/trust-tasks`, // the binding's path; clients that put /v1 after a bare origin reach the same door at /v1/trust-tasks
      answersTo: this.identities().map((i) => i.did), // a document names one of these as its recipient
      inDid: Boolean(base && s?.did && typeof s.trustTasks === 'string' && s.trustTasks.replace(/\/+$/, '') === base), // the room's DID document names this door (a TrustTaskHTTPS service at this origin)
      serves: this.serves(),
      accepts: { maxBytes: MAX_DOCUMENT_BYTES, maxAgeSeconds: ACCEPT_MS / 1000, clockSkewSeconds: SKEW_MS / 1000, expiryHorizonSeconds: HORIZON_MS / 1000, proof: 'eddsa-jcs-2022, by the document\'s issuer (did:key, did:peer:4 or did:webvh)' },
      limits: this.limits,
      counts: { ...this.counts, rememberedIds: this.accepted.records.size },
    }
  }
}

// ---- the tasks the door serves from the start

const slugOf = (uri) => (uri.startsWith(SPEC) ? uri.slice(SPEC.length) : uri) // a type outside the registry is matched whole
/** Discovery's pattern grammar, the same from 0.1 to 0.4: "*" is everything, "<prefix>/*" anything under the prefix, anything else one whole slug. A "*" elsewhere is a plain character. */
const matchSlug = (pattern, slug) => pattern === '*' || (pattern.endsWith('/*') ? slug.startsWith(pattern.slice(0, -1)) : pattern === slug)

/**
 * Discovery, ping and the room's own log lines. `ctx.acceptEntry(doc, { ip, origin })` is the one way a line gets
 * into the log; POST /api/entries uses it too, so the door and that route check, refuse and act alike.
 */
export function serveRoomTasks (door, ctx) {
  // Which tasks the room serves, and the window it accepts documents in. The window is read from the same numbers
  // the door checks with, so what is said cannot be wider than what is done. Request { patterns } (none: everything);
  // answer { supportedTypes, acceptanceWindow, frameworkVersion } (vti-common/src/trust_task/discovery.rs). Only to
  // callers the room can identify: the room refuses an unsigned document for every type, on purpose, which is
  // stricter than upstream (it accepts a proofless document unless the task's own policy needs a proof, and ping 0.2
  // does not: vti-trust-task-server/src/spine.rs, the "No proof" branch). The reason is at the top of this file: the
  // rate limit is per signer.
  const discovery = (horizon) => ({ payload }) => {
    const patterns = payload.patterns ?? []
    if (!Array.isArray(patterns) || !patterns.every((p) => typeof p === 'string')) throw new Refusal('malformedRequest', 'payload: patterns is a list of strings ("*", "<prefix>/*", or one whole slug such as messaging/ping/0.2)')
    // The discovery schema allows at most 16 patterns, each at least one character (taken from the schema as the review notes give it;
    // the schema bundle itself is not in the pinned sources). They protect the work: every pattern is tried against every
    // served type, so an unbounded list is unbounded work for a document that costs nothing to send. 300 characters
    // is the longest type address the door takes (register), so no honest pattern is longer.
    if (patterns.length > MAX_PATTERNS || patterns.some((p) => !p || p.length > 300)) throw new Refusal('malformedRequest', `payload: patterns holds at most ${MAX_PATTERNS} patterns, each 1 to 300 characters`, { maxPatterns: MAX_PATTERNS })
    const supportedTypes = door.serves().filter((uri) => !patterns.length || patterns.some((p) => matchSlug(p, slugOf(uri))))
    const acceptanceWindow = { maxAgeSeconds: Math.floor(ACCEPT_MS / 1000), clockSkewSeconds: Math.floor(SKEW_MS / 1000), ...(horizon ? { expiryHorizonSeconds: Math.floor(HORIZON_MS / 1000) } : {}) }
    return { supportedTypes, acceptanceWindow, frameworkVersion: FRAMEWORK_VERSION }
  }
  // discovery and ping change nothing: running twice is harmless, so they take no place in the duplicate-id record (once: false)
  door.register(DISCOVERY, discovery(true), { once: false })
  door.register(DISCOVERY_0_3, discovery(false), { once: false }) // 0.3 cannot state a horizon: it says the ten minutes and the slack, which is never wider than applied

  // "Are you there, and how do you take documents?" Request { nonce? }; answer { respondedAt, status, protocols,
  // nonce? } with the nonce given back as sent (vta-service/src/trust_tasks/messaging.rs). The room takes Trust
  // Tasks over https only; upstream's word for that way in is "rest".
  door.register(PING, ({ payload }) => ({ respondedAt: instant(door.now()), status: 'ok', protocols: ['rest'], ...(typeof payload.nonce === 'string' ? { nonce: payload.nonce } : {}) }), { once: false })

  // A line for the room's log, of any of the room's own types. The answer is the entry the room made (its place in
  // the chain, its hash, the room's witness signature), without the document, which the sender has. Types only the
  // room writes, private ones and wake links are refused in the log's own words, which say where they do go; they
  // are not listed. The answer to agent/host carries the new agent's connector link, a secret: it is not kept.
  const line = async ({ doc, http }) => {
    const { entry: { document, ...entry }, duplicate, hosted } = await ctx.acceptEntry(doc, { ip: http.ip, origin: http.base || undefined }) // the room's own address: the hosted agent's connector link is built from it
    return { entry, duplicate, ...(hosted ? { hosted } : {}) }
  }
  for (const [name, uri] of Object.entries(TYPES)) door.register(uri, line, { record: name !== 'host', listed: (WHO[name] === 'human' || WHO[name] === 'anyone') && name !== 'wake' })
  return door
}
