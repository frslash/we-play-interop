// The Trust Task door of a room that is really running, asked the way another project's client asks it: a key made
// for this run, a signed standard document, POST <base>/trust-tasks, and the signed answer checked against the room's
// own DID. The tests in test/door.test.js show the room agrees with itself; this one shows a running room answers.
//
// Skipped unless LIVE_ROOM_URL is set (it calls a host outside this machine):
//   LIVE_ROOM_URL=https://<room> node --test test/live/door-live.test.js
// It only asks (discovery, ping) and sends documents meant to be refused: it writes nothing to the room.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { DISCOVERY, DISCOVERY_0_3, PING } from '../../src/server/door.js'
import { createResolver } from '../../src/server/resolver.js'
import { newIdentity } from '../../src/shared/did.js'
import { ERROR_PREFIX, postTask, serviceEndpoint, signedTask, verifyTask } from '../../src/shared/trusttask.js'

const ROOM = (process.env.LIVE_ROOM_URL || '').replace(/\/+$/, '')

describe('a running room\'s Trust Task door', { skip: ROOM ? false : 'set LIVE_ROOM_URL=https://<room> to ask a running room' }, () => {
  const me = newIdentity(), resolver = createResolver() // did:key offline; a did:webvh from its own host, over https
  let door
  const info = async () => { door ??= (await (await fetch(`${ROOM}/api/info`)).json()).door; return door }
  /** The answer is signed, for authentication, by the DID the document was addressed to. */
  const signedBy = async (reply, did, to = me.did) => assert.deepEqual(await verifyTask(reply, { keyFor: resolver.keyFor, me: to, requireRecipient: Boolean(to), purposes: ['authentication'] }), { ok: true, signer: did })

  test('the room says where its door is and what it serves', async () => {
    const d = await info()
    assert.ok(d, '/api/info has no door entry: this room runs code from before the door')
    assert.match(d.address, /\/trust-tasks$/); assert.ok(d.answersTo.length >= 1)
    for (const t of [DISCOVERY, DISCOVERY_0_3, PING]) assert.ok(d.serves.includes(t), t)
  })

  test('discovery and ping, addressed to each DID the room answers to, come back signed by that DID', async () => {
    const d = await info()
    for (const did of d.answersTo) {
      const found = await postTask(ROOM, signedTask(me, { type: DISCOVERY, recipient: did, payload: { patterns: ['messaging/*', 'trust-task-discovery/*'] } }))
      assert.equal(found.status, 200, JSON.stringify(found.reply)); assert.equal(found.kind, 'response')
      assert.deepEqual(found.payload.supportedTypes, [PING, DISCOVERY_0_3, DISCOVERY])
      assert.ok(found.payload.acceptanceWindow.maxAgeSeconds >= 1 && found.payload.acceptanceWindow.clockSkewSeconds >= 0 && found.payload.acceptanceWindow.expiryHorizonSeconds >= 1)
      assert.match(found.payload.frameworkVersion, /^\d+\.\d+\.\d+$/)
      await signedBy(found.reply, did)
      const nonce = `live-${Date.now()}`
      const pong = await postTask(`${ROOM}/v1`, signedTask(me, { type: PING, recipient: did, payload: { nonce } })) // the address clients that add /v1 to a bare origin use
      assert.equal(pong.status, 200, JSON.stringify(pong.reply)); assert.equal(pong.reply.type, `${PING}#response`)
      assert.equal(pong.payload.nonce, nonce); assert.equal(pong.payload.status, 'ok'); assert.ok(Array.isArray(pong.payload.protocols))
      assert.ok(Math.abs(Date.parse(pong.payload.respondedAt) - Date.now()) < 5 * 60_000, 'the room\'s clock and this one differ by more than five minutes')
      await signedBy(pong.reply, did)
    }
  })

  test('a document that is unsigned, or meant for someone else, is refused with a signed trust-task-error', async () => {
    const d = await info(), did = d.answersTo[0]
    const { proof, ...unsigned } = signedTask(me, { type: PING, recipient: did })
    const a = await postTask(ROOM, unsigned)
    assert.equal(a.status, 422); assert.equal(a.code, 'proofRequired'); assert.ok(a.reply.type.startsWith(ERROR_PREFIX)); assert.equal(typeof a.reply.payload.retryable, 'boolean')
    await signedBy(a.reply, did)
    const b = await postTask(ROOM, signedTask(me, { type: PING, recipient: newIdentity().did }))
    assert.equal(b.status, 422); assert.equal(b.code, 'wrongRecipient')
    await signedBy(b.reply, did)
  })

  test('a room with a did:webvh names the door in its DID document (a TrustTaskHTTPS service at the room\'s origin)', async (t) => {
    const d = await info(), did = d.answersTo.find((x) => x.startsWith('did:webvh:'))
    if (!did) return t.skip('this room answers as a did:key only (no PUBLIC_URL, or its DID log does not carry the room\'s key yet)')
    const base = serviceEndpoint(await resolver.resolve(did), 'TrustTaskHTTPS')
    assert.ok(base, 'the DID document has no TrustTaskHTTPS service yet: its log needs one more entry (the host adds it on start when it holds the update key; otherwise the people who hold that key sign it)')
    assert.equal(`${base.replace(/\/+$/, '')}/trust-tasks`, d.address); assert.equal(d.inDid, true)
    assert.equal(new URL(base).origin, new URL(ROOM).origin)
  })
})
