// The public record a member downloads from the Log tab: every line the room's AIs can read, with its author's signed
// document, and nothing of a People only line: not its words, not its hash, not a line naming it as the one before.
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { verifySignature } from '../src/shared/proof.js'
import { PUBLIC_RECORD_FORMAT } from '../src/server/views.js'
import { startRoom } from './helpers/room.js'

describe('the public record, as a file', () => {
  let room, a, b, hidden
  before(async () => {
    room = await startRoom()
    a = await room.firstMember('Person A')
    b = await room.newMember(a.id, 'Person B')
    await room.say(a.id, 'note', { kind: 'message', text: 'Hello everyone' })
    hidden = (await room.say(b.id, 'note', { kind: 'message', text: 'Only for people: the secret plan', audience: 'people' })).body
    await room.say(a.id, 'note', { kind: 'message', text: 'Said right after a people-only line' })
  })
  after(() => room.stop())

  test('a member downloads it as a file, with every line the AIs can read and no People only line', async () => {
    const r = await room.call('/api/export/public', { cookie: a.cookie })
    assert.equal(r.status, 200)
    assert.match(r.headers.get('content-disposition'), /^attachment; filename="inwove-public-record-\d{4}-\d{2}-\d{2}\.json"$/)
    assert.equal(r.headers.get('cache-control'), 'no-store')
    const f = r.body
    assert.equal(f.format, PUBLIC_RECORD_FORMAT); assert.equal(f.version, 1); assert.equal(f.count, f.entries.length)
    const texts = f.entries.map((e) => e.document.payload?.text).filter(Boolean)
    assert.ok(texts.includes('Hello everyone') && texts.includes('Said right after a people-only line'))
    assert.ok(!r.text.includes('the secret plan'), 'the words of a People only line are not in it')
    assert.ok(!r.text.includes(hidden.hash), 'nor its hash, so not even a line naming it as the one before')
    const all = room.ctx.log.entries.filter((e) => e.document.payload?.audience !== 'people').length
    assert.equal(f.count, all, 'every other line is there')
  })

  test('it is what an agent reads, and each line still checks against its author\'s key', async () => {
    const f = (await room.call('/api/export/public', { cookie: a.cookie })).body
    const asAgent = []
    for (let after = -1; ;) { const page = (await room.call(`/api/log?after=${after}&limit=500`, { cookie: a.cookie })).body.entries.filter((e) => e.document.payload?.audience !== 'people'); asAgent.push(...page); if (page.length < 1 || asAgent.length >= f.count) break; after = asAgent.at(-1).seq }
    assert.deepEqual(f.entries.map((e) => e.hash), asAgent.map((e) => e.hash))
    const mine = f.entries.find((e) => e.document.payload?.text === 'Hello everyone')
    const key = await room.ctx.log.resolver.keyFor(mine.document.issuer, mine.document.proof.verificationMethod, mine.document.proof.proofPurpose)
    assert.equal(verifySignature(mine.document, key).ok, true)
  })

  test('nobody signed out gets it', async () => {
    assert.equal((await room.call('/api/export/public')).status, 401)
  })
})
