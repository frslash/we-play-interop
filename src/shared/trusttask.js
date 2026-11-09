// Standard Trust Task documents (https://trusttasks.org), exactly as the other projects here exchange them: OpenVTC's
// trust agent, trust community, room host and mediator, RLTP's shared-connect, and the DTG credentials flows. The
// room's own log lines are already this shape with the same proof; this file is the part that speaks to others:
// their type addresses, a named recipient, their freshness window, their reply and refusal documents.
//
// Every rule below was read from the code it has to match, at the commit the room's projects shelf names:
//   OpenVTC vti-trust-task-server/src/spine.rs (the order a document is checked in), reject.rs (refusals),
//   sign.rs (replies are signed), vti-oob-server/tests/flow.rs (a whole exchange), openvti-starter
//   packages/vta-client (what a JavaScript sender must do).
// Shared by the page, the server and agents: no Node-only and no browser-only APIs.
import { base58btc, canonicalize, concat, fromBase58btc, fromMultibase, sha256, toHex } from './crypto.js'
import { sign, verifySignature } from './proof.js'
import { uuid } from './types.js'

export const SPEC = 'https://trusttasks.org/spec/'
export const ERROR_PREFIX = `${SPEC}trust-task-error/` // match refusals by this prefix: servers in use write 0.1, 0.3, 0.5 and 0.6
export const ERROR_TYPE = `${ERROR_PREFIX}0.6`
export const NEXT_STEP_PREFIX = `${SPEC}trust-task-next-step/` // "not yet: someone has to act first" (an approval, a second device)
export const HTTPS_SERVICE = 'TrustTaskHTTPS' // the DID document service whose endpoint + /trust-tasks takes documents over https
export const DIDCOMM_ENVELOPE = 'https://trusttasks.org/binding/didcomm/0.1/envelope'
export const TSP_ENVELOPE = 'https://trusttasks.org/binding/tsp/0.1/envelope'

// What a limit protects, so a reader can tell when the number and the need have come apart:
// a document is accepted for ten minutes after it was written, with a minute of slack for two clocks that disagree
// (OpenVTC's window, VTI-OPS-024); longer only when it states its own expiry, and never past thirty days.
export const ACCEPT_MS = 10 * 60_000
export const SKEW_MS = 60_000
export const MAX_EXPIRY_MS = 30 * 24 * 3600_000
// One document is one request, not a file transfer: the same cap OpenVTC's door applies before it parses anything.
export const MAX_DOCUMENT_BYTES = 64 * 1024

/** The refusal codes every Trust Task consumer shares (a task may add its own as "<family>:<local>"). */
export const CODES = ['malformedRequest', 'unsupportedType', 'unsupportedVersion', 'unsupportedExtension', 'expired', 'proofRequired', 'proofInvalid', 'permissionDenied', 'wrongRecipient', 'identityMismatch', 'idConflict', 'cancelled', 'taskFailed', 'unavailable', 'indeterminate', 'internalError']
/**
 * The HTTP status that goes with a refusal over https (the https binding's table, section 4): a document that could
 * not be read is 400, "you may not" 403, another document under a used id 409, "try again later" 503, the service's
 * own fault 500. Every other refusal (a wrong recipient, a stale or unsigned document, an unknown type, a task's own
 * "<family>:<local>" code) is one flat 422, so a status line tells a prober nothing the signed code would not.
 * Read from OpenVTC's own tests of its door (vta-service/tests/it/trust_task_admin.rs, auth_flow.rs,
 * vtc-service/tests/it/join_requests.rs, relationships.rs) and the starter kit's mirror of the table
 * (templates/inbox-verifier/src/server.ts). The code in the document is what counts; the status is a courtesy.
 */
export const statusFor = (code) => ({ malformedRequest: 400, permissionDenied: 403, idConflict: 409, unavailable: 503, internalError: 500 }[String(code)] ?? 422)
/** What a refusal's `retryable` says when its maker does not: only "try again later" is worth trying again unchanged. */
export const retryableByDefault = (code) => ['unavailable', 'indeterminate', 'internalError'].includes(code)

const TYPE_RE = /^https:\/\/trusttasks\.org\/spec\/([a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*)\/(\d+\.\d+)(#response)?$/
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/
const DID = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/

/** `https://trusttasks.org/spec/<family>/<major.minor>` for a family such as "vtc/join-requests/submit". */
export const typeUri = (family, version) => `${SPEC}${family}/${version}`
/** { family, version, response } for a registry type address, or null when it is not one. */
export function parseType (uri) {
  const m = TYPE_RE.exec(String(uri ?? ''))
  return m ? { family: m[1], version: m[2], response: Boolean(m[3]) } : null
}
export const isError = (doc) => typeof doc?.type === 'string' && doc.type.startsWith(ERROR_PREFIX)
export const isNextStep = (doc) => typeof doc?.type === 'string' && doc.type.startsWith(NEXT_STEP_PREFIX)
export const isResponseTo = (doc, type) => doc?.type === `${type}#response`

/**
 * A time as other consumers accept it: whole seconds, never a fraction. A document whose issuedAt ends ".000Z" has
 * failed the trust agent's proof check (it wrote the time back without the zeros before checking the signature).
 */
export const instant = (t = Date.now()) => new Date(Math.floor(new Date(t).getTime() / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')

/** The did a proof's key belongs to, and that DID without a did:scid "src" hint (which names where to look, not who). */
export const signerOf = (doc) => String(doc?.proof?.verificationMethod ?? '').split('#')[0]
export const sameDid = (a, b) => typeof a === 'string' && typeof b === 'string' && a.split('?')[0] === b.split('?')[0]

/**
 * An unsigned document. A member that is not set is left out, never written as null (a consumer that reads a null
 * recipient refuses the document). `recipient` is the DID of the service it is for: OpenVTC refuses any document
 * not addressed to it by name.
 */
export function taskDocument ({ type, issuer, recipient, payload = {}, id = `urn:uuid:${uuid()}`, issuedAt = instant(), expiresAt, threadId, parentThreadId, ceremony, ext }) {
  const doc = { id, type, issuer }
  if (recipient) doc.recipient = recipient
  if (threadId) doc.threadId = threadId
  if (parentThreadId) doc.parentThreadId = parentThreadId
  if (ceremony) doc.ceremony = ceremony
  doc.issuedAt = issuedAt
  if (expiresAt) doc.expiresAt = expiresAt
  if (ext) doc.ext = ext
  doc.payload = payload
  return doc
}

/**
 * Sign a document with an identity ({ did, seed, verificationMethod }). Requests are signed for "authentication";
 * something a person attests (an approval, a grant, a credential) for "assertionMethod". Everything the proof
 * covers must be set before this is called: the proof is over the document as it stands.
 */
export function signTask (doc, identity, { purpose = 'authentication', verificationMethod = identity.verificationMethod } = {}) {
  if (doc.issuer !== identity.did) throw new Error('a document is signed by its issuer')
  return sign(doc, { seed: identity.seed, verificationMethod, created: doc.issuedAt, proofPurpose: purpose })
}
/** Build and sign in one step. */
export const signedTask = (identity, fields, opts) => signTask(taskDocument({ issuer: identity.did, ...fields }), identity, opts)

const no = (code, message, details) => ({ ok: false, code, message, ...(details ? { details } : {}) })

/**
 * The last moment a consumer still accepts a document (ms): ten minutes and the slack after it was written, or its
 * own `expiresAt` and the slack when it states one. A stated expiry further out than the horizon counts as the
 * horizon (OpenVTC applies it so, it does not refuse: vti-common/src/trust_task/acceptance.rs). It is also how long
 * the record of an accepted id must be kept: a record dropped sooner lets a replay run twice.
 */
export function acceptedUntil (doc, { horizonMs = MAX_EXPIRY_MS } = {}) {
  const at = Date.parse(doc.issuedAt)
  return (doc.expiresAt === undefined ? at + ACCEPT_MS : Math.min(Date.parse(doc.expiresAt), at + horizonMs)) + SKEW_MS
}

/**
 * Everything about a received document that needs no key: its shape, that it is fresh, that it has not run out, and
 * that it is addressed to `me` (one DID, or a list when a service answers to more than one). Returns { ok: true } or
 * { ok: false, code, message, details? } with a shared code. `bytes` is the size of the document as it arrived
 * (checked first, before anything is believed). The codes are the ones OpenVTC's door gives (its own tests pin
 * them): `expired` only for a document that was once good; one that never was (no issuedAt, written in the future,
 * an expiry at or before its own issuedAt, no recipient) is `malformedRequest`, because waiting will not fix it.
 */
export function checkTask (doc, { me, now = Date.now(), bytes, maxBytes = MAX_DOCUMENT_BYTES, requireRecipient = true, horizonMs = MAX_EXPIRY_MS } = {}) {
  if (bytes !== undefined && bytes > maxBytes) return no('malformedRequest', `the document is ${bytes} bytes; at most ${maxBytes} are accepted`, { maxBytes })
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return no('malformedRequest', 'a Trust Task document is a JSON object')
  if (typeof doc.id !== 'string' || !doc.id || doc.id.length > 200) return no('malformedRequest', 'id: a URI naming this document (for example urn:uuid:…)')
  if (typeof doc.type !== 'string' || doc.type.length > 300) return no('malformedRequest', 'type: the task\'s address')
  if (doc.issuer !== undefined && doc.issuer !== null && !DID.test(String(doc.issuer))) return no('malformedRequest', 'issuer: a DID')
  if (!doc.payload || typeof doc.payload !== 'object' || Array.isArray(doc.payload)) return no('malformedRequest', 'payload: a JSON object')
  if (typeof doc.issuedAt !== 'string' || !RFC3339.test(doc.issuedAt)) return no('malformedRequest', 'issuedAt: when it was written, as an RFC 3339 time (it is required)')
  const at = Date.parse(doc.issuedAt)
  if (!Number.isFinite(at)) return no('malformedRequest', 'issuedAt: not a real time') // month 13 has the right shape and no meaning; left in, it would never read as old
  if (at > now + SKEW_MS) return no('malformedRequest', 'issuedAt is in the future: check the clock and write it again')
  if (doc.expiresAt !== undefined) {
    if (typeof doc.expiresAt !== 'string' || !RFC3339.test(doc.expiresAt) || !Number.isFinite(Date.parse(doc.expiresAt))) return no('malformedRequest', 'expiresAt: an RFC 3339 time')
    if (Date.parse(doc.expiresAt) <= at) return no('malformedRequest', 'expiresAt is not after issuedAt: this document was never good')
    if (now > acceptedUntil(doc, { horizonMs })) return no('expired', 'this document has run out (its expiresAt has passed, or it is older than a stated expiry is honoured for)')
  } else if (now > acceptedUntil(doc)) return no('expired', 'this document is older than ten minutes: write a fresh one')
  const mine = me ? [].concat(me) : []
  if (mine.length) {
    if (doc.recipient === undefined || doc.recipient === null) { if (requireRecipient) return no('malformedRequest', `recipient: the DID this document is for (${mine[0]})`) } else if (!mine.some((d) => sameDid(doc.recipient, d))) return no('wrongRecipient', `this document is addressed to ${String(doc.recipient).slice(0, 200)}, not to ${mine[0]}`)
  }
  return { ok: true }
}

/**
 * The whole check of a received document: checkTask, then its proof. `keyFor(did, verificationMethod, purpose)`
 * gives the Ed25519 key that DID lists for that purpose (the room's resolver). Returns { ok: true, signer } or a
 * refusal. The proof's key must belong to the document's issuer (Trust Tasks §4.7); `purpose` names the purposes
 * accepted here (a request: authentication; an attestation: assertionMethod).
 */
export async function verifyTask (doc, { keyFor, me, now, bytes, maxBytes, requireRecipient, horizonMs, purposes = ['authentication', 'assertionMethod'] } = {}) {
  const basic = checkTask(doc, { me, now, bytes, maxBytes, requireRecipient, horizonMs })
  if (!basic.ok) return basic
  const p = doc.proof
  if (!p || typeof p !== 'object' || Array.isArray(p)) return no('proofRequired', 'this document is not signed (proof is missing)')
  if (!purposes.includes(p.proofPurpose)) return no('proofInvalid', `the proof's purpose must be ${purposes.join(' or ')}`)
  const signer = signerOf(doc)
  if (!DID.test(signer) || !sameDid(signer, doc.issuer)) return no('proofInvalid', 'the proof\'s verificationMethod does not belong to the document\'s issuer')
  let key
  try { key = await keyFor(signer, p.verificationMethod, p.proofPurpose) } catch (e) { return no('proofInvalid', 'the signing key could not be found for that DID and purpose') } // one answer, so resolving a DID tells a caller nothing
  if (!key) return no('proofInvalid', 'the signing key could not be found for that DID and purpose')
  const sig = verifySignature(doc, key)
  return sig.ok ? { ok: true, signer } : no('proofInvalid', 'the signature does not verify')
}

/** A short string, or nothing: what a reply may copy from a document it has not (or not fully) checked. */
const short = (v, max) => (typeof v === 'string' && v && v.length <= max ? v : undefined)
/** The thread a reply belongs to: the request's own thread, else the request itself. */
const threadOf = (request) => short(request?.threadId, 200) ?? short(request?.id, 200)

/**
 * What an answer carries forward from its request besides the thread: `parentThreadId` and `ceremony`, each only when
 * it is a short string (nothing unchecked is copied in, so a long or odd value is left out). Upstream carries both
 * from the request into a routed refusal so that a rejection stays inside the enactment it belonged to (Trust Tasks
 * SPEC section 7.1; vta-service/src/trust_tasks/helpers.rs, the comment in malformed_request_response, which says an
 * unrouted refusal has no request to carry them from and that `reject_with` copies them for routed ones).
 */
const carried = (request) => ({ parentThreadId: short(request?.parentThreadId, 200), ceremony: short(request?.ceremony, 200) })

/** The reply to a request: its type with "#response", addressed back to whoever asked, in the request's thread (and its parent thread and ceremony). */
export function responseTo (request, payload, issuer) {
  return taskDocument({ type: `${request.type}#response`, issuer, recipient: request.issuer, threadId: threadOf(request), ...carried(request), payload })
}
/**
 * A refusal document for a request (or for something that could not be read at all: then it names no recipient).
 * Its payload has the members of the registry's trust-task-error and no others: `code` and `retryable` always
 * (a reader that follows the schema, RLTP's for one, drops an error without a boolean `retryable`), `message` (at
 * most 1024 characters), and when there is something to say `retryAfter` (an RFC 3339 time), `details` (small) and
 * `inResponseTo` (the type and id of the document refused).
 */
export function refusalTo (request, { code, message, details, retryable = retryableByDefault(code), retryAfter }, issuer) {
  const d = details && typeof details === 'object' && !Array.isArray(details) && Object.keys(details).length <= 16 && canonicalize(details).length <= 4096 ? details : undefined // a refusal stays small
  const answers = short(request?.id, 200) && short(request?.type, 300) ? { typeUri: request.type, id: request.id } : null
  const payload = { code, retryable: Boolean(retryable), message: [...String(message ?? '')].slice(0, 1024).join(''), ...(retryAfter ? { retryAfter } : {}), ...(d ? { details: d } : {}), ...(answers ? { inResponseTo: answers } : {}) }
  return taskDocument({ type: ERROR_TYPE, issuer, ...(typeof request?.issuer === 'string' && DID.test(request.issuer) ? { recipient: request.issuer } : {}), ...(threadOf(request) ? { threadId: threadOf(request) } : {}), ...carried(request), payload })
}

/** What an answer is: { kind: 'response' | 'error' | 'next-step' | 'other', payload, code? }. Go by its type, never by the HTTP status. */
export function classify (reply, requestType) {
  if (isError(reply)) return { kind: 'error', code: reply.payload?.code ?? 'internalError', message: reply.payload?.message ?? '', details: reply.payload?.details, payload: reply.payload }
  if (isNextStep(reply)) return { kind: 'next-step', payload: reply.payload }
  if (!requestType || isResponseTo(reply, requestType)) return { kind: 'response', payload: reply.payload }
  return { kind: 'other', payload: reply?.payload }
}

/**
 * Send one signed document to a service's https door and read its answer. `base` is the endpoint of the service's
 * TrustTaskHTTPS (or VTCRest / VTARest) entry in its DID document, for example https://vtc.example/v1; the door is
 * base + /trust-tasks. No bearer token: the document's own proof is the authentication (a trust agent session adds
 * `bearer`). A `Trust-Task: <type>` header names the task, as OpenVTC's own client sends it on every call
 * (vta-sdk/src/auth_light.rs TRUST_TASK_HEADER): its community gates routes on it and answers 400 without it, and
 * its trust agent charges a rate limit by it before reading the body; the document's `type` still decides, and the
 * room's door ignores the header. `trustTaskHeader: false` leaves it out (a browser sending to another origin whose
 * CORS does not allow it). `fetch` must be one that refuses private addresses when `base` came from someone else
 * (the room's publicFetch).
 */
export async function postTask (base, doc, { fetch: f = globalThis.fetch, bearer, timeoutMs = 60_000, trustTaskHeader = true } = {}) {
  const url = `${String(base).replace(/\/+$/, '')}/trust-tasks`
  const type = typeof doc?.type === 'string' && /^[\x21-\x7e]{1,300}$/.test(doc.type) ? doc.type : null // a header value: printable, one line
  const res = await f(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', ...(trustTaskHeader && type ? { 'trust-task': type } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(doc), signal: AbortSignal.timeout(timeoutMs) })
  const text = await res.text(), wait = res.headers.get('retry-after')
  const later = wait ? { retryAfter: wait } : {} // a 429 or 503 may carry a body too (a signed refusal): the header still says how long to wait
  if (!text) return { status: res.status, reply: null, kind: res.status === 202 ? 'in-flight' : res.status === 204 ? 'done-no-body' : res.status === 429 ? 'slow-down' : 'empty', retryAfter: wait }
  let reply; try { reply = JSON.parse(text) } catch { return { status: res.status, reply: null, kind: 'not-json', text: text.slice(0, 300), ...later } }
  return { status: res.status, reply, ...classify(reply, doc.type), ...later }
}

/** The service endpoint of one type in a DID document (matched by `type`, never by the entry's #id), as a string. */
export function serviceEndpoint (didDocument, type) {
  for (const s of didDocument?.service ?? []) {
    const types = Array.isArray(s.type) ? s.type : [s.type]
    if (!types.includes(type)) continue
    const e = Array.isArray(s.serviceEndpoint) ? s.serviceEndpoint[0] : s.serviceEndpoint
    const uri = typeof e === 'string' ? e : e?.uri
    if (typeof uri === 'string') return uri
  }
  return null
}

/** "z" + base58btc(0x12 0x20 ‖ SHA-256(JCS(value))): the digest form these projects bind one document to another with. */
export const multihashOf = (value) => 'z' + base58btc(concat(new Uint8Array([0x12, 0x20]), sha256(canonicalize(value))))
/** True when two such digests name the same bytes ("z" base58btc or "u" base64url). */
export function sameDigest (a, b) {
  const raw = (s) => {
    if (typeof s !== 'string' || s.length < 2) return null
    try {
      if (s[0] === 'z') return fromBase58btc(s.slice(1))
      if (s[0] === 'u') return Uint8Array.from(atob(s.slice(1).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
    } catch {}
    return null
  }
  const x = raw(a), y = raw(b)
  return Boolean(x && y && toHex(x) === toHex(y))
}

/**
 * The 32-byte Ed25519 seed inside a private key written as these projects write it: "z" + base58btc of either the
 * bare seed, or the seed behind the two bytes 0x80 0x26 (the multicodec mark for an Ed25519 private key).
 */
export function seedFromPrivateMultibase (s) {
  const b = fromMultibase(String(s).trim())
  if (b.length === 32) return b
  if (b.length === 34 && b[0] === 0x80 && b[1] === 0x26) return b.slice(2)
  throw new Error('not an Ed25519 private key in multibase form')
}
