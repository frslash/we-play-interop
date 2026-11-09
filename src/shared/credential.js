// A person's permission for their agent, as a W3C Verifiable Credential (VC 2.0)
// the person signs, so anyone can check it without trusting the room:
//   issuer             the person's DID
//   credentialSubject  { id: the agent's DID, room: the room's DID,
//                        scope: what the agent may do, askFirst: what waits for the person's OK }
//   validFrom/Until    the grant's window (its issuedAt .. expiresAt)
//   proof              a Data Integrity proof, eddsa-jcs-2022, assertionMethod, the person's key
// The grant line (delegation/grant) carries it as payload.credential. The room
// verifies it once, when the grant is appended, keeps what it says, and checks
// every write the agent makes against that. It ends with the room's record:
// a revoke line (delegation/revoke), removing the agent, or the person leaving.
// There is no separate status list (no credentialStatus): the log is the status.
// Terms beyond VC 2.0's own fall under the v2 context's issuer-dependent vocabulary.
// Shared by the page, the server and anyone verifying the log: no Node-only APIs.
import { canonicalize } from './crypto.js'
import { CRYPTOSUITE, sign, verifySignature } from './proof.js'
import { AGENT_SCOPES, DID_RE, RFC3339, uuid } from './types.js'

export const VC_V2 = 'https://www.w3.org/ns/credentials/v2'
export const PERMISSION_TYPE = 'AgentPermissionCredential'
const FIELDS = ['@context', 'id', 'type', 'issuer', 'validFrom', 'validUntil', 'credentialSubject', 'proof']
const SUBJECT = ['id', 'room', 'scope', 'askFirst']
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)
const sameSet = (a, b) => { const A = new Set(a), B = new Set(b); return A.size === B.size && [...A].every((x) => B.has(x)) }

/** The unsigned credential for one permission. */
export function permissionCredential ({ person, agent, room, scope, ask = [], validFrom, validUntil }) {
  return {
    '@context': [VC_V2], id: 'urn:uuid:' + uuid(), type: ['VerifiableCredential', PERMISSION_TYPE],
    issuer: person, validFrom, validUntil, credentialSubject: { id: agent, room, scope: [...scope], askFirst: [...ask] },
  }
}

/** Made and signed by the person (an identity from did.js), dated at the grant's issuedAt. */
export function signPermissionCredential (identity, { agent, room, scope, ask, validFrom, validUntil }) {
  const unsigned = permissionCredential({ person: identity.did, agent, room, scope, ask, validFrom, validUntil })
  return sign(unsigned, { seed: identity.seed, verificationMethod: identity.verificationMethod, created: validFrom, proofPurpose: 'assertionMethod' })
}

/** What is wrong with a permission credential's shape, in words, or null. */
export function checkPermissionCredential (c) {
  if (!isObj(c)) return 'an object (a W3C verifiable credential)'
  const extra = Object.keys(c).find((k) => !FIELDS.includes(k))
  if (extra) return `unknown field ${extra}`
  const ctx = c['@context']
  if (!Array.isArray(ctx) || ctx[0] !== VC_V2 || ctx.length > 4 || !ctx.every((x) => typeof x === 'string')) return `@context: a list that starts with ${VC_V2}`
  if (c.id !== undefined && (typeof c.id !== 'string' || !c.id.length || c.id.length > 200)) return 'id: a URI'
  if (!Array.isArray(c.type) || !c.type.includes('VerifiableCredential') || !c.type.includes(PERMISSION_TYPE)) return `type: VerifiableCredential and ${PERMISSION_TYPE}`
  if (typeof c.issuer !== 'string' || !DID_RE.test(c.issuer)) return 'issuer: the person\'s DID'
  if (!RFC3339.test(c.validFrom ?? '') || !RFC3339.test(c.validUntil ?? '')) return 'validFrom and validUntil: date-times with a time zone'
  if (!(Date.parse(c.validUntil) > Date.parse(c.validFrom))) return 'validUntil: after validFrom'
  const s = c.credentialSubject
  if (!isObj(s) || Object.keys(s).some((k) => !SUBJECT.includes(k))) return 'credentialSubject: { id, room, scope, askFirst }'
  if (!DID_RE.test(s.id ?? '')) return 'credentialSubject.id: the agent\'s DID'
  if (!DID_RE.test(s.room ?? '')) return 'credentialSubject.room: the room\'s DID'
  if (!Array.isArray(s.scope) || !s.scope.length || !s.scope.every((x) => AGENT_SCOPES.includes(x))) return `credentialSubject.scope: some of ${AGENT_SCOPES.join(', ')}`
  if (!Array.isArray(s.askFirst) || !s.askFirst.every((x) => s.scope.includes(x))) return 'credentialSubject.askFirst: the kinds of line (from scope) that wait for the person\'s OK'
  const p = c.proof
  if (!isObj(p) || p.type !== 'DataIntegrityProof' || p.cryptosuite !== CRYPTOSUITE) return `proof: one DataIntegrityProof with ${CRYPTOSUITE}`
  if (p.proofPurpose !== 'assertionMethod') return 'proof.proofPurpose: assertionMethod (the person asserting the permission)'
  if (typeof p.verificationMethod !== 'string' || p.verificationMethod.length > 4200) return 'proof.verificationMethod: the person\'s key'
  // the spec lets the proof carry the document's @context; here it must be the very same list
  if (p['@context'] !== undefined && canonicalize(p['@context']) !== canonicalize(ctx)) return 'proof.@context: the same as the credential\'s'
  if (canonicalize(c).length > 6000) return 'at most 6000 characters'
  return null
}

/** What a checked credential says: the room keeps this (a copy, never the log's own arrays) next to the grant. */
export const claimsOf = (c) => ({
  id: c.id ?? null, issuer: c.issuer, agent: c.credentialSubject.id, room: c.credentialSubject.room,
  scope: [...c.credentialSubject.scope], askFirst: [...c.credentialSubject.askFirst], validFrom: c.validFrom, validUntil: c.validUntil,
})

/**
 * Check a permission credential's shape and the person's signature on it.
 * keyFor(did, verificationMethod, proofPurpose) gives the Ed25519 key, as for documents,
 * or null when this verifier cannot resolve that DID method (then checked is false).
 * Returns { ok: true, checked, claims } or { ok: false, problem: 'shape' | 'key' | 'proof', reason }.
 */
export async function verifyPermissionCredential (c, { keyFor }) {
  const bad = checkPermissionCredential(c)
  if (bad) return { ok: false, problem: 'shape', reason: bad }
  let key
  try { key = await keyFor(c.issuer, c.proof.verificationMethod, c.proof.proofPurpose) } catch (err) { return { ok: false, problem: 'key', reason: `could not get the key that signed it: ${err.message}` } }
  if (!key) return { ok: true, checked: false, claims: claimsOf(c) }
  const sig = verifySignature(c, key)
  return sig.ok ? { ok: true, checked: true, claims: claimsOf(c) } : { ok: false, problem: 'proof', reason: sig.reason }
}

/** Why a grant and the credential it carries disagree, or null: the credential says exactly what the grant says. */
export function grantMismatch (claims, grant, room) {
  const p = grant.payload
  if (claims.issuer !== grant.issuer) return 'it is signed by someone other than the person giving the permission'
  if (claims.agent !== p.delegate) return 'it names a different agent'
  if (claims.room !== room) return 'it is for another room'
  if (!sameSet(claims.scope, p.scope)) return 'what it lets the agent do differs from the grant\'s scope'
  if (!sameSet(claims.askFirst, p.ask ?? [])) return 'what it says waits for the person\'s OK differs from the grant\'s ask'
  if (Date.parse(claims.validFrom) !== Date.parse(grant.issuedAt) || Date.parse(claims.validUntil) !== Date.parse(grant.expiresAt)) return 'its dates differ from the grant\'s (validFrom is the grant\'s issuedAt, validUntil its expiresAt)'
  return null
}

/**
 * Why one write by an agent falls outside the credential its permission carries,
 * as { code, message }, or null. kind is the room's name for the line (note, vote, …);
 * slackMs is the clock slack the room allows anywhere.
 */
export function credentialRefuses (claims, { agent, person, room, kind, at = Date.now(), slackMs = 0, revoked = false }) {
  const no = (message, code = 'permissionDenied') => ({ code, message })
  if (revoked) return no('the permission was stopped in the room\'s record, so its credential no longer holds')
  if (claims.agent !== agent || claims.issuer !== person) return no('the permission\'s credential is not from this person to this agent')
  if (claims.room !== room) return no('the permission\'s credential is for another room')
  if (at + slackMs < Date.parse(claims.validFrom)) return no('the permission\'s credential is not valid yet; check the clock')
  if (at >= Date.parse(claims.validUntil)) return no('the permission\'s credential has expired; ask your person for a new one', 'expired')
  if (!claims.scope.includes(kind)) return no(`the permission your person signed as a credential does not cover ${kind}`)
  return null
}
