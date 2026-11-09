// Join QR: a short link for one visit, a browser sent to the join flow, a wallet given the room's DID and a
// DIDComm out-of-band invitation, and a store that cannot grow without limit.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { config as baseConfig } from '../src/server/config.js'
import { createApp } from '../src/server/index.js'
import { CODE_RE, OOB_TYPE, VISIT_MS, Visits } from '../src/server/visits.js'

describe('join links in memory', () => {
  test('a link opens once, then says it was used; it runs out after its window', () => {
    let t = 1_000_000
    const v = new Visits({ now: () => t })
    const a = v.make('ip1'), b = v.make('ip1')
    assert.match(a.code, CODE_RE); assert.notEqual(a.code, b.code); assert.notEqual(a.invitation, b.invitation)
    assert.equal(v.peek(a.code), 'live')
    assert.equal(v.open(a.code).visit.code, a.code)
    assert.equal(v.open(a.code).why, 'used')
    assert.equal(v.peek(a.code), 'used')
    t += VISIT_MS - 1
    assert.equal(v.peek(b.code), 'live')
    t += 1
    assert.equal(v.open(b.code).why, 'gone')
    assert.equal(v.open(a.code).why, 'gone')
    assert.equal(v.byCode.size, 0)
    assert.deepEqual([v.counts.openedByPage, v.counts.refusedUsed, v.counts.refusedGone, v.counts.ranOutUnused], [1, 1, 2, 1])
  })

  test('the store stays bounded: past its size the oldest link goes, and one address gets only so many a minute', () => {
    let t = 0
    const v = new Visits({ max: 5, perIpPerMinute: 1000, now: () => t })
    const made = Array.from({ length: 8 }, () => v.make('ip1'))
    assert.equal(v.byCode.size, 5); assert.equal(v.counts.dropped, 3)
    assert.deepEqual(made.map((m) => v.peek(m.code)), ['gone', 'gone', 'gone', 'live', 'live', 'live', 'live', 'live'])

    const r = new Visits({ perIpPerMinute: 3, now: () => t })
    for (let i = 0; i < 3; i++) assert.ok(r.make('busy'))
    assert.equal(r.make('busy'), null); assert.equal(r.counts.limited, 1)
    assert.ok(r.make('other'))
    for (let i = 0; i < 100; i++) r.make('addr' + i)
    t += 60_000
    assert.ok(r.make('busy'), 'a new minute, a new allowance')
    assert.equal(r.recent.size, 1, 'last minute\'s counters are dropped, so they cannot pile up either')
  })
})

describe('join QR over HTTP', () => {
  let ctx, base, dir
  const local = (u) => { const x = new URL(u); return base + x.pathname + x.search }
  const newLink = async () => { const r = await fetch(`${base}/api/visit`, { method: 'POST' }); assert.equal(r.status, 201); return r.json() }
  const asWallet = (u) => fetch(local(u), { headers: { accept: 'application/json' } })
  const asBrowser = (u) => fetch(local(u), { redirect: 'manual', headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' } })

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wpi-join-'))
    const config = { ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, publicUrl: 'https://interop.example', checkEveryMinutes: 0, boardDataUrl: 'data:application/json,{}', llm: { ...baseConfig.llm, apiKey: '' } }
    ctx = await createApp(config, { hostWelcomeMs: null })
    await new Promise((r) => ctx.server.listen(0, r))
    base = `http://localhost:${ctx.server.address().port}`
  })
  after(async () => { await ctx.stop(); rmSync(dir, { recursive: true, force: true }) })

  test('the page gets a short link for this visit, with when it runs out', async () => {
    const { url, expiresAt } = await newLink()
    assert.match(url, /^https:\/\/interop\.example\/j\/[0-9a-hjkmnp-tv-z]{8}\?iuv=1$/)
    const left = Date.parse(expiresAt) - Date.now()
    assert.ok(left > VISIT_MS - 5000 && left <= VISIT_MS, 'about ten minutes')
    const qr = await fetch(`${base}/api/qr.svg?text=${encodeURIComponent(url)}`)
    assert.equal(qr.status, 200); assert.match(await qr.text(), /^<svg/)
  })

  test('a browser is sent to the join flow, once; the second open is refused', async () => {
    const { url } = await newLink()
    const first = await asBrowser(url)
    assert.equal(first.status, 303); assert.equal(first.headers.get('location'), '/#tab=you'); assert.equal(first.headers.get('cache-control'), 'no-store')
    const again = await asBrowser(url)
    assert.equal(again.status, 410); assert.match(again.headers.get('content-type'), /text\/html/); assert.match(await again.text(), /has been used.*Open the room/)
    assert.equal((await asWallet(url)).status, 410)
  })

  test('a HEAD (a link check or a preview) does not use the link up', async () => {
    const { url } = await newLink()
    assert.equal((await fetch(local(url), { method: 'HEAD' })).status, 200)
    assert.equal((await asBrowser(url)).status, 303)
    assert.equal((await fetch(local(url), { method: 'HEAD' })).status, 410)
  })

  test('a wallet asking for JSON gets the room\'s DID and a DIDComm out-of-band invitation; its _oob decodes to the same JSON', async () => {
    const one = await newLink(), two = await newLink()
    const r = await asWallet(one.url)
    assert.equal(r.status, 200)
    const body = await r.json(), inv = body.invitation
    assert.equal(body.did, ctx.identity.did)
    assert.equal(inv.type, OOB_TYPE); assert.equal(inv.type, 'https://didcomm.org/out-of-band/2.0/invitation')
    assert.equal(inv.from, ctx.identity.did)
    assert.match(inv.id, /^[0-9a-f-]{36}$/)
    assert.equal(inv.body.goal_code, 'join'); assert.match(inv.body.goal, /We Play Interop|Join/)
    assert.deepEqual(inv.body.accept, ['didcomm/v2'])
    // the VCALM interaction answer: a protocols map, with DIDComm's entry the invitation's URL form
    const oob = new URL(body.protocols.didcomm)
    assert.equal(oob.origin, 'https://interop.example'); assert.equal(oob.pathname, '/')
    const raw = oob.searchParams.get('_oob')
    assert.match(raw, /^[A-Za-z0-9_-]+$/, 'base64url, no padding')
    const decoded = Buffer.from(raw, 'base64url').toString('utf8')
    assert.deepEqual(JSON.parse(decoded), inv)
    assert.equal(decoded, JSON.stringify(inv), 'whitespace-free')
    assert.equal(Date.parse(body.expiresAt), Date.parse(one.expiresAt))
    // a fresh invitation id for every visit
    const other = await (await asWallet(two.url)).json()
    assert.notEqual(other.invitation.id, inv.id)
    assert.equal((await asWallet(one.url)).status, 410, 'single use for wallets too')
    // the invitation's URL opens the room's page for a person
    const page = await fetch(local(body.protocols.didcomm))
    assert.equal(page.status, 200); assert.match(page.headers.get('content-type'), /text\/html/)
  })

  test('a link runs out, and an unknown or malformed code is not found', async () => {
    const { url } = await newLink()
    const real = ctx.visits.now
    ctx.visits.now = () => real() + VISIT_MS + 1
    try { assert.equal((await asBrowser(url)).status, 404) } finally { ctx.visits.now = real }
    assert.equal((await asBrowser(`${base}/j/zzzzzzzz?iuv=1`)).status, 404)
    assert.equal((await asWallet(`${base}/j/not-a-code`)).status, 404)
    const counts = await (await fetch(`${base}/api/visit`)).json()
    assert.ok(counts.counts.openedByPage >= 2 && counts.counts.openedByWallet >= 2, 'how links were opened is counted, with no addresses')
    assert.equal(JSON.stringify(counts).includes('127.0.0.1'), false)
  })
})
