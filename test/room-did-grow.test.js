import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareDataForSigning, resolveDIDFromLog, updateDID } from 'didwebvh-ts'
import { writeFileSync } from 'node:fs'
import { ensureRoomDid, growRoomDid, handleRoomDid, roomDidDiffers, roomDidDocument, roomDidStatus } from '../src/server/roomdid.js'
import { ed25519, multibase } from '../src/shared/crypto.js'
import { newIdentity, ed25519Multikey, identityFromSeedHex } from '../src/shared/did.js'
import { serviceEndpoint } from '../src/shared/trusttask.js'

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

test('pre-rotation: ROOM_DID_NEXT_KEY commits only a hash, and then only that key can take over', async () => {
  const { dir } = await rehearsal()
  const room = newIdentity(); const recovery = newIdentity(); const rk = ed25519Multikey(recovery.publicKey); const lines = []
  const r = await growRoomDid({ dataDir: dir, publicUrl: 'https://inwove.org', roomPublicKey: room.publicKey, nextKey: rk, log: (l) => lines.push(l) })
  assert.equal(r.grown, true)
  const out = await resolveDIDFromLog(entries(dir))
  assert.equal(out.didDocumentMetadata.nextKeyHashes.length, 1)
  assert.ok(!out.didDocumentMetadata.nextKeyHashes.includes(rk)) // a hash, not the key
  // idempotent
  assert.deepEqual(await growRoomDid({ dataDir: dir, publicUrl: 'https://inwove.org', roomPublicKey: room.publicKey, nextKey: rk, log: quiet }), { grown: false, reason: 'up to date' })
  // the host can no longer rotate to a key that wasn't committed
  const before = readFileSync(join(dir, 'did.jsonl'), 'utf8')
  const stranger = ed25519Multikey(newIdentity().publicKey)
  const blocked = await growRoomDid({ dataDir: dir, publicUrl: 'https://inwove.org', roomPublicKey: newIdentity().publicKey, updateKey: stranger, log: quiet })
  assert.equal(blocked.grown, false)
  assert.equal(readFileSync(join(dir, 'did.jsonl'), 'utf8'), before)
  // planted fake: no seed, and not even the recovery key's public form, shows in output
  const logText = readFileSync(join(dir, 'did.jsonl'), 'utf8')
  for (const secret of [recovery.seedHex, room.seedHex, readFileSync(join(dir, 'update-key.txt'), 'utf8').trim()]) assert.ok(!logText.includes(secret) && !lines.some((l) => l.includes(secret)))
  assert.ok(!lines.some((l) => l.includes(rk)))
})

test('the recovery key must be a real multikey and differ from the update key', async () => {
  const { dir } = await rehearsal(); const room = newIdentity()
  assert.deepEqual(await growRoomDid({ dataDir: dir, publicUrl: 'https://inwove.org', roomPublicKey: room.publicKey, nextKey: 'nope', log: quiet }), { grown: false, reason: 'error' })
  const same = ed25519Multikey(newIdentity().publicKey)
  assert.deepEqual(await growRoomDid({ dataDir: dir, publicUrl: 'https://inwove.org', roomPublicKey: room.publicKey, updateKey: same, nextKey: same, log: quiet }), { grown: false, reason: 'next key must differ from the update key' })
  assert.equal(entries(dir).length, 1)
})

/** One more entry in the log with exactly this document, signed with the update key the host holds (as an earlier version of this code would have left it). */
async function writeEntry (dir, didDocument, updateKeys) {
  const log = entries(dir), id = identityFromSeedHex(readFileSync(join(dir, 'update-key.txt'), 'utf8')), mk = ed25519Multikey(id.publicKey)
  const signer = { getVerificationMethodId: () => `did:key:${mk}#${mk}`, async sign ({ document, proof }) { return { proofValue: multibase(ed25519.sign(await prepareDataForSigning(document, proof), id.seed)) } } }
  const r = await updateDID({ log, signer, verifier: { verify: async (sig, msg, pub) => ed25519.verify(sig, msg, pub) }, didDocument, updateKeys: updateKeys ?? [mk], updated: new Date(Date.parse(log.at(-1).versionTime) + 1000).toISOString().replace(/\.\d+Z$/, 'Z') })
  writeFileSync(join(dir, 'did.jsonl'), r.log.map((e) => JSON.stringify(e)).join('\n') + '\n')
}
/** The DIDComm inbox the room used to ask its DID to list (until November 2026): a live DID may still carry it. */
const didcommService = (did) => ({ id: `${did}#didcomm`, type: 'DIDCommMessaging', serviceEndpoint: { uri: 'https://inwove.org/didcomm', accept: ['didcomm/v2'] } })
/** The room's DID document as the code before the door wrote it: the room key, the site and the DIDComm inbox. */
function withoutDoor (did, room) {
  const doc = roomDidDocument({ did, roomPublicKey: room.publicKey, publicUrl: 'https://inwove.org' })
  return { ...doc, service: [...doc.service.filter((s) => s.type === 'LinkedDomains'), didcommService(did)] }
}
const ours = (doc) => doc.service.filter((s) => /#(room-site|didcomm|trust-tasks)$/.test(s.id)).map((s) => s.type) // did:webvh adds its own #files and #whois

test('the DID names the room\'s Trust Task door: TrustTaskHTTPS, its endpoint the origin, so the door is <origin>/trust-tasks', async () => {
  const { dir } = await rehearsal(); const room = newIdentity()
  assert.equal((await growRoomDid({ dataDir: dir, publicUrl: 'https://inwove.org/', roomPublicKey: room.publicKey, log: quiet })).grown, true)
  const doc = (await resolveDIDFromLog(entries(dir))).didDocument
  const door = doc.service.find((s) => s.type === 'TrustTaskHTTPS')
  assert.deepEqual(door, { id: `${doc.id}#trust-tasks`, type: 'TrustTaskHTTPS', serviceEndpoint: 'https://inwove.org' }) // the base, never the full address: a sender adds /trust-tasks itself
  assert.equal(serviceEndpoint(doc, 'TrustTaskHTTPS'), 'https://inwove.org')
  assert.deepEqual(ours(doc), ['LinkedDomains', 'TrustTaskHTTPS']) // no DIDComm inbox: the room has no desk behind one
  assert.ok(doc.service.some((s) => s.type === 'LinkedDomains' && s.serviceEndpoint === 'https://inwove.org/'))
  assert.equal(doc.service.some((s) => s.type === 'DIDCommMessaging'), false)
  const { document, ...status } = await roomDidStatus({ dataDir: dir })
  assert.deepEqual(status, { did: doc.id, trustTasks: 'https://inwove.org', roomKey: ed25519Multikey(room.publicKey) }); assert.deepEqual(document, doc)
  assert.equal(serviceEndpoint(doc, 'SignInPortal'), 'https://inwove.org/') // wallet sign-in's page, beside the door
})

test('a DID grown before the room had a door gets one more entry on the next start, for the service alone', async () => {
  const { dir } = await rehearsal(); const room = newIdentity()
  await growRoomDid({ dataDir: dir, publicUrl: 'https://inwove.org', roomPublicKey: room.publicKey, log: quiet })
  const did = (await resolveDIDFromLog(entries(dir))).didDocument.id
  await writeEntry(dir, withoutDoor(did, room))
  assert.equal(entries(dir).length, 3)
  assert.deepEqual(ours((await resolveDIDFromLog(entries(dir))).didDocument), ['LinkedDomains', 'DIDCommMessaging'])
  assert.equal((await roomDidStatus({ dataDir: dir })).trustTasks, null)
  const keysBefore = (await resolveDIDFromLog(entries(dir))).didDocumentMetadata.updateKeys, seedBefore = readFileSync(join(dir, 'update-key.txt'), 'utf8')
  // the next start
  const r = await growRoomDid({ dataDir: dir, publicUrl: 'https://inwove.org', roomPublicKey: room.publicKey, log: quiet })
  assert.equal(r.grown, true); assert.match(r.versionId, /^4-/)
  const out = await resolveDIDFromLog(entries(dir)) // the whole chain and every proof still check
  assert.equal(entries(dir).length, 4)
  assert.deepEqual(ours(out.didDocument), ['LinkedDomains', 'TrustTaskHTTPS']) // the entry the room writes anyway is the one that drops the old inbox
  assert.deepEqual(out.didDocumentMetadata.updateKeys, keysBefore); assert.equal(readFileSync(join(dir, 'update-key.txt'), 'utf8'), seedBefore) // nothing else changed: the same update key, still held
  // and the start after that changes nothing
  assert.deepEqual(await growRoomDid({ dataDir: dir, publicUrl: 'https://inwove.org', roomPublicKey: room.publicKey, log: quiet }), { grown: false, reason: 'up to date' })
  assert.equal(entries(dir).length, 4)
})

test('when the room\'s people hold the update key, the host cannot add the door to the DID by itself, and says so', async () => {
  const { dir } = await rehearsal(); const room = newIdentity(), owner = ed25519Multikey(newIdentity().publicKey)
  await growRoomDid({ dataDir: dir, publicUrl: 'https://inwove.org', roomPublicKey: room.publicKey, log: quiet })
  const did = (await resolveDIDFromLog(entries(dir))).didDocument.id
  await writeEntry(dir, withoutDoor(did, room), [owner]) // handed over before the room had a door
  const before = readFileSync(join(dir, 'did.jsonl'), 'utf8'), lines = []
  assert.deepEqual(await growRoomDid({ dataDir: dir, publicUrl: 'https://inwove.org', roomPublicKey: room.publicKey, updateKey: owner, log: (l) => lines.push(l) }), { grown: false, reason: 'no update key here' })
  assert.match(lines[0], /holds none of its update keys/)
  assert.equal(readFileSync(join(dir, 'did.jsonl'), 'utf8'), before) // their signature is needed for that entry
  assert.equal((await roomDidStatus({ dataDir: dir })).trustTasks, null) // and /api/info's door.inDid stays false until then
})

test('wallet sign-in reads the grown DID: the door, the sign-in page and the room key are all there', async () => {
  const { SignIn } = await import('../src/server/signin.js')
  const { createResolver } = await import('../src/server/resolver.js')
  const { dir } = await rehearsal(); const room = newIdentity()
  assert.equal((await growRoomDid({ dataDir: dir, publicUrl: 'https://inwove.org', roomPublicKey: room.publicKey, log: quiet })).grown, true)
  const signIn = new SignIn({ identity: room, resolver: createResolver(), config: { publicUrl: 'https://inwove.org', dataDir: dir, didLogFile: '' } })
  await signIn.refresh(true)
  assert.match(signIn.status.did, /^did:webvh:/); assert.ok(signIn.status.document, 'roomDidStatus hands sign-in the whole document')
  assert.deepEqual(signIn.didDocument(), { status: 'ok' })
  signIn.stop()
  const none = mkdtempSync(join(tmpdir(), 'wpi-no-did-'))
  assert.deepEqual(await roomDidStatus({ dataDir: none }), { did: null, trustTasks: null, roomKey: null, document: null })
})

test('a live DID that still lists DIDCommMessaging: the room asks for no such service, changes nothing for it, and says what differs', async () => {
  const { dir } = await rehearsal(); const room = newIdentity()
  assert.equal((await growRoomDid({ dataDir: dir, publicUrl: 'https://inwove.org', roomPublicKey: room.publicKey, log: quiet })).grown, true)
  const fresh = (await resolveDIDFromLog(entries(dir))).didDocument
  assert.deepEqual(roomDidDiffers(fresh), [], 'a DID the room wrote today differs in nothing')
  // the room's people publish a document with the old inbox still in it (the host does not hold their key in the real room; the test signs with the rehearsal one)
  const { service, ...rest } = roomDidDocument({ did: fresh.id, roomPublicKey: room.publicKey, publicUrl: 'https://inwove.org' })
  await writeEntry(dir, { ...rest, service: [...service, didcommService(fresh.id)] })
  const count = entries(dir).length, text = readFileSync(join(dir, 'did.jsonl'), 'utf8')
  const r = await growRoomDid({ dataDir: dir, publicUrl: 'https://inwove.org', roomPublicKey: room.publicKey, log: quiet })
  assert.deepEqual(r, { grown: false, reason: 'up to date' }, 'every service the room wants is there: nothing to write, and nothing fails')
  assert.equal(readFileSync(join(dir, 'did.jsonl'), 'utf8'), text); assert.equal(entries(dir).length, count)
  const status = await roomDidStatus({ dataDir: dir })
  assert.equal(status.trustTasks, 'https://inwove.org'); assert.ok(status.roomKey)
  assert.deepEqual(roomDidDiffers(status.document).map((d) => d.service), ['DIDCommMessaging'])
  assert.deepEqual(roomDidDiffers(null), []); assert.deepEqual(roomDidDiffers({}), [])
})
