// DTG credentials: the one family of credential every project around this room issues. A W3C Verifiable Credential
// (VC 2.0) with a Data Integrity proof (eddsa-jcs-2022), typed "DTGCredential" plus what it is: a community's
// membership pass (VMC), a grant of authority (VAC), an invitation (VIC), a relationship between two people (VRC),
// and others the room verifies without reading into (statements, personas, delegations).
// This file is the room's reader for that family: what one is, whether one is genuine, and whether a chain of
// authority credentials adds up. It issues nothing and holds no key.
//
// Every rule below was read from the code it has to agree with:
//   OpenVTC (at the commit the room builds from) vtc-service/src/credentials/ingress.rs (the common structure, the
//     validity window), dtg.rs (the shapes it mints), vta-sdk/src/trust_task_proof/proof_set.rs (a set of proofs),
//     vti-rooms-dtg/src/lib.rs and vti-rooms/src/authz.rs (the authority chain a room host checks);
//   RLTP conformance/dtg-vrc.mjs (its reader for other projects' relationship credentials: did:peer:2, dates);
//   TrustStackers packages/core/src/services/dtg-credential.ts (its context address and types).
// Where they disagree it says so, and reports which way a credential was read rather than hiding it.
// Shared by the page, the server and agents: no Node-only and no browser-only APIs.
import { canonicalize } from './crypto.js'
import { keyFromDidDocument } from './chain.js'
import { CRYPTOSUITE, verifySignature } from './proof.js'
import { multihashOf, sameDigest, signedTask } from './trusttask.js'
import { DID_RE, NS } from './types.js'

export const VC_V2 = 'https://www.w3.org/ns/credentials/v2'
/**
 * The address of the DTG context, second in @context. Three are in use among the projects here, and a credential is
 * signed over the one it names, so none can be rewritten into another:
 *   registry-v1       the current one: OpenVTC, Geb and RLTP's encounter credentials. OpenVTC accepts only this.
 *   firstperson-wd01  the first draft's, retired: RLTP's invitations and vouches still carry it.
 *   trustoverip-v1    TrustStackers' (with https://w3id.org/security/data-integrity/v1 third).
 * The room reads all three and says which it met (`context.name`); only the first is the published standard.
 */
export const DTG_CONTEXTS = {
  'https://registry.trustoverip.org/dtg/context/v1': 'registry-v1',
  'https://firstperson.network/credentials/dtg/v1': 'firstperson-wd01',
  'https://trustoverip.org/dtg/credentials/v1': 'trustoverip-v1',
}
export const DTG_TYPE = 'DTGCredential'
/** The kinds the room reads into, by the type that names them. Any other DTG credential is 'other': verified, not interpreted. */
export const DTG_KINDS = { MembershipCredential: 'membership', AuthorityCredential: 'authority', InvitationCredential: 'invitation', RelationshipCredential: 'relationship' }
const CONCRETE = [...Object.keys(DTG_KINDS), 'StatementCredential', 'PersonaCredential', 'DelegationCredential'] // one credential is exactly one of these
const RETIRED = ['EndorsementCredential', 'WitnessCredential'] // early drafts' names; today both are a StatementCredential with a predicate
const HINTS = ['PersonhoodCredential'] // rides beside the kind and changes nothing about it
export const ISSUER_SCOPES = ['pairwise', 'directed', 'public'] // who the issuer's DID is known to; exact, lower case
export const STATUS_ENTRY = 'BitstringStatusListEntry'

// What each limit protects:
// a credential travels inside a 64 KiB Trust Task document, with room left for the envelope around it;
export const MAX_CREDENTIAL_CHARS = 48 * 1024
// a proof set is one proof per kind of key its issuer holds (today two: Ed25519 and a post-quantum one), not a pile;
const MAX_PROOFS = 8
const MAX_CONTEXTS = 8
// an authority chain is a person narrowing what they were given for their agent, perhaps twice: the room host's own cap.
export const MAX_CHAIN_DEPTH = 8

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)
const same = (a, b) => { try { return canonicalize(a) === canonicalize(b) } catch { return false } }
const no = (problem, reason) => ({ ok: false, problem, reason })
const an = (w) => (/^[aeiou]/.test(w) ? 'an ' : 'a ') + w

/** The DID a credential's issuer is, whether written as a string or as { id }. */
export const issuerOf = (vc) => (typeof vc?.issuer === 'string' ? vc.issuer : isObj(vc?.issuer) && typeof vc.issuer.id === 'string' ? vc.issuer.id : null)

// ---------- times ----------
// A credential's dates are compared as written. Date.parse quietly turns 30 February into 2 March and cannot hold a
// leap second or a nanosecond, so a time is kept as [its UTC minute, its second 0..60, its fraction's digits] and two
// are compared part by part (the same care RLTP's reader takes; a second of 60 is real only at 23:59:60 UTC).
const TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:Z|([+-])(\d{2}):(\d{2}))$/
export function instantOf (v) {
  const m = typeof v === 'string' ? TIME.exec(v) : null
  if (!m) return null
  const [Y, M, D, h, mi, s] = m.slice(1, 7).map(Number)
  if (h > 23 || mi > 59 || s > 60 || (m[8] && (Number(m[9]) > 23 || Number(m[10]) > 59))) return null
  const d = new Date(0); d.setUTCFullYear(Y, M - 1, D)
  if (d.getUTCMonth() !== M - 1 || d.getUTCDate() !== D) return null // no such day
  d.setUTCHours(h, mi - (m[8] ? (m[8] === '-' ? -1 : 1) * (Number(m[9]) * 60 + Number(m[10])) : 0), 0, 0)
  if (s === 60 && (d.getUTCHours() !== 23 || d.getUTCMinutes() !== 59)) return null
  return [d.getTime(), s, (m[7] ?? '').replace(/0+$/, '')]
}
export function compareInstants (a, b) {
  if (a[0] !== b[0]) return a[0] - b[0]
  if (a[1] !== b[1]) return a[1] - b[1]
  const n = Math.max(a[2].length, b[2].length), x = a[2].padEnd(n, '0'), y = b[2].padEnd(n, '0')
  return x < y ? -1 : x > y ? 1 : 0
}
const instantOfMs = (ms) => { const t = Math.floor(ms), min = Math.floor(t / 60_000) * 60_000; return [min, Math.floor((t - min) / 1000), String((t - min) % 1000).padStart(3, '0').replace(/0+$/, '')] }

/** A credential's window as written: VC 2.0's validFrom/validUntil, or VC 1.1's issuanceDate/expirationDate (OpenVTC reads both; stating both is refused as ambiguous). */
function windowOf (vc) {
  const pick = (now, old) => (vc[now] !== undefined && vc[old] !== undefined ? { both: `${now} and ${old}` } : { key: vc[now] !== undefined ? now : old, value: vc[now] ?? vc[old] })
  return { from: pick('validFrom', 'issuanceDate'), until: pick('validUntil', 'expirationDate') }
}

// ---------- what it is ----------

/** What a DTG credential says it is, from its @context and type alone: { kind, subtype, context: { address, name, current }, personhood, hints }. */
export function describeDtg (vc) {
  const types = Array.isArray(vc?.type) ? vc.type.filter((t) => typeof t === 'string') : []
  const concrete = types.filter((t) => CONCRETE.includes(t))
  const others = types.filter((t) => t !== 'VerifiableCredential' && t !== DTG_TYPE && !CONCRETE.includes(t) && !HINTS.includes(t))
  const subtype = concrete[0] ?? others[0] ?? null
  const address = Array.isArray(vc?.['@context']) ? vc['@context'][1] : undefined
  return { kind: DTG_KINDS[subtype] ?? 'other', subtype, concrete, context: { address, name: DTG_CONTEXTS[address] ?? null, current: DTG_CONTEXTS[address] === 'registry-v1' }, personhood: types.includes('PersonhoodCredential'), hints: others.filter((t) => t !== subtype) }
}

/** The status entries a credential points at, as { type, purpose, index, list }: where a verifier looks to see whether it was withdrawn. */
export function statusEntriesOf (vc) {
  const s = vc?.credentialStatus
  return (Array.isArray(s) ? s : s === undefined || s === null ? [] : [s]).map((e) => ({ type: e?.type, purpose: e?.statusPurpose, index: e?.statusListIndex, list: e?.statusListCredential, ...(e?.statusSize !== undefined ? { size: e.statusSize } : {}) }))
}

/** The proofs on a document: those this room can check (eddsa-jcs-2022) and the cryptosuites of those it cannot. */
function proofsOf (doc) {
  const all = Array.isArray(doc?.proof) ? doc.proof : doc?.proof === undefined || doc?.proof === null ? [] : [doc.proof]
  return { all, mine: all.filter((p) => p?.cryptosuite === CRYPTOSUITE), others: all.filter((p) => p?.cryptosuite !== CRYPTOSUITE).map((p) => String(p?.cryptosuite)) }
}
/** What is wrong with a document's proof block, in words, or null. A set must hold at least one proof this room can check. */
function checkProofs (doc) {
  const { all, mine } = proofsOf(doc)
  if (!all.length) return 'proof: it is not signed'
  if (all.length > MAX_PROOFS) return `proof: at most ${MAX_PROOFS} proofs`
  for (const p of all) {
    // as OpenVTC reads a set: a proof of a cryptosuite this reader does not have is set aside; anything else that is not a well-formed proof is refused, never skipped
    if (!isObj(p) || p.type !== 'DataIntegrityProof' || typeof p.cryptosuite !== 'string') return 'proof: a Data Integrity proof, or a set of them'
    if (p.cryptosuite !== CRYPTOSUITE) continue
    if (typeof p.proofValue !== 'string' || typeof p.verificationMethod !== 'string' || p.verificationMethod.length > 4200) return 'proof: verificationMethod (the issuer\'s key) and proofValue'
  }
  if (!mine.length) return `proof: none of its proofs is ${CRYPTOSUITE}, the one this room can check`
  return null
}

/**
 * What is wrong with a DTG credential's shape, in words, or null. No key is needed and no clock is read: it says
 * whether this is a DTG credential at all, not whether it is genuine or in date (verifyDtgCredential does that).
 */
export function checkDtgCredential (vc) {
  if (!isObj(vc)) return 'an object (a W3C verifiable credential)'
  const ctx = vc['@context']
  if (!Array.isArray(ctx) || ctx[0] !== VC_V2 || ctx.length > MAX_CONTEXTS) return `@context: a list that starts with ${VC_V2}`
  if (!DTG_CONTEXTS[ctx[1]]) return `@context: the DTG context second (${Object.keys(DTG_CONTEXTS).join(', or ')})`
  if (!Array.isArray(vc.type) || !vc.type.every((t) => typeof t === 'string') || !vc.type.includes('VerifiableCredential') || !vc.type.includes(DTG_TYPE)) return `type: VerifiableCredential, ${DTG_TYPE} and what kind it is`
  const d = describeDtg(vc)
  if (d.concrete.length > 1) return `type: exactly one kind (it says ${d.concrete.join(' and ')})`
  if (!d.subtype) return `type: what kind of DTG credential it is (${Object.keys(DTG_KINDS).join(', ')}, …)`
  if (vc.id !== undefined && (typeof vc.id !== 'string' || !vc.id.length || vc.id.length > 4200)) return 'id: a URI'
  const issuer = issuerOf(vc)
  if (!issuer || !DID_RE.test(issuer)) return 'issuer: a DID'
  // issuerScope is required by the current DTG structure (OpenVTC and RLTP both refuse a credential without it); the two older contexts never had it
  if (vc.issuerScope === undefined ? d.context.current : !ISSUER_SCOPES.includes(vc.issuerScope)) return `issuerScope: one of ${ISSUER_SCOPES.join(', ')}`
  const w = windowOf(vc)
  if (w.from.both || w.until.both) return `${w.from.both ?? w.until.both}: say it once`
  const from = instantOf(w.from.value), until = w.until.value === undefined ? undefined : instantOf(w.until.value)
  if (!from) return 'validFrom: a date and time on a real day, with a time zone'
  if (until === null) return 'validUntil: a date and time on a real day, with a time zone'
  if (until && compareInstants(until, from) < 0) return 'validUntil: not before validFrom'
  const s = vc.credentialSubject
  if (!isObj(s) || typeof s.id !== 'string' || !DID_RE.test(s.id)) return 'credentialSubject.id: the DID it is about'
  if (d.kind === 'authority') {
    const a = s.authority
    if (!isObj(a) || typeof a.scope !== 'string' || !a.scope || !Array.isArray(a.actions) || !a.actions.length || a.actions.length > 64 || !a.actions.every((x) => typeof x === 'string' && x)) return 'credentialSubject.authority: { scope, actions } (what it lets its subject do, and where)'
    if (a.maxAttenuation !== undefined && !(Number.isInteger(a.maxAttenuation) && a.maxAttenuation >= 0)) return 'credentialSubject.authority.maxAttenuation: how many more times it may be narrowed (a whole number)'
    if (a.parent !== undefined && typeof a.parent !== 'string') return 'credentialSubject.authority.parent: the credential it was narrowed from'
  }
  if (d.kind === 'invitation' && s.scopes !== undefined && !(Array.isArray(s.scopes) && s.scopes.every((x) => typeof x === 'string'))) return 'credentialSubject.scopes: a list of words'
  for (const e of statusEntriesOf(vc)) {
    if (typeof e.type !== 'string') return 'credentialStatus: each entry has a type'
    if (e.type === STATUS_ENTRY && (typeof e.purpose !== 'string' || typeof e.list !== 'string' || !/^\d{1,12}$/.test(String(e.index)))) return 'credentialStatus: { statusPurpose, statusListIndex, statusListCredential }'
  }
  const bad = checkProofs(vc)
  if (bad) return bad
  let size; try { size = canonicalize(vc).length } catch { return 'plain JSON (it could not be put in canonical form)' }
  if (size > MAX_CREDENTIAL_CHARS) return `at most ${MAX_CREDENTIAL_CHARS} characters`
  return null
}

// ---------- whether it is genuine ----------

/**
 * Check the issuer's proof on any signed credential (a DTG credential, or the status list a community signs).
 * As OpenVTC reads a proof, which may be one object or a set:
 *   every eddsa-jcs-2022 proof present must verify (a proof someone appended cannot be ignored), there must be one,
 *   each is made for assertionMethod (a credential is its issuer's statement; a key listed only for signing in may
 *   not make one) with a key under the issuer's own DID, and a proof of another cryptosuite (a post-quantum second
 *   proof) is set aside and named in `unchecked`, neither trusted nor a reason to refuse.
 * What is signed, as the W3C suite defines it: the proof without its value, then the credential without its proof.
 * When the proof carries an @context (every project here copies the credential's into it) that copy is part of
 * what is signed, it must be the start of the credential's own list, and the credential is hashed with it.
 * keyFor(did, verificationMethod, purpose) gives the Ed25519 key, or null when this verifier cannot resolve that DID
 * method (then checked is false: the shape is right and the signature was not checked here).
 * Returns { ok: true, checked, unchecked } or { ok: false, problem: 'proof' | 'key', reason }.
 */
export async function verifyIssuerProof (doc, issuer, { keyFor }) {
  const bad = checkProofs(doc)
  if (bad) return no('proof', bad)
  const { mine, others } = proofsOf(doc)
  const ctx = doc['@context']
  let checked = true
  for (const p of mine) {
    if (p.proofPurpose !== 'assertionMethod') return no('proof', 'the proof\'s purpose must be assertionMethod: a credential is its issuer\'s statement')
    const at = p.verificationMethod.indexOf('#')
    if (at < 1 || p.verificationMethod.slice(0, at) !== issuer) return no('proof', 'the proof is made with a key that does not belong to the issuer it names')
    const pctx = p['@context']
    if (pctx !== undefined && !(Array.isArray(pctx) && Array.isArray(ctx) && pctx.length <= ctx.length && pctx.every((c, i) => same(c, ctx[i])))) return no('proof', 'the proof\'s @context is not the start of the credential\'s own')
    let key
    try { key = await keyFor(issuer, p.verificationMethod, 'assertionMethod') } catch (err) { return no('key', `could not get the key that signed it: ${err.message}`) }
    if (!key) { checked = false; continue }
    const sig = verifySignature({ ...doc, ...(pctx !== undefined ? { '@context': pctx } : {}), proof: p }, key)
    if (!sig.ok) return no('proof', sig.reason)
  }
  return { ok: true, checked, unchecked: others }
}

/** What a checked credential says, as plain values (a copy, never the credential's own arrays). */
function claimsOf (vc, d) {
  const s = vc.credentialSubject, w = windowOf(vc)
  return {
    id: vc.id ?? null, issuer: issuerOf(vc), subject: s.id, types: [...vc.type], issuerScope: vc.issuerScope ?? null,
    validFrom: w.from.value, validUntil: w.until.value ?? null, personhood: d.personhood, status: statusEntriesOf(vc),
    ...(d.kind === 'authority' ? { authority: { scope: s.authority.scope, actions: [...s.authority.actions], ...(s.authority.maxAttenuation !== undefined ? { maxAttenuation: s.authority.maxAttenuation } : {}), ...(s.authority.parent !== undefined ? { parent: s.authority.parent } : {}) } } : {}),
    ...(d.kind === 'invitation' && s.scopes ? { scopes: [...s.scopes] } : {}),
    // a member's own half of a membership pair names the community's grant by its digest (OpenVTC docs/03-vtc/credentials.md)
    ...(d.kind === 'membership' && typeof s.digestMultibase === 'string' ? { digestMultibase: s.digestMultibase } : {}),
  }
}

/**
 * The whole check of one DTG credential: its shape, that it is one of `kinds` (when given), its issuer's proof, and
 * that `now` is inside its dates. The window is OpenVTC's: validFrom <= now < validUntil, with no slack at the end;
 * `skewMs` (a minute) is allowed at the start only, for a pass shown seconds after a server with a faster clock made it.
 * Returns { ok: true, checked, kind, claims, context, notes, unchecked } or
 * { ok: false, problem: 'shape' | 'kind' | 'proof' | 'key' | 'dates', reason }.
 * `checked: false` means the issuer's DID could not be resolved here, so the signature was NOT checked: never treat
 * that as genuine. `unchecked` names the cryptosuites of proofs that were present and not checked.
 */
export async function verifyDtgCredential (vc, { keyFor, now = Date.now(), kinds, skewMs = 60_000 } = {}) {
  const bad = checkDtgCredential(vc)
  if (bad) return no('shape', bad)
  const d = describeDtg(vc)
  if (kinds && !kinds.includes(d.kind)) return no('kind', `this is ${an(d.kind === 'other' ? d.subtype : d.kind + ' credential')}; ${kinds.map((k) => an(k + ' credential')).join(' or ')} is needed here`)
  const proof = await verifyIssuerProof(vc, issuerOf(vc), { keyFor })
  if (!proof.ok) return proof
  const claims = claimsOf(vc, d)
  if (compareInstants(instantOf(claims.validFrom), instantOfMs(now + skewMs)) > 0) return no('dates', `it is not valid yet (from ${claims.validFrom}); check the clock`)
  if (claims.validUntil && compareInstants(instantOf(claims.validUntil), instantOfMs(now)) <= 0) return no('dates', `it ran out on ${claims.validUntil}`)
  const notes = []
  if (!d.context.current) notes.push(`its DTG context is ${d.context.address}, not the current ${Object.keys(DTG_CONTEXTS)[0]}: OpenVTC would refuse it`)
  if (vc.issuerScope === undefined) notes.push('it does not say its issuerScope, which the current DTG structure requires')
  if (RETIRED.includes(d.subtype)) notes.push(`${d.subtype} is an early draft's name; today it is a StatementCredential`)
  if (proof.unchecked.length) notes.push(`it also carries ${proof.unchecked.length === 1 ? 'a proof' : 'proofs'} this room cannot check (${proof.unchecked.join(', ')}); only the ${CRYPTOSUITE} proof was checked`)
  return { ok: true, checked: proof.checked, kind: d.kind, claims, context: d.context, notes, unchecked: proof.unchecked }
}

/** "z…": the digest one DTG credential names another by (credentialSubject.digestMultibase): over the credential without its proof. */
export const dtgDigest = (vc) => { const { proof: _p, ...rest } = vc; return multihashOf(rest) }

/** A credential as the room host accepts one in a presentation: the object, its JSON text, or base64url (no padding) of that text. Null when it is none of these. */
export function openCredential (encoded) {
  if (isObj(encoded)) return encoded
  if (typeof encoded !== 'string' || !encoded || encoded.length > MAX_CREDENTIAL_CHARS * 2) return null
  try {
    const t = encoded.trim()
    const v = JSON.parse(t.startsWith('{') ? t : new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(t.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))))
    return isObj(v) ? v : null
  } catch { return null }
}

// ---------- showing a membership pass to the room ----------

/**
 * The task a holder sends the room to ask "is this a current member's pass?" (POST /api/community/pass).
 * It is the room's own address, not the registry's credential-exchange/present: that one is the answer to a
 * verifier's credential-exchange/query and is bound to a nonce the verifier made and must remember, and this
 * check keeps nothing. A signed Trust Task document already carries what a presentation's own proof would add:
 * who presents (its signer), for whom (recipient: the room's DID) and when (issuedAt, good for ten minutes).
 * payload: { membership } with the credential as the room host takes one: the object, its JSON, or base64url of it.
 */
export const PASS_CHECK_TYPE = `${NS}community:pass:check:0.1`
/** The signed request, made where the holder's key is (a wallet, an agent, the page): the room's server never has that key. */
export const passCheck = (holder, { room, membership }) => signedTask(holder, { type: PASS_CHECK_TYPE, recipient: room, payload: { membership } })

// ---------- did:peer:2, which Geb and OpenVTC's relationship DIDs use ----------

const PEER2 = { A: 'assertionMethod', E: 'keyAgreement', V: 'authentication', I: 'capabilityInvocation', D: 'capabilityDelegation' }
/**
 * The DID document inside a did:peer:2 identifier: "did:peer:2" then ".<purpose><key>" parts, keys named #key-1,
 * #key-2 … in order (a service part, S, is not a key). Read with no network.
 * The method's purposes are exact: A is assertionMethod, V is authentication. OpenVTC also lets a V key make an
 * assertion; RLTP's reader does not. The room follows the method (and RLTP) unless `vAsserts` is set, so a
 * credential signed with a key its DID lists only for signing in is refused.
 */
export function resolveDidPeer2 (did, { vAsserts = false } = {}) {
  if (typeof did !== 'string' || !did.startsWith('did:peer:2.') || did.length > 4200) throw new Error('malformed did:peer:2')
  const doc = { id: did, verificationMethod: [] }
  for (const part of did.slice('did:peer:2.'.length).split('.')) {
    if (part.length < 2) throw new Error('malformed did:peer:2')
    if (part[0] === 'S') continue
    const purpose = PEER2[part[0]], mb = part.slice(1)
    if (!purpose || !/^z[1-9A-HJ-NP-Za-km-z]+$/.test(mb)) throw new Error('malformed did:peer:2')
    const id = `${did}#key-${doc.verificationMethod.length + 1}`
    doc.verificationMethod.push({ id, type: 'Multikey', controller: did, publicKeyMultibase: mb })
    for (const rel of purpose === 'authentication' && vAsserts ? ['authentication', 'assertionMethod'] : [purpose]) (doc[rel] ??= []).push(id)
  }
  if (!doc.verificationMethod.length) throw new Error('did:peer:2 has no key')
  return doc
}
/**
 * A keyFor that also reads did:peer:2 (the room's resolver reads did:key, did:peer:4 and did:webvh). A key may be
 * named #key-N or by its own multibase value; either way it must be listed for the proof's purpose and be Ed25519.
 */
export const withDidPeer2 = (keyFor, opts) => async (did, vmRef, purpose) => {
  if (!String(did).startsWith('did:peer:2.')) return keyFor ? keyFor(did, vmRef, purpose) : null
  const doc = resolveDidPeer2(did, opts), frag = String(vmRef).slice(String(vmRef).indexOf('#') + 1)
  const byValue = (doc[purpose] ?? []).find((id) => doc.verificationMethod.find((m) => m.id === id)?.publicKeyMultibase === frag)
  return keyFromDidDocument(doc, did, byValue ?? vmRef, purpose)
}

// ---------- a chain of authority, as a room host checks one ----------

/**
 * Does this chain of authority credentials let `presenter` do `action` in `root`'s scope? The rules are the room
 * host's (OpenVTC vti-rooms/src/authz.rs "Contract" and vti-rooms-dtg/src/lib.rs), because a genuine signature on a
 * grant someone gave themselves is still a grant they gave themselves:
 *   the chain is given whole, leaf first, at most 8 links, and nothing is fetched to complete it;
 *   every link is an authority credential with its issuer's proof, in date now, and states when it ends;
 *   the last link is issued by `root` (the room, or the community, whose scope this is): a chain that starts
 *     anywhere else confers nothing, however well formed;
 *   each link below is issued by the subject of the one above, names it as its parent, stays in the same scope,
 *     adds no action, and is no deeper than the links above allow (maxAttenuation: 0 means "not onward");
 *   the first link grants to `presenter`, the party whose signature was checked on the request, never one named
 *     in a payload: a presentation is not a bearer token;
 *   with `membership` (the member's pass): it is issued by `root`, in date, and about the subject of the LAST link,
 *     the member the room granted to. An agent holds a narrowed first link and presents its person's pass; two
 *     people cannot pool one's membership with the other's authority.
 * Returns { ok: true, subject, actions, member, validUntil } (validUntil: the first moment any credential read here
 * stops being valid) or { ok: false, problem, reason }.
 * Not confirmed in source (the rules live in the dtg-credentials library, which the sources here do not include):
 * that `parent` is the DTG digest of the link above (its id, the older form, is read too), and the arithmetic of
 * maxAttenuation. Both are read from OpenVTC's own comments and changelog.
 */
export async function verifyAuthorityChain (chain, { root, scope = root, action, presenter, keyFor, now = Date.now(), membership } = {}) {
  if (!Array.isArray(chain) || !chain.length) return no('chain', 'an authority chain has at least one credential')
  if (chain.length > MAX_CHAIN_DEPTH) return no('chain', `the authority chain is ${chain.length} links; at most ${MAX_CHAIN_DEPTH}`)
  if (typeof root !== 'string' || !DID_RE.test(root)) return no('chain', 'whose scope this is (a DID) must be named')
  if (typeof presenter !== 'string' || !presenter) return no('presenter', 'the party presenting the chain must be known from its signature')
  const open = async (encoded, what, kind) => {
    const vc = openCredential(encoded)
    if (!vc) return no('shape', `${what} is neither a credential, its JSON, nor base64url of its JSON`)
    const r = await verifyDtgCredential(vc, { keyFor, now, kinds: [kind], skewMs: 0 }) // the room host allows no slack on either end
    if (!r.ok) return no(r.problem, `${what}: ${r.reason}`)
    return r.checked ? { ok: true, vc, ...r.claims } : no('key', `${what}: its signature could not be checked here`)
  }
  const links = []
  for (const [i, encoded] of chain.entries()) {
    const l = await open(encoded, `authority credential ${i}`, 'authority')
    if (!l.ok) return l
    if (!l.validUntil) return no('shape', `authority credential ${i}: it must say when it ends (validUntil)`)
    links.push(l)
  }
  const top = links.at(-1)
  if (top.issuer !== root) return no('chain', `the chain does not confer this: its last credential is issued by ${top.issuer}, not by ${root}`)
  if (top.authority.parent !== undefined) return no('chain', 'the chain does not confer this: its last credential was itself narrowed from another, which was not presented')
  let onward = top.authority.maxAttenuation ?? Infinity // how many more times the grant may be narrowed below this link
  for (let i = links.length - 1; i >= 0; i--) {
    const l = links[i], above = links[i + 1]
    if (l.authority.scope !== scope) return no('chain', `the chain does not confer this: credential ${i} is for ${l.authority.scope}, not ${scope}`)
    if (!above) continue
    if (l.issuer !== above.subject) return no('chain', `the chain does not confer this: credential ${i} is issued by ${l.issuer}, not by ${above.subject} who was granted the one above it`)
    if (!l.authority.actions.every((a) => above.authority.actions.includes(a))) return no('chain', `the chain does not confer this: credential ${i} adds an action the one above it does not grant`)
    if (onward < 1) return no('chain', `the chain does not confer this: credential ${i} narrows a grant that may not be narrowed further`)
    if (!(typeof l.authority.parent === 'string' && (sameDigest(l.authority.parent, dtgDigest(above.vc)) || (above.id && l.authority.parent === above.id)))) return no('chain', `the chain does not confer this: credential ${i} does not name the one presented above it as its parent`)
    onward = Math.min(onward - 1, l.authority.maxAttenuation ?? Infinity)
  }
  const leaf = links[0]
  if (leaf.subject !== presenter) return no('presenter', `the chain grants to ${leaf.subject} but it was presented by ${presenter}`)
  if (action !== undefined && !leaf.authority.actions.includes(action)) return no('action', `the chain does not confer ${action}`)
  let member = null, ends = links.map((l) => l.validUntil)
  if (membership !== undefined) {
    const m = await open(membership, 'the membership credential', 'membership')
    if (!m.ok) return m
    if (m.issuer !== root) return no('membership', `the membership credential was issued by ${m.issuer}, not by ${root}`)
    if (m.subject !== top.subject) return no('membership', `the membership credential describes ${m.subject} but the authority chain descends from ${top.subject}; two parties cannot pool credentials into one`)
    member = m.subject
    if (m.validUntil) ends = [...ends, m.validUntil]
  }
  const validUntil = ends.reduce((a, b) => (compareInstants(instantOf(a), instantOf(b)) <= 0 ? a : b))
  return { ok: true, subject: leaf.subject, actions: [...leaf.authority.actions], member, validUntil }
}
