// The room's Trust Task door (src/server/door.js): every step a document goes through, the answers it gets, and the
// tasks the door serves from the start. First a door on its own (each step in isolation, with a clock the test
// moves), then the door in a running room, over http, with the same helpers another project's client would use
// (signedTask, postTask).
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { resolveDIDFromLog } from 'didwebvh-ts'
import { mintRoomDid } from '../agent/mint-room-did.js'
import { config as baseConfig } from '../src/server/config.js'
import { DISCOVERY, DISCOVERY_0_3, Door, FRAMEWORK_VERSION, HORIZON_MS, PING, Refusal, SIGNED, serveRoomTasks } from '../src/server/door.js'
import { createApp } from '../src/server/index.js'
import { TaskError } from '../src/server/log.js'
import { createResolver } from '../src/server/resolver.js'
import { growRoomDid, roomDidDocument } from '../src/server/roomdid.js'
import { keyFromDidDocument } from '../src/shared/chain.js'
import { didPeer4FromDocument, ed25519Multikey, newIdentity } from '../src/shared/did.js'
import { ACCEPT_MS, ERROR_TYPE, MAX_DOCUMENT_BYTES, SKEW_MS, classify, instant, postTask, responseTo, serviceEndpoint, signTask, signedTask, taskDocument, typeUri, verifyTask } from '../src/shared/trusttask.js'
import { TYPES, signedDocument } from '../src/shared/types.js'

const ECHO = typeUri('test/echo', '0.1') // a task of the test's own, to see what a handler is given and what its outcomes become
const MEMBERS = ['code', 'retryable', 'inResponseTo', 'message', 'retryAfter', 'details'] // the registry's trust-task-error payload, and nothing else

// A resolver that also knows DIDs the test makes up: a did:webvh cannot be fetched here (tests make no outside
// calls), so its document is handed over directly. The document has the shape OpenVTC's personas have: one
// Multikey verification method, #key-0, listed for authentication and assertionMethod (vti-oob-server/tests/flow.rs
// signs with "<issuer>#key-0").
const known = new Map(), plain = createResolver()
const resolver = { resolve: async (did) => known.get(did) ?? plain.resolve(did), keyFor: async (did, vm, purpose) => keyFromDidDocument(known.get(did) ?? await plain.resolve(did), did, vm, purpose) }
function webvhPersona (host) {
  const key = newIdentity(), did = `did:webvh:QmTestOnly${host.replace(/\W/g, '')}:${host}`, vm = `${did}#key-0`
  known.set(did, { id: did, verificationMethod: [{ id: vm, type: 'Multikey', controller: did, publicKeyMultibase: ed25519Multikey(key.publicKey) }], authentication: [vm], assertionMethod: [vm] })
  return { did, seed: key.seed, verificationMethod: vm }
}

describe('a door on its own: each step, in order', () => {
  const room = newIdentity(), person = newIdentity(), other = newIdentity()
  /** A door over a stand-in for the room: its key, a resolver, and (when `webvh` is given) the DID log status join-route.js keeps. */
  function make ({ webvh, roomKey, ...limits } = {}) {
    const clock = { now: Date.now() }, runs = []
    const join = webvh ? { did: webvh, status: { did: webvh, roomKey, trustTasks: 'https://room.example' }, refresh: async () => {} } : { did: room.did, status: { did: null }, refresh: async () => {} }
    const ctx = { identity: room, config: { ratePerMinute: 30, publicUrl: 'https://room.example' }, log: { resolver }, join }
    const door = new Door({ ctx, now: () => clock.now, ...limits })
    door.register(ECHO, async (given) => { runs.push(given); return { said: given.payload.say ?? null, signer: given.signer } })
    const doc = (over = {}, id = person, opts) => signedTask(id, { type: ECHO, recipient: room.did, issuedAt: instant(clock.now), payload: {}, ...over }, opts)
    const send = async (d, http = { ip: '203.0.113.7' }) => { const out = await door.handle(Buffer.from(typeof d === 'string' ? d : JSON.stringify(d)), http); return { ...out, reply: out.body ? JSON.parse(out.body) : null } }
    return { door, clock, runs, doc, send, ctx }
  }
  /** The answer is a document signed by `as` for authentication, and (for a refusal) has the registry's members only. */
  async function signedBy (reply, as, to) {
    const v = await verifyTask(reply, { keyFor: resolver.keyFor, me: to, requireRecipient: Boolean(to), purposes: ['authentication'] })
    assert.deepEqual(v, { ok: true, signer: as }, JSON.stringify(v))
    if (reply.type === ERROR_TYPE) { assert.ok(Object.keys(reply.payload).every((k) => MEMBERS.includes(k)), Object.keys(reply.payload).join()); assert.equal(typeof reply.payload.retryable, 'boolean'); assert.equal(typeof reply.payload.message, 'string') }
  }

  test('a good document reaches its task with the signer, and gets a signed #response in its thread', async () => {
    const { runs, doc, send, door } = make()
    const d = doc({ payload: { say: 'hello' } })
    const out = await send(d, { ip: '203.0.113.7', origin: 'https://room.example', host: 'room.example', userAgent: 'test/1', https: true })
    assert.equal(out.status, 200)
    assert.equal(out.reply.type, `${ECHO}#response`); assert.equal(out.reply.issuer, room.did); assert.equal(out.reply.recipient, person.did); assert.equal(out.reply.threadId, d.id)
    assert.deepEqual(out.reply.payload, { said: 'hello', signer: person.did })
    await signedBy(out.reply, room.did, person.did)
    assert.equal(out.reply.proof.proofPurpose, 'authentication'); assert.equal(out.reply.proof.created, out.reply.issuedAt); assert.doesNotMatch(out.reply.issuedAt, /\.\d+Z$/)
    assert.equal(runs.length, 1); assert.deepEqual(runs[0].doc, d); assert.equal(runs[0].signer, person.did)
    assert.deepEqual(runs[0].http, { origin: 'https://room.example', base: '', host: 'room.example', ip: '203.0.113.7', userAgent: 'test/1', https: true })
    assert.equal(classify(out.reply, ECHO).kind, 'response')
    assert.equal(door.counts.received, 1); assert.equal(door.counts.answered, 1); assert.deepEqual(door.counts.answeredByType, { [ECHO]: 1 })
  })

  test('a task\'s precheck runs before the proof is read, and only for a fresh document addressed to the room', async () => {
    const { door, doc, send } = make()
    const GATED = typeUri('test/gated', '0.1'), seen = []
    door.register(GATED, async () => ({ ran: true }), { precheck: (d) => { seen.push(d.id); return d.payload.no ? new Refusal('test/gated:keyUnsupported', 'not this kind of key') : undefined } })
    const { proof: _p, ...unsigned } = doc({ type: GATED, payload: { no: true } })
    assert.equal((await send(unsigned)).reply.payload.code, 'test/gated:keyUnsupported', 'refused by the gate, not for its missing proof')
    assert.equal((await send(doc({ type: GATED, payload: { no: true }, recipient: other.did }))).reply.payload.code, 'wrongRecipient', 'the gate never sees a document for someone else')
    assert.equal(seen.length, 1)
    assert.deepEqual((await send(doc({ type: GATED }))).reply.payload, { ran: true })
  })

  test('an answer the task signed itself (marked SIGNED) goes out byte for byte, is kept for a redelivery, and must be the room\'s answer to this document', async () => {
    const { door, doc, send } = make()
    const ATTEST = typeUri('test/attest', '0.1'), odd = { forged: false }
    door.register(ATTEST, async ({ doc: d }) => {
      const answer = signTask(responseTo(odd.forged ? { ...d, issuer: other.did } : d, { step: 1 }, room.did), room, { purpose: 'assertionMethod' })
      return Object.defineProperty(answer, SIGNED, { value: true })
    })
    const d = doc({ type: ATTEST })
    const out = await send(d)
    assert.equal(out.status, 200)
    assert.equal(out.reply.proof.proofPurpose, 'assertionMethod', 'not signed again by the door'); assert.deepEqual(out.reply.payload, { step: 1 })
    assert.equal((await verifyTask(out.reply, { keyFor: resolver.keyFor, me: person.did, purposes: ['assertionMethod'] })).ok, true)
    const again = await send(d)
    assert.equal(again.body, out.body, 'the same bytes for the same document')
    odd.forged = true
    const wrong = await send(doc({ type: ATTEST }))
    assert.equal(wrong.reply.payload.code, 'internalError', 'a marked answer addressed to someone else is never sent')
  })

  test('step 1, size: a body over 64 KiB is refused before it is parsed, by a refusal that answers no document', async () => {
    const { send, runs } = make()
    const big = await send('x'.repeat(MAX_DOCUMENT_BYTES + 1)) // not even JSON: nothing in it was read
    assert.equal(big.status, 400); assert.equal(big.reply.payload.code, 'malformedRequest'); assert.deepEqual(big.reply.payload.details, { maxBytes: MAX_DOCUMENT_BYTES })
    assert.equal(big.reply.recipient, undefined); assert.equal(big.reply.threadId, undefined); assert.equal(big.reply.payload.inResponseTo, undefined)
    await signedBy(big.reply, room.did)
    const counted = await send('{}', { ip: '203.0.113.7', bytes: 5_000_000, cut: true }) // the caller stopped reading: the size is what it counted
    assert.equal(counted.status, 400); assert.match(counted.reply.payload.message, /more than 5000000 bytes/)
    assert.equal(runs.length, 0)
  })

  test('step 2, parse: a body that is not JSON, or not a document, is malformedRequest', async () => {
    const { send, doc } = make()
    const notJson = await send('{"id": ')
    assert.equal(notJson.status, 400); assert.equal(notJson.reply.payload.code, 'malformedRequest'); assert.equal(notJson.reply.recipient, undefined)
    await signedBy(notJson.reply, room.did)
    for (const bad of ['[]', '"text"', '42', 'null', JSON.stringify({ ...doc(), payload: 'text' }), JSON.stringify({ ...doc(), id: 7 }), JSON.stringify({ ...doc(), issuer: 'nobody' })]) {
      const r = await send(bad)
      assert.equal(r.status, 400, bad.slice(0, 40)); assert.equal(r.reply.payload.code, 'malformedRequest')
    }
  })

  test('step 3, freshness: old is expired; never-good (no issuedAt, the future, an expiry before it was written) is malformedRequest', async () => {
    const { send, doc, clock, runs } = make()
    const at = (ms) => instant(clock.now + ms)
    const code = async (over) => { const r = await send(doc(over)); return r.status === 200 ? 'ok' : `${r.status} ${r.reply.payload.code}` }
    assert.equal(await code({ issuedAt: at(-ACCEPT_MS - SKEW_MS - 2000) }), '422 expired')
    assert.equal(await code({ issuedAt: at(-ACCEPT_MS + 2000) }), 'ok')
    assert.equal(await code({ issuedAt: at(SKEW_MS + 2000) }), '400 malformedRequest')
    assert.equal(await code({ issuedAt: at(30_000) }), 'ok') // a clock half a minute ahead is ordinary
    assert.equal(await code({ issuedAt: at(-60_000), expiresAt: at(-90_000) }), '400 malformedRequest')
    assert.equal(await code({ issuedAt: at(-1800_000), expiresAt: at(-120_000) }), '422 expired')
    assert.equal(await code({ issuedAt: at(-1800_000), expiresAt: at(600_000) }), 'ok') // its own expiry is honoured past the ten minutes
    assert.equal(await code({ issuedAt: at(-HORIZON_MS - SKEW_MS - 2000), expiresAt: at(24 * 3600_000) }), '422 expired') // but for an hour after it was written, not for as long as it says
    const { proof, ...unsigned } = doc(); delete unsigned.issuedAt
    const none = await send(unsigned)
    assert.equal(none.status, 400); assert.match(none.reply.payload.message, /issuedAt/)
    assert.equal(runs.length, 3)
  })

  test('step 3, recipient: a document for someone else is wrongRecipient; one that names nobody is malformedRequest', async () => {
    const { send, doc, runs } = make()
    const wrong = await send(doc({ recipient: other.did }))
    assert.equal(wrong.status, 422); assert.equal(wrong.reply.payload.code, 'wrongRecipient'); assert.equal(wrong.reply.recipient, person.did)
    await signedBy(wrong.reply, room.did, person.did)
    const none = await send(doc({ recipient: undefined }))
    assert.equal(none.status, 400); assert.equal(none.reply.payload.code, 'malformedRequest'); assert.match(none.reply.payload.message, new RegExp(room.did))
    assert.equal(runs.length, 0)
  })

  test('the room answers to its did:webvh and to its did:key, each as the DID it was addressed by', async () => {
    const webvh = 'did:webvh:QmRoomTestOnly:room.example'
    known.set(webvh, roomDidDocument({ did: webvh, roomPublicKey: room.publicKey, publicUrl: 'https://room.example' }))
    const { send, doc, door } = make({ webvh, roomKey: ed25519Multikey(room.publicKey) })
    assert.deepEqual(door.identities().map((i) => i.did), [webvh, room.did])
    const a = await send(doc({ recipient: webvh }))
    assert.equal(a.status, 200); assert.equal(a.reply.issuer, webvh); assert.equal(a.reply.proof.verificationMethod, `${webvh}#room`)
    await signedBy(a.reply, webvh, person.did) // verifies against the key the DID's document lists as #room
    const b = await send(doc({ recipient: room.did }))
    assert.equal(b.status, 200); assert.equal(b.reply.issuer, room.did)
    await signedBy(b.reply, room.did, person.did)
    const wrong = await send(doc({ recipient: other.did }))
    assert.equal(wrong.reply.payload.code, 'wrongRecipient'); assert.equal(wrong.reply.issuer, webvh) // unaddressed answers come from the DID it prefers
    assert.equal(door.info().inDid, true); assert.equal(door.info().address, 'https://room.example/trust-tasks')
    // a DID log that does not carry the room's key yet (minted, never grown): the room cannot sign as it, so it does not answer to it
    const early = make({ webvh, roomKey: null })
    assert.deepEqual(early.door.identities().map((i) => i.did), [room.did])
    assert.equal((await early.send(early.doc({ recipient: webvh }))).reply.payload.code, 'wrongRecipient')
  })

  test('step 4, proof: unsigned is proofRequired; changed, signed by another, or for the wrong purpose is proofInvalid', async () => {
    const { send, doc, door, runs } = make()
    const { proof, ...unsigned } = doc()
    const none = await send(unsigned)
    assert.equal(none.status, 422); assert.equal(none.reply.payload.code, 'proofRequired')
    const changed = await send({ ...doc(), payload: { say: 'not what was signed' } })
    assert.equal(changed.status, 422); assert.equal(changed.reply.payload.code, 'proofInvalid')
    assert.equal((await send({ ...doc({}, other), issuer: person.did })).reply.payload.code, 'proofInvalid') // someone else's signature under this issuer
    assert.equal((await send(doc({}, person, { purpose: 'keyAgreement' }))).reply.payload.code, 'proofInvalid') // a key for agreeing on secrets signs nothing
    assert.equal((await send(doc({}, { did: 'did:web:unknown.example', seed: person.seed, verificationMethod: 'did:web:unknown.example#k' }))).reply.payload.code, 'proofInvalid') // a DID method the room cannot resolve: one answer, whatever the reason
    // a task may take only what a person attests
    door.register(typeUri('test/approve', '0.1'), () => ({ ok: true }), { purposes: ['assertionMethod'] })
    const approve = (purpose) => send(doc({ type: typeUri('test/approve', '0.1') }, person, { purpose }))
    assert.equal((await approve('authentication')).reply.payload.code, 'proofInvalid')
    assert.equal((await approve('assertionMethod')).status, 200)
    assert.equal(runs.length, 0) // nothing unverified reached the echo task
  })

  test('step 4, proof: a did:webvh signer and a did:peer:4 signer verify through the room\'s resolver', async () => {
    const { send, doc, runs } = make()
    const persona = webvhPersona('member.example')
    const a = await send(doc({}, persona))
    assert.equal(a.status, 200, JSON.stringify(a.reply)); assert.equal(a.reply.recipient, persona.did); assert.equal(runs[0].signer, persona.did)
    assert.equal((await send({ ...doc({}, persona), payload: { changed: true } })).reply.payload.code, 'proofInvalid')
    const peerKey = newIdentity(), { long } = didPeer4FromDocument({ verificationMethod: [{ id: '#key-1', type: 'Multikey', publicKeyMultibase: ed25519Multikey(peerKey.publicKey) }], authentication: ['#key-1'] })
    const b = await send(doc({}, { did: long, seed: peerKey.seed, verificationMethod: `${long}#key-1` }))
    assert.equal(b.status, 200, JSON.stringify(b.reply)); assert.equal(runs[1].signer, long)
  })

  test('step 5, the signer is let in: past its allowance a signer gets an empty 429 with Retry-After, and its document keeps its id', async () => {
    const { send, doc, clock, runs, door } = make({ perSignerPerMinute: 2 })
    assert.equal((await send(doc())).status, 200); assert.equal((await send(doc())).status, 200)
    const third = doc(), slow = await send(third)
    assert.equal(slow.status, 429); assert.equal(slow.body, ''); assert.match(slow.headers['retry-after'], /^\d+$/)
    assert.equal((await send(doc({}, other))).status, 200) // someone else is not held up
    assert.equal((await send({ ...third, payload: { forged: true } })).reply.payload.code, 'proofInvalid') // a document that does not verify never counts against the signer it names
    clock.now += 61_000
    assert.equal((await send(third)).status, 200) // the same document, a minute later: its id was not spent
    assert.equal(runs.length, 4); assert.equal(door.counts.rateLimited.signer, 1)
  })

  test('before the steps, an address is held to its own allowance, whoever it says it is', async () => {
    const { send, doc, door } = make({ perAddressPerMinute: 2 })
    await send(doc()); await send('not json')
    const slow = await send(doc({}, other))
    assert.equal(slow.status, 429) // the address's 429 has a small JSON body, as OpenVTC's community gives for its per-address limiter; the signer's stays empty
    assert.deepEqual(Object.keys(JSON.parse(slow.body)).sort(), ['error', 'limiter', 'message', 'retry_after_secs']); assert.equal(JSON.parse(slow.body).error, 'rate_limited'); assert.equal(JSON.parse(slow.body).limiter, 'address')
    assert.equal(JSON.parse(slow.body).retry_after_secs, Number(slow.headers['retry-after'])); assert.equal(slow.headers['x-rate-limit-source'], 'room')
    assert.equal((await send(doc(), { ip: '198.51.100.9' })).status, 200)
    assert.equal(door.counts.rateLimited.address, 1)
  })

  test('a type the door does not serve: unsupportedType, or unsupportedVersion naming what it does serve; only a request is routed', async () => {
    const { send, doc, door } = make()
    serveRoomTasks(door, { acceptEntry: async () => { throw new Error('not used here') } })
    const unknown = await send(doc({ type: typeUri('vtc/join-requests/submit', '0.3') }))
    assert.equal(unknown.status, 422); assert.equal(unknown.reply.payload.code, 'unsupportedType'); assert.deepEqual(unknown.reply.payload.details, { requestedType: typeUri('vtc/join-requests/submit', '0.3') })
    const old = await send(doc({ type: typeUri('messaging/ping', '0.1') }))
    assert.equal(old.status, 422); assert.equal(old.reply.payload.code, 'unsupportedVersion')
    assert.deepEqual(old.reply.payload.details, { requestedType: typeUri('messaging/ping', '0.1'), servedVersions: [PING] })
    assert.deepEqual((await send(doc({ type: typeUri('trust-task-discovery', '0.1') }))).reply.payload.details.servedVersions, [DISCOVERY_0_3, DISCOVERY])
    assert.equal((await send(doc({ type: 'urn:we-play-interop:tasks:spec:input:note:9.9' }))).reply.payload.code, 'unsupportedVersion') // the room's own types have versions too
    for (const notARequest of [`${ECHO}#response`, ERROR_TYPE, `${PING}#response`]) assert.equal((await send(doc({ type: notARequest }))).reply.payload.code, 'unsupportedType', notARequest)
    const explicit = await send(doc({ type: `${ECHO}#request`, payload: { say: 'hi' } })) // a request may say so
    assert.equal(explicit.status, 200); assert.equal(explicit.reply.type, `${ECHO}#response`)
    const unsigned = taskDocument({ type: typeUri('vtc/join-requests/submit', '0.3'), issuer: person.did, recipient: door.ctx.identity.did })
    assert.equal((await send(unsigned)).reply.payload.code, 'proofRequired') // the proof comes before the type: an unsigned caller learns nothing about what is served
  })

  test('step 6, the same document again: the first answer, word for word, and the task does not run twice', async () => {
    const { send, doc, runs, door, clock } = make()
    const d = doc({ payload: { say: 'once' } })
    const first = await send(d), again = await send(d)
    assert.equal(again.status, 200); assert.equal(again.body, first.body); assert.equal(runs.length, 1)
    assert.equal(door.counts.duplicates.answeredAgain, 1); assert.equal(door.counts.answered, 1)
    // a different document under the same id
    const other2 = await send(signTask({ ...taskDocument({ type: ECHO, issuer: person.did, recipient: d.recipient, issuedAt: d.issuedAt, payload: { say: 'twice' } }), id: d.id }, person))
    assert.equal(other2.status, 409); assert.equal(other2.reply.payload.code, 'idConflict'); assert.equal(runs.length, 1)
    // the id is keyed alone, not by who sent it: someone else cannot take it either
    assert.equal((await send(signTask({ ...taskDocument({ type: ECHO, issuer: other.did, recipient: d.recipient, issuedAt: d.issuedAt }), id: d.id }, other))).reply.payload.code, 'idConflict')
    // once the document could no longer be accepted, its record goes
    clock.now += ACCEPT_MS + SKEW_MS + 1000
    assert.equal((await send(d)).reply.payload.code, 'expired')
    assert.equal(door.accepted.claim('x', 'y', clock.now + 1000, clock.now + 61_000).fresh !== undefined, true); assert.equal(door.accepted.records.has(d.id), false)
  })

  test('step 6, while the first is still running: 202 and nothing else; an answer that is not kept: 204', async () => {
    const { send, doc, door } = make()
    let finish; const waiting = new Promise((resolve) => { finish = resolve })
    let ran = 0
    door.register(typeUri('test/slow', '0.1'), async () => { ran++; await waiting; return { done: true } })
    door.register(typeUri('test/secret', '0.1'), () => ({ token: 'one-time' }), { record: false })
    const d = doc({ type: typeUri('test/slow', '0.1') })
    const first = send(d)
    await new Promise((resolve) => setImmediate(resolve))
    const during = await send(d)
    assert.equal(during.status, 202); assert.equal(during.body, '')
    finish()
    assert.equal((await first).status, 200); assert.equal(ran, 1)
    assert.equal((await send(d)).body, (await first).body)
    const s = doc({ type: typeUri('test/secret', '0.1') })
    assert.equal((await send(s)).reply.payload.token, 'one-time')
    const replay = await send(s)
    assert.equal(replay.status, 204); assert.equal(replay.body, '') // the secret is not handed out a second time
    assert.deepEqual(door.counts.duplicates, { answeredAgain: 1, stillRunning: 1, doneNothingKept: 1 })
  })

  test('a task that refuses gives the id back; one that breaks answers internalError and says nothing of why', async () => {
    const { send, doc, door } = make()
    let mood = 'refuse'
    door.register(typeUri('test/moody', '0.1'), () => {
      if (mood === 'refuse') throw new Refusal('test/moody:notYet', 'not yet', { waitFor: 'the other side' }, { retryable: true, retryAfter: instant(door.now() + 30_000) })
      if (mood === 'log') throw new TaskError('permissionDenied', 'join first (member/join)', { status: 403 })
      if (mood === 'break') throw new Error('the database password is hunter2')
      if (mood === 'badcode') throw new Refusal('NOT A CODE', 'x')
      if (mood === 'text') return 'not an object'
      if (mood === 'nothing') return undefined
      return { ok: true }
    })
    const d = doc({ type: typeUri('test/moody', '0.1') })
    const no = await send(d)
    assert.equal(no.status, 422); assert.deepEqual(no.reply.payload, { code: 'test/moody:notYet', retryable: true, message: 'not yet', retryAfter: no.reply.payload.retryAfter, details: { waitFor: 'the other side' }, inResponseTo: { typeUri: d.type, id: d.id } })
    assert.equal(no.headers['retry-after'], '30')
    await signedBy(no.reply, door.ctx.identity.did, person.did)
    mood = 'log'; const denied = await send(d)
    assert.equal(denied.status, 403); assert.equal(denied.reply.payload.code, 'permissionDenied'); assert.equal(denied.reply.payload.retryable, false)
    mood = 'break'; const broke = await send(d)
    assert.equal(broke.status, 500); assert.equal(broke.reply.payload.code, 'internalError'); assert.equal(broke.reply.payload.retryable, true); assert.doesNotMatch(broke.body, /hunter2|database/)
    mood = 'badcode'; assert.equal((await send(d)).reply.payload.code, 'internalError')
    mood = 'text'; assert.equal((await send(d)).reply.payload.code, 'internalError')
    mood = 'nothing'; const ack = await send(d) // the same id, every time: each refusal gave it back
    assert.equal(ack.status, 200); assert.deepEqual(ack.reply.payload, {})
    assert.deepEqual(door.counts.refused, { 'test/moody:notYet': 1, permissionDenied: 1, internalError: 3 })
    // what a task hands back is signed as it is sent: a Date goes out as its text, and the proof still verifies; a refusal's extras that cannot be sent are left out
    door.register(typeUri('test/odd', '0.1'), ({ payload }) => { if (payload.refuse) throw new Refusal('taskFailed', 'no', { n: 10n }, { retryAfter: 'soon' }); return { at: new Date(0), gone: undefined } })
    const odd = await send(doc({ type: typeUri('test/odd', '0.1') }))
    assert.deepEqual(odd.reply.payload, { at: '1970-01-01T00:00:00.000Z' }); await signedBy(odd.reply, door.ctx.identity.did, person.did)
    const oddNo = await send(doc({ type: typeUri('test/odd', '0.1'), payload: { refuse: true } }))
    assert.deepEqual(Object.keys(oddNo.reply.payload), ['code', 'retryable', 'message', 'inResponseTo']); assert.equal(oddNo.headers, undefined); await signedBy(oddNo.reply, door.ctx.identity.did, person.did)
  })

  test('a document nested thousands deep is refused, not crashed on', async () => {
    const { send, doc, runs } = make()
    const d = doc(), deep = JSON.stringify(d).replace('"payload":{}', `"payload":{"a":${'['.repeat(20000)}${']'.repeat(20000)}}`)
    assert.ok(deep.length < MAX_DOCUMENT_BYTES)
    const r = await send(deep)
    assert.equal(r.status, 400); assert.equal(r.reply.payload.code, 'malformedRequest'); assert.equal(runs.length, 0)
  })

  test('the record is bounded: full, the door says unavailable (try again) instead of forgetting an id it accepted', async () => {
    const { send, doc, clock, runs } = make({ maxRecords: 2 })
    const a = doc(), b = doc()
    await send(a); await send(b)
    const full = await send(doc())
    assert.equal(full.status, 503); assert.equal(full.reply.payload.code, 'unavailable'); assert.equal(full.reply.payload.retryable, true); assert.equal(full.headers['retry-after'], '60')
    assert.equal((await send(a)).status, 200); assert.equal(runs.length, 2) // what it holds, it still answers
    clock.now += ACCEPT_MS + SKEW_MS + 2000 // the two it held have run out: swept, and there is room again
    assert.equal((await send(doc())).status, 200)
  })

  test('a task registered with once: false leaves no record: 2,000 signed pings from fresh signers remember no id, and never fill a record of 50', async () => {
    const { door, send, clock } = make({ perSignerPerMinute: 1e6, perAddressPerMinute: 1e6, maxRecords: 50 }) // a record of 50: were pings recorded, the 51st would be refused as unavailable
    serveRoomTasks(door, { acceptEntry: async () => { throw new Error('not used here') } })
    let signer = newIdentity()
    for (let i = 0; i < 2000; i++) {
      if (i % 200 === 0) signer = newIdentity() // fresh signers, a few hundred documents each
      const r = await send(signedTask(signer, { type: PING, recipient: room.did, issuedAt: instant(clock.now), payload: {} }))
      assert.equal(r.status, 200)
    }
    assert.equal(door.info().counts.rememberedIds, 0)
    const same = signedTask(signer, { type: PING, recipient: room.did, issuedAt: instant(clock.now), payload: {} })
    assert.equal((await send(same)).status, 200); assert.equal((await send(same)).status, 200) // again: it runs again, never 202 or 204
    assert.equal(door.info().counts.rememberedIds, 0); assert.equal(door.counts.duplicates.answeredAgain + door.counts.duplicates.doneNothingKept, 0)
  })

  test('the registry: one task per address, known purposes, and serves() lists what is offered', () => {
    const { door } = make()
    assert.deepEqual(door.serves(), [ECHO])
    assert.throws(() => door.register(ECHO, () => ({})), /already served/)
    assert.throws(() => door.register(`${ECHO}#response`, () => ({})), /without a #fragment/)
    assert.throws(() => door.register(typeUri('test/x', '0.1'), 'not a function'), /needs a handler/)
    assert.throws(() => door.register(typeUri('test/x', '0.1'), () => ({}), { purposes: ['keyAgreement'] }), /purposes/)
    door.register(typeUri('test/hidden', '0.1'), () => ({}), { listed: false })
    assert.deepEqual(door.serves(), [ECHO])
  })

  test('discovery and ping, as OpenVTC answers them', async () => {
    const { send, doc, door, clock } = make()
    serveRoomTasks(door, { acceptEntry: async () => { throw new Error('not used here') } })
    const ask = async (type, payload) => (await send(doc({ type, payload }))).reply
    const all = await ask(DISCOVERY, {})
    assert.equal(all.type, `${DISCOVERY}#response`)
    assert.deepEqual(Object.keys(all.payload).sort(), ['acceptanceWindow', 'frameworkVersion', 'supportedTypes'])
    assert.equal(all.payload.frameworkVersion, FRAMEWORK_VERSION); assert.equal(FRAMEWORK_VERSION, '0.6.0')
    assert.deepEqual(all.payload.acceptanceWindow, { maxAgeSeconds: 600, clockSkewSeconds: 60, expiryHorizonSeconds: 3600 }) // what the door applies, read from the same numbers
    assert.deepEqual(all.payload.supportedTypes, door.serves()); assert.deepEqual([...all.payload.supportedTypes].sort(), all.payload.supportedTypes); assert.equal(new Set(all.payload.supportedTypes).size, all.payload.supportedTypes.length)
    for (const t of [DISCOVERY, DISCOVERY_0_3, PING, ECHO, TYPES.note, TYPES.join, TYPES.vote, TYPES.propose]) assert.ok(all.payload.supportedTypes.includes(t), t)
    for (const t of [TYPES.genesis, TYPES.round, TYPES.notebook, TYPES.wake, TYPES.hosted]) assert.ok(!all.payload.supportedTypes.includes(t), t) // only the room writes these, or they go elsewhere
    // the pattern grammar: "*", "<prefix>/*", one whole slug; a "*" anywhere else is a plain character
    const list = async (patterns) => (await ask(DISCOVERY, { patterns })).payload.supportedTypes
    assert.deepEqual(await list(['*']), door.serves())
    assert.deepEqual(await list(['messaging/*']), [PING])
    assert.deepEqual(await list(['messaging/ping/0.2', 'test/*']), [PING, ECHO])
    assert.deepEqual(await list(['*/ping/0.2']), []); assert.deepEqual(await list(['messaging']), []); assert.deepEqual(await list([PING]), []) // the slug, not the whole address
    assert.deepEqual(await list([TYPES.note]), [TYPES.note]) // a type outside the registry is matched whole
    assert.equal((await ask(DISCOVERY, { patterns: 'messaging/*' })).payload.code, 'malformedRequest')
    assert.equal((await ask(DISCOVERY, { patterns: [7] })).payload.code, 'malformedRequest')
    // the older version: the same list, and a window without the horizon it cannot state
    const older = await ask(DISCOVERY_0_3, { patterns: ['messaging/*'] })
    assert.equal(older.type, `${DISCOVERY_0_3}#response`); assert.deepEqual(older.payload, { supportedTypes: [PING], acceptanceWindow: { maxAgeSeconds: 600, clockSkewSeconds: 60 }, frameworkVersion: '0.6.0' })
    // ping: when it answered, that it is well, how it takes documents, and the nonce given back as sent
    const pong = await ask(PING, { nonce: 'n-123' })
    assert.equal(pong.type, `${PING}#response`); assert.deepEqual(pong.payload, { respondedAt: instant(clock.now), status: 'ok', protocols: ['rest'], nonce: 'n-123' })
    assert.deepEqual(Object.keys((await ask(PING, {})).payload), ['respondedAt', 'status', 'protocols'])
  })

  test('what the door reports is counts and outcomes, never who or what', async () => {
    const { send, doc, door } = make()
    const secret = 'a-nonce-nobody-else-should-see'
    await send(doc({ payload: { say: secret } })); await send(doc({ recipient: other.did })); await send('nope')
    const info = door.info('https://room.example'), text = JSON.stringify(info)
    assert.equal(info.address, 'https://room.example/trust-tasks'); assert.deepEqual(info.answersTo, [door.ctx.identity.did]); assert.equal(info.inDid, false)
    assert.deepEqual(info.serves, [ECHO])
    assert.deepEqual(info.accepts, { maxBytes: 65536, maxAgeSeconds: 600, clockSkewSeconds: 60, expiryHorizonSeconds: 3600, proof: info.accepts.proof })
    assert.deepEqual(info.limits, { perSignerPerMinute: 60, perAddressPerMinute: 240, rememberedIds: 18300 })
    assert.equal(info.counts.received, 3); assert.equal(info.counts.answered, 1); assert.deepEqual(info.counts.refused, { wrongRecipient: 1, malformedRequest: 1 }); assert.equal(info.counts.rememberedIds, 1)
    assert.ok(!text.includes(secret) && !text.includes(person.did) && !text.includes(other.did) && !text.includes('203.0.113.7'))
  })
})

describe('the door in a running room', () => {
  let ctx, base, dir
  const person = newIdentity(), stranger = newIdentity()
  const PUBLIC = 'https://room.example'
  const get = async (p) => (await fetch(base + p)).json()
  const raw = (body, path = '/trust-tasks', headers = { 'content-type': 'application/json' }) => fetch(base + path, { method: 'POST', headers, body })

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wpi-door-'))
    const config = { ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, publicUrl: PUBLIC, checkEveryMinutes: 0, boardDataUrl: 'data:application/json,{}', llm: { ...baseConfig.llm, apiKey: '' } }
    ctx = await createApp(config, { hostWelcomeMs: null, resolver })
    await new Promise((resolve) => ctx.server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${ctx.server.address().port}`
  })
  after(async () => { await ctx.stop(); rmSync(dir, { recursive: true, force: true }) })

  test('a document built with signedTask and sent with postTask gets a signed #response, at /trust-tasks and at /v1/trust-tasks', async () => {
    const room = ctx.identity.did
    const ping = signedTask(person, { type: PING, recipient: room, payload: { nonce: 'abc' } })
    const a = await postTask(base, ping)
    assert.equal(a.status, 200); assert.equal(a.kind, 'response'); assert.equal(a.reply.type, `${PING}#response`); assert.equal(a.payload.nonce, 'abc'); assert.equal(a.payload.status, 'ok')
    assert.deepEqual(await verifyTask(a.reply, { keyFor: createResolver().keyFor, me: person.did, purposes: ['authentication'] }), { ok: true, signer: room }) // the reply's proof, against the room's key
    assert.equal(a.reply.threadId, ping.id)
    const b = await postTask(`${base}/v1`, signedTask(person, { type: DISCOVERY, recipient: room, payload: { patterns: ['messaging/*', 'trust-task-discovery/*'] } }))
    assert.equal(b.kind, 'response'); assert.deepEqual(b.payload.supportedTypes, [PING, DISCOVERY_0_3, DISCOVERY])
  })

  test('over http: JSON back, open to any origin, POST only; a huge body is refused without being kept', async () => {
    const res = await raw(JSON.stringify(signedTask(person, { type: PING, recipient: ctx.identity.did })))
    assert.equal(res.status, 200); assert.equal(res.headers.get('content-type'), 'application/json'); assert.equal(res.headers.get('access-control-allow-origin'), '*'); assert.equal(res.headers.get('cache-control'), 'no-store')
    const pre = await fetch(`${base}/trust-tasks`, { method: 'OPTIONS' })
    assert.equal(pre.status, 204); assert.equal(pre.headers.get('access-control-allow-origin'), '*'); assert.match(pre.headers.get('access-control-allow-methods'), /POST/)
    const getIt = await fetch(`${base}/trust-tasks`)
    assert.equal(getIt.status, 405); assert.equal(getIt.headers.get('allow'), 'POST')
    const big = await raw(JSON.stringify({ ...signedTask(person, { type: PING, recipient: ctx.identity.did }), payload: { nonce: 'x'.repeat(200_000) } }))
    assert.equal(big.status, 400)
    const refusal = await big.json()
    assert.equal(refusal.type, ERROR_TYPE); assert.equal(refusal.payload.code, 'malformedRequest'); assert.deepEqual(refusal.payload.details, { maxBytes: 65536 }); assert.match(refusal.payload.message, /^the document is 2\d{5} bytes/)
    assert.equal((await verifyTask(refusal, { keyFor: createResolver().keyFor, requireRecipient: false })).ok, true)
    const huge = await raw(Buffer.alloc(3 * 1024 * 1024, 0x20)) // past a megabyte the room stops counting and answers while the rest is still arriving
    assert.equal(huge.status, 400); assert.match((await huge.json()).payload.message, /^the document is more than \d+ bytes/)
    const notJson = await raw('this is not a document')
    assert.equal(notJson.status, 400); assert.equal((await notJson.json()).payload.code, 'malformedRequest')
  })

  test('a room line written through the door is in the log, exactly as one sent to /api/entries would be', async () => {
    const room = ctx.identity.did, before = ctx.log.entries.length
    // nothing gets in without a verified signature
    const { proof, ...unsigned } = signedTask(person, { type: TYPES.join, recipient: room, payload: { name: 'Door Tester' } })
    assert.equal((await postTask(base, unsigned)).code, 'proofRequired')
    assert.equal((await postTask(base, { ...unsigned, proof: { ...proof, proofValue: proof.proofValue.slice(0, -4) + 'zzzz' } })).code, 'proofInvalid')
    assert.equal(ctx.log.entries.length, before)
    // a note before joining: the log's own refusal, with its own words, under the shared code
    const early = await postTask(base, signedTask(person, { type: TYPES.note, recipient: room, payload: { text: 'hello', kind: 'message' } }))
    assert.equal(early.status, 403); assert.equal(early.code, 'permissionDenied'); assert.match(early.message, /join first/)
    // join, then a note
    const join = signedTask(person, { type: TYPES.join, recipient: room, payload: { name: 'Door Tester' } })
    const joined = await postTask(base, join)
    assert.equal(joined.status, 200); assert.equal(joined.kind, 'response'); assert.equal(joined.reply.type, `${TYPES.join}#response`); assert.equal(joined.payload.duplicate, false)
    const note = signedTask(person, { type: TYPES.note, recipient: room, payload: { text: 'written through the Trust Task door', kind: 'message' } })
    const noted = await postTask(base, note)
    assert.equal(noted.kind, 'response')
    const entry = await get(`/api/log/${noted.payload.entry.hash}`)
    assert.deepEqual(entry.document, note); assert.equal(entry.author, person.did); assert.equal(entry.seq, noted.payload.entry.seq)
    const { document, ...rest } = entry
    assert.deepEqual(noted.payload.entry, rest) // the answer is the entry without the document, which the sender has
    assert.ok((await get('/api/log?type=note')).entries.some((e) => e.hash === entry.hash))
    assert.equal((await get('/api/verify')).ok, true) // the whole chain still verifies, this line's proof included
    // the same document again: the same answer from the door; at /api/entries, the same entry as a duplicate
    const again = await postTask(base, note)
    assert.deepEqual(again.reply, noted.reply)
    const rest2 = await fetch(`${base}/api/entries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(note) })
    assert.equal(rest2.status, 200); assert.equal((await rest2.json()).hash, entry.hash)
    assert.equal(ctx.log.entries.filter((e) => e.document.id === note.id).length, 1)
    // after a restart the door's own record is gone: the log's index of ids still answers a replay as a duplicate, and a changed document as idConflict
    ctx.door.accepted.records.clear()
    const afterRestart = await postTask(base, note)
    assert.equal(afterRestart.kind, 'response'); assert.equal(afterRestart.payload.duplicate, true); assert.equal(afterRestart.payload.entry.hash, entry.hash)
    ctx.door.accepted.records.clear()
    const forged = await postTask(base, signTask({ ...taskDocument({ type: TYPES.note, issuer: person.did, recipient: room, payload: { text: 'something else', kind: 'message' } }), id: note.id }, person))
    assert.equal(forged.status, 409); assert.equal(forged.code, 'idConflict')
  })

  test('the room\'s other types are refused in the log\'s own words: what only the room writes, what is private, what goes elsewhere', async () => {
    const room = ctx.identity.did
    const code = async (type, payload = {}) => { const r = await postTask(base, signedTask(person, { type, recipient: room, payload })); return `${r.status} ${r.code}: ${r.message}` }
    assert.match(await code(TYPES.round), /^403 permissionDenied: only the workspace writes round/)
    assert.match(await code(TYPES.notebook), /^400 malformedRequest: notebook is private: send it to \/api\/notebook/)
    assert.match(await code(TYPES.wake, { agent: person.did, urlHash: null, on: [] }), /^400 malformedRequest: send wake settings to \/api\/wake/)
    assert.match(await code(TYPES.note, { text: '', kind: 'message' }), /^400 malformedRequest: text: 1 to 2000 characters/)
    assert.match(await code(TYPES.vote, { proposal: 'a'.repeat(64), choice: 'for' }), /^400 malformedRequest: no proposal with that hash/)
    const stray = await postTask(base, signedTask(stranger, { type: TYPES.vote, recipient: room, payload: { proposal: 'a'.repeat(64), choice: 'for' } }))
    assert.equal(stray.code, 'permissionDenied')
    // a document signed the room's older way (signedDocument: no recipient) is not a door document
    const old = await postTask(base, signedDocument(person, { type: TYPES.note, payload: { text: 'no recipient', kind: 'message' } }))
    assert.equal(old.status, 400); assert.equal(old.code, 'malformedRequest'); assert.match(old.message, /recipient/)
  })

  test('/api/info says where the door is, what it serves, and what it has done', async () => {
    const { door } = await get('/api/info')
    assert.equal(door.address, `${PUBLIC}/trust-tasks`); assert.deepEqual(door.answersTo, [ctx.identity.did]); assert.equal(door.inDid, false) // no DID log yet
    assert.ok(door.serves.includes(PING) && door.serves.includes(DISCOVERY) && door.serves.includes(TYPES.note))
    assert.ok(door.counts.received >= 10); assert.ok(door.counts.answered >= 4); assert.ok(door.counts.answeredByType[PING] >= 2); assert.equal(door.counts.answeredByType[TYPES.note], 2)
    for (const c of ['proofRequired', 'proofInvalid', 'permissionDenied', 'malformedRequest', 'idConflict']) assert.ok(door.counts.refused[c] >= 1, c)
    assert.ok(door.counts.duplicates.answeredAgain >= 1); assert.deepEqual(door.counts.rateLimited, { address: 0, signer: 0 })
    assert.ok(!JSON.stringify(door).includes(person.did))
  })

  test('with its did:webvh: the DID document names the door, and a document addressed to that DID is answered as it', async () => {
    const m = await mintRoomDid('room.example')
    writeFileSync(join(dir, 'did.jsonl'), m.log); writeFileSync(join(dir, 'update-key.txt'), m.seedHex + '\n')
    assert.equal((await growRoomDid({ dataDir: dir, publicUrl: PUBLIC, roomPublicKey: ctx.identity.publicKey, log: () => {} })).grown, true)
    await ctx.join.refresh(true)
    // what anyone resolves from the room's own /.well-known/did.jsonl
    const log = (await (await fetch(`${base}/.well-known/did.jsonl`)).text()).trim().split('\n').map((l) => JSON.parse(l))
    const didDoc = (await resolveDIDFromLog(log)).didDocument
    assert.equal(didDoc.id, m.did)
    assert.equal(serviceEndpoint(didDoc, 'TrustTaskHTTPS'), PUBLIC)
    const info = (await get('/api/info')).door
    assert.equal(info.address, `${serviceEndpoint(didDoc, 'TrustTaskHTTPS')}/trust-tasks`); assert.equal(info.inDid, true); assert.deepEqual(info.answersTo, [m.did, ctx.identity.did])
    // a sender that starts from the DID: addressed to it, answered as it, and the answer verifies against its document
    known.set(m.did, didDoc)
    const pong = await postTask(base, signedTask(person, { type: PING, recipient: m.did, payload: { nonce: 'from the DID' } }))
    assert.equal(pong.kind, 'response'); assert.equal(pong.reply.issuer, m.did); assert.equal(pong.reply.proof.verificationMethod, `${m.did}#room`)
    assert.deepEqual(await verifyTask(pong.reply, { keyFor: resolver.keyFor, me: person.did, purposes: ['authentication'] }), { ok: true, signer: m.did })
    // and still to its did:key
    assert.equal((await postTask(base, signedTask(person, { type: PING, recipient: ctx.identity.did }))).reply.issuer, ctx.identity.did)
    // a did:webvh member writes through the same door (its DID document comes from the stand-in resolver)
    const persona = webvhPersona('member.example')
    const joined = await postTask(base, signedTask(persona, { type: TYPES.join, recipient: m.did, payload: { name: 'A persona' } }))
    assert.equal(joined.kind, 'response', JSON.stringify(joined.reply)); assert.equal(joined.reply.recipient, persona.did)
    assert.equal((await get(`/api/log/${joined.payload.entry.hash}`)).author, persona.did)
  })

  test('while the room restarts, the door says so in its own form: a signed unavailable with when to try again', async () => {
    ctx.waits.stopping = true
    try {
      const r = await postTask(base, signedTask(person, { type: PING, recipient: ctx.identity.did }))
      assert.equal(r.status, 503); assert.equal(r.kind, 'error'); assert.equal(r.code, 'unavailable'); assert.equal(r.reply.payload.retryable, true); assert.match(r.reply.payload.retryAfter, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
    } finally { ctx.waits.stopping = false }
  })
})
