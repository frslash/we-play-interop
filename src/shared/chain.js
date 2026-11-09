// The log is a hash chain. Each entry is
//   { seq, parent, timestamp, author, onBehalfOf, delegation?, type, document, hash, witness }
// where hash = SHA-256(JCS(everything but hash and witness)), parent is the hash
// of the entry before it, document is the signed Trust Task document exactly as
// received, and witness is the workspace's eddsa-jcs-2022 signature over the
// same fields (the workspace saying "I put this here, at this place").
// verifyChain re-checks all of it; anyone can run it on the public log,
// including each permission signed as a credential and every write made under one.
import { canonicalize, fromBase58btc, sha256, toHex } from './crypto.js'
import { credentialRefuses, grantMismatch, verifyPermissionCredential } from './credential.js'
import { multikeyToEd25519, resolveDidKey, SIGNING_RELATIONSHIPS } from './did.js'
import { verifySignature } from './proof.js'
import { NAME_OF, TYPES } from './types.js'

export const entryCore = ({ hash, witness, ...core }) => core
export const hashCore = (core) => toHex(sha256(canonicalize(core)))

const b64urlToBytes = (s) => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

/** The Ed25519 key a DID document authorizes for one proof purpose, per Trust Tasks §4.7.3. */
export function keyFromDidDocument (didDoc, issuer, vmRef, purpose) {
  if (!SIGNING_RELATIONSHIPS.includes(purpose)) throw new Error(`proofPurpose ${purpose} cannot sign`)
  if (didDoc.id !== issuer) throw new Error('DID document id is not the issuer')
  const abs = (ref) => (typeof ref === 'string' && ref.startsWith('#') ? didDoc.id + ref : ref)
  const target = abs(vmRef)
  const rel = didDoc[purpose] ?? []
  let vm = null
  for (const r of rel) {
    if (typeof r === 'string' && abs(r) === target) vm = (didDoc.verificationMethod ?? []).find((m) => abs(m.id) === target)
    else if (r && typeof r === 'object' && abs(r.id) === target) vm = r
    if (vm) break
  }
  if (!vm) throw new Error(`${vmRef} is not listed under ${purpose}`)
  if ((vm.controller ?? didDoc.id) !== issuer) throw new Error('verification method belongs to another controller')
  if (vm.publicKeyMultibase && (vm.type === 'Multikey' || vm.type === 'Ed25519VerificationKey2020')) return multikeyToEd25519(vm.publicKeyMultibase)
  if (vm.publicKeyBase58 && vm.type === 'Ed25519VerificationKey2018') return fromBase58btc(vm.publicKeyBase58)
  if (vm.publicKeyJwk?.kty === 'OKP' && vm.publicKeyJwk.crv === 'Ed25519') return b64urlToBytes(vm.publicKeyJwk.x)
  throw new Error(`unsupported verification method ${vm.type}`)
}

/** Key lookup that works anywhere, for did:key only (others return null = not checked here). */
export const didKeyOnly = async (did, vmRef, purpose) => did.startsWith('did:key:') ? keyFromDidDocument(resolveDidKey(did), did, vmRef, purpose) : null

/**
 * Verify a whole log. keyFor(did, verificationMethod, proofPurpose) resolves a key
 * (or returns null when this verifier cannot resolve that DID method).
 */
export async function verifyChain (entries, { keyFor = didKeyOnly } = {}) {
  const problems = []
  let checked = 0, skipped = 0, prev = null, workspace = null
  const delegations = new Map() // hash -> { issuer, delegate, scope, expiresAt, revokedAt, credential }
  const bad = (seq, problem) => problems.push({ seq, problem })
  for (const [i, e] of entries.entries()) {
    const core = entryCore(e)
    if (e.seq !== i) bad(e.seq, `expected seq ${i}`)
    if (e.parent !== (prev ? prev.hash : null)) bad(e.seq, 'parent does not point at the entry before')
    if (hashCore(core) !== e.hash) bad(e.seq, 'hash does not match the entry')
    const doc = e.document
    if (i === 0) {
      if (e.type !== TYPES.genesis) bad(0, 'the first entry is not the genesis')
      workspace = e.author
    }
    if (e.type !== doc?.type) bad(e.seq, 'entry type differs from the document type')
    if (e.author !== doc?.issuer) bad(e.seq, 'author is not the document issuer')
    if ((doc?.onBehalfOf ?? doc?.issuer) !== e.onBehalfOf) bad(e.seq, 'onBehalfOf differs from the document')
    for (const [what, signed, did] of [['witness', { ...core, proof: e.witness }, workspace], ['document proof', doc, doc?.issuer]]) {
      try {
        const key = await keyFor(did, signed.proof?.verificationMethod, signed.proof?.proofPurpose)
        if (!key) { skipped++; continue }
        const r = verifySignature(signed, key)
        if (!r.ok) bad(e.seq, `${what}: ${r.reason}`)
      } catch (err) { bad(e.seq, `${what}: ${err.message}`) }
    }
    // Agents: the delegation they name must be from their human, cover the type, and be live.
    const name = NAME_OF[e.type]
    if (doc?.onBehalfOf) {
      const d = delegations.get(doc.delegation)
      if (!d) bad(e.seq, 'names a delegation that is not earlier in the log')
      else {
        if (d.issuer !== doc.onBehalfOf || d.delegate !== doc.issuer) bad(e.seq, 'delegation is not from this human to this agent')
        if (!d.scope.includes(name)) bad(e.seq, `delegation does not cover ${name}`)
        if (Date.parse(e.timestamp) >= Date.parse(d.expiresAt)) bad(e.seq, 'delegation had expired')
        if (d.revokedAt && d.revokedAt <= e.seq) bad(e.seq, 'delegation had been revoked')
        // the grant is earlier in the log than the write, so only the end of the window is checked against the time
        const no = d.credential && credentialRefuses(d.credential, { agent: doc.issuer, person: doc.onBehalfOf, room: workspace, kind: name === 'approve' ? 'vote' : name, at: Date.parse(e.timestamp), slackMs: Infinity })
        if (no) bad(e.seq, `credential: ${no.message}`)
      }
    }
    if (name === 'delegate') {
      let credential = null
      if (doc.payload?.credential !== undefined) {
        const r = await verifyPermissionCredential(doc.payload.credential, { keyFor })
        const why = r.ok ? grantMismatch(r.claims, doc, workspace) : r.reason
        if (why) bad(e.seq, `the permission's credential: ${why}`)
        else { credential = r.claims; if (!r.checked) skipped++ }
      }
      delegations.set(e.hash, { issuer: doc.issuer, delegate: doc.payload.delegate, scope: doc.payload.scope, expiresAt: doc.expiresAt, credential })
    }
    if (name === 'revoke') { const d = delegations.get(doc.payload.delegation); if (d && d.issuer === doc.issuer && !d.revokedAt) d.revokedAt = e.seq }
    checked++
    prev = e
  }
  return { ok: problems.length === 0, entries: entries.length, checked, signaturesNotChecked: skipped, head: prev ? { seq: prev.seq, hash: prev.hash } : null, problems: problems.slice(0, 200) }
}
