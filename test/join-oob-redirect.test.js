// A join QR's short link sends a wallet (or a phone's browser) to the visit's one-time ?_oob= invitation link,
// so a wallet that reads the invitation from the URL it lands on (Keyring) finds one. The QR stays short.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { config as baseConfig } from '../src/server/config.js'
import { createApp } from '../src/server/index.js'
import { OOB_TYPE } from '../src/server/visits.js'

describe('/j/<code> redirects to the one-time ?_oob= invitation link', () => {
  let ctx, base, dir
  const local = (u) => { const x = new URL(u); return base + x.pathname + x.search }
  const newLink = async () => (await fetch(`${base}/api/visit`, { method: 'POST' })).json()
  const curlI = (u) => fetch(local(u), { method: 'HEAD', redirect: 'manual', headers: { accept: '*/*' } }) // what curl -sI sends
  const get = (u, accept = '*/*') => fetch(local(u), { redirect: 'manual', headers: { accept } })
  const decode = (loc) => JSON.parse(Buffer.from(new URL(loc).searchParams.get('_oob'), 'base64url').toString('utf8'))

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wpi-oob-'))
    const config = { ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, publicUrl: 'https://interop.example', checkEveryMinutes: 0, boardDataUrl: 'data:application/json,{}', llm: { ...baseConfig.llm, apiKey: '' } }
    ctx = await createApp(config, { hostWelcomeMs: null })
    await new Promise((r) => ctx.server.listen(0, r))
    base = `http://localhost:${ctx.server.address().port}`
  })
  after(async () => { await ctx.stop(); rmSync(dir, { recursive: true, force: true }) })

  test('curl -sI on a fresh link: a redirect whose Location has ?_oob=, and the link is still unused', async () => {
    const { url } = await newLink()
    assert.ok(url.length < 50, 'the QR text stays short')
    const h = await curlI(url)
    assert.equal(h.status, 303)
    const loc = h.headers.get('location')
    assert.match(loc, /\?_oob=[A-Za-z0-9_-]+$/)
    const inv = decode(loc)
    assert.equal(inv.type, OOB_TYPE); assert.equal(inv.from, ctx.identity.did); assert.equal(inv.body.goal_code, 'join')
    assert.equal((await curlI(url)).headers.get('location'), loc, 'a check does not use it up, and sees the same invitation')
    // a wallet's plain GET (no JSON asked for) lands on the same one-time link
    const g = await get(url)
    assert.equal(g.status, 303); assert.equal(g.headers.get('location'), loc); assert.equal(g.headers.get('cache-control'), 'no-store')
  })

  test('single use: after the first open, GET and HEAD are refused and give no invitation', async () => {
    const { url } = await newLink()
    assert.equal((await get(url, 'text/html')).status, 303)
    const h = await curlI(url)
    assert.equal(h.status, 410); assert.equal(h.headers.get('location'), null)
    const g = await get(url)
    assert.equal(g.status, 410); assert.equal(g.headers.get('location'), null)
    const unknown = await curlI(`${base}/j/zzzzzzzz`)
    assert.equal(unknown.status, 404); assert.equal(unknown.headers.get('location'), null)
  })

  test('each visit gets its own invitation; the redirect matches what a JSON wallet is given', async () => {
    const a = await newLink(), b = await newLink()
    const la = (await curlI(a.url)).headers.get('location'), lb = (await curlI(b.url)).headers.get('location')
    assert.notEqual(decode(la).id, decode(lb).id)
    const body = await (await get(a.url, 'application/json')).json()
    assert.equal(body.protocols.didcomm, la)
    assert.equal((await get(a.url)).status, 410, 'the JSON open used it')
    const page = await fetch(local(lb))
    assert.equal(page.status, 200); assert.match(page.headers.get('content-type'), /text\/html/)
  })
})
