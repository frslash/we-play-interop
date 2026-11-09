import { test } from 'node:test'
import assert from 'node:assert/strict'
import { publicFetch } from '../src/server/resolver.js'

test('publicFetch refuses anything but public https on port 443', async () => {
  await assert.rejects(publicFetch('http://example.com/'), /https only/)
  await assert.rejects(publicFetch('https://example.com:8443/'), /port 443 only/)
  await assert.rejects(publicFetch('https://127.0.0.1/'), /not public/)
  await assert.rejects(publicFetch('https://169.254.169.254/latest/meta-data/'), /not public/)
  await assert.rejects(publicFetch('https://user:pw@example.com/'), /no credentials/)
})

// ── Security's four checks: a local server and a stub resolver, no real network ──
import http from 'node:http'
import { createPublicFetch } from '../src/server/resolver.js'

const PUBLIC = '203.0.113.7' // documentation range: passes the public check

/** A fetch whose resolver answers from a script and whose "public" address really connects to the local server. */
function rig (answers, port) {
  const seen = { lookups: 0, pinned: [], connectedTo: [] }
  const dnsLookup = async () => { const a = answers[Math.min(seen.lookups, answers.length - 1)]; seen.lookups++; return a }
  const request = (opts, cb) => {
    // Ask the pinned lookup what it would connect to, then route that (fake public) address to the local server.
    opts.lookup(opts.host, { all: false }, (_e, addr) => seen.pinned.push(addr))
    opts.lookup(opts.host, { all: true }, (_e, list) => assert.ok(Array.isArray(list) && list.length === 1 && list[0].address && list[0].family))
    return http.request({ ...opts, protocol: 'http:', servername: undefined, lookup: (_n, o, c) => { seen.connectedTo.push(opts.port); return o?.all ? c(null, [{ address: '127.0.0.1', family: 4 }]) : c(null, '127.0.0.1', 4) } }, cb)
  }
  return { seen, fetch: createPublicFetch({ lookup: dnsLookup, request, port }) }
}
const listen = (handler) => new Promise((resolve) => {
  const hits = []
  const server = http.createServer((req, res) => { hits.push(req.url); handler(req, res) })
  server.listen(0, '127.0.0.1', () => resolve({ server, hits, port: server.address().port, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r) }) }))
})

test('rebinding: the connection goes to the first (public) answer, and a private second answer is never used', async () => {
  const s = await listen((_q, res) => res.end('ok'))
  try {
    for (const evil of ['127.0.0.1', '10.0.0.5', '169.254.169.254']) {
      const { seen, fetch } = rig([[{ address: PUBLIC, family: 4 }], [{ address: evil, family: 4 }]], s.port)
      const r = await fetch('https://rebind.example/x')
      assert.equal(await r.text(), 'ok')
      assert.equal(seen.lookups, 1, 'resolved exactly once; no second lookup to rebind')
      assert.ok(seen.pinned.every((a) => a === PUBLIC), `pinned to ${PUBLIC}, not ${evil}`)
    }
    // And a name that is private on the check itself never connects at all.
    const hitsBefore = s.hits.length
    const { fetch } = rig([[{ address: '127.0.0.1', family: 4 }]], s.port)
    await assert.rejects(fetch('https://rebind.example/x'), /not public/)
    assert.equal(s.hits.length, hitsBefore)
    // A mixed answer (one public, one private) is refused whole.
    const mixed = rig([[{ address: PUBLIC, family: 4 }, { address: '10.0.0.5', family: 4 }]], s.port)
    await assert.rejects(mixed.fetch('https://rebind.example/x'), /not public/)
  } finally { await s.close() }
})

test('redirects are refused, never followed to a private address or another port', async () => {
  const target = await listen((_q, res) => res.end('secret'))
  const s = await listen((q, res) => { res.writeHead(302, { location: q.url === '/port' ? `https://rebind.example:${target.port}/` : `https://127.0.0.1:${target.port}/` }); res.end() })
  try {
    for (const path of ['/private', '/port']) {
      const { fetch } = rig([[{ address: PUBLIC, family: 4 }]], s.port)
      await assert.rejects(fetch(`https://rebind.example${path}`), /redirects are not followed/)
    }
    assert.equal(target.hits.length, 0, 'the redirect target was never contacted')
  } finally { await s.close(); await target.close() }
})

test('IPv6: loopback, unique-local, link-local and v4-mapped answers are refused; all:true lookups still work', async () => {
  const s = await listen((_q, res) => res.end('ok'))
  try {
    for (const addr of ['::1', 'fc00::1', 'fd12::1', 'fe80::1', '::ffff:127.0.0.1', '::FFFF:7f00:1']) {
      const { fetch } = rig([[{ address: addr, family: 6 }]], s.port)
      await assert.rejects(fetch('https://v6.example/'), /not public/, addr)
    }
    // A public v6 answer works, through both lookup shapes (the rig asserts the all:true shape).
    const { seen, fetch } = rig([[{ address: '2001:db8::7', family: 6 }]], s.port)
    assert.equal(await (await fetch('https://v6.example/')).text(), 'ok')
    assert.ok(seen.pinned.every((a) => a === '2001:db8::7'))
  } finally { await s.close() }
})

test('size: a reply streaming past 1 MB is cut off, with or without a length header', async () => {
  const chunk = Buffer.alloc(64 * 1024, 97)
  const noHeader = await listen((_q, res) => { // chunked, no content-length
    res.writeHead(200)
    const t = setInterval(() => { if (res.destroyed || !res.write(chunk)) { /* backpressure or closed */ } }, 1)
    res.on('close', () => clearInterval(t))
  })
  const withHeader = await listen((_q, res) => { res.writeHead(200, { 'content-length': String(5_000_000) }); res.end(Buffer.alloc(10)) })
  try {
    await assert.rejects(rig([[{ address: PUBLIC, family: 4 }]], noHeader.port).fetch('https://big.example/'), /too large/)
    await assert.rejects(rig([[{ address: PUBLIC, family: 4 }]], withHeader.port).fetch('https://big.example/'), /too large/)
  } finally { await noHeader.close(); await withHeader.close() }
})

import { MAX_CACHED_DIDS, createResolver } from '../src/server/resolver.js'
test('the did:webvh cache is bounded: past its size the entry resolved longest ago goes first', async () => {
  let calls = 0
  const webvh = async (did) => { calls++; return { didDocument: { id: did }, didResolutionMetadata: {}, didDocumentMetadata: {} } }
  const r = createResolver({ webvh })
  const did = (n) => `did:webvh:scid${n}:host${n}.example`
  for (let n = 0; n <= MAX_CACHED_DIDS; n++) await r.resolve(did(n))
  assert.equal(r.cached(), MAX_CACHED_DIDS)
  calls = 0
  await r.resolve(did(MAX_CACHED_DIDS)); assert.equal(calls, 0, 'the newest is still held')
  await r.resolve(did(0)); assert.equal(calls, 1, 'the oldest was dropped and is resolved again')
  assert.equal(r.cached(), MAX_CACHED_DIDS)
})
