// The room's reader for DTG credentials (src/shared/dtg.js).
// Two kinds of test, and they prove different things:
//   known answers: credentials ANOTHER project's code made, with the answer that project published. These are the
//     interop evidence. RLTP's vectors are in test/fixtures/rltp (Apache-2.0, see test/fixtures/NOTICE). Geb's
//     credentials from the 9 November 2026 interopathon and a TrustStackers credential are read from a path in the
//     environment (their repositories give no licence to copy them) and skipped when it is not set.
//   self-made: credentials this file signs in each project's shape. They show the reader is consistent with what
//     the sources say those projects emit; they are not proof that those projects' credentials verify.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DTG_CONTEXTS, VC_V2, checkDtgCredential, compareInstants, describeDtg, dtgDigest, instantOf, openCredential, resolveDidPeer2, verifyAuthorityChain, verifyDtgCredential, withDidPeer2 } from '../src/shared/dtg.js'
import { didKeyOnly } from '../src/shared/chain.js'
import { ed25519, multibase, toHex } from '../src/shared/crypto.js'
import { didPeer4FromDocument, ed25519Multikey, newIdentity } from '../src/shared/did.js'
import { proofConfig, sign, signingInput, verifySignature } from '../src/shared/proof.js'
import { multikeyToEd25519 } from '../src/shared/did.js'
import { createResolver } from '../src/server/resolver.js'

const [REGISTRY, FIRSTPERSON, TRUSTOVERIP] = Object.keys(DTG_CONTEXTS)
const keyFor = withDidPeer2(createResolver().keyFor) // did:key and did:peer:4 with no network, plus did:peer:2
const NOW = Date.parse('2026-11-09T20:00:00Z')
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/rltp/${name}`, import.meta.url), 'utf8'))
const id = (n) => newIdentity(new Uint8Array(32).fill(n))
const community = id(1), member = id(2), other = id(3), agent = id(4)

/** A credential signed the way every project here signs one: the credential's @context copied into the proof. */
const wire = (doc) => JSON.parse(JSON.stringify(doc)) // as it arrives: plain JSON, nothing shared between its parts
const mint = (issuer, body, created = '2026-11-01T00:00:00Z') => wire(sign({ '@context': [VC_V2, REGISTRY], issuer: issuer.did, ...body }, { seed: issuer.seed, verificationMethod: issuer.verificationMethod, created, proofPurpose: 'assertionMethod' }))
/** The membership credential as OpenVTC's trust community mints it (vtc-service/src/credentials/dtg.rs; docs/03-vtc/credentials.md "VMC details"). */
const vmc = (issuer, subject, extra = {}) => mint(issuer, {
  id: 'urn:uuid:11111111-2222-4333-8444-555555555555', type: ['VerifiableCredential', 'DTGCredential', 'MembershipCredential'], issuerScope: 'public',
  validFrom: '2026-11-01T00:00:00Z', validUntil: '2026-12-01T00:00:00Z', credentialSubject: { id: subject },
  credentialStatus: { id: 'https://vtc.example/v1/status-lists/revocation#42', type: 'BitstringStatusListEntry', statusPurpose: 'revocation', statusListIndex: '42', statusListCredential: 'https://vtc.example/v1/status-lists/revocation' },
  ...extra,
})

// ---------- what a DTG credential is ----------

test('a membership credential in OpenVTC\'s shape is read: kind, dates, where its status is', async () => {
  const vc = vmc(community, member.did, { type: ['VerifiableCredential', 'DTGCredential', 'MembershipCredential', 'PersonhoodCredential'] })
  assert.equal(checkDtgCredential(vc), null)
  const r = await verifyDtgCredential(vc, { keyFor, now: NOW })
  assert.equal(r.ok, true); assert.equal(r.checked, true); assert.equal(r.kind, 'membership')
  assert.deepEqual(r.context, { address: REGISTRY, name: 'registry-v1', current: true })
  assert.equal(r.claims.issuer, community.did); assert.equal(r.claims.subject, member.did)
  assert.equal(r.claims.personhood, true, 'PersonhoodCredential rides beside the kind')
  assert.deepEqual(r.claims.status, [{ type: 'BitstringStatusListEntry', purpose: 'revocation', index: '42', list: 'https://vtc.example/v1/status-lists/revocation' }])
  assert.deepEqual(r.notes, []); assert.deepEqual(r.unchecked, [])
})

test('each kind is told from its type, and anything else in the family is verified as "other"', async () => {
  const role = mint(community, { type: ['VerifiableCredential', 'DTGCredential', 'AuthorityCredential'], issuerScope: 'public', validFrom: '2026-11-01T00:00:00Z', validUntil: '2026-12-01T00:00:00Z', credentialSubject: { id: member.did, authority: { scope: community.did, actions: ['role:member'], maxAttenuation: 0 } } })
  const invite = mint(community, { type: ['VerifiableCredential', 'DTGCredential', 'InvitationCredential'], issuerScope: 'public', validFrom: '2026-11-01T00:00:00Z', validUntil: '2026-11-15T00:00:00Z', credentialSubject: { id: member.did, scopes: ['role:member'] } })
  const vrc = mint(member, { type: ['VerifiableCredential', 'DTGCredential', 'RelationshipCredential'], issuerScope: 'pairwise', validFrom: '2026-11-01T00:00:00Z', credentialSubject: { id: other.did } })
  const statement = mint(community, { type: ['VerifiableCredential', 'DTGCredential', 'StatementCredential'], issuerScope: 'public', validFrom: '2026-11-01T00:00:00Z', credentialSubject: { id: member.did, predicate: 'https://registry.trustoverip.org/dtg/vsc/endorses/1', object: { value: { skill: 'weaving' } } } })
  const got = {}
  for (const [name, vc] of Object.entries({ role, invite, vrc, statement })) { const r = await verifyDtgCredential(vc, { keyFor, now: NOW }); assert.equal(r.ok, true, `${name}: ${r.reason}`); got[name] = r }
  assert.equal(got.role.kind, 'authority'); assert.deepEqual(got.role.claims.authority, { scope: community.did, actions: ['role:member'], maxAttenuation: 0 })
  assert.equal(got.invite.kind, 'invitation'); assert.deepEqual(got.invite.claims.scopes, ['role:member'])
  assert.equal(got.vrc.kind, 'relationship')
  assert.equal(got.statement.kind, 'other'); assert.equal(describeDtg(statement).subtype, 'StatementCredential')
  const wrong = await verifyDtgCredential(vrc, { keyFor, now: NOW, kinds: ['membership'] })
  assert.deepEqual([wrong.ok, wrong.problem], [false, 'kind']); assert.match(wrong.reason, /a relationship credential; a membership credential is needed/)
})

test('what is not a DTG credential is refused in words', () => {
  const good = vmc(community, member.did)
  const bad = (change, re) => { const vc = structuredClone(good); change(vc); assert.match(String(checkDtgCredential(vc)), re) }
  assert.match(checkDtgCredential('x'), /an object/)
  bad((v) => { v['@context'] = [REGISTRY, VC_V2] }, /starts with https:\/\/www\.w3\.org\/ns\/credentials\/v2/)
  bad((v) => { v['@context'][1] = 'https://openvtc.org/contexts/dtg-membership-v1.jsonld' }, /the DTG context second/)
  bad((v) => { v.type = ['VerifiableCredential', 'MembershipCredential'] }, /DTGCredential/)
  bad((v) => { v.type = ['VerifiableCredential', 'DTGCredential'] }, /what kind/)
  bad((v) => { v.type.push('RelationshipCredential') }, /exactly one kind/)
  bad((v) => { v.issuer = 'someone' }, /issuer: a DID/)
  bad((v) => { delete v.issuerScope }, /issuerScope/)
  bad((v) => { v.issuerScope = 'Public' }, /issuerScope/)
  bad((v) => { v.validFrom = '2026-02-30T12:00:00Z' }, /validFrom: .* real day/)
  bad((v) => { v.validUntil = '2026-10-01T00:00:00Z' }, /not before validFrom/)
  bad((v) => { v.issuanceDate = v.validFrom }, /say it once/)
  bad((v) => { v.credentialSubject = { name: 'x' } }, /credentialSubject\.id/)
  bad((v) => { v.credentialStatus.statusListIndex = 'forty-two' }, /credentialStatus/)
  bad((v) => { delete v.proof }, /not signed/)
  bad((v) => { v.proof = [] }, /not signed/)
  bad((v) => { v.proof = { type: 'Ed25519Signature2020', proofValue: 'z1' } }, /a Data Integrity proof/)
  bad((v) => { v.proof.cryptosuite = 'mldsa44-jcs-2024' }, /none of its proofs is eddsa-jcs-2022/)
  bad((v) => { v.credentialSubject.pad = 'x'.repeat(50_000) }, /at most 49152 characters/)
  // the two older contexts never had issuerScope: absent is read (and noted), a wrong value is still refused
  const old = structuredClone(good); old['@context'][1] = FIRSTPERSON; delete old.issuerScope
  assert.equal(checkDtgCredential(old), null)
  old.issuerScope = 'everyone'; assert.match(checkDtgCredential(old), /issuerScope/)
})

test('a credential with VC 1.1 date names is read as OpenVTC reads it', async () => {
  const vc = mint(member, { type: ['VerifiableCredential', 'DTGCredential', 'RelationshipCredential'], issuerScope: 'pairwise', issuanceDate: '2026-11-01T00:00:00Z', expirationDate: '2026-12-01T00:00:00Z', credentialSubject: { id: other.did } })
  const r = await verifyDtgCredential(vc, { keyFor, now: NOW })
  assert.equal(r.ok, true); assert.equal(r.claims.validFrom, '2026-11-01T00:00:00Z'); assert.equal(r.claims.validUntil, '2026-12-01T00:00:00Z')
})

// ---------- whether it is genuine ----------

test('a changed credential is refused, and so is one signed by someone other than its issuer', async () => {
  const vc = vmc(community, member.did)
  const changed = structuredClone(vc); changed.credentialSubject.id = other.did
  assert.deepEqual(await verifyDtgCredential(changed, { keyFor, now: NOW }), { ok: false, problem: 'proof', reason: 'signature does not verify' })
  const noStatus = structuredClone(vc); delete noStatus.credentialStatus // stripping the status entry breaks the proof: it is signed
  assert.equal((await verifyDtgCredential(noStatus, { keyFor, now: NOW })).problem, 'proof')
  // signed by `other` while naming the community as issuer: a valid signature by the wrong party
  const forged = sign({ ...structuredClone(vc), proof: undefined }, { seed: other.seed, verificationMethod: other.verificationMethod, created: '2026-11-01T00:00:00Z', proofPurpose: 'assertionMethod' })
  const f = await verifyDtgCredential(forged, { keyFor, now: NOW })
  assert.deepEqual([f.ok, f.problem], [false, 'proof']); assert.match(f.reason, /does not belong to the issuer/)
  // a proof made for signing in, not for making a statement
  const { proof: _p, ...body } = vc
  const login = sign(body, { seed: community.seed, verificationMethod: community.verificationMethod, created: '2026-11-01T00:00:00Z', proofPurpose: 'authentication' })
  assert.match((await verifyDtgCredential(login, { keyFor, now: NOW })).reason, /assertionMethod/)
})

test('the @context is part of what is signed, whichever way the issuer wrote the proof', async () => {
  const vc = vmc(community, member.did)
  assert.deepEqual(vc.proof['@context'], vc['@context'], 'the room, RLTP, Geb, TrustStackers and the trust agent all copy it into the proof')
  // 1. the proof carries the copy: changing either list breaks it
  const swapped = structuredClone(vc); swapped['@context'][1] = FIRSTPERSON; swapped.proof['@context'][1] = FIRSTPERSON
  assert.equal((await verifyDtgCredential(swapped, { keyFor, now: NOW })).problem, 'proof', 'a credential cannot be moved to another DTG context after signing')
  const stripped = structuredClone(vc); delete stripped.proof['@context']
  assert.equal((await verifyDtgCredential(stripped, { keyFor, now: NOW })).problem, 'proof', 'the copy cannot be dropped after signing')
  const longer = structuredClone(vc); longer.proof['@context'].push('https://example.org/extra/v1')
  assert.match((await verifyDtgCredential(longer, { keyFor, now: NOW })).reason, /not the start of the credential's own/)
  // 2. an issuer that never put @context in its proof: verified from the proof exactly as written
  const { proof: _p, ...body } = vc
  const cfg = proofConfig({ verificationMethod: community.verificationMethod, created: '2026-11-01T00:00:00Z', proofPurpose: 'assertionMethod' })
  const bare = { ...body, proof: { ...cfg, proofValue: multibase(ed25519.sign(signingInput(body, cfg), community.seed)) } }
  assert.equal(bare.proof['@context'], undefined)
  assert.equal((await verifyDtgCredential(bare, { keyFor, now: NOW })).ok, true)
  // 3. W3C's rule for a context added after signing: the proof's list must be the start of the credential's, and is what was signed
  const grown = structuredClone(vc); grown['@context'].push('https://example.org/extra/v1')
  assert.equal((await verifyDtgCredential(grown, { keyFor, now: NOW })).ok, true)
})

test('a set of proofs: every one this room can check must hold, and the rest are named, not trusted', async () => {
  const vc = vmc(community, member.did)
  const pq = { type: 'DataIntegrityProof', cryptosuite: 'mldsa44-jcs-2024', created: vc.proof.created, verificationMethod: `${community.did}#key-pq`, proofPurpose: 'assertionMethod', proofValue: 'zNotCheckedHere' }
  const hybrid = { ...vc, proof: [vc.proof, pq] } // OpenVTC with a post-quantum key signs once per key (credentials/signer.rs)
  const r = await verifyDtgCredential(hybrid, { keyFor, now: NOW })
  assert.equal(r.ok, true); assert.deepEqual(r.unchecked, ['mldsa44-jcs-2024'])
  assert.match(r.notes.join(' '), /a proof this room cannot check \(mldsa44-jcs-2024\); only the eddsa-jcs-2022 proof was checked/)
  // a second eddsa proof that does not verify is a refusal, not something to skip
  const second = { ...vc.proof, proofValue: vmc(community, other.did).proof.proofValue }
  assert.equal((await verifyDtgCredential({ ...vc, proof: [vc.proof, second] }, { keyFor, now: NOW })).problem, 'proof')
  // a valid proof from someone else beside the issuer's is refused: one signer
  const { proof: _p, ...body } = vc
  const theirs = sign(body, { seed: other.seed, verificationMethod: other.verificationMethod, created: vc.proof.created, proofPurpose: 'assertionMethod' }).proof
  assert.match((await verifyDtgCredential({ ...vc, proof: [vc.proof, theirs] }, { keyFor, now: NOW })).reason, /does not belong to the issuer/)
  assert.match(checkDtgCredential({ ...vc, proof: [pq] }), /none of its proofs is eddsa-jcs-2022/)
})

test('dates: in force from validFrom until validUntil, with a minute of slack at the start only', async () => {
  const vc = vmc(community, member.did)
  const at = (t, opts) => verifyDtgCredential(vc, { keyFor, now: Date.parse(t), ...opts })
  assert.equal((await at('2026-11-01T00:00:00Z')).ok, true)
  assert.equal((await at('2026-10-31T23:59:30Z')).ok, true, 'thirty seconds early: two clocks that disagree')
  assert.deepEqual([(await at('2026-10-31T23:00:00Z')).problem, (await at('2026-10-31T23:59:30Z', { skewMs: 0 })).problem], ['dates', 'dates'])
  assert.equal((await at('2026-11-30T23:59:59Z')).ok, true)
  const over = await at('2026-12-01T00:00:00Z') // OpenVTC: validUntil exactly now is expired (ingress.rs check_validity_window)
  assert.deepEqual([over.ok, over.problem], [false, 'dates']); assert.match(over.reason, /ran out on 2026-12-01/)
  assert.ok(compareInstants(instantOf('2016-12-31T23:59:60Z'), instantOf('2017-01-01T00:00:00Z')) < 0, 'a leap second comes before the next day')
  assert.ok(compareInstants(instantOf('2026-10-08T12:00:00.000000001Z'), instantOf('2026-10-08T12:00:00.000000002Z')) < 0, 'a nanosecond is kept')
  assert.equal(compareInstants(instantOf('2026-08-23T14:00:00+02:00'), instantOf('2026-08-23T12:00:00Z')), 0)
  assert.equal(instantOf('2026-10-08T12:00:60Z'), null)
})

test('a DID this verifier cannot resolve is "not checked", never "genuine"', async () => {
  const r = await verifyDtgCredential(vmc(community, member.did), { keyFor: async () => null, now: NOW })
  assert.deepEqual([r.ok, r.checked], [true, false])
  const r2 = await verifyDtgCredential(vmc(community, member.did), { keyFor: async () => { throw new Error('no such host') }, now: NOW })
  assert.deepEqual([r2.ok, r2.problem], [false, 'key'])
})

test('a credential in TrustStackers\' shape (its context address, no issuerScope, a did:peer:4 issuer) is read and noted', async () => {
  // packages/core/src/services/dtg-credential.ts: three context addresses, the proof carries the same three, verificationMethod <did>#key-1
  const seed = new Uint8Array(32).fill(9), pub = ed25519.publicKey(seed)
  const did = didPeer4FromDocument({ '@context': ['https://www.w3.org/ns/did/v1'], verificationMethod: [{ id: '#key-1', type: 'Multikey', publicKeyMultibase: ed25519Multikey(pub) }], authentication: ['#key-1'], assertionMethod: ['#key-1'] }).long
  const vc = wire(sign({ '@context': [VC_V2, TRUSTOVERIP, 'https://w3id.org/security/data-integrity/v1'], id: 'urn:uuid:0b9c1c1e-2f0a-4a53-9d53-0a6d7c1f2e11', type: ['VerifiableCredential', 'DTGCredential', 'MembershipCredential'], issuer: did, validFrom: '2026-11-01T00:00:00.000Z', validUntil: '2026-12-01T00:00:00.000Z', credentialSubject: { id: member.did, memberOf: did, membershipRole: 'member' } },
    { seed, verificationMethod: `${did}#key-1`, created: '2026-11-01T00:00:00.000Z', proofPurpose: 'assertionMethod' }))
  const r = await verifyDtgCredential(vc, { keyFor, now: NOW })
  assert.equal(r.ok, true, r.reason); assert.equal(r.checked, true); assert.equal(r.kind, 'membership'); assert.equal(r.context.name, 'trustoverip-v1')
  assert.match(r.notes.join(' | '), /OpenVTC would refuse it/); assert.match(r.notes.join(' | '), /does not say its issuerScope/)
  assert.deepEqual(r.claims.status, [], 'TrustStackers emits no credentialStatus: nothing outside its stack can see a revocation')
})

// ---------- known answers: credentials other projects' code made ----------

test('known answers: RLTP\'s relationship credentials for other implementations (did:peer:2 and did:key), and every negative', async () => {
  const f = fixture('dtg-vrc-foreign.json')
  for (const p of f.positive) {
    const r = await verifyDtgCredential(p.credential, { keyFor, now: NOW })
    assert.equal(r.ok, true, `${p.name}: ${r.reason}`); assert.equal(r.checked, true); assert.equal(r.kind, 'relationship'); assert.equal(r.context.name, 'registry-v1')
  }
  // where RLTP's reader stops, and what the room calls the same refusal
  const here = { context: ['shape'], type: ['shape'], issuerScope: ['shape'], validFrom: ['shape'], 'proof-signature': ['proof'], 'proof-binding': ['proof'], 'proof-key': ['key', 'proof'] }
  assert.equal(f.negative.length, 17)
  for (const n of f.negative) {
    const r = await verifyDtgCredential(n.credential, { keyFor, now: NOW })
    if (n.name === 'context-wd01-iri') { // RLTP's reader is for the current context only. The room reads the retired one too, on purpose, and says so.
      assert.equal(r.ok, true); assert.equal(r.context.name, 'firstperson-wd01'); assert.equal(r.context.current, false); assert.match(r.notes[0], /OpenVTC would refuse it/)
      continue
    }
    assert.equal(r.ok, false, `${n.name} must be refused`)
    assert.ok(here[n.failsAt].includes(r.problem), `${n.name}: RLTP stops at ${n.failsAt}; here ${r.problem}: ${r.reason}`)
  }
})

test('known answers: the RLTP encounter credentials another project\'s verifier read on 9 November 2026', async () => {
  // Project-Weave-Tech/interopathon rltp-geb/README.md, "Direction 2": four accepted, the rewritten one refused. Same file (blob 882fbe4a).
  const e = fixture('encounter-cards.json')
  const accepted = [['current form', e.credential, 'registry-v1'], ['held 0.25 form', e.credential025, 'firstperson-wd01'], ...e.timestampSpelling.accepted.map((a) => [a.name, a.credential, 'registry-v1'])]
  assert.equal(accepted.length, 4)
  for (const [name, vc, context] of accepted) {
    const r = await verifyDtgCredential(vc, { keyFor, now: NOW })
    assert.equal(r.ok, true, `${name}: ${r.reason}`); assert.equal(r.checked, true); assert.equal(r.kind, 'relationship'); assert.equal(r.context.name, context)
  }
  const rewritten = await verifyDtgCredential(e.timestampSpelling.rewritten.credential, { keyFor, now: NOW })
  assert.deepEqual(rewritten, { ok: false, problem: 'proof', reason: 'signature does not verify' }, 'a time re-spelled after signing is a different document')
  const tampered = structuredClone(e.credential); tampered.credentialSubject.challenge = 'u' + 'A'.repeat(43)
  assert.equal((await verifyDtgCredential(tampered, { keyFor, now: NOW })).problem, 'proof')
})

const INTEROPATHON = process.env.INTEROPATHON_DIR // a checkout of Project-Weave-Tech/interopathon (it states no licence, so nothing from it is copied here)
test('known answers: Geb\'s relationship credentials from the 9 November 2026 interopathon', { skip: INTEROPATHON ? false : 'set INTEROPATHON_DIR to a checkout of Project-Weave-Tech/interopathon' }, async () => {
  const g = JSON.parse(readFileSync(join(INTEROPATHON, 'rltp-geb', 'geb-vrcs.json'), 'utf8'))
  for (const [name, hash] of [['response_vrc_by_bob_about_alice', 'response'], ['completion_vrc_by_alice_about_bob', 'completion']]) {
    const vc = g[name]
    const r = await verifyDtgCredential(vc, { keyFor, now: NOW })
    assert.equal(r.ok, true, `${name}: ${r.reason}`); assert.equal(r.checked, true); assert.equal(r.kind, 'relationship'); assert.equal(r.context.name, 'registry-v1')
    const { proofValue: _v, ...cfg } = vc.proof
    assert.equal(toHex(signingInput(vc, cfg)), g.hashData_hex[hash], 'the bytes the room checks the signature over are the bytes Geb signed')
    // the four changes the published tamper check makes
    const change = async (fn) => { const t = structuredClone(vc); fn(t); return verifyDtgCredential(t, { keyFor, now: NOW }) }
    assert.equal((await change((t) => { t.credentialSubject.nonce = '0'.repeat(32) })).problem, 'proof')
    assert.equal((await change((t) => { t.validFrom = '2026-11-09T12:00:01Z' })).problem, 'proof')
    assert.match((await change((t) => { t.proof.verificationMethod = `${t.credentialSubject.id}#key-1` })).reason, /does not belong to the issuer/)
    assert.equal((await change((t) => { t.proof.verificationMethod = `${t.issuer}#key-3` })).problem, 'key', 'a key agreement key signs nothing')
  }
})
test('known answers: the two signed documents RLTP and NAOMS exchanged on 9 November 2026', { skip: INTEROPATHON ? false : 'set INTEROPATHON_DIR to a checkout of Project-Weave-Tech/interopathon' }, async () => {
  for (const file of ['rltp-signed.json', 'naoms-signed.json']) {
    const doc = JSON.parse(readFileSync(join(INTEROPATHON, 'rltp-naoms', file), 'utf8'))
    const key = await didKeyOnly(doc.signer, doc.proof.verificationMethod, doc.proof.proofPurpose)
    assert.equal(verifySignature(doc, key).ok, true, file)
    assert.equal(verifySignature({ ...doc, challenge: doc.challenge.replace(/.$/, (c) => (c === '0' ? '1' : '0')) }, key).ok, false)
    if (doc.proof.domain) assert.equal(verifySignature({ ...doc, proof: { ...doc.proof, domain: 'elsewhere' } }, key).ok, false, 'extra proof members are signed too')
  }
})

const TS_FILE = process.env.TRUSTSTACKERS_CREDENTIAL // a JSON file holding one credential, or a list of them, made by TrustStackers' p2p-trust-stack (GPL-3.0-only: not copied here)
test('known answers: a credential TrustStackers\' own code made', { skip: TS_FILE && existsSync(TS_FILE) ? false : 'set TRUSTSTACKERS_CREDENTIAL to a JSON file of credentials made by p2p-trust-stack (did:peer:4 issuers verify with no network)' }, async () => {
  const list = [JSON.parse(readFileSync(TS_FILE, 'utf8'))].flat()
  assert.ok(list.length > 0)
  for (const vc of list) {
    const r = await verifyDtgCredential(vc, { keyFor: async (d, vm, p) => (d.startsWith('did:scid:') ? null : keyFor(d, vm, p)), now: Date.parse(vc.validFrom) + 1000 })
    assert.equal(r.ok, true, r.reason); assert.equal(r.context.name, 'trustoverip-v1')
    if (String(vc.issuer).startsWith('did:peer:4')) assert.equal(r.checked, true)
    const t = structuredClone(vc); t.credentialSubject.id = other.did
    if (r.checked) assert.equal((await verifyDtgCredential(t, { keyFor, now: Date.parse(vc.validFrom) + 1000 })).problem, 'proof')
  }
})

// ---------- did:peer:2 ----------

test('did:peer:2 is read from the identifier: a key signs only for the purpose it is listed under', async () => {
  const a = id(5), e = 'z6LSbysY2xFMRpGMhb7tFTLMpeuPRaqaWM1yECx2AtzE3KCc' // an X25519 key agreement value (a published example key)
  const mk = ed25519Multikey(a.publicKey), did = `did:peer:2.A${mk}.V${mk}.E${e}.SeyJ0IjoiZG0ifQ`
  const doc = resolveDidPeer2(did)
  assert.deepEqual(doc.verificationMethod.map((m) => m.id), [`${did}#key-1`, `${did}#key-2`, `${did}#key-3`], 'a service part is not a key')
  assert.deepEqual([doc.assertionMethod, doc.authentication, doc.keyAgreement], [[`${did}#key-1`], [`${did}#key-2`], [`${did}#key-3`]])
  assert.deepEqual(await keyFor(did, `${did}#key-1`, 'assertionMethod'), multikeyToEd25519(mk))
  assert.deepEqual(await keyFor(did, `${did}#${mk}`, 'authentication'), multikeyToEd25519(mk), 'a key may also be named by its own value')
  await assert.rejects(keyFor(did, `${did}#key-2`, 'assertionMethod'), /not listed under assertionMethod/)
  await assert.rejects(keyFor(did, `${did}#key-3`, 'assertionMethod'), /not listed under assertionMethod/)
  // OpenVTC also lets a V key make an assertion; the room does only when asked to read it that way
  const vOnly = `did:peer:2.V${mk}`
  await assert.rejects(keyFor(vOnly, `${vOnly}#key-1`, 'assertionMethod'), /not listed/)
  assert.deepEqual(await withDidPeer2(null, { vAsserts: true })(vOnly, `${vOnly}#key-1`, 'assertionMethod'), multikeyToEd25519(mk))
  for (const bad of ['did:peer:2', 'did:peer:2.', 'did:peer:2.Xz6Mk', 'did:peer:2.SeyJ0IjoiZG0ifQ']) assert.throws(() => resolveDidPeer2(bad))
})

// ---------- a chain of authority, as OpenVTC's room host checks one ----------

const room = id(10), owner = id(11), helper = id(12), stranger = id(13)
const vac = (issuer, subject, authority, extra = {}) => mint(issuer, { id: `urn:uuid:${toHex(ed25519.publicKey(issuer.seed)).slice(0, 8)}-${subject.slice(-6)}-${authority.actions.join('')}`, type: ['VerifiableCredential', 'DTGCredential', 'AuthorityCredential'], issuerScope: issuer === room ? 'public' : 'directed', validFrom: '2026-11-09T00:00:00Z', validUntil: '2026-12-09T00:00:00Z', credentialSubject: { id: subject, authority }, ...extra })
// the fixture of vti-rooms-dtg/src/lib.rs: the room grants its owner read and write; the owner narrows it to read for an agent; the room issues the owner's membership
const ownerVac = vac(room, owner.did, { scope: room.did, actions: ['read', 'write'] })
const agentVac = vac(owner, helper.did, { scope: room.did, actions: ['read'], parent: dtgDigest(ownerVac) }, { validUntil: '2026-11-10T00:00:00Z' })
const ownerVmc = mint(room, { type: ['VerifiableCredential', 'DTGCredential', 'MembershipCredential'], issuerScope: 'public', validFrom: '2026-11-09T00:00:00Z', validUntil: '2026-12-09T00:00:00Z', credentialSubject: { id: owner.did } })
const chainOpts = (o) => ({ root: room.did, keyFor, now: NOW, ...o })

test('a chain the room issued authorizes its owner, and a narrowed one authorizes the agent for less', async () => {
  const o = await verifyAuthorityChain([ownerVac], chainOpts({ action: 'write', presenter: owner.did, membership: ownerVmc }))
  assert.deepEqual(o, { ok: true, subject: owner.did, actions: ['read', 'write'], member: owner.did, validUntil: '2026-12-09T00:00:00Z' })
  const a = await verifyAuthorityChain([agentVac, ownerVac], chainOpts({ action: 'read', presenter: helper.did, membership: ownerVmc }))
  assert.deepEqual(a, { ok: true, subject: helper.did, actions: ['read'], member: owner.did, validUntil: '2026-11-10T00:00:00Z' }, 'the agent acts as itself; the member is its person; it ends when the first credential does')
  const w = await verifyAuthorityChain([agentVac, ownerVac], chainOpts({ action: 'write', presenter: helper.did }))
  assert.deepEqual([w.ok, w.problem, w.reason], [false, 'action', 'the chain does not confer write'])
  // base64url and JSON text are the same credential
  const b64 = (vc) => Buffer.from(JSON.stringify(vc)).toString('base64url')
  assert.equal((await verifyAuthorityChain([b64(agentVac), JSON.stringify(ownerVac)], chainOpts({ action: 'read', presenter: helper.did, membership: b64(ownerVmc) }))).ok, true)
  assert.equal(openCredential('not a credential'), null)
})

test('a chain is bound to who presents it, and to the room it is for', async () => {
  const p = await verifyAuthorityChain([agentVac, ownerVac], chainOpts({ action: 'read', presenter: owner.did }))
  assert.deepEqual([p.ok, p.problem], [false, 'presenter']); assert.match(p.reason, /but it was presented by/)
  assert.equal((await verifyAuthorityChain([ownerVac], chainOpts({ action: 'read' }))).problem, 'presenter', 'a presenter must be known')
  // perfectly valid credentials rooted at someone who is not the room confer nothing
  const elsewhere = vac(stranger, owner.did, { scope: room.did, actions: ['read', 'write', 'admin'] })
  const e = await verifyAuthorityChain([elsewhere], chainOpts({ action: 'admin', presenter: owner.did }))
  assert.deepEqual([e.ok, e.problem], [false, 'chain']); assert.match(e.reason, /does not confer this: its last credential is issued by/)
  // a grant for another room's scope
  const otherScope = vac(room, owner.did, { scope: stranger.did, actions: ['read'] })
  assert.match((await verifyAuthorityChain([otherScope], chainOpts({ presenter: owner.did }))).reason, /is for did:key:.*, not did:key:/)
  // the narrowed link alone, without the grant it descends from
  assert.match((await verifyAuthorityChain([agentVac], chainOpts({ presenter: helper.did }))).reason, /issued by/)
})

test('a link cannot widen, skip its parent, outlive its dates or go deeper than allowed', async () => {
  const refuses = async (chain, opts, re) => { const r = await verifyAuthorityChain(chain, chainOpts(opts)); assert.equal(r.ok, false); assert.match(r.reason, re) }
  // tampering: `admin` added to the room's signed grant
  const widened = structuredClone(ownerVac); widened.credentialSubject.authority.actions.push('admin')
  await refuses([widened], { action: 'admin', presenter: owner.did }, /authority credential 0: signature does not verify/)
  // an honest signature on a link that adds an action its parent never had
  const greedy = vac(owner, helper.did, { scope: room.did, actions: ['read', 'admin'], parent: dtgDigest(ownerVac) })
  await refuses([greedy, ownerVac], { presenter: helper.did }, /adds an action/)
  // a link issued by someone the link above did not grant to
  const sideways = vac(stranger, helper.did, { scope: room.did, actions: ['read'], parent: dtgDigest(ownerVac) })
  await refuses([sideways, ownerVac], { presenter: helper.did }, /not by did:key:.* who was granted the one above/)
  // a link that names no parent, or another credential
  await refuses([vac(owner, helper.did, { scope: room.did, actions: ['read'] }), ownerVac], { presenter: helper.did }, /does not name the one presented above it/)
  await refuses([vac(owner, helper.did, { scope: room.did, actions: ['read'], parent: dtgDigest(ownerVmc) }), ownerVac], { presenter: helper.did }, /does not name the one presented above it/)
  // the older form (the parent's id) is read too
  assert.equal((await verifyAuthorityChain([vac(owner, helper.did, { scope: room.did, actions: ['read'], parent: ownerVac.id }), ownerVac], chainOpts({ presenter: helper.did }))).ok, true)
  // a community role: maxAttenuation 0 means it cannot be handed on (vtc-service/src/credentials/dtg.rs ROLE_VAC_MAX_ATTENUATION)
  const role = vac(room, owner.did, { scope: room.did, actions: ['role:admin'], maxAttenuation: 0 })
  await refuses([vac(owner, helper.did, { scope: room.did, actions: ['role:admin'], parent: dtgDigest(role) }), role], { presenter: helper.did }, /may not be narrowed further/)
  // dates: the agent's link ran out a day later
  const late = await verifyAuthorityChain([agentVac, ownerVac], chainOpts({ presenter: helper.did, now: Date.parse('2026-11-10T00:00:01Z') }))
  assert.deepEqual([late.ok, late.problem], [false, 'dates'])
  await refuses([vac(room, owner.did, { scope: room.did, actions: ['read'] }, { validUntil: undefined })], { presenter: owner.did }, /must say when it ends/)
  // length
  await refuses([], { presenter: owner.did }, /at least one/)
  await refuses(Array(9).fill(ownerVac), { presenter: owner.did }, /9 links; at most 8/)
  await refuses([ownerVmc], { presenter: owner.did }, /a membership credential; an authority credential is needed/)
})

test('membership and authority must be one member\'s: two people cannot pool them', async () => {
  const theirVmc = mint(room, { type: ['VerifiableCredential', 'DTGCredential', 'MembershipCredential'], issuerScope: 'public', validFrom: '2026-11-09T00:00:00Z', credentialSubject: { id: stranger.did } })
  const pooled = await verifyAuthorityChain([ownerVac], chainOpts({ presenter: owner.did, membership: theirVmc }))
  assert.deepEqual([pooled.ok, pooled.problem], [false, 'membership']); assert.match(pooled.reason, /cannot pool credentials into one/)
  const elsewhere = mint(stranger, { type: ['VerifiableCredential', 'DTGCredential', 'MembershipCredential'], issuerScope: 'public', validFrom: '2026-11-09T00:00:00Z', credentialSubject: { id: owner.did } })
  assert.match((await verifyAuthorityChain([ownerVac], chainOpts({ presenter: owner.did, membership: elsewhere }))).reason, /was issued by .*, not by/)
  const expired = mint(room, { type: ['VerifiableCredential', 'DTGCredential', 'MembershipCredential'], issuerScope: 'public', validFrom: '2026-10-01T00:00:00Z', validUntil: '2026-11-01T00:00:00Z', credentialSubject: { id: owner.did } })
  assert.equal((await verifyAuthorityChain([ownerVac], chainOpts({ presenter: owner.did, membership: expired }))).problem, 'dates')
})
