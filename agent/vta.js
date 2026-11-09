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
//   the client   openvti-starter packages/vta-client/src/client.ts (Apache-2.0; ideas only, no code copied)
// Versions sent: rooms/keys/act 0.12 (then 0.8, what the kit's older trust agent serves), seal 0.3 (then 0.2),
// open 0.2, list 0.2, commit 0.1, present 0.2, backfill 0.2.
import { readFileSync, statSync } from 'node:fs'
import { newIdentity } from '../src/shared/did.js'
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
  constructor ({ credential, url = credential?.vtaUrl, fetch: f = globalThis.fetch, sleep = pause } = {}) {
    if (!credential) throw new Error('no trust agent credential')
    if (!/^https?:\/\//.test(String(url ?? ''))) throw new Error('the trust agent\'s address is missing: set VTA_URL, or use a credential that carries vtaUrl')
    this.me = credential; this.did = credential.did; this.vtaDid = credential.vtaDid; this.url = String(url).replace(/\/+$/, '')
    this.fetch = f; this.sleep = sleep; this.token = null; this.refreshToken = null
    this.stepped = new Map() // family -> the version this trust agent answered at
    this.counts = { calls: 0, refused: 0, signIns: 0, refreshes: 0, slowDowns: 0 } // counts and outcomes only, never content
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
  async call (family, version, payload = {}) {
    try {
      if (!this.token) await this.signIn()
      let r = await this.#post(this.#doc(family, version, payload), this.token)
      if (r.status === 401) { await this.renew(); r = await this.#post(this.#doc(family, version, payload), this.token) }
      const out = unwrap(r, 'the trust agent')
      this.last = { ok: true, family, at: Date.now() }
      return out
    } catch (e) { this.counts.refused++; this.last = { ok: false, family, code: e.code ?? 'unreachable', at: Date.now() }; throw e } // the outcome and its code are kept; what was sent is not
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
}
