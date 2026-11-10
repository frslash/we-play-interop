// P2, sealed notebooks: the client side. One room per person; the host keeps ciphertext only.
// TEST MEMBERS AND TEST VALUES ONLY until Security's gate opens (Railroad step 3, a second
// implementation, Security's code read, the founder's call on lost keys). Key distribution between
// members (MLS, T1/T2) is NOT here: `Notebook` takes the epoch keys it is handed.
// Uses WebCrypto (AES-256-GCM); on plain http a browser has no crypto.subtle, so this runs
// where the page is served over https (Security condition 12 asks for that anyway).
import { canonicalize, ed25519, fromHex, randomBytes, sha256, toHex, utf8, fromUtf8 } from './crypto.js'
import { newIdentity, resolveDidKey, multikeyToEd25519 } from './did.js'
import { sign, verifySignature } from './proof.js'
import { DTG_CONTEXT } from './dtg-context.js'

export const MAX_NOTE_BYTES = 34 * 1024 // Security P2.8; the host's own cap is 64 KiB
export const AGENT_MAX_TTL_MS = 7 * 24 * 3600e3 // Security P2.4: a delegation lives 7 days at most
export const MEMBER_MAX_TTL_MS = 7 * 24 * 3600e3 // Railroad: nothing a real person relies on beyond 7 days
export const AGENT_SCOPES = ['notes:read', 'notes:write'] // never: members, rules, keys, delegation
export const MEMBER_SCOPES = ['notes:read', 'notes:write', 'members:admin']

const subtle = () => { if (!globalThis.crypto?.subtle) throw new Error('sealed notes need https (no crypto.subtle here)'); return globalThis.crypto.subtle }
const aad = (room, recordId, epoch) => utf8(`wpi-sealed-v1|${room}|${recordId}|${epoch}`)

export const newRoomKey = () => randomBytes(32)

/** Seal one note for one room and epoch. The room, record id and epoch are bound in, so a record cannot be replayed elsewhere. */
export async function sealNote (key, { room, recordId, epoch }, text) {
  const bytes = utf8(String(text))
  if (bytes.length > MAX_NOTE_BYTES) throw new Error(`a note is at most ${MAX_NOTE_BYTES} bytes`)
  const iv = randomBytes(12)
  const k = await subtle().importKey('raw', key, 'AES-GCM', false, ['encrypt'])
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: aad(room, recordId, epoch) }, k, bytes))
  return toHex(iv) + toHex(ct)
}
export async function openNote (key, { room, recordId, epoch }, sealed) {
  const iv = fromHex(sealed.slice(0, 24)), ct = fromHex(sealed.slice(24))
  const k = await subtle().importKey('raw', key, 'AES-GCM', false, ['decrypt'])
  return fromUtf8(new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv, additionalData: aad(room, recordId, epoch) }, k, ct)))
}

/** A fresh identity for one person in one room. Never reuse a persona across rooms (Security P2.7, P4.8). */
export const newRoomPersona = () => newIdentity()

/** The room signs credentials with its own key. Roles: 'member' or 'agent' (a delegation: this room, notes only, 7 days at most). */
export function issueCredential (room, { subject, role, scopes, notBefore = new Date(), ttlMs, delegatedBy }) {
  const max = role === 'agent' ? AGENT_MAX_TTL_MS : MEMBER_MAX_TTL_MS
  if (!(ttlMs > 0) || ttlMs > max) throw new Error(`a ${role} credential lives at most ${max / 3600e3} hours`)
  if (role === 'agent' && (scopes.some((s) => !AGENT_SCOPES.includes(s)) || !delegatedBy)) throw new Error('an agent delegation is notes read/write only, and names the member who gave it')
  if (role === 'member' && scopes.some((s) => !MEMBER_SCOPES.includes(s))) throw new Error('unknown scope')
  const id = toHex(randomBytes(16))
  const doc = {
    '@context': ['https://www.w3.org/ns/credentials/v2', DTG_CONTEXT], // the registry's DTG context: the one the room writes
    type: ['VerifiableCredential', role === 'agent' ? 'WpiAgentDelegation' : 'WpiMemberCredential'],
    id: `urn:wpi:cred:${id}`, issuer: room.did,
    validFrom: notBefore.toISOString(), validUntil: new Date(notBefore.getTime() + ttlMs).toISOString(),
    credentialSubject: { id: subject, room: room.did, role, scopes, ...(delegatedBy ? { delegatedBy } : {}) },
  }
  return sign(doc, { seed: room.seed, verificationMethod: room.verificationMethod, proofPurpose: 'assertionMethod' })
}

/** Hash of a call's arguments, signed into the presentation so a request cannot be altered in flight (Security should-fix 6). */
export const argsHash = (args = {}) => toHex(sha256(canonicalize(args)))

/** The holder proves it owns the credential's subject DID, with a fresh nonce from the host, for exactly these args. */
export function present (holder, credential, { room, nonce, op, host, args = {} }) {
  const doc = { '@context': ['https://www.w3.org/ns/credentials/v2'], type: 'WpiPresentation', holder: holder.did, room, host, nonce, op, args: argsHash(args), credential }
  return sign(doc, { seed: holder.seed, verificationMethod: holder.verificationMethod, proofPurpose: 'authentication' })
}

/** Signature by `did`'s key AND the proof's purpose is the one expected: credentials are 'assertionMethod', presentations 'authentication' (Security should-fix 7). */
export const verifyWith = (doc, did, purpose) => doc?.proof?.proofPurpose === purpose && verifySignature(doc, multikeyToEd25519(resolveDidKey(did).verificationMethod[0].publicKeyMultibase)).ok
export { canonicalize, sha256, toHex, ed25519 }
