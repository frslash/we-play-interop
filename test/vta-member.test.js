// What the agent bridge asks of a person's own trust agent to join a community and enter its encrypted room
// (agent/vta.js: signDocument, keyPackage, welcome, the vault calls, actAsMember), against the stand-in trust agent in
// test/helpers/fake-vti.js. The stand-in follows the wire of each task's bundle; it proves the bridge's side is
// self-consistent, not interop (test/live/vta-member-live.test.js is the check against a real trust agent).
import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'
import { canonicalize } from '../src/shared/crypto.js'
import { keyFromDidDocument } from '../src/shared/chain.js'
import { newIdentity, resolveDidKey } from '../src/shared/did.js'
import { sign, verifySignature } from '../src/shared/proof.js'
import { instant, typeUri } from '../src/shared/trusttask.js'
import { Vta, VtiError, decodeCredential, safeAddress } from '../agent/vta.js'
import { startFakeVti } from './helpers/fake-vti.js'

const noWait = async () => {}
const fakes = []
after(() => Promise.all(fakes.map((f) => f.close())))
/** A trust agent holding one persona (the person's member) and a Vta signed in to it; `later` the room, if wanted. */
async function world (opts = {}, credentialOpts) {
  const fake = await startFakeVti(opts); fakes.push(fake)
  const persona = fake.persona()
  const vta = new Vta({ credential: decodeCredential(fake.credential([persona], credentialOpts)), sleep: noWait })
  return { fake, persona, vta }
}
const proofOk = (doc, did, purpose) => verifySignature(doc, keyFromDidDocument(resolveDidKey(did), did, doc.proof.verificationMethod, purpose)).ok
const rejects = async (p, code) => assert.rejects(p, (e) => e instanceof VtiError && e.code === code, `expected VtiError ${code}`)

describe('sign a document as the persona', () => {
  test('the proof verifies, the key is found once past a revoked copy and a key no DID lists, and kept', async () => {
    const { fake, persona, vta } = await world({ keysPageSize: 1 }) // one key a page: the cursor is followed
    const doc = { '@context': ['https://www.w3.org/ns/credentials/v2'], type: ['VerifiableCredential'], issuer: persona, credentialSubject: { id: 'did:example:x' } }
    const r = await vta.signDocument(doc)
    assert.equal(r.signerDid, persona)
    assert.equal(r.proof.proofPurpose, 'assertionMethod')
    assert.ok(proofOk(r.document, persona, 'assertionMethod'))
    assert.deepEqual({ ...r.document, proof: undefined }, { ...doc, proof: undefined })
    const pages = fake.seen.vta[typeUri('keys/list', '0.2')]
    assert.equal(pages, 2, 'the decoy first, then the persona\'s own key')
    await vta.signDocument(doc, { proofPurpose: 'authentication' }) // another purpose: found again, once
    await vta.signDocument(doc)
    assert.equal(fake.seen.vta[typeUri('keys/list', '0.2')], 4, 'a kept key is not looked up again')
    assert.equal(vta.counts.signed, 3)
  })
  test('challenge, domain and a controller-named document pass through into the proof', async () => {
    const { persona, vta } = await world()
    const r = await vta.signDocument({ controller: [persona], note: 'x' }, { challenge: 'abc', domain: 'example.org' })
    assert.equal(r.proof.challenge, 'abc'); assert.equal(r.proof.domain, 'example.org')
    assert.ok(proofOk(r.document, persona, 'assertionMethod'))
  })
  test('a document with a proof, or naming no signer, is refused before anything is sent', async () => {
    const { fake, persona, vta } = await world()
    await rejects(vta.signDocument({ issuer: persona, proof: { x: 1 } }), 'malformedRequest')
    await rejects(vta.signDocument({ note: 'no signer' }), 'malformedRequest')
    assert.equal(fake.seen.vta[typeUri('keys/sign-document', '0.1')], undefined)
    assert.equal(vta.counts.signed, 0); assert.equal(vta.last.ok, false)
  })
  test('a DID this trust agent holds no key for is refused here; a named key for another DID is refused by the trust agent', async () => {
    const { fake, persona, vta } = await world()
    const other = newIdentity().did
    await rejects(vta.signDocument({ issuer: other }), 'taskFailed')
    assert.equal(fake.seen.vta[typeUri('keys/sign-document', '0.1')], undefined)
    const keys = (await vta.call('keys/list', '0.2', {})).keys
    await rejects(vta.signDocument({ issuer: other }, { keyId: keys.at(-1).keyId }), 'keys/sign-document:issuerMismatch')
    void persona
  })
  test('a delegate credential is refused', async () => {
    const { persona, vta } = await world({}, { delegate: true })
    await rejects(vta.signDocument({ issuer: persona }), 'permissionDenied')
  })
  test('an answer naming another signer is indeterminate; so is a document that was changed on the way', async () => {
    const { fake, persona, vta } = await world()
    fake.alter['keys/sign-document'] = (p) => ({ ...p, signerDid: newIdentity().did })
    await rejects(vta.signDocument({ issuer: persona }), 'indeterminate')
    fake.alter['keys/sign-document'] = (p) => ({ ...p, document: { ...p.document, note: 'edited' } })
    await rejects(vta.signDocument({ issuer: persona }), 'indeterminate')
    assert.equal(vta.counts.signed, 0)
  })
  test('a proof that does not verify is indeterminate', async () => {
    const { fake, persona, vta } = await world()
    const forged = newIdentity()
    fake.alter['keys/sign-document'] = (p) => { const { proof: _p, ...body } = p.document; const s = sign(body, { seed: forged.seed, verificationMethod: p.proof.verificationMethod, created: p.proof.created, proofPurpose: 'assertionMethod' }); return { ...p, document: s, proof: s.proof } }
    await rejects(vta.signDocument({ issuer: persona }), 'indeterminate')
  })
})

describe('a KeyPackage and a Welcome for a room', () => {
  async function invited () {
    const w = await world()
    const owner = w.fake.persona(), room = w.fake.room(owner), otherRoom = w.fake.room(owner)
    return { ...w, room, otherRoom, invitation: w.fake.invite(room, w.persona) }
  }
  test('twice gives the same package, then alreadyMinted', async () => {
    const { vta, room, invitation } = await invited()
    const a = await vta.keyPackage(room, invitation), b = await vta.keyPackage(room, invitation)
    assert.equal(a.alreadyMinted, false); assert.equal(b.alreadyMinted, true)
    assert.equal(a.keyPackage, b.keyPackage); assert.equal(a.expiresAt, b.expiresAt)
    assert.match(a.keyPackage, /^[A-Za-z0-9_-]+$/)
    assert.equal(vta.counts.keyPackages, 2)
  })
  test('another room\'s invitation is notInvited', async () => {
    const { vta, otherRoom, invitation } = await invited()
    await rejects(vta.keyPackage(otherRoom, invitation), 'rooms/keys/key-package:notInvited')
    assert.equal(vta.counts.keyPackages, 0); assert.equal(vta.counts.refused, 1)
  })
  test('a welcome joins and gives the epoch; a second with the same invitation reads as success', async () => {
    const { fake, vta, room, invitation, persona } = await invited()
    const { keyPackage } = await vta.keyPackage(room, invitation)
    const w = fake.welcomeFor(keyPackage)
    const first = await vta.welcome(room, { welcome: w, invitation })
    assert.ok(Number.isInteger(first.epoch) && first.epoch >= 0); assert.equal(first.alreadyJoined, false)
    assert.equal(fake.epochOf(room, persona) - 1, first.epoch)
    const again = await vta.welcome(room, { welcome: w, invitation })
    assert.deepEqual(again, { epoch: null, alreadyJoined: true })
    assert.equal(vta.counts.welcomes, 2); assert.equal(vta.counts.refused, 0, 'a join already made is not a failure'); assert.equal(vta.last.ok, true)
  })
  test('a welcome without a matching invitation is refused, and so is one for a KeyPackage this trust agent did not mint', async () => {
    const { fake, vta, room, invitation, otherRoom } = await invited()
    const { keyPackage } = await vta.keyPackage(room, invitation)
    await rejects(vta.welcome(room, { welcome: fake.welcomeFor(keyPackage) }), 'rooms/keys/welcome:notInvited')
    await rejects(vta.welcome(otherRoom, { welcome: fake.welcomeFor(keyPackage), invitation }), 'rooms/keys/welcome:notInvited')
    await rejects(vta.welcome(room, { welcome: fake.welcomeFor('bm90LW1pbnRlZA'), invitation }), 'rooms/keys/welcome:welcomeInvalid')
    assert.equal(vta.counts.welcomes, 0)
  })
})

describe('the person\'s own vault', () => {
  const membership = (issuer, subject) => sign({ '@context': ['https://www.w3.org/ns/credentials/v2'], type: ['VerifiableCredential', 'MembershipCredential'], id: 'urn:uuid:11111111-1111-4111-8111-111111111111', issuer: issuer.did, credentialSubject: { id: subject, community: 'did:example:community' } }, { seed: issuer.seed, verificationMethod: issuer.verificationMethod, created: instant(), proofPurpose: 'assertionMethod' })
  test('receive, then query by type finds it; get returns the body byte for byte', async () => {
    const { persona, vta } = await world()
    const vmc = membership(newIdentity(), persona)
    const stored = await vta.receiveCredential(vmc)
    assert.equal(stored.status, 'valid'); assert.ok(stored.types.includes('MembershipCredential'))
    const found = await vta.queryCredentials({ type: 'MembershipCredential' })
    assert.deepEqual(found.map((c) => c.id), [stored.id]); assert.equal(found[0].purpose, 'membership')
    assert.equal(JSON.stringify(found[0]).includes('community'), false, 'a descriptor carries no body')
    const got = await vta.getCredential(stored.id)
    assert.equal(got.format, 'ldp_vc'); assert.equal(JSON.stringify(got.credential), JSON.stringify(vmc))
    assert.equal(vta.counts.credentialsStored, 1)
  })
  test('a handle can be chosen; a query without a filter is refused before sending; a credential that does not verify is refused', async () => {
    const { fake, persona, vta } = await world()
    const vmc = membership(newIdentity(), persona)
    assert.equal((await vta.receiveCredential(vmc, { id: 'my-pass' })).id, 'my-pass')
    await rejects(vta.queryCredentials({ subjectDid: persona }), 'malformedRequest')
    assert.equal(fake.seen.vta[typeUri('vault/credentials/query', '0.1')], undefined)
    assert.deepEqual(await vta.queryCredentials({ type: 'NoSuchType' }), [])
    await rejects(vta.receiveCredential({ ...vmc, credentialSubject: { id: persona, community: 'other' } }), 'vault/credentials/receive:verificationFailed')
    await rejects(vta.getCredential('nothing'), 'vault/credentials/get:notFound')
  })
  test('a compact credential goes in as base64url and comes back as it was stored', async () => {
    const { vta } = await world()
    const r = await vta.receiveCredential('eyJhbGciOiJFZERTQSJ9.e30.c2ln~', { id: 'sd', format: 'dc+sd-jwt' })
    const got = await vta.getCredential(r.id)
    assert.equal(Buffer.from(got.credentialBase64, 'base64url').toString(), 'eyJhbGciOiJFZERTQSJ9.e30.c2ln~'); assert.equal(got.format, 'dc+sd-jwt')
  })
})

describe('community requests completed as the member', () => {
  const request = (type, payload, member) => ({ id: `urn:uuid:${crypto.randomUUID()}`, type, recipient: 'did:example:community', issuedAt: instant(), payload, ...(member ? {} : {}) })
  test('offers/list: the issuer is set, the proof is the member\'s under authentication', async () => {
    const { persona, vta } = await world()
    const d = await vta.actAsMember(request(typeUri('vtc/rooms/offers/list', '0.4'), {}), persona)
    assert.equal(d.issuer, persona); assert.equal(d.proof.proofPurpose, 'authentication'); assert.ok(proofOk(d, persona, 'authentication'))
  })
  test('offers/accept completes only with a KeyPackage the trust agent minted', async () => {
    const { fake, persona, vta } = await world()
    const owner = fake.persona(), room = fake.room(owner), invitation = fake.invite(room, persona)
    const type = typeUri('vtc/rooms/offers/accept', '0.1')
    await rejects(vta.actAsMember(request(type, { roomId: room, keyPackage: 'bm90LW1pbnRlZA' }), persona), 'rooms/keys/act:keyPackageNotHeld')
    const { keyPackage } = await vta.keyPackage(room, invitation)
    const d = await vta.actAsMember(request(type, { roomId: room, keyPackage }), persona)
    assert.equal(d.payload.keyPackage, keyPackage)
  })
  test('a member the credential may not act as is refused by the trust agent', async () => {
    const { vta } = await world()
    await rejects(vta.actAsMember(request(typeUri('vtc/rooms/offers/list', '0.4'), {}), newIdentity().did), 'rooms/keys/act:issuerNotPrincipal')
  })
  test('a changed payload, a changed id, or a proof by someone else is refused', async () => {
    const { fake, persona, vta } = await world()
    const type = typeUri('vtc/rooms/offers/list', '0.4')
    fake.alter['rooms/keys/act'] = (p) => ({ ...p, document: { ...p.document, payload: { ...p.document.payload, extra: 1 } } })
    await rejects(vta.actAsMember(request(type, {}), persona), 'indeterminate')
    fake.alter['rooms/keys/act'] = (p) => ({ ...p, document: { ...p.document, id: 'urn:uuid:other' } })
    await rejects(vta.actAsMember(request(type, {}), persona), 'indeterminate')
    const forged = newIdentity()
    fake.alter['rooms/keys/act'] = (p) => { const { proof: _p, ...body } = p.document; return { ...p, document: sign(body, { seed: forged.seed, verificationMethod: p.document.proof.verificationMethod, created: instant(), proofPurpose: 'authentication' }) } }
    await rejects(vta.actAsMember(request(type, {}), persona), 'indeterminate')
  })
  test('what is sent is canonical-equal to what came back, apart from the proof', async () => {
    const { persona, vta } = await world()
    const sent = request(typeUri('vtc/rooms/memberships/list', '0.2'), { cursor: 'c' })
    const { proof: _p, ...rest } = await vta.actAsMember(sent, persona)
    assert.equal(canonicalize(rest), canonicalize({ ...sent, issuer: persona }))
  })
})

test('a plain http:// trust agent address is taken only for this machine: the sign-in token must not cross a network in the clear', () => {
  for (const u of ['https://vta.example', 'http://127.0.0.1:8100', 'http://localhost:8100', 'http://agent.localhost', 'http://[::1]:8100']) assert.equal(safeAddress(u), true, u)
  for (const u of ['http://vta.example', 'http://10.0.0.5:8100', 'http://localhost.example.com', 'ftp://vta.example', 'not a url', '']) assert.equal(safeAddress(u), false, u)
  const credential = { did: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH', vtaDid: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH' }
  assert.throws(() => new Vta({ credential, url: 'http://vta.example' }), /in the clear/)
  assert.ok(new Vta({ credential, url: 'http://127.0.0.1:9' }))
  assert.ok(new Vta({ credential, url: 'https://vta.example' }))
})
