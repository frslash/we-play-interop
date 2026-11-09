// The You tab's QR carries the visit's DIDComm out-of-band invitation in `_oob`, the form Keyring reads off a
// scanned URL, and it is the same invitation a wallet gets by asking the link for JSON.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { config as baseConfig } from '../src/server/config.js'
import { createApp } from '../src/server/index.js'
import { OOB_TYPE, joinUrl } from '../src/server/visits.js'

const decode = (u) => JSON.parse(Buffer.from(new URL(u).searchParams.get('_oob'), 'base64url').toString('utf8'))

test('joinUrl puts the invitation for this visit behind _oob on the /j/<code> link', () => {
  const visit = { code: 'abcdefgh', invitation: '00000000-0000-4000-8000-000000000000' }
  const u = new URL(joinUrl({ base: 'https://room.example', did: 'did:key:z6MkTest', name: 'A Room', visit }))
  assert.equal(u.pathname, '/j/abcdefgh')
  assert.equal(u.searchParams.get('iuv'), '1')
  assert.match(u.searchParams.get('_oob'), /^[A-Za-z0-9_-]+$/, 'base64url, nothing to escape in a QR code')
  const inv = decode(u.href)
  assert.deepEqual(inv, { type: OOB_TYPE, id: visit.invitation, from: 'did:key:z6MkTest', body: { goal_code: 'join', goal: 'Join A Room', accept: ['didcomm/v2'] } })
})

describe('the QR link over HTTP', () => {
  let ctx, base, dir
  const local = (u) => { const x = new URL(u); return base + x.pathname + x.search }
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wpi-oob-'))
    const config = { ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, publicUrl: 'https://interop.example', checkEveryMinutes: 0, boardDataUrl: 'data:application/json,{}', llm: { ...baseConfig.llm, apiKey: '' } }
    ctx = await createApp(config, { hostWelcomeMs: null })
    await new Promise((r) => ctx.server.listen(0, r))
    base = `http://localhost:${ctx.server.address().port}`
  })
  after(async () => { await ctx.stop(); rmSync(dir, { recursive: true, force: true }) })

  test('the link the page shows contains _oob with the room\'s DID, and the QR draws it', async () => {
    const { url } = await (await fetch(`${base}/api/visit`, { method: 'POST' })).json()
    assert.ok(url.includes('_oob='))
    const inv = decode(url)
    assert.equal(inv.type, OOB_TYPE); assert.equal(inv.from, ctx.identity.did); assert.equal(inv.body.goal_code, 'join')
    const qr = await fetch(`${base}/api/qr.svg?text=${encodeURIComponent(url)}`)
    assert.equal(qr.status, 200); assert.match(await qr.text(), /^<svg/)
  })

  test('the _oob in the QR is the same invitation a wallet gets by asking the link for JSON', async () => {
    const { url } = await (await fetch(`${base}/api/visit`, { method: 'POST' })).json()
    const r = await fetch(local(url), { headers: { accept: 'application/json' } })
    assert.equal(r.status, 200)
    const body = await r.json()
    assert.deepEqual(decode(url), body.invitation)
    assert.deepEqual(decode(body.protocols.didcomm), body.invitation)
  })

  test('a phone camera opening the link with _oob still goes to the join flow, once', async () => {
    const { url } = await (await fetch(`${base}/api/visit`, { method: 'POST' })).json()
    const first = await fetch(local(url), { redirect: 'manual', headers: { accept: 'text/html' } })
    assert.equal(first.status, 303); assert.equal(first.headers.get('location'), '/#tab=you')
    assert.equal((await fetch(local(url), { redirect: 'manual', headers: { accept: 'text/html' } })).status, 410)
  })
})
