// An agent with its own key writes its notebook and submits a change with a signed document, as the bridge does
// (agent/bridge.js), without a session and without the read header (which is GET and HEAD only). The gate lets these
// two doors through because the document is its own proof; a change's signature and live permission are checked
// before a byte of its body is read.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { after, before, describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { TYPES, signedDocument } from '../src/shared/types.js'
import { startRoom } from './helpers/room.js'

const DIFF = 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n # x\n+one more line\n'

describe('an agent with its own key writes with a signed document, never with the read header', () => {
  let room, a, agent, stranger, noteDelegation, changeDelegation
  before(async () => {
    room = await startRoom(); a = await room.firstMember('Person A'); agent = newIdentity(); stranger = newIdentity()
    assert.equal((await room.linkGithub(a)).status, 201)
    const in1d = { expiresAt: new Date(Date.now() + 86400000).toISOString() }
    const d = await room.say(a.id, 'delegate', { delegate: agent.did, scope: ['note'], repos: ['acme/app'] }, in1d)
    assert.equal(d.status, 201, d.text); noteDelegation = d.body.hash
  })
  after(() => room.stop())

  const notebook = (who, op, text) => room.call('/api/notebook', { method: 'POST', body: signedDocument(who, { type: TYPES.notebook, payload: { agent: agent.did, op, ...(text ? { text } : {}) } }) })
  const change = (who, delegation, onBehalfOf, text = DIFF, claimed = text) => {
    const doc = signedDocument(who, { type: TYPES.change, payload: { title: 'One more line', sha256: createHash('sha256').update(claimed).digest('hex'), bytes: Buffer.byteLength(claimed) }, onBehalfOf, delegation })
    return room.call('/api/changes', { method: 'POST', headers: { 'content-type': 'text/x-diff; charset=utf-8', 'x-wpi-change': JSON.stringify(doc) }, raw: text })
  }

  test('the agent adds to and reads its own notebook with no session', async () => {
    const add = await notebook(agent, 'add', 'a note to myself')
    assert.equal(add.status, 200, add.text)
    const read = await notebook(agent, 'read')
    assert.equal(read.status, 200, read.text)
    assert.ok(read.body.notes.some((n) => n.text === 'a note to myself'))
  })

  test('a stranger cannot open the agent\'s notebook', async () => {
    const r = await notebook(stranger, 'read')
    assert.equal(r.status, 403, r.text)
  })

  test('a change from an agent whose permission does not cover changes is refused before its body is read', async () => {
    const r = await change(agent, noteDelegation, a.id.did)
    assert.equal(r.status, 403, r.text)
    assert.match(r.text, /live permission covers changes/)
  })

  test('a change from a stranger naming someone else\'s permission is refused', async () => {
    const r = await change(stranger, noteDelegation, a.id.did)
    assert.equal(r.status, 403, r.text)
  })

  test('a change whose header signature does not hold is refused before its body is read', async () => {
    const d = await room.say(a.id, 'delegate', { delegate: agent.did, scope: ['note', 'change'], repos: ['acme/app'] }, { expiresAt: new Date(Date.now() + 86400000).toISOString() })
    assert.equal(d.status, 201, d.text); changeDelegation = d.body.hash
    const doc = signedDocument(agent, { type: TYPES.change, payload: { title: 'x', sha256: createHash('sha256').update(DIFF).digest('hex'), bytes: Buffer.byteLength(DIFF) }, onBehalfOf: a.id.did, delegation: changeDelegation })
    doc.payload.title = 'changed after signing'
    const r = await room.call('/api/changes', { method: 'POST', headers: { 'content-type': 'text/x-diff; charset=utf-8', 'x-wpi-change': JSON.stringify(doc) }, raw: DIFF })
    assert.equal(r.status, 401, r.text)
  })

  test('with a permission that covers changes, a signed change gets past the gate and its signature check', async () => {
    const r = await change(agent, changeDelegation, a.id.did)
    assert.notEqual(r.status, 401, r.text); assert.notEqual(r.status, 403, r.text)
  })
})
