// The room's membership pass (src/server/pass.js): a DTG MembershipCredential the room signs and a member downloads.
// The gate that sets req.inwoveViewer is built elsewhere, so the route is tested by calling its handler with a request
// that carries a viewer; the one HTTP test shows that a request with no viewer is refused.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { createDID, defaultVerifier } from 'didwebvh-ts'
import { ed25519, multibase } from '../src/shared/crypto.js'
import { ed25519Multikey, newIdentity } from '../src/shared/did.js'
import { didKeyOnly } from '../src/shared/chain.js'
import { signingInput } from '../src/shared/proof.js'
import { verifyDtgCredential } from '../src/shared/dtg.js'
import { config as baseConfig } from '../src/server/config.js'
import { createApp } from '../src/server/index.js'
import { createResolver } from '../src/server/resolver.js'
import { issueMembershipPass, servePass, PASS_DAYS } from '../src/server/pass.js'

const DAY = 86_400_000
const NOW = Date.parse('2026-11-10T12:00:00Z')

// a did:webvh for the room whose document lists the room's key as #room for assertionMethod, served by a fake fetch
async function webvhRoom () {
  const update = newIdentity(), key = newIdentity(), mk = ed25519Multikey(update.publicKey)
  const signer = { getVerificationMethodId: () => `did:key:${mk}#${mk}`, sign: async ({ document, proof }) => ({ proofValue: multibase(ed25519.sign(signingInput(document, proof), update.seed)) }) }
  const { did, log } = await createDID({
    address: 'interop.example', signer, verifier: defaultVerifier, updateKeys: [mk],
    didDocument: { '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'], id: '{DID}', verificationMethod: [{ id: '{DID}#room', type: 'Multikey', controller: '{DID}', publicKeyMultibase: ed25519Multikey(key.publicKey) }], authentication: ['{DID}#room'], assertionMethod: ['{DID}#room'] },
  })
  const jsonl = log.map((e) => JSON.stringify(e)).join('\n') + '\n'
  const fetch = async (url) => (String(url).endsWith('/did.jsonl') ? new Response(jsonl, { status: 200 }) : new Response('not found', { status: 404 }))
  return { room: { did, seed: key.seed, verificationMethod: `${did}#room` }, keyFor: createResolver({ fetch }).keyFor }
}

const keyRoom = () => { const id = newIdentity(); return { room: { did: id.did, seed: id.seed, verificationMethod: id.verificationMethod }, keyFor: didKeyOnly } }

for (const [label, make] of [['did:key', async () => keyRoom()], ['did:webvh', webvhRoom]]) {
  describe(`a pass from a ${label} room`, () => {
    test('verifies with the room\'s own reader, about the member, in a 30 day window', async () => {
      const { room, keyFor } = await make(), member = newIdentity()
      const pass = issueMembershipPass({ room, memberDid: member.did, name: 'Member One', now: NOW })
      const r = await verifyDtgCredential(pass, { keyFor, now: NOW, kinds: ['membership'] })
      assert.equal(r.ok, true, r.reason); assert.equal(r.checked, true)
      assert.equal(r.claims.subject, member.did); assert.equal(r.claims.issuer, room.did)
      assert.equal(r.context.current, true); assert.deepEqual(r.notes, [])
      assert.equal(pass.proof.verificationMethod, room.verificationMethod); assert.equal(pass.proof.proofPurpose, 'assertionMethod')
      assert.equal(pass.proof.cryptosuite, 'eddsa-jcs-2022'); assert.equal(pass.credentialStatus, undefined)
      assert.equal(Date.parse(pass.validUntil) - Date.parse(pass.validFrom), PASS_DAYS * DAY)
    })

    test('a changed byte fails', async () => {
      const { room, keyFor } = await make(), member = newIdentity(), other = newIdentity()
      const pass = issueMembershipPass({ room, memberDid: member.did, now: NOW })
      for (const bad of [{ ...pass, credentialSubject: { id: other.did } }, { ...pass, validUntil: new Date(NOW + 900 * DAY).toISOString() }, { ...pass, issuerScope: 'pairwise' }]) {
        const r = await verifyDtgCredential(bad, { keyFor, now: NOW })
        assert.equal(r.ok, false); assert.equal(r.problem, 'proof')
      }
    })

    test('it expires after 30 days and is not valid before it is made', async () => {
      const { room, keyFor } = await make()
      const pass = issueMembershipPass({ room, memberDid: newIdentity().did, now: NOW })
      assert.equal((await verifyDtgCredential(pass, { keyFor, now: NOW + 30 * DAY - 1000 })).ok, true)
      const late = await verifyDtgCredential(pass, { keyFor, now: NOW + 30 * DAY + 1000 })
      assert.equal(late.ok, false); assert.equal(late.problem, 'dates')
      assert.equal((await verifyDtgCredential(pass, { keyFor, now: NOW - 10 * 60_000 })).problem, 'dates')
    })
  })
}

test('no name, no name in the pass', () => {
  const { room } = keyRoom(), pass = issueMembershipPass({ room, memberDid: newIdentity().did, now: NOW })
  assert.deepEqual(Object.keys(pass.credentialSubject), ['id'])
})

describe('GET /api/me/pass', () => {
  const fake = () => { const r = { status: 0, headers: {}, body: undefined }; return { r, res: { writeHead: (s, h) => { r.status = s; r.headers = h ?? {} }, end: (b) => { r.body = b } } } }
  const setup = () => {
    const { room, keyFor } = keyRoom(), alice = newIdentity(), gone = newIdentity(), old = newIdentity(), stranger = newIdentity()
    const participants = new Map([
      [alice.did, { did: alice.did, kind: 'human', name: 'Alice' }],
      [gone.did, { did: gone.did, kind: 'human', name: 'Gone', left: '2026-11-01T00:00:00.000Z' }],
      [old.did, { did: old.did, kind: 'human', name: 'Old', replacedBy: alice.did }],
      ['did:key:zAgent', { did: 'did:key:zAgent', kind: 'agent', name: 'a bot' }],
    ])
    const ctx = { join: { room, refresh: async () => {} }, log: { state: { participants, nameOf: (d) => participants.get(d)?.name } } }
    return { ctx, keyFor, alice, gone, old, stranger }
  }
  const ask = async (ctx, viewer) => { const { r, res } = fake(); await servePass(ctx, { inwoveViewer: viewer }, res, NOW); return r }

  test('a current member gets a pass that verifies, as a download that is never cached', async () => {
    const { ctx, keyFor, alice } = setup()
    const r = await ask(ctx, { kind: 'human', did: alice.did })
    assert.equal(r.status, 200)
    assert.equal(r.headers['content-disposition'], 'attachment; filename="inwove-pass.json"'); assert.equal(r.headers['cache-control'], 'no-store')
    assert.equal(r.headers['access-control-allow-origin'], undefined)
    const pass = JSON.parse(r.body)
    assert.equal(pass.credentialSubject.id, alice.did); assert.equal(pass.credentialSubject.name, 'Alice')
    assert.equal((await verifyDtgCredential(pass, { keyFor, now: NOW, kinds: ['membership'] })).ok, true)
  })

  test('no viewer, a person who left, a replaced key, a stranger, an agent and the open-room viewer are all refused', async () => {
    const { ctx, gone, old, stranger } = setup()
    for (const viewer of [undefined, null, { kind: 'human', did: gone.did }, { kind: 'human', did: old.did }, { kind: 'human', did: stranger.did }, { kind: 'agent', did: 'did:key:zAgent' }, { kind: 'human', did: null }]) {
      const r = await ask(ctx, viewer)
      assert.equal(r.status, 401, JSON.stringify(viewer)); assert.deepEqual(JSON.parse(r.body), { error: 'Sign in first.' }); assert.equal(r.headers['cache-control'], 'no-store')
    }
  })

  test('over HTTP, a request nobody vouched for gets 401 (the viewer cannot be set from outside)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wpi-pass-'))
    const ctx = await createApp({ ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, publicUrl: '', checkEveryMinutes: 0, boardDataUrl: 'data:application/json,{}', llm: { ...baseConfig.llm, apiKey: '' } }, { hostWelcomeMs: null })
    try {
      await new Promise((r) => ctx.server.listen(0, '127.0.0.1', r))
      const res = await fetch(`http://127.0.0.1:${ctx.server.address().port}/api/me/pass`, { headers: { 'x-inwove-viewer': 'human', cookie: 'inwove_viewer=1' } })
      assert.equal(res.status, 401); assert.deepEqual(await res.json(), { error: 'Sign in first.' })
    } finally { await ctx.stop(); rmSync(dir, { recursive: true, force: true }) }
  })
})
