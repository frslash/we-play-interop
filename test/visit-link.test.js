// The room's second QR code ("Join on your phone", with its DIDComm invitation and join desk) is gone. What is
// left of it: a link someone already holds opens the room's page, the desk's paths are not there, the page has one
// code, and /api/info says where joining happens now.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { config as baseConfig } from '../src/server/config.js'
import { createApp } from '../src/server/index.js'

describe('the old join link and the removed join desk', () => {
  let ctx, base, dir
  const start = async (extra = {}) => {
    dir = mkdtempSync(join(tmpdir(), 'wpi-visit-'))
    const config = { ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, publicUrl: 'https://interop.example', checkEveryMinutes: 0, boardDataUrl: 'data:application/json,{}', llm: { ...baseConfig.llm, apiKey: '' }, ...extra }
    ctx = await createApp(config, { hostWelcomeMs: null })
    await new Promise((r) => ctx.server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${ctx.server.address().port}`
  }
  before(() => start())
  after(async () => { await ctx.stop(); rmSync(dir, { recursive: true, force: true }) })

  test('a /j/<code> link opens the room\'s page, whatever the code, with no invitation, for a browser or for software', async () => {
    for (const path of ['/j/abcd2345?iuv=1', '/j/short', '/j/' + 'x'.repeat(200), '/j/']) {
      for (const accept of ['text/html', 'application/json']) {
        const r = await fetch(base + path, { redirect: 'manual', headers: { accept } })
        assert.equal(r.status, 303, path); assert.equal(r.headers.get('location'), '/', path)
        assert.equal(await r.text(), '', 'no body: nothing about a code, an invitation or the room\'s DID')
      }
      const h = await fetch(base + path, { method: 'HEAD', redirect: 'manual' })
      assert.equal(h.status, 303); assert.equal(h.headers.get('location'), '/')
    }
    const page = await fetch(base + '/j/abcd2345?iuv=1') // followed: the room's page itself
    assert.equal(page.status, 200); assert.match(page.headers.get('content-type'), /text\/html/)
  })

  test('/didcomm, its desk paths and /api/visit are gone', async () => {
    for (const [method, path] of [['GET', '/didcomm'], ['POST', '/didcomm'], ['GET', '/didcomm/nonce'], ['POST', '/didcomm/approve'], ['POST', '/api/visit'], ['GET', '/api/visit']]) {
      const r = await fetch(base + path, { method, ...(method === 'POST' ? { body: '{}', headers: { 'content-type': 'application/json' } } : {}) })
      assert.equal(r.status, method === 'GET' ? 404 : 405, `${method} ${path}`) // a path the room does not have: 404 to a read, and the room's answer to a write it has no route for
    }
  })

  test('the page draws no join-on-your-phone card and asks for no visit link', () => {
    const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
    assert.doesNotMatch(app, /api\/visit|Join on your phone|phoneCard|_oob/)
    assert.match(app, /walletCard\(/, 'the sign-in card stays')
  })

  test('/api/info: no keyring block, a join block that says where joining happens, and the sign-in and door reports stay', async () => {
    const i = await (await fetch(base + '/api/info')).json()
    assert.equal('keyring' in i, false); assert.equal('visits' in i, false)
    assert.deepEqual(i.join, { via: 'none' })
    assert.deepEqual(i.roomDid, { differs: [] }, 'no DID log, nothing that differs')
    assert.ok(i.door && i.door.address, 'the door report stays')
    assert.ok(!/_oob|invitation/i.test(JSON.stringify(i)), 'nothing about an invitation')
  })
})

describe('/api/info says what a live DID still lists that the room no longer asks for', () => {
  let ctx, base, dir
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wpi-visit-d-'))
    const config = { ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, publicUrl: 'https://interop.example', checkEveryMinutes: 0, boardDataUrl: 'data:application/json,{}', llm: { ...baseConfig.llm, apiKey: '' } }
    ctx = await createApp(config, { hostWelcomeMs: null })
    await new Promise((r) => ctx.server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${ctx.server.address().port}`
  })
  after(async () => { await ctx.stop(); rmSync(dir, { recursive: true, force: true }) })
  test('a DID document that lists DIDCommMessaging: the room runs, and /api/info names it (the real DID-log case is in room-did-grow.test.js)', async () => {
    ctx.join.status = { ...ctx.join.status, at: Date.now() + 60_000, document: { id: 'did:webvh:x', service: [{ id: '#didcomm', type: 'DIDCommMessaging', serviceEndpoint: 'https://interop.example/didcomm' }] } } // as a read of the log 'just now'
    const r = await fetch(base + '/api/info'); assert.equal(r.status, 200)
    assert.deepEqual((await r.json()).roomDid.differs.map((d) => d.service), ['DIDCommMessaging'])
  })
})

describe('/api/info join.via with a community named', () => {
  let ctx, base, dir
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wpi-visit-c-'))
    const config = { ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, publicUrl: 'https://interop.example', checkEveryMinutes: 0, boardDataUrl: 'data:application/json,{}', llm: { ...baseConfig.llm, apiKey: '' }, communityDid: 'did:webvh:QmExample:community.example' }
    ctx = await createApp(config, { hostWelcomeMs: null, communityFetch: async () => { throw new Error('no network in this test') } })
    await new Promise((r) => ctx.server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${ctx.server.address().port}`
  })
  after(async () => { await ctx.stop(); rmSync(dir, { recursive: true, force: true }) })
  test('says community', async () => { assert.deepEqual((await (await fetch(base + '/api/info')).json()).join, { via: 'community' }) })
})
