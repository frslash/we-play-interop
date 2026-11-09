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
/** The HTTP status that goes with a refusal over https. */
export const statusFor = (code) => ({ malformedRequest: 400, unsupportedType: 404, unsupportedVersion: 404, unsupportedExtension: 400, expired: 400, proofRequired: 401, proofInvalid: 401, permissionDenied: 403, wrongRecipient: 400, identityMismatch: 401, idConflict: 409, cancelled: 409, unavailable: 503, indeterminate: 503, internalError: 500 }[String(code).includes(':') ? 'taskFailed' : code] ?? 422)

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
export function taskDocument ({ type, issuer, recipient, payload = {}, id = `urn:uuid:${uuid()}`, issuedAt = instant(), expiresAt, threadId, parentThreadId, ext }) {
  const doc = { id, type, issuer }
  if (recipient) doc.recipient = recipient
  if (threadId) doc.threadId = threadId
  if (parentThreadId) doc.parentThreadId = parentThreadId
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
 * Everything about a received document that needs no key: its shape, that it is fresh, that it has not run out, and
 * that it is addressed to `me`. Returns { ok: true } or { ok: false, code, message, details? } with a shared code.
 * `bytes` is the size of the document as it arrived (checked first, before anything is believed).
 */
export function checkTask (doc, { me, now = Date.now(), bytes, maxBytes = MAX_DOCUMENT_BYTES, requireRecipient = true } = {}) {
  if (bytes !== undefined && bytes > maxBytes) return no('malformedRequest', `the document is ${bytes} bytes; at most ${maxBytes} are accepted`, { maxBytes })
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return no('malformedRequest', 'a Trust Task document is a JSON object')
  if (typeof doc.id !== 'string' || !doc.id || doc.id.length > 200) return no('malformedRequest', 'id: a URI naming this document (for example urn:uuid:…)')
  if (typeof doc.type !== 'string' || doc.type.length > 300) return no('malformedRequest', 'type: the task\'s address')
  if (doc.issuer !== undefined && doc.issuer !== null && !DID.test(String(doc.issuer))) return no('malformedRequest', 'issuer: a DID')
  if (!doc.payload || typeof doc.payload !== 'object' || Array.isArray(doc.payload)) return no('malformedRequest', 'payload: a JSON object')
  if (typeof doc.issuedAt !== 'string' || !RFC3339.test(doc.issuedAt)) return no('malformedRequest', 'issuedAt: when it was written, as an RFC 3339 time (it is required)')
  const at = Date.parse(doc.issuedAt)
  if (at > now + SKEW_MS) return no('expired', 'issuedAt is in the future: check the clock')
  if (doc.expiresAt !== undefined) {
    if (typeof doc.expiresAt !== 'string' || !RFC3339.test(doc.expiresAt)) return no('malformedRequest', 'expiresAt: an RFC 3339 time')
    const until = Date.parse(doc.expiresAt)
    if (until + SKEW_MS < now) return no('expired', 'this document has run out (expiresAt has passed)')
    if (until - at > MAX_EXPIRY_MS) return no('expired', 'a document may be good for thirty days at most')
  } else if (now - at > ACCEPT_MS + SKEW_MS) return no('expired', 'this document is older than ten minutes: write a fresh one')
  if (me) {
    if (doc.recipient === undefined || doc.recipient === null) { if (requireRecipient) return no('wrongRecipient', `recipient: the DID this document is for (${me})`) } else if (!sameDid(doc.recipient, me)) return no('wrongRecipient', `this document is addressed to ${String(doc.recipient).slice(0, 200)}, not to ${me}`)
  }
  return { ok: true }
}

/**
 * The whole check of a received document: checkTask, then its proof. `keyFor(did, verificationMethod, purpose)`
 * gives the Ed25519 key that DID lists for that purpose (the room's resolver). Returns { ok: true, signer } or a
 * refusal. The proof's key must belong to the document's issuer (Trust Tasks §4.7); `purpose` names the purposes
 * accepted here (a request: authentication; an attestation: assertionMethod).
 */
export async function verifyTask (doc, { keyFor, me, now, bytes, maxBytes, requireRecipient, purposes = ['authentication', 'assertionMethod'] } = {}) {
  const basic = checkTask(doc, { me, now, bytes, maxBytes, requireRecipient })
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

/** The reply to a request: its type with "#response", addressed back to whoever asked, in the request's thread. */
export function responseTo (request, payload, issuer) {
  return taskDocument({ type: `${request.type}#response`, issuer, recipient: request.issuer, threadId: request.threadId ?? request.id, payload })
}
/** A refusal document for a request (or for something that could not be read at all: then it names no recipient). */
export function refusalTo (request, { code, message, details }, issuer) {
  const d = details && typeof details === 'object' && Object.keys(details).length <= 16 && canonicalize(details).length <= 4096 ? details : undefined // a refusal stays small
  return taskDocument({ type: ERROR_TYPE, issuer, ...(typeof request?.issuer === 'string' && DID.test(request.issuer) ? { recipient: request.issuer } : {}), ...(typeof request?.id === 'string' ? { threadId: request.threadId ?? request.id } : {}), payload: { code, message, ...(d ? { details: d } : {}) } })
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
 * base + /trust-tasks. No bearer token and no extra header: the document's own proof is the authentication (a
 * trust agent session adds `bearer`). `fetch` must be one that refuses private addresses when `base` came from
 * someone else (the room's publicFetch).
 */
export async function postTask (base, doc, { fetch: f = globalThis.fetch, bearer, timeoutMs = 60_000 } = {}) {
  const url = `${String(base).replace(/\/+$/, '')}/trust-tasks`
  const res = await f(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(doc), signal: AbortSignal.timeout(timeoutMs) })
  const text = await res.text()
  if (!text) return { status: res.status, reply: null, kind: res.status === 202 ? 'in-flight' : res.status === 204 ? 'done-no-body' : res.status === 429 ? 'slow-down' : 'empty', retryAfter: res.headers.get('retry-after') }
  let reply; try { reply = JSON.parse(text) } catch { return { status: res.status, reply: null, kind: 'not-json', text: text.slice(0, 300) } }
  return { status: res.status, reply, ...classify(reply, doc.type) }
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
