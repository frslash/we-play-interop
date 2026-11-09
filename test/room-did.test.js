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
