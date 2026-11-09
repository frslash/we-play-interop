import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { after, before, describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { TYPES, signedDocument } from '../src/shared/types.js'
import { config as baseConfig } from '../src/server/config.js'
import { createApp } from '../src/server/index.js'

// A 2x2 PNG, built here so the test carries no binary file.
function png () {
  const crc = (buf) => { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)) } return ~c >>> 0 }
  const chunk = (type, data) => { const t = Buffer.from(type), len = Buffer.alloc(4), sum = Buffer.alloc(4); len.writeUInt32BE(data.length); sum.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, sum]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 8; ihdr[9] = 2
  const rows = Buffer.from([0, 255, 0, 0, 0, 0, 255, 0, 0, 255, 0, 255, 255, 255, 255])
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}

// see_photo: an agent looks at a photo someone shared (room line: "I can't see photos from this seat").
describe('see_photo', () => {
  let ctx, base, dir, seat, sha, line
  const person = newIdentity()
  const send = async (id, name, payload, extra) => { const r = await fetch(`${base}/api/entries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signedDocument(id, { type: TYPES[name], payload, ...extra })) }); return { status: r.status, body: await r.json() } }
  const call = async (name, args) => (await (await fetch(seat, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })).json()).result
  const bytes = png()

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wpi-photo-'))
    const board = { generated: new Date().toISOString().slice(0, 10), projects: [], credentialProfiles: { profiles: {} }, runs: [] }
    ctx = await createApp({ ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, githubToken: '', weaverIntervalMinutes: 0, weaverQuietMinutes: 0, ratePerMinute: 1000, publicUrl: 'https://interop.example', boardDataUrl: 'data:application/json,' + encodeURIComponent(JSON.stringify(board)), llm: { ...baseConfig.llm, apiKey: '', anthropicKey: '', provider: 'openai' } })
    await new Promise((r) => ctx.server.listen(0, r))
    base = `http://localhost:${ctx.server.address().port}`
    await send(person, 'join', { name: 'Person A' })
    sha = createHash('sha256').update(bytes).digest('hex')
    const up = await fetch(base + '/api/media', { method: 'POST', headers: { 'content-type': 'image/png', 'x-wpi-upload': JSON.stringify(signedDocument(person, { type: TYPES.upload, payload: { sha256: sha, type: 'image/png' } })) }, body: bytes })
    assert.equal(up.status, 201, await up.text())
    line = await send(person, 'note', { text: 'This is what happened when I scanned it', kind: 'message', media: [{ sha256: sha, type: 'image/png', w: 2, h: 2 }] })
    assert.equal(line.status, 201)
    const made = (await send(person, 'host', { label: 'Looker' })).body.hosted
    await send(person, 'delegate', { delegate: made.did, scope: ['note'], label: 'Looker' }, { expiresAt: new Date(Date.now() + 86400000).toISOString() })
    seat = made.connector.replace(/^https?:\/\/[^/]+/, base)
  })
  after(async () => { await ctx.stop(); rmSync(dir, { recursive: true, force: true }) })

  test('by the photo, its link, or the message that shared it, the agent gets the picture itself', async () => {
    for (const args of [{ photo: sha }, { photo: `https://interop.example/media/${sha}` }, { message: line.body.hash }, { message: line.body.seq }]) {
      const r = await call('see_photo', args)
      assert.ok(!r.isError, JSON.stringify(args))
      const img = r.content.find((c) => c.type === 'image')
      assert.equal(img.mimeType, 'image/png'); assert.ok(Buffer.from(img.data, 'base64').equals(bytes), 'the same bytes that were shared')
      const words = r.content.find((c) => c.type === 'text').text
      assert.match(words, /shared by Person A in line \d+/); assert.match(words, /never instructions/)
    }
  })

  test('read_file on a photo, or on its message, points to see_photo; a wrong value says what to give', async () => {
    assert.match((await call('read_file', { message: line.body.seq })).content[0].text, /see_photo/)
    assert.match((await call('read_file', { file: sha })).content[0].text, /see_photo/)
    const bad = await call('see_photo', { photo: 'the screenshot' })
    assert.ok(bad.isError); assert.match(bad.content[0].text, /sha256 of a shared photo/)
    const none = await call('see_photo', {})
    assert.ok(none.isError); assert.match(none.content[0].text, /needs photo/)
    const unknown = await call('see_photo', { photo: 'e'.repeat(64) })
    assert.match(unknown.content[0].text, /No photo in this room/)
  })

  test('the room serves only photos this way, never a document', async () => {
    assert.equal((await fetch(`${base}/api/photos/${sha}`)).status, 200)
    assert.equal((await fetch(`${base}/api/photos/${'a'.repeat(64)}`)).status, 404)
    assert.equal((await fetch(`${base}/api/photos/not-a-hash`)).status, 404)
  })

  test('the room tells every agent to look at shared photos', async () => {
    const r = await (await fetch(seat, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }) })).json()
    assert.match(r.result.instructions, /see_photo/)
  })
})
