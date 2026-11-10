// A person's permission for their agent, signed as a W3C Verifiable Credential
// (VC 2.0, eddsa-jcs-2022), carried on the grant line and checked on every write.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { canonicalize, ed25519, fromMultibase, sha256, toHex } from '../src/shared/crypto.js'
import { didKeyOnly } from '../src/shared/chain.js'
import { credentialRefuses, grantMismatch, PERMISSION_TYPE, permissionCredential, signPermissionCredential, VC_V2, verifyPermissionCredential } from '../src/shared/credential.js'
import { newIdentity } from '../src/shared/did.js'
import { DTG_CONTEXT } from '../src/shared/dtg-context.js'
import { sign, verifySignature } from '../src/shared/proof.js'
import { TYPES, signedDocument } from '../src/shared/types.js'
import { config as baseConfig } from '../src/server/config.js'
import { createApp } from '../src/server/index.js'

const ROOM = newIdentity().did
const clone = (x) => JSON.parse(JSON.stringify(x))

describe('the permission as a credential', () => {
  test('the eddsa-jcs-2022 proof reproduces the W3C spec\'s own test vector', () => {
    // vc-di-eddsa, "Representation: eddsa-jcs-2022": the key pair, the credential and the expected proofValue
    const secret = fromMultibase('z3u2en7t5LR2WtQH5PfFqMqwVHBeXouLzo6haApm8XHqvjxq')
    assert.deepEqual([...secret.slice(0, 2)], [0x80, 0x26]) // multicodec ed25519-priv
    const seed = secret.slice(2)
    const vm = 'did:key:z6MkrJVnaZkeFzdQyMZu1cgjg7k1pZZ6pvBQ7XJPt4swbTQ2#z6MkrJVnaZkeFzdQyMZu1cgjg7k1pZZ6pvBQ7XJPt4swbTQ2'
    const credential = {
      '@context': ['https://www.w3.org/ns/credentials/v2', 'https://www.w3.org/ns/credentials/examples/v2'],
      id: 'urn:uuid:58172aac-d8ba-11ed-83dd-0b3aef56cc33', type: ['VerifiableCredential', 'AlumniCredential'],
      name: 'Alumni Credential', description: 'A minimum viable example of an Alumni Credential.',
      issuer: 'https://vc.example/issuers/5678', validFrom: '2023-01-01T00:00:00Z',
      credentialSubject: { id: 'did:example:abcdefgh', alumniOf: 'The School of Examples' },
    }
    assert.equal(toHex(sha256(canonicalize(credential))), '59b7cb6251b8991add1ce0bc83107e3db9dbbab5bd2c28f687db1a03abc92f19')
    const signed = sign(credential, { seed, verificationMethod: vm, created: '2023-02-24T23:36:38Z', proofPurpose: 'assertionMethod' })
    const { proofValue, ...cfg } = signed.proof
    assert.equal(toHex(sha256(canonicalize(cfg))), '66ab154f5c2890a140cb8388a22a160454f80575f6eae09e5a097cabe539a1db')
    assert.equal(proofValue, 'z2HnFSSPPBzR36zdDgK8PbEHeXbR56YF24jwMpt3R1eHXQzJDMWS93FCzpvJpwTWd3GAVFuUfjoJdcnTMuVor51aX')
    assert.equal(verifySignature(signed, ed25519.publicKey(seed)).ok, true)
  })

  test('a credential round-trips (made, signed, verified) and a tampered one fails', async () => {
    const person = newIdentity(), agent = newIdentity()
    const from = new Date().toISOString(), until = new Date(Date.now() + 86400000).toISOString()
    const c = signPermissionCredential(person, { agent: agent.did, room: ROOM, scope: ['note', 'vote'], ask: ['vote'], validFrom: from, validUntil: until })
    assert.deepEqual(c['@context'], [VC_V2, DTG_CONTEXT]); assert.deepEqual(c.type, ['VerifiableCredential', PERMISSION_TYPE])
    assert.equal(c.issuer, person.did); assert.equal(c.validFrom, from); assert.equal(c.validUntil, until)
    assert.deepEqual(c.credentialSubject, { id: agent.did, room: ROOM, scope: ['note', 'vote'], askFirst: ['vote'] })
    assert.equal(c.proof.cryptosuite, 'eddsa-jcs-2022'); assert.equal(c.proof.proofPurpose, 'assertionMethod'); assert.match(c.proof.proofValue, /^z[1-9A-HJ-NP-Za-km-z]+$/)
    const r = await verifyPermissionCredential(clone(c), { keyFor: didKeyOnly })
    assert.equal(r.ok, true); assert.equal(r.checked, true); assert.deepEqual(r.claims.scope, ['note', 'vote'])

    const wider = clone(c); wider.credentialSubject.scope.push('propose')
    assert.equal((await verifyPermissionCredential(wider, { keyFor: didKeyOnly })).problem, 'proof')
    const longer = clone(c); longer.validUntil = new Date(Date.now() + 9 * 86400000).toISOString()
    assert.equal((await verifyPermissionCredential(longer, { keyFor: didKeyOnly })).problem, 'proof')
    const otherSigner = clone(c); otherSigner.issuer = newIdentity().did
    assert.equal((await verifyPermissionCredential(otherSigner, { keyFor: didKeyOnly })).ok, false)
    const unsigned = permissionCredential({ person: person.did, agent: agent.did, room: ROOM, scope: ['note'], validFrom: from, validUntil: until })
    assert.equal((await verifyPermissionCredential(unsigned, { keyFor: didKeyOnly })).problem, 'shape')
    assert.equal((await verifyPermissionCredential({ ...clone(c), extra: 1 }, { keyFor: didKeyOnly })).reason, 'unknown field extra')
  })

  test('the write check: in scope and in its window only', () => {
    const now = Date.now()
    const claims = { issuer: 'did:key:zPerson', agent: 'did:key:zAgent', room: ROOM, scope: ['note'], askFirst: [], validFrom: new Date(now).toISOString(), validUntil: new Date(now + 60_000).toISOString() }
    const write = { agent: 'did:key:zAgent', person: 'did:key:zPerson', room: ROOM, kind: 'note', at: now + 1000 }
    assert.equal(credentialRefuses(claims, write), null)
    assert.match(credentialRefuses(claims, { ...write, kind: 'vote' }).message, /does not cover vote/)
    assert.equal(credentialRefuses(claims, { ...write, at: now + 60_000 }).code, 'expired')
    assert.match(credentialRefuses(claims, { ...write, at: now - 5000 }).message, /not valid yet/)
    assert.equal(credentialRefuses(claims, { ...write, at: now - 5000, slackMs: 10_000 }), null, 'the room\'s clock slack applies to validFrom')
    assert.match(credentialRefuses(claims, { ...write, room: 'did:key:zElsewhere' }).message, /another room/)
    assert.match(credentialRefuses(claims, { ...write, agent: 'did:key:zSomeoneElse' }).message, /not from this person to this agent/)
    assert.match(credentialRefuses(claims, { ...write, revoked: true }).message, /stopped/)
  })
})

describe('the room checks the credential: at the grant, then on every write', () => {
  let ctx, base, dir, room
  const personA = newIdentity(), personB = newIdentity()
  const postDoc = async (doc) => { const r = await fetch(`${base}/api/entries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(doc) }); return { status: r.status, body: await r.json() } }
  const send = (id, name, payload, extra) => postDoc(signedDocument(id, { type: TYPES[name], payload, ...extra }))
  const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() } }
  const asAgent = (agent, person, grant, name, payload) => send(agent, name, payload, { onBehalfOf: person.did, delegation: grant })
  /** A grant as the page makes it: the same permission, signed as a credential; change() bends the credential to test refusals. */
  const grant = (person, agent, { scope = ['note'], ask, ms = 86400000, signer = person, change = (x) => x } = {}) => {
    const issuedAt = new Date().toISOString(), expiresAt = new Date(Date.now() + ms).toISOString()
    const credential = change(signPermissionCredential(signer, { agent: agent.did, room, scope, ask: ask ?? [], validFrom: issuedAt, validUntil: expiresAt }))
    return send(person, 'delegate', { delegate: agent.did, scope, ...(ask ? { ask } : {}), label: 'Credential bot', credential }, { issuedAt, expiresAt })
  }

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wpi-cred-'))
    const config = { ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, githubToken: '', ratePerMinute: 1000, publicUrl: 'https://interop.example', boardDataUrl: 'data:application/json,' + encodeURIComponent(JSON.stringify({ projects: [] })), llm: { ...baseConfig.llm, apiKey: '' } }
    ctx = await createApp(config, { hostWelcomeMs: null })
    await new Promise((r) => ctx.server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${ctx.server.address().port}`
    room = ctx.log.state.workspace
    assert.equal((await send(personA, 'join', { name: 'Person A' })).status, 201)
    assert.equal((await send(personB, 'join', { name: 'Person B' })).status, 201)
  })
  after(async () => { await ctx.stop(); rmSync(dir, { recursive: true, force: true }) })

  test('a grant carrying a valid credential is accepted and marked, and anyone can fetch and check it', async () => {
    const agent = newIdentity()
    const g = await grant(personA, agent, { scope: ['note', 'propose'] })
    assert.equal(g.status, 201, JSON.stringify(g.body))
    assert.deepEqual(ctx.log.state.delegations.get(g.body.hash).credential.scope, ['note', 'propose'])
    assert.equal((await get('/api/state')).body.people.find((p) => p.did === agent.did).credential, true)
    const fetched = await get(`/api/credentials/${g.body.hash}`)
    assert.equal(fetched.status, 200); assert.equal(fetched.body.status, 'live'); assert.equal(fetched.body.endedBy, null)
    const r = await verifyPermissionCredential(fetched.body.credential, { keyFor: didKeyOnly }) // checked without the room
    assert.equal(r.ok, true); assert.equal(r.claims.issuer, personA.did); assert.equal(r.claims.agent, agent.did); assert.equal(r.claims.room, room)
    assert.equal(grantMismatch(r.claims, ctx.log.byHash.get(g.body.hash).document, room), null)
    assert.equal((await asAgent(agent, personA, g.body.hash, 'note', { text: 'Hello, within my permission.', kind: 'message' })).status, 201)
  })

  test('a grant whose credential does not match it, or does not verify, is refused', async () => {
    const agent = newIdentity(), someoneElse = newIdentity()
    const subject = await grant(personA, agent, { change: (c) => signPermissionCredential(personA, { agent: someoneElse.did, room, scope: ['note'], validFrom: c.validFrom, validUntil: c.validUntil }) })
    assert.equal(subject.status, 400); assert.match(subject.body.payload.message, /names a different agent/)
    const scope = await grant(personA, agent, { change: (c) => signPermissionCredential(personA, { agent: agent.did, room, scope: ['note', 'vote'], validFrom: c.validFrom, validUntil: c.validUntil }) })
    assert.equal(scope.status, 400); assert.match(scope.body.payload.message, /differs from the grant's scope/)
    const issuer = await grant(personA, agent, { signer: personB }) // Person B's genuine signature on Person A's grant
    assert.equal(issuer.status, 403); assert.equal(issuer.body.payload.code, 'permissionDenied'); assert.match(issuer.body.payload.message, /someone other than the person/)
    const elsewhere = await grant(personA, agent, { change: (c) => signPermissionCredential(personA, { agent: agent.did, room: newIdentity().did, scope: ['note'], validFrom: c.validFrom, validUntil: c.validUntil }) })
    assert.match(elsewhere.body.payload.message, /for another room/)
    const dates = await grant(personA, agent, { change: (c) => signPermissionCredential(personA, { agent: agent.did, room, scope: ['note'], validFrom: c.validFrom, validUntil: new Date(Date.parse(c.validUntil) + 86400000).toISOString() }) })
    assert.match(dates.body.payload.message, /dates differ/)
    const tampered = await grant(personA, agent, { change: (c) => ({ ...c, id: 'urn:uuid:00000000-0000-4000-8000-000000000000' }) }) // changed after signing
    assert.equal(tampered.body.payload.code, 'proofInvalid')
    const shape = await grant(personA, agent, { change: (c) => ({ ...c, type: ['VerifiableCredential'] }) })
    assert.equal(shape.body.payload.code, 'malformedRequest'); assert.match(shape.body.payload.message, /AgentPermissionCredential/)
    assert.equal(ctx.log.state.activeDelegation(agent.did), null, 'none of them became a permission')
  })

  test('an agent\'s write outside the credential\'s scope is refused, even if the room\'s own table says otherwise', async () => {
    const agent = newIdentity()
    const g = (await grant(personA, agent, { scope: ['note'] })).body.hash
    const proposal = (await send(personA, 'propose', { kind: 'other', title: 'Try a credential check' })).body.hash
    const vote = await asAgent(agent, personA, g, 'vote', { proposal, choice: 'for' })
    assert.equal(vote.status, 403); assert.match(vote.body.payload.message, /signed as a credential does not cover vote/)
    const d = ctx.log.state.delegations.get(g); d.scope = [...d.scope, 'vote'] // the room's table bent, as if it were wrong (the log untouched): the credential still decides
    const again = await asAgent(agent, personA, g, 'vote', { proposal, choice: 'for' })
    assert.equal(again.status, 403); assert.match(again.body.payload.message, /does not cover vote/)
  })

  test('a revoked credential stops the agent, and says which line ended it', async () => {
    const agent = newIdentity()
    const g = (await grant(personA, agent)).body.hash
    assert.equal((await asAgent(agent, personA, g, 'note', { text: 'Before the stop.', kind: 'message' })).status, 201)
    const revoke = await send(personA, 'revoke', { delegation: g })
    assert.equal(revoke.status, 201)
    const after = await asAgent(agent, personA, g, 'note', { text: 'After the stop.', kind: 'message' })
    assert.equal(after.status, 403); assert.equal(after.body.payload.code, 'permissionDenied')
    const fetched = (await get(`/api/credentials/${g}`)).body
    assert.equal(fetched.status, 'revoked'); assert.equal(fetched.endedBy, revoke.body.hash)
  })

  test('an expired credential stops the agent, whatever the room\'s table says', async () => {
    const agent = newIdentity()
    const g = (await grant(personA, agent, { ms: 1200 })).body.hash
    assert.equal((await asAgent(agent, personA, g, 'note', { text: 'Quick, while it holds.', kind: 'message' })).status, 201)
    await new Promise((r) => setTimeout(r, 1300))
    ctx.log.state.delegations.get(g).expiresAt = new Date(Date.now() + 86400000).toISOString() // the table bent again
    const late = await asAgent(agent, personA, g, 'note', { text: 'Too late.', kind: 'message' })
    assert.equal(late.body.payload.code, 'expired'); assert.match(late.body.payload.message, /credential has expired/)
    assert.equal((await get(`/api/credentials/${g}`)).body.status, 'expired')
  })

  test('an old grant without a credential still works, and says it has none', async () => {
    const agent = newIdentity(), expiresAt = new Date(Date.now() + 86400000).toISOString()
    const g = await send(personB, 'delegate', { delegate: agent.did, scope: ['note'], label: 'Older bot' }, { expiresAt })
    assert.equal(g.status, 201)
    assert.equal(ctx.log.state.delegations.get(g.body.hash).credential, null)
    assert.equal((await get('/api/state')).body.people.find((p) => p.did === agent.did).credential, false)
    assert.equal((await asAgent(agent, personB, g.body.hash, 'note', { text: 'Still here, the old way.', kind: 'message' })).status, 201)
    assert.equal((await asAgent(agent, personB, g.body.hash, 'propose', { kind: 'other', title: 'x' })).body.payload.code, 'permissionDenied') // its table still decides
    const none = await get(`/api/credentials/${g.body.hash}`)
    assert.equal(none.status, 404); assert.match(none.body.error, /without a credential/)
    assert.equal((await get(`/api/credentials/${'0'.repeat(64)}`)).status, 404)
  })

  test('the whole log still verifies, credentials included, and a replay rebuilds the same marks', async () => {
    const v = (await get('/api/verify')).body
    assert.equal(v.ok, true, JSON.stringify(v.problems))
    const { State } = await import('../src/server/state.js')
    const replay = new State()
    for (const e of ctx.log.entries) replay.apply(e)
    const marked = (s) => [...s.delegations.values()].filter((d) => d.credential).map((d) => d.hash).sort()
    assert.deepEqual(marked(replay), marked(ctx.log.state))
    assert.ok(marked(replay).length >= 4)
  })
})
