// A person's trust agent (OpenVTC's "VTA"), as the agent bridge reaches it: sign in, then ask it to do the things
// only it can do for a sealed room, because it holds the person's keys and their MLS group state. This file runs on
// the person's own machine, beside the agent's key. Nothing here is ever sent to the room's server.
//
// Read from OpenVTC at the commit the room builds from (c6964c4), and from the openvti starter kit's client:
//   sign-in      vti-specs-core/trust-tasks/auth/{challenge/0.1,authenticate/0.3,refresh/0.2}.bundle.json,
//                vta-sdk/src/auth_di.rs (what the reference client sends), vti-common/src/auth/extractor.rs (401)
//   rooms keys   vta-service/src/trust_tasks/mod.rs (which versions are served), room_act.rs (act, seal),
//                room_group.rs (open, commit, backfill), room_label.rs (list), room_keys.rs (present),
//                vti-specs-rooms/trust-tasks/rooms/keys/*/*.bundle.json (the members of each request and answer)
//   member tasks keys/sign-document 0.1, keys/list 0.2 (vti-specs-core/trust-tasks/keys/), rooms/keys/{key-package 0.2, welcome 0.1}
//                (vti-specs-rooms), vault/credentials/{receive 0.1, query 0.1, get 0.2} (vti-specs-core), served in vta-service/src/
//                trust_tasks/{mod.rs, keys.rs, room_group.rs, room_act.rs}; signing rules in operations/keys.rs sign_document
//   the client   openvti-starter packages/vta-client/src/client.ts (Apache-2.0; ideas only, no code copied)
// Versions sent: rooms/keys/act 0.12 (then 0.8, what the kit's older trust agent serves), seal 0.3 (then 0.2),
// open 0.2, list 0.2, commit 0.1, present 0.2, backfill 0.2.
import { readFileSync, statSync } from 'node:fs'
import { keyFromDidDocument } from '../src/shared/chain.js'
import { canonicalize, fromMultibase, toHex } from '../src/shared/crypto.js'
import { newIdentity } from '../src/shared/did.js'
import { verifySignature } from '../src/shared/proof.js'
import { createResolver } from '../src/server/resolver.js'
import { postTask, seedFromPrivateMultibase, signTask, taskDocument, typeUri } from '../src/shared/trusttask.js'

// What these limits protect: an agent is waiting on the tool call that led here. A door that says "slow down" is
// obeyed, but only for as long as that agent can reasonably wait; past it the call fails and names the wait.
const SLOW_DOWN_TURNS = 2
const MAX_WAIT_MS = 15_000
export const MEMBER_EXT = 'org.openvtc.rooms' // vta-service/src/operations/room_member.rs MEMBER_EXT: names which member, when a caller acts as several

/** A refusal from a trust agent or a room host: the shared code, plain words, and nothing that was sent. */
export class VtiError extends Error {
  constructor (code, message, { details, status, from, retryAfterMs } = {}) {
    super(message || code); this.name = 'VtiError'; this.code = code; this.from = from
    if (details !== undefined) this.details = details
    if (status !== undefined) this.status = status
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs
  }
}
const b64u = (bytes) => Buffer.from(bytes).toString('base64url')
const unb64u = (s) => new Uint8Array(Buffer.from(String(s), 'base64url'))
const retryMs = (h) => { if (!h) return undefined; const s = Number(h); if (Number.isFinite(s)) return Math.max(0, s * 1000); const t = Date.parse(h); return Number.isNaN(t) ? undefined : Math.max(0, t - Date.now()) }
// What this protects: a trust agent whose key list never ends must not keep this bridge asking for ever. 64 pages is
// far more keys than one person's trust agent holds for a DID; past it the list is refused, not guessed at.
const MAX_PAGES = 64
const bad = (message, code = 'malformedRequest') => new VtiError(code, message, { from: 'this bridge' }) // a refusal made here, before anything was sent or after an answer failed a check
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
/** The 32 raw bytes of an Ed25519 public key as a trust agent lists it: multibase base58btc, multicodec-prefixed (0xed01) or bare. Length decides, as vta-sdk/src/did_key.rs does. */
function listedKey (mb) {
  const b = fromMultibase(mb)
  return b.length === 34 && b[0] === 0xed && b[1] === 0x01 ? b.slice(2) : b.length === 32 ? b : null
}
/** The DID a document names as its signer: `issuer` (a DID or { id }) or `controller` (a DID or an array of one), as sign-document 0.1 reads it. */
function signerOfDocument (doc) {
  const named = doc.issuer !== undefined ? (isObj(doc.issuer) ? doc.issuer.id : doc.issuer) : Array.isArray(doc.controller) && doc.controller.length === 1 ? doc.controller[0] : doc.controller
  return typeof named === 'string' && /^did:[a-z0-9]+:[^\s#?]+$/.test(named) ? named : null
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * One document to one door. "Slow down" (HTTP 429) and "still working on that one" (202) are answered by waiting
 * for the time the door names and sending the same bytes again: the same id, so a write is never done twice.
 */
export async function sendTask (base, doc, { fetch: f = globalThis.fetch, bearer, sleep = pause, counts } = {}) {
  for (let turn = 0; ; turn++) {
    const r = await postTask(base, doc, { bearer, fetch: f }) // postTask keeps Retry-After, with a body or without
    if (r.status !== 429 && r.kind !== 'in-flight') return r
    const ms = retryMs(r.retryAfter) ?? 1000
    if (counts) counts.slowDowns++
    if (turn >= SLOW_DOWN_TURNS || ms > MAX_WAIT_MS) return { ...r, kind: 'slow-down', retryAfterMs: ms }
    await sleep(ms)
  }
}
/** The answer's payload, or a VtiError that says who refused and why. */
export function unwrap (r, from) {
  if (r.kind === 'response') return r.payload ?? {}
  if (r.kind === 'error') throw new VtiError(r.code, r.message, { details: r.details, status: r.status, from })
  if (r.kind === 'slow-down') throw new VtiError('unavailable', `${from} asked to slow down; try again in ${Math.ceil((r.retryAfterMs ?? 1000) / 1000)} s`, { status: r.status, from, retryAfterMs: r.retryAfterMs })
  throw new VtiError('indeterminate', `${from} gave no answer that can be read (HTTP ${r.status})`, { status: r.status, from })
}

/**
 * The credential a trust agent hands an app (the starter kit's VTA_CREDENTIAL): base64url of the JSON
 * { did, privateKeyMultibase, vtaDid, vtaUrl? }. Read from the environment, or from a file only its owner can read.
 * It is a key: it is never logged, never put in an error, and never leaves this machine.
 */
export function readCredential (env = process.env) {
  let text = env.VTA_CREDENTIAL
  if (!text && env.VTA_CREDENTIAL_FILE) {
    const mode = statSync(env.VTA_CREDENTIAL_FILE).mode
    if (process.platform !== 'win32' && (mode & 0o077)) throw new Error('VTA_CREDENTIAL_FILE can be read by other accounts on this machine. Run: chmod 600 on that file, then start again.')
    text = readFileSync(env.VTA_CREDENTIAL_FILE, 'utf8')
  }
  return text ? decodeCredential(text) : null
}
export function decodeCredential (text) {
  let c
  try { c = JSON.parse(Buffer.from(String(text).trim(), 'base64url').toString('utf8')) } catch { throw new Error('VTA_CREDENTIAL is not readable: it is the one long line a trust agent hands out (base64url of a small JSON object)') }
  if (typeof c?.privateKeyMultibase !== 'string' || typeof c?.vtaDid !== 'string' || !c.vtaDid.startsWith('did:')) throw new Error('VTA_CREDENTIAL lacks its key or the trust agent\'s DID (privateKeyMultibase, vtaDid)')
  let id
  try { id = newIdentity(seedFromPrivateMultibase(c.privateKeyMultibase)) } catch { throw new Error('VTA_CREDENTIAL holds a key that is not Ed25519') }
  if (c.did && c.did !== id.did) throw new Error('VTA_CREDENTIAL names a DID its key does not belong to')
  return { did: id.did, seed: id.seed, verificationMethod: id.verificationMethod, vtaDid: c.vtaDid, ...(typeof c.vtaUrl === 'string' ? { vtaUrl: c.vtaUrl } : {}) }
}

export class Vta {
  /** `credential` as readCredential gives it; `url` the trust agent's address (default: the one in the credential). */
  constructor ({ credential, url = credential?.vtaUrl, fetch: f = globalThis.fetch, sleep = pause, resolver = createResolver() } = {}) {
    if (!credential) throw new Error('no trust agent credential')
    if (!/^https?:\/\//.test(String(url ?? ''))) throw new Error('the trust agent\'s address is missing: set VTA_URL, or use a credential that carries vtaUrl')
    this.me = credential; this.did = credential.did; this.vtaDid = credential.vtaDid; this.url = String(url).replace(/\/+$/, '')
    this.fetch = f; this.sleep = sleep; this.token = null; this.refreshToken = null
    this.resolver = resolver; this.keyIds = new Map() // `${did}|${purpose}` -> the trust agent's keyId for the key that DID's document lists under that purpose
    this.stepped = new Map() // family -> the version this trust agent answered at
    this.counts = { calls: 0, refused: 0, signIns: 0, refreshes: 0, slowDowns: 0, signed: 0, keyPackages: 0, welcomes: 0, credentialsStored: 0 } // counts and outcomes only, never content
    this.last = null // { ok, family, code?, at }
  }

  #doc (family, version, payload, signed = true) {
    const doc = taskDocument({ type: typeUri(family, version), issuer: this.did, recipient: this.vtaDid, payload })
    return signed ? signTask(doc, this.me) : doc
  }

  async #post (doc, bearer) { this.counts.calls++; return sendTask(this.url, doc, { fetch: this.fetch, sleep: this.sleep, counts: this.counts, ...(bearer ? { bearer } : {}) }) }

  /** Sign in: ask for a challenge, answer it signed with the credential's key, keep the session's two tokens. */
  async signIn () {
    const ch = unwrap(await this.#post(this.#doc('auth/challenge', '0.1', { subject: this.did })), 'the trust agent')
    const got = unwrap(await this.#post(this.#doc('auth/authenticate', '0.3', { challenge: ch.challenge, sessionId: ch.sessionId, scope: [] })), 'the trust agent')
    this.#keep(got); this.counts.signIns++
  }

  #keep (got) {
    if (typeof got?.tokens?.accessToken !== 'string') throw new VtiError('indeterminate', 'the trust agent signed in without giving a token', { from: 'the trust agent' })
    this.token = got.tokens.accessToken; this.refreshToken = got.tokens.refreshToken ?? null
  }

  /** A refused token: swap the refresh token for a new pair (it is the credential there, so that document is unsigned); failing that, sign in again. */
  async renew () {
    const old = this.refreshToken; this.token = null; this.refreshToken = null
    if (old) {
      try { this.#keep(unwrap(await this.#post(this.#doc('auth/refresh', '0.2', { refreshToken: old }, false)), 'the trust agent')); this.counts.refreshes++; return } catch {}
    }
    await this.signIn()
  }

  /**
   * One task, by family and version, with the session's token. A refused token is renewed once and the task sent
   * again; a second refusal is the answer. Returns the response's payload or throws a VtiError.
   */
  async call (family, version, payload = {}, { okCodes = [] } = {}) {
    try {
      if (!this.token) await this.signIn()
      let r = await this.#post(this.#doc(family, version, payload), this.token)
      if (r.status === 401) { await this.renew(); r = await this.#post(this.#doc(family, version, payload), this.token) }
      const out = unwrap(r, 'the trust agent')
      this.last = { ok: true, family, at: Date.now() }
      return out
    } catch (e) {
      if (okCodes.includes(e.code)) { this.last = { ok: true, family, code: e.code, at: Date.now() }; throw e } // a refusal the caller reads as success (a welcome already used): an outcome, not a failure
      this.counts.refused++; this.last = { ok: false, family, code: e.code ?? 'unreachable', at: Date.now() }; throw e
    } // the outcome and its code are kept; what was sent is not
  }

  /** The same task at the newest version this trust agent serves: it says which it serves when it refuses one. */
  async #newest (family, versions, payload) {
    const from = this.stepped.get(family)
    for (const v of from ? [from] : versions) {
      try { const out = await this.call(family, v, payload); this.stepped.set(family, v); return out } catch (e) {
        if (from || v === versions.at(-1) || !['unsupportedVersion', 'unsupportedType'].includes(e.code)) throw e
      }
    }
  }

  /** The rooms this trust agent holds keys for, as members this credential may act as: [{ roomId, member, epoch, earliestReadableEpoch }]. */
  async list () { return ((await this.call('rooms/keys/list', '0.2', {})).rooms ?? []).filter((r) => typeof r?.roomId === 'string' && typeof r?.member === 'string') }

  /**
   * Complete a request to a room's host as the member: the trust agent sets the issuer, puts in the member's own
   * authority narrowed to the one action that request needs, and signs with the member's key. The caller sends what
   * comes back. `document` is unsigned, addressed to the host, written now, and carries no presentation of its own.
   */
  async act (document) {
    const out = await this.#newest('rooms/keys/act', ['0.12', '0.8'], { document })
    if (!out?.document || typeof out.document !== 'object') throw new VtiError('indeterminate', 'the trust agent completed nothing', { from: 'the trust agent' })
    return out // { principal, document, expiresAt? }
  }
  /** True once this trust agent has answered rooms/keys/act at 0.8 only: its table stops at the older record tasks. */
  get olderTable () { return this.stepped.get('rooms/keys/act') === '0.8' }

  /**
   * Seal one record body for `key` at `version` under the room's current epoch. With signAsPrincipal the bytes are
   * the unsigned body (JSON); the trust agent signs it as its author, the member, and then seals it.
   */
  async seal (roomId, key, version, bytes, { signAsPrincipal = false, member } = {}) {
    const out = await this.#newest('rooms/keys/seal', ['0.3', '0.2'], { roomId, key, version, plaintext: b64u(bytes), ...(signAsPrincipal ? { signAsPrincipal: true } : member ? { ext: { [MEMBER_EXT]: { member } } } : {}) })
    const s = out?.sealed
    if (typeof s?.ciphertext !== 'string' || typeof s?.nonce !== 'string' || !Number.isInteger(s?.epoch)) throw new VtiError('indeterminate', 'the trust agent sealed nothing', { from: 'the trust agent' })
    return { ciphertext: s.ciphertext, nonce: s.nonce, epoch: s.epoch }
  }

  /** Open a sealed body. Returns { bytes, sealedAt? }: sealedAt when it opened at an earlier version than the one asked for. */
  async open (roomId, key, version, sealed, { member } = {}) {
    const out = await this.call('rooms/keys/open', '0.2', { roomId, key, version, sealed: { ciphertext: sealed.ciphertext, nonce: sealed.nonce, epoch: sealed.epoch }, ...(member ? { ext: { [MEMBER_EXT]: { member } } } : {}) })
    if (typeof out?.plaintext !== 'string') throw new VtiError('indeterminate', 'the trust agent opened nothing', { from: 'the trust agent' })
    const at = out.ext?.[MEMBER_EXT]?.sealedAt
    return { bytes: unb64u(out.plaintext), ...(Number.isInteger(at) ? { sealedAt: at } : {}) }
  }

  /** Apply one commit the room's host relayed. `mlsEpoch` is the MLS epoch it produces: the room's epoch minus one. Answers the MLS epoch held after. */
  async commit (roomId, commit, mlsEpoch) { return this.call('rooms/keys/commit', '0.1', { roomId, commit, epoch: mlsEpoch }) }

  /** Have the trust agent fetch the room's older epoch keys from the host (a room that keeps its chain), so records from before this membership open. */
  async backfill (roomId, host) { return this.call('rooms/keys/backfill', '0.2', { roomId, host }) }

  /**
   * A presentation for one action, granted to this credential's own DID (not to the member). It is what a caller
   * the person registered as a delegate uses, signing its own requests; the notebook acts as the member instead.
   */
  async present (roomId, action) { return this.call('rooms/keys/present', '0.2', { roomId, action }) }

  // ----- what joining a community and entering its encrypted room need, all done by the person's own trust agent -----

  /** A refusal made here after an answer failed a check: counted and remembered like one the trust agent made. */
  #refuse (family, message, code = 'indeterminate') { this.counts.refused++; this.last = { ok: false, family, code, at: Date.now() }; return bad(message, code) }

  /** The verification relationship's keys in `did`'s document as { vm, key (hex) }: what a proof under that purpose may be made with. */
  async #listedUnder (did, purpose) {
    let doc
    try { doc = await this.resolver.resolve(did) } catch (e) { throw new VtiError('unavailable', `the DID ${did} could not be read (${e.message})`, { from: 'this bridge' }) }
    const out = []
    for (const r of doc?.[purpose] ?? []) {
      const vm = typeof r === 'string' ? r : r?.id
      try { out.push({ vm, key: toHex(keyFromDidDocument(doc, did, vm, purpose)) }) } catch {} // a method that is not Ed25519, or not this DID's own, is not one a proof here can use
    }
    return { doc, listed: out }
  }

  /** Every key record this trust agent lists (status `active` only), following the cursor to its end. */
  async #activeKeys () {
    const keys = []
    let cursor
    for (let page = 0; page < MAX_PAGES; page++) {
      const out = await this.call('keys/list', '0.2', { status: 'active', ...(cursor ? { cursor } : {}) })
      for (const k of Array.isArray(out?.keys) ? out.keys : []) if (typeof k?.keyId === 'string' && k.status === 'active' && k.keyType === 'ed25519' && typeof k.publicKey === 'string') keys.push(k)
      cursor = out?.nextCursor
      if (!cursor) return keys
    }
    throw this.#refuse('keys/list', `the trust agent's key list did not end within ${MAX_PAGES} pages`)
  }

  /** The keyId of the active Ed25519 key `did`'s document lists under `purpose`, found once and kept in memory. */
  async #keyIdFor (did, purpose) {
    const memo = `${did}|${purpose}`
    if (this.keyIds.has(memo)) return this.keyIds.get(memo)
    const { listed } = await this.#listedUnder(did, purpose)
    const want = new Set(listed.map((l) => l.key))
    for (const k of await this.#activeKeys()) {
      let raw; try { raw = listedKey(k.publicKey) } catch { continue } // a public key written in a form this reader does not know is not the one wanted
      if (raw && want.has(toHex(raw))) { this.keyIds.set(memo, k.keyId); return k.keyId }
    }
    throw this.#refuse('keys/list', `this trust agent holds no active Ed25519 key that ${did} lists under ${purpose}`, 'taskFailed')
  }

  /**
   * Have the trust agent sign `document` as the persona it names (`issuer` or `controller`), with the persona's own key.
   * The document must carry no proof. Answers { document, proof, signerDid, keyId } after checking the answer: the
   * document is what was sent plus the proof, the signer is the DID the document names, and the proof verifies against
   * that DID's own document for the purpose. Needs a credential the trust agent lets write.
   */
  async signDocument (document, { proofPurpose, keyId, created, challenge, domain } = {}) {
    if (!isObj(document)) throw this.#refuse('keys/sign-document', 'a document to sign is a JSON object', 'malformedRequest')
    if ('proof' in document) throw this.#refuse('keys/sign-document', 'the document already carries a proof; this makes its only one', 'malformedRequest')
    const signer = signerOfDocument(document)
    if (!signer) throw this.#refuse('keys/sign-document', 'the document names no signer: it needs an issuer or a controller that is a DID', 'malformedRequest')
    const purpose = proofPurpose ?? 'assertionMethod' // what the trust agent reads from a request that names none
    if (!['assertionMethod', 'authentication'].includes(purpose)) throw this.#refuse('keys/sign-document', `proofPurpose ${purpose} is not one a trust agent signs under`, 'malformedRequest')
    const id = keyId ?? await this.#keyIdFor(signer, purpose)
    let out
    try { out = await this.call('keys/sign-document', '0.1', { keyId: id, document, ...(proofPurpose ? { proofPurpose } : {}), ...(created ? { created } : {}), ...(challenge ? { challenge } : {}), ...(domain ? { domain } : {}) }) } catch (e) {
      if (!keyId && ['keys:notFound', 'keys/sign-document:failedPrecondition'].includes(e.code)) this.keyIds.delete(`${signer}|${purpose}`) // a kept keyId the trust agent no longer accepts is found again next time
      throw e
    }
    if (out.signerDid !== signer) throw this.#refuse('keys/sign-document', 'the trust agent signed as a DID other than the one the document names')
    if (!isObj(out.document) || !isObj(out.proof) || canonicalize(out.document.proof) !== canonicalize(out.proof)) throw this.#refuse('keys/sign-document', 'the signed document does not carry the proof the trust agent returned')
    const { proof, ...body } = out.document
    if (canonicalize(body) !== canonicalize(document)) throw this.#refuse('keys/sign-document', 'the signed document is not the one that was sent')
    if (proof.proofPurpose !== purpose) throw this.#refuse('keys/sign-document', `the proof is made under ${proof.proofPurpose}, not ${purpose}`)
    let key
    try { key = keyFromDidDocument((await this.#listedUnder(signer, purpose)).doc, signer, proof.verificationMethod, purpose) } catch (e) { throw this.#refuse('keys/sign-document', `the proof's key is not one ${signer} lists under ${purpose} (${e.message})`) }
    const v = verifySignature(out.document, key)
    if (!v.ok) throw this.#refuse('keys/sign-document', `the proof does not verify (${v.reason})`)
    this.counts.signed++
    return { document: out.document, proof, signerDid: out.signerDid, keyId: out.keyId ?? id }
  }

  /** The KeyPackage the trust agent mints for a room, for the member `invitation` names (the same one again while it is outstanding). */
  async keyPackage (roomId, invitation) {
    const out = await this.call('rooms/keys/key-package', '0.2', { roomId, invitation })
    if (typeof out.keyPackage !== 'string' || !/^[A-Za-z0-9_-]+$/.test(out.keyPackage) || typeof out.alreadyMinted !== 'boolean' || Number.isNaN(Date.parse(out.expiresAt))) throw this.#refuse('rooms/keys/key-package', 'the trust agent answered with no usable KeyPackage')
    this.counts.keyPackages++
    return { keyPackage: out.keyPackage, expiresAt: out.expiresAt, alreadyMinted: out.alreadyMinted }
  }

  /**
   * Hand the trust agent the Welcome that lets it join the room's group. Answers { epoch } (the MLS epoch joined at).
   * A trust agent that has already joined with this invitation refuses with rooms/keys/welcome:alreadyJoined: that is
   * the join made, so it reads as success: { epoch: null, alreadyJoined: true } (the answer carries no epoch then).
   */
  async welcome (roomId, { welcome, invitation, ratchetTree } = {}) {
    let out
    try { out = await this.call('rooms/keys/welcome', '0.1', { roomId, welcome, ...(invitation ? { invitation } : {}), ...(ratchetTree ? { ratchetTree } : {}) }, { okCodes: ['rooms/keys/welcome:alreadyJoined'] }) } catch (e) {
      if (e.code !== 'rooms/keys/welcome:alreadyJoined') throw e
      this.counts.welcomes++
      return { epoch: null, alreadyJoined: true }
    }
    if (!Number.isInteger(out.epoch) || out.epoch < 0) throw this.#refuse('rooms/keys/welcome', 'the trust agent joined without saying at which epoch')
    this.counts.welcomes++
    return { epoch: out.epoch, alreadyJoined: false }
  }

  /**
   * Store a credential in the person's own vault (a community's pushed credential-exchange/issue lands there too).
   * An object is sent as JSON; a string that is JSON likewise; any other string (an SD-JWT's compact form) as base64url.
   */
  async receiveCredential (credential, { id, format, contextId } = {}) {
    let body = credential
    if (typeof body === 'string' && body.trim().startsWith('{')) { try { body = JSON.parse(body) } catch {} }
    const named = isObj(body) ? { credential: body } : typeof body === 'string' && body ? { credentialBase64: b64u(Buffer.from(body, 'utf8')) } : null
    if (!named) throw this.#refuse('vault/credentials/receive', 'a credential is a JSON object or a string', 'malformedRequest')
    const out = await this.call('vault/credentials/receive', '0.1', { ...named, ...(format ? { format } : {}), ...(contextId ? { contextId } : {}), ...(id ? { id } : {}) })
    if (typeof out.id !== 'string' || !out.id || !Array.isArray(out.types) || !['valid', 'expired', 'revoked', 'unknown'].includes(out.status)) throw this.#refuse('vault/credentials/receive', 'the trust agent stored nothing it could name')
    this.counts.credentialsStored++
    return { id: out.id, types: out.types, status: out.status, ...(typeof out.purpose === 'string' ? { purpose: out.purpose } : {}) }
  }

  /** Descriptors (no bodies) of stored credentials. Needs at least one of type, communityDid, issuerDid, purpose, status; subjectDid and includeArchived only narrow. */
  async queryCredentials (filter = {}) {
    const f = {}
    for (const k of ['type', 'communityDid', 'issuerDid', 'purpose', 'status', 'subjectDid', 'includeArchived', 'includeDeleted']) if (filter[k] !== undefined) f[k] = filter[k]
    if (!['type', 'communityDid', 'issuerDid', 'purpose', 'status'].some((k) => f[k] !== undefined)) throw this.#refuse('vault/credentials/query', 'a vault query needs at least one of type, communityDid, issuerDid, purpose or status', 'malformedRequest')
    const out = await this.call('vault/credentials/query', '0.1', f)
    if (!Array.isArray(out.credentials)) throw this.#refuse('vault/credentials/query', 'the trust agent answered a query with no list')
    return out.credentials.filter((c) => typeof c?.id === 'string')
  }

  /** One stored credential's body, as stored: { format, credential } for JSON, { format, credentialBase64 } otherwise. */
  async getCredential (id) {
    const out = await this.call('vault/credentials/get', '0.2', { id })
    if (typeof out.format !== 'string' || (isObj(out.credential) === (typeof out.credentialBase64 === 'string'))) throw this.#refuse('vault/credentials/get', 'the trust agent answered with a credential in neither form, or both')
    return isObj(out.credential) ? { format: out.format, credential: out.credential } : { format: out.format, credentialBase64: out.credentialBase64 }
  }

  /**
   * Have the trust agent complete a request to a community (an offer list, an offer acceptance, a memberships list) as
   * the member `memberDid`: sets `issuer`, sends it through rooms/keys/act, and checks what comes back is the same
   * request (id, type, recipient, payload: for an acceptance, the same KeyPackage) signed by the member under
   * `authentication`. `document` is unsigned, addressed to the community, written now, with no presentation.
   */
  async actAsMember (document, memberDid) {
    if (!isObj(document) || typeof memberDid !== 'string' || !memberDid.startsWith('did:')) throw this.#refuse('rooms/keys/act', 'actAsMember takes an unsigned document and the member\'s DID', 'malformedRequest')
    const sent = { ...document, issuer: memberDid }
    const out = await this.act(sent)
    const d = out.document
    if (d.issuer !== memberDid || out.principal !== memberDid) throw this.#refuse('rooms/keys/act', 'the trust agent completed the request as someone other than the member')
    for (const k of ['id', 'type', 'recipient']) if (d[k] !== sent[k]) throw this.#refuse('rooms/keys/act', `the completed request changed its ${k}`)
    if (canonicalize(d.payload) !== canonicalize(sent.payload)) throw this.#refuse('rooms/keys/act', 'the completed request changed its payload')
    if (!isObj(d.proof) || d.proof.proofPurpose !== 'authentication') throw this.#refuse('rooms/keys/act', 'the completed request is not signed under authentication')
    let key
    try { key = keyFromDidDocument((await this.#listedUnder(memberDid, 'authentication')).doc, memberDid, d.proof.verificationMethod, 'authentication') } catch (e) { throw this.#refuse('rooms/keys/act', `the proof's key is not one the member lists under authentication (${e.message})`) }
    const v = verifySignature(d, key)
    if (!v.ok) throw this.#refuse('rooms/keys/act', `the member's proof does not verify (${v.reason})`)
    return d
  }
}
