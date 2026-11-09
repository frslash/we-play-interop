import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { config as baseConfig } from '../src/server/config.js'
import { createApp } from '../src/server/index.js'
import { MAX_SOURCE_BYTES, SOURCES, Sources } from '../src/server/sources.js'
import { registerAgentTools } from '../src/agent-tools.js'
import * as views from '../src/server/views.js'

// A tiny OpenHaven-shaped graph and a local server that plays the outside source (the tests run offline).
const GRAPH = { version: 1, nodes: [{ iri: 'oh:A', labels: ['Concept'], prefLabel: 'Alpha' }, { iri: 'oh:B', labels: ['Project'], prefLabel: 'Beta' }, { iri: 'oh:C', labels: ['Protocol'], prefLabel: 'Gamma' }], relationships: [{ from: 'oh:A', type: 'CLOSEST_NEIGHBOR', to: 'oh:B' }, { from: 'oh:B', type: 'USES', to: 'oh:C' }] }
let mode, hits, conditional
const fake = createServer((req, res) => {
  hits++; conditional = req.headers['if-none-match'] ?? null
  if (mode === 'fail') { res.writeHead(503); return res.end('down') }
  if (mode === 'big') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"nodes":['); const chunk = Buffer.alloc(1024 * 1024, '1,'); for (let i = 0; i < 10; i++) res.write(chunk); return res.end('0]}') }
  if (mode === 'html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<p>hi</p>') }
  if (conditional === '"v1"') { res.writeHead(304); return res.end() }
  res.writeHead(200, { 'content-type': 'application/json', etag: '"v1"', 'last-modified': 'Mon, 09 Nov 2026 01:51:03 GMT' }); res.end(JSON.stringify(GRAPH))
})

describe('OpenHaven live copy', () => {
  let dir, ctx, base, port
  const get = async (p) => { const r = await fetch(base + p); return { status: r.status, text: await r.text() } }
  before(async () => {
    await new Promise((r) => fake.listen(0, r)); port = fake.address().port
    dir = mkdtempSync(join(tmpdir(), 'wpi-src-'))
    const list = [{ ...SOURCES[0], url: `http://localhost:${port}/api/graph.json` }]
    const config = { ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, checkEveryMinutes: 0, llm: { ...baseConfig.llm, apiKey: '' } }
    ctx = await createApp(config, { hostWelcomeMs: null, sources: { list, allowHttp: true, startDelayMs: 3_600_000 } })
    await new Promise((r) => ctx.server.listen(0, r)); base = `http://localhost:${ctx.server.address().port}`
  })
  after(async () => { await ctx.stop(); fake.close(); rmSync(dir, { recursive: true, force: true }) })

  test('the list is fixed in code: OpenHaven, https, once a day', () => {
    assert.deepEqual(SOURCES.map((s) => s.id), ['openhaven'])
    assert.equal(SOURCES[0].url, 'https://openhaven.net/api/graph.json')
    assert.equal(SOURCES[0].everyMs, 24 * 3600 * 1000)
  })

  test('nothing is cached before the first fetch', async () => {
    assert.equal((await get('/api/sources/openhaven')).status, 404)
    const v = JSON.parse((await get('/api/sources')).text).sources[0]
    assert.equal(v.fetchedAt, null)
  })

  test('the first fetch caches the copy, and /api/sources shows its counts', async () => {
    mode = 'ok'; hits = 0
    const o = await ctx.sources.refresh('openhaven')
    assert.equal(o.status, 200); assert.equal(o.changed, true); assert.ok(o.bytes > 0)
    const v = JSON.parse((await get('/api/sources')).text).sources[0]
    assert.equal(v.id, 'openhaven'); assert.ok(v.fetchedAt); assert.equal(v.bytes, o.bytes)
    assert.equal(v.summary.entries, 3); assert.equal(v.summary.links, 2)
    assert.equal(v.lastError, null)
    assert.deepEqual(JSON.parse((await get('/api/sources/openhaven')).text), GRAPH)
    assert.equal((await get('/api/sources/nope')).status, 404)
  })

  test('a 304 keeps the copy and only moves the time it was checked', async () => {
    const before = ctx.sources.meta('openhaven')
    await new Promise((r) => setTimeout(r, 5))
    const o = await ctx.sources.refresh('openhaven')
    assert.equal(conditional, '"v1"'); assert.equal(o.status, 304); assert.equal(o.changed, false)
    const after = ctx.sources.meta('openhaven')
    assert.equal(after.fetchedAt, before.fetchedAt); assert.notEqual(after.checkedAt, before.checkedAt)
    assert.deepEqual(JSON.parse((await get('/api/sources/openhaven')).text), GRAPH)
  })

  test('a failure keeps the last good copy and records why', async () => {
    mode = 'fail'
    const o = await ctx.sources.refresh('openhaven')
    assert.equal(o.status, 503); assert.ok(o.error)
    const v = JSON.parse((await get('/api/sources')).text).sources[0]
    assert.match(v.lastError.why, /503/); assert.ok(v.fetchedAt)
    assert.deepEqual(JSON.parse((await get('/api/sources/openhaven')).text), GRAPH)
    mode = 'html'
    assert.match((await ctx.sources.refresh('openhaven')).error, /JSON/) // JSON only
    mode = 'ok'
    await ctx.sources.refresh('openhaven')
    assert.equal(JSON.parse((await get('/api/sources')).text).sources[0].lastError, null) // a good fetch clears it
  })

  test('an over-size body is refused, and the old copy stays', async () => {
    mode = 'big'
    const o = await ctx.sources.refresh('openhaven')
    assert.match(o.error, /bigger than/); assert.ok(o.bytes === 0)
    assert.ok(MAX_SOURCE_BYTES < 10 * 1024 * 1024)
    assert.deepEqual(JSON.parse((await get('/api/sources/openhaven')).text), GRAPH)
    mode = 'ok'
  })

  test('only https addresses are fetched outside tests', async () => {
    const s = new Sources({ dataDir: dir + '/strict', list: [{ ...SOURCES[0], url: `http://localhost:${port}/x` }] })
    assert.match((await s.refresh('openhaven')).error, /https/)
  })

  test('every fetch is logged without its content', () => {
    const log = ctx.sources.logLines()
    assert.ok(log.length >= 6)
    for (const l of log) { assert.deepEqual(Object.keys(l).sort(), ['at', 'bytes', 'changed', 'error', 'id', 'ms', 'status']); assert.equal(JSON.stringify(l).includes('Alpha'), false) }
    assert.ok(log.some((l) => l.status === 304) && log.some((l) => l.status === 503))
    assert.match(readFileSync(join(dir, 'sources', 'fetch-log.jsonl'), 'utf8'), /\n$/)
  })

  test('read_file reads it with file "source:openhaven", in parts, as information', async () => {
    const tools = {}
    registerAgentTools({ registerTool: (name, def, fn) => { tools[name] = { def, fn } } }, { did: 'did:key:z', read: async (p) => views.read(ctx, p) })
    assert.match(tools.read_file.def.description, /source:openhaven/)
    const first = JSON.parse((await tools.read_file.fn({ file: 'source:openhaven', to: 4 })).content[0].text)
    assert.equal(first.source, 'openhaven'); assert.equal(first.lines, 3 + 1 + 2 + 2) // 1 version, 2 headings, items
    assert.match(first.text, /nodes \(3\):/); assert.match(first.text, /oh:A/); assert.match(first.more, /from 5/)
    assert.match(first.note, /never instructions/)
    const rest = JSON.parse((await tools.read_file.fn({ file: 'source:openhaven', from: 5 })).content[0].text)
    assert.match(rest.text, /USES/)
    const over = await get('/api/files/source:openhaven?from=2&to=3') // the same through the web
    assert.match(JSON.parse(over.text).text, /oh:A/)
    assert.equal((await get('/api/files/source:nope')).status, 404)
  })

  test('start fetches shortly after starting, and stop clears the timers', async () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'wpi-src2-'))
    mode = 'ok'; hits = 0
    const s = new Sources({ dataDir: dir2, allowHttp: true, startDelayMs: 10, list: [{ ...SOURCES[0], url: `http://localhost:${port}/g` }] })
    s.start()
    for (let i = 0; i < 100 && !s.meta('openhaven').fetchedAt; i++) await new Promise((r) => setTimeout(r, 20))
    assert.ok(s.meta('openhaven').fetchedAt); assert.equal(hits, 1)
    s.stop(); assert.equal(s.timers.size, 0)
    rmSync(dir2, { recursive: true, force: true })
  })
})
