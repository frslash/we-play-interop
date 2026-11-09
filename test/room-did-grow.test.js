import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveDIDFromLog } from 'didwebvh-ts'
import { ensureRoomDid, growRoomDid, handleRoomDid } from '../src/server/roomdid.js'
import { newIdentity, ed25519Multikey } from '../src/shared/did.js'

const entries = (dir) => readFileSync(join(dir, 'did.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const quiet = () => {}
async function rehearsal () {
  const dir = mkdtempSync(join(tmpdir(), 'wpi-grow-'))
  await ensureRoomDid({ dataDir: dir, publicUrl: 'https://inwove.org', log: quiet })
  return { dir, rehearsalKey: entries(dir)[0].parameters.updateKeys[0], seed: readFileSync(join(dir, 'update-key.txt'), 'utf8') }
}

test('a second signed entry adds the room key and an inwove.org service, and retires the rehearsal update key', async () => {
  const { dir, rehearsalKey, seed } = await rehearsal()
  const room = newIdentity(); const lines = []
  const r = await growRoomDid({ dataDir: dir, publicUrl: 'https://inwove.org', roomPublicKey: room.publicKey, log: (l) => lines.push(l) })
  assert.equal(r.grown, true)
  const log = entries(dir)
  assert.equal(log.length, 2); assert.match(log[1].versionId, /^2-/); assert.equal(log[1].proof.length, 1)
  const out = await resolveDIDFromLog(log) // checks the whole chain and every proof
  const doc = out.didDocument
  assert.equal(doc.verificationMethod[0].publicKeyMultibase, ed25519Multikey(room.publicKey))
  assert.deepEqual(doc.assertionMethod, [doc.verificationMethod[0].id])
  assert.ok(doc.service.some((s) => s.type === 'LinkedDomains' && s.serviceEndpoint === 'https://inwove.org/'))
  assert.notDeepEqual(out.didDocumentMetadata.updateKeys, [rehearsalKey]); assert.ok(!out.didDocumentMetadata.updateKeys.includes(rehearsalKey))
  const newSeed = readFileSync(join(dir, 'update-key.txt'), 'utf8')
  assert.notEqual(newSeed, seed); assert.ok(!existsSync(join(dir, 'update-key.next.txt')))
  assert.equal(JSON.parse(readFileSync(join(dir, 'did-test.json'), 'utf8')).rehearsalUpdateKey, rehearsalKey)
  assert.ok(lines.every((l) => !l.includes(newSeed.trim()) && !l.includes(seed.trim())))
  // served as is, with no secret in it
  let body; handleRoomDid({ method: 'GET' }, { writeHead () {}, end (b) { body = b } }, '/.well-known/did.jsonl', { dataDir: dir })
  assert.equal(body.trim().split('\n').length, 2); assert.doesNotMatch(body, new RegExp(newSeed.trim()))
  // the next start changes nothing
  assert.deepEqual(await growRoomDid({ dataDir: dir, publicUrl: 'https://inwove.org', roomPublicKey: room.publicKey, log: quiet }), { grown: false, reason: 'up to date' })
  assert.equal(entries(dir).length, 2)
})

test('ROOM_DID_UPDATE_KEY hands the update power to the room\'s people, and the host keeps no key', async () => {
  const { dir } = await rehearsal()
  const owner = ed25519Multikey(newIdentity().publicKey)
  const r = await growRoomDid({ dataDir: dir, publicUrl: 'https://inwove.org', roomPublicKey: newIdentity().publicKey, updateKey: owner, log: quiet })
  assert.equal(r.grown, true)
  assert.deepEqual((await resolveDIDFromLog(entries(dir))).didDocumentMetadata.updateKeys, [owner])
  assert.equal(existsSync(join(dir, 'update-key.txt')), false)
  // with no key it holds, the host changes nothing more (a new room key would need the owner's signature)
  assert.deepEqual(await growRoomDid({ dataDir: dir, publicUrl: 'https://inwove.org', roomPublicKey: newIdentity().publicKey, updateKey: owner, log: quiet }), { grown: false, reason: 'no update key here' })
})

test('a host key can later be handed on, and bad input changes nothing', async () => {
  const { dir } = await rehearsal()
  const room = newIdentity()
  await growRoomDid({ dataDir: dir, publicUrl: 'https://inwove.org', roomPublicKey: room.publicKey, log: quiet })
  const owner = ed25519Multikey(newIdentity().publicKey)
  assert.equal((await growRoomDid({ dataDir: dir, publicUrl: 'https://inwove.org', roomPublicKey: room.publicKey, updateKey: owner, log: quiet })).grown, true)
  assert.equal(entries(dir).length, 3)
  assert.deepEqual((await resolveDIDFromLog(entries(dir))).didDocumentMetadata.updateKeys, [owner])
  const other = (await rehearsal()).dir
  assert.deepEqual(await growRoomDid({ dataDir: other, publicUrl: 'https://inwove.org', roomPublicKey: room.publicKey, updateKey: 'not-a-key', log: quiet }), { grown: false, reason: 'error' })
  assert.deepEqual(await growRoomDid({ dataDir: other, publicUrl: '', roomPublicKey: room.publicKey, log: quiet }), { grown: false, reason: 'no PUBLIC_URL or room key' })
  assert.equal(entries(other).length, 1)
  assert.deepEqual(await growRoomDid({ dataDir: mkdtempSync(join(tmpdir(), 'wpi-grow-')), publicUrl: 'https://inwove.org', roomPublicKey: room.publicKey, log: quiet }), { grown: false, reason: 'no log' })
})

test('planted fake: no seed (rehearsal, fresh or handed-over) appears in the log, the served body or any output line', async () => {
  const { dir, seed } = await rehearsal()
  const lines = []; const room = newIdentity()
  await growRoomDid({ dataDir: dir, publicUrl: 'https://inwove.org', roomPublicKey: room.publicKey, log: (l) => lines.push(l) })
  const fresh = readFileSync(join(dir, 'update-key.txt'), 'utf8').trim()
  const owner = newIdentity()
  await growRoomDid({ dataDir: dir, publicUrl: 'https://inwove.org', roomPublicKey: room.publicKey, updateKey: ed25519Multikey(owner.publicKey), log: (l) => lines.push(l) })
  const logText = readFileSync(join(dir, 'did.jsonl'), 'utf8')
  for (const secret of [seed.trim(), fresh, owner.seedHex, room.seedHex].filter(Boolean)) {
    assert.ok(!logText.includes(secret)); assert.ok(!lines.some((l) => l.includes(secret)))
  }
  assert.equal(entries(dir).length, 3)
})
