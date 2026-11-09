import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveDIDFromLog } from 'didwebvh-ts'
import { mintRoomDid } from '../agent/mint-room-did.js'
import { handleRoomDid, readRoomDidLog } from '../src/server/roomdid.js'

const fake = () => { const r = { status: 0, headers: {}, body: undefined }; return { r, res: { writeHead: (s, h) => { r.status = s; r.headers = h ?? {} }, end: (b) => { r.body = b } } } }

test('a minted room DID resolves from its log, and the route serves exactly that log', async () => {
  const m = await mintRoomDid('inwove.org')
  assert.match(m.did, /^did:webvh:[^:]+:inwove\.org$/)
  const out = await resolveDIDFromLog(m.log.trim().split('\n').map((l) => JSON.parse(l)))
  assert.equal(out.didDocument.id, m.did)
  const dir = mkdtempSync(join(tmpdir(), 'wpi-did-'))
  writeFileSync(join(dir, 'did.jsonl'), m.log)
  const { r, res } = fake()
  assert.equal(handleRoomDid({ method: 'GET' }, res, '/.well-known/did.jsonl', { dataDir: dir }), true)
  assert.equal(r.status, 200); assert.equal(r.body, m.log)
  assert.doesNotMatch(r.body, new RegExp(m.seedHex)) // the log holds no secret
})

test('no log, a bad log, other methods and other paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wpi-did-'))
  let f = fake(); handleRoomDid({ method: 'GET' }, f.res, '/.well-known/did.jsonl', { dataDir: dir }); assert.equal(f.r.status, 404)
  writeFileSync(join(dir, 'did.jsonl'), 'not json\n'); assert.equal(readRoomDidLog({ dataDir: dir }), null)
  f = fake(); handleRoomDid({ method: 'POST' }, f.res, '/.well-known/did.jsonl', { dataDir: dir }); assert.equal(f.r.status, 405)
  assert.equal(handleRoomDid({ method: 'GET' }, fake().res, '/api/state', { dataDir: dir }), false)
})

test('first start mints a test DID once, keeps the key private, and logs no key', async () => {
  const { ensureRoomDid, didHostOf } = await import('../src/server/roomdid.js')
  const { readFileSync, statSync, existsSync } = await import('node:fs')
  const dir = mkdtempSync(join(tmpdir(), 'wpi-did-')); const lines = []
  const log = (l) => lines.push(l)
  assert.deepEqual(await ensureRoomDid({ dataDir: dir, publicUrl: '', log }), { minted: false, reason: 'no PUBLIC_URL' })
  assert.equal(existsSync(join(dir, 'did.jsonl')), false)
  const r = await ensureRoomDid({ dataDir: dir, publicUrl: 'https://inwove.org/', log })
  assert.equal(r.minted, true); assert.match(r.did, /:inwove\.org$/)
  for (const f of ['did.jsonl', 'update-key.txt', 'did-test.json']) assert.equal(statSync(join(dir, f)).mode & 0o777, 0o600, f)
  const key = readFileSync(join(dir, 'update-key.txt'), 'utf8').trim()
  assert.ok(key.length >= 32)
  assert.equal(JSON.parse(readFileSync(join(dir, 'did-test.json'), 'utf8')).test, true)
  assert.ok(lines.length === 1 && lines[0].includes(r.did) && lines.every((l) => !l.includes(key)))
  assert.doesNotMatch(readFileSync(join(dir, 'did.jsonl'), 'utf8') + readFileSync(join(dir, 'did-test.json'), 'utf8'), new RegExp(key))
  const again = await ensureRoomDid({ dataDir: dir, publicUrl: 'https://inwove.org', log }) // second start: nothing new
  assert.equal(again.minted, false); assert.equal(lines.length, 1)
  const failing = await ensureRoomDid({ dataDir: join(dir, 'x', 'y'), file: join(dir, 'did-test.json', 'nope', 'did.jsonl'), publicUrl: 'https://inwove.org', log })
  assert.equal(failing.minted, false); assert.ok(lines.every((l) => !l.includes(key)))
  assert.equal(didHostOf('http://localhost:3000'), 'localhost%3A3000')
})
