// The join desk on a live route for the test community: the You-tab QR carries ?_oob= with a one-time desk token,
// the room's DID names a DIDComm inbox, /didcomm takes a joiner's signed request (one use, runs out), a test
// member's tap admits, and 'Ready for Keyring' is reported only when every part is live.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { config as baseConfig } from '../src/server/config.js'
import { createApp } from '../src/server/index.js'
import { approval, joinRequest } from '../src/server/join.js'
import { mintRoomDid } from '../agent/mint-room-did.js'
import { growRoomDid, roomDidDocument, roomDidStatus } from '../src/server/roomdid.js'
import { newIdentity } from '../src/shared/did.js'

const PUBLIC = 'https://interop.example'
const decode = (oob) => JSON.parse(Buffer.from(new URL(oob).searchParams.get('_oob'), 'base64url').toString('utf8'))

describe('the room DID names a DIDComm inbox', () => {
  test('the wanted document lists a DIDCommMessaging service at /didcomm', () => {
    const doc = roomDidDocument({ did: 'did:webvh:abc:interop.example', roomPublicKey: newIdentity().publicKey, publicUrl: PUBLIC })
    const s = doc.service.find((x) => x.type === 'DIDCommMessaging')
    assert.deepEqual(s.serviceEndpoint, { uri: `${PUBLIC}/didcomm`, accept: ['didcomm/v2'] })
    assert.ok(doc.service.some((x) => x.type === 'LinkedDomains'), 'the site link stays')
  })
})

describe('Keyring joins through the live route (test community only)', () => {
  let ctx, base, dir
  const member = newIdentity(), joiner = newIdentity()
  const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  const nonce = async () => (await (await fetch(`${base}/didcomm/nonce`)).json()).nonce
  const visit = async () => (await fetch(`${base}/api/visit`, { method: 'POST' })).json()

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wpi-keyring-'))
    const config = { ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, publicUrl: PUBLIC, checkEveryMinutes: 0, boardDataUrl: 'data:application/json,{}', llm: { ...baseConfig.llm, apiKey: '' }, joinTestMembers: [member.did] }
    ctx = await createApp(config, { hostWelcomeMs: null })
    await new Promise((r) => ctx.server.listen(0, r))
    base = `http://localhost:${ctx.server.address().port}`
  })
  after(async () => { await ctx.stop(); rmSync(dir, { recursive: true, force: true }) })

  test('without a DID log the room does not claim to be ready for Keyring', async () => {
    const v = await visit()
    assert.match(v.oob, /\?_oob=/)
    assert.equal(v.keyring.ready, false); assert.equal(v.keyring.checks.didcommService, false)
    assert.equal(v.keyring.community.test, true)
  })

  test('with a grown DID log: the QR text is the ?_oob= link from the room DID, and the room reports ready', async () => {
    const m = await mintRoomDid('interop.example')
    writeFileSync(join(dir, 'did.jsonl'), m.log); writeFileSync(join(dir, 'update-key.txt'), m.seedHex + '\n')
    assert.equal((await growRoomDid({ dataDir: dir, publicUrl: PUBLIC, roomPublicKey: ctx.identity.publicKey, log: () => {} })).grown, true)
    assert.equal((await roomDidStatus({ dataDir: dir })).didcomm, `${PUBLIC}/didcomm`)
    await ctx.join.refresh(true)
    const v = await visit()
    assert.ok(v.oob.startsWith(`${PUBLIC}/?_oob=`)); assert.ok(v.oob.length <= 600, 'fits the QR endpoint')
    const inv = decode(v.oob)
    assert.equal(inv.from, m.did); assert.equal(inv.body.goal_code, 'join'); assert.match(inv.body.goal, /test community/)
    assert.equal(v.keyring.ready, true, JSON.stringify(v.keyring.checks))
    assert.equal((await (await fetch(`${base}/api/info`)).json()).keyring.ready, true)
    // the short link redirects to the same one-time invitation
    const loc = (await fetch(base + new URL(v.url).pathname + new URL(v.url).search, { method: 'HEAD', redirect: 'manual' })).headers.get('location')
    assert.equal(decode(loc).id, inv.id)
  })

  test('a signed join request makes a pending request; the code is single use; a test member admits', async () => {
    const v = await visit(), inv = decode(v.oob), host = new URL(PUBLIC).host
    const msg = joinRequest(joiner, { room: inv.from, host, token: inv.id, nonce: await nonce() })
    const r = await post('/didcomm', msg, { 'content-type': 'application/didcomm-plain+json' })
    assert.equal(r.status, 202)
    const pending = await r.json()
    assert.equal(pending.status, 'pending'); assert.equal(pending.credential, undefined); assert.equal(pending.community.test, true)
    // the same code again, even by someone else: refused
    const again = await post('/didcomm', joinRequest(newIdentity(), { room: inv.from, host, token: inv.id, nonce: await nonce() }))
    assert.equal(again.status, 403); assert.match((await again.json()).error, /invite not valid/)
    // the joiner cannot admit itself; a test member can
    const self = await post('/didcomm/approve', { requestId: pending.requestId, approval: approval(joiner, { room: inv.from, nonce: await nonce(), request: pending.requestId }) })
    assert.equal(self.status, 403)
    const ok = await post('/didcomm/approve', { requestId: pending.requestId, approval: approval(member, { room: inv.from, nonce: await nonce(), request: pending.requestId }) })
    assert.equal(ok.status, 200)
    const got = await ok.json()
    assert.equal(got.credential.credentialSubject.id, joiner.did); assert.equal(got.community.test, true)
  })

  test('a DIDComm plaintext message carrying the request in body is read the same way', async () => {
    const inv = decode((await visit()).oob), j = newIdentity()
    const signed = joinRequest(j, { room: inv.from, host: new URL(PUBLIC).host, token: inv.id, nonce: await nonce() })
    const { type, ...body } = signed
    const r = await post('/didcomm', { id: 'm1', type, body })
    assert.equal(r.status, 202)
  })

  test('the code runs out, an unsigned or encrypted message is refused, and GET does nothing', async () => {
    const inv = decode((await visit()).oob), host = new URL(PUBLIC).host
    const forged = { ...joinRequest(newIdentity(), { room: inv.from, host, token: inv.id, nonce: await nonce() }), holder: newIdentity().did }
    assert.equal((await post('/didcomm', forged)).status, 403)
    assert.equal((await post('/didcomm', { protected: 'x', ciphertext: 'y' })).status, 415)
    assert.equal((await post('/didcomm', {}, { 'content-type': 'application/didcomm-encrypted+json' })).status, 415)
    assert.equal((await fetch(`${base}/didcomm`)).status, 405)
    // expiry: move the desk's clock past the invite's life
    const inv2 = decode((await visit()).oob), real = ctx.join.desk.now
    const n = await nonce()
    ctx.join.desk.now = () => real() + 11 * 60_000
    try {
      const late = await post('/didcomm', joinRequest(newIdentity(), { room: inv2.from, host, token: inv2.id, nonce: n }))
      assert.equal(late.status, 403)
    } finally { ctx.join.desk.now = real }
  })
})
