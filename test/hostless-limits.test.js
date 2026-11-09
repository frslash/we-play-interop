// No-host limits: a copy with more than 64 loose ends can still add a line, and a copy holds
// only so many lines that wait for earlier lines it does not have.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { Copy, LINE_TYPE, MAX_AFTER, MAX_WAITING, lineId, lineProblem } from '../src/shared/hostless.js'
import { sign } from '../src/shared/proof.js'

const ROOM = 'did:example:room-test'
const AT = '2026-11-09T12:00:00.000Z'

// A signed line written by hand, naming whatever `after` we choose.
function lineBy (me, text, after = []) {
  const unsigned = { type: LINE_TYPE, room: ROOM, issuer: me.did, text, after: [...after].sort(), created: AT }
  return sign(unsigned, { seed: me.seed, verificationMethod: me.verificationMethod, created: AT })
}

function pair (opts = {}) {
  const ada = newIdentity(), ben = newIdentity()
  const members = [ada.did, ben.did]
  return {
    ada, ben,
    a: new Copy({ room: ROOM, members, me: ada, now: () => AT, ...opts }),
    b: new Copy({ room: ROOM, members, me: ben, now: () => AT, ...opts })
  }
}

describe('no host: a copy with more than 64 loose ends still adds a line', () => {
  test('70 loose ends: the new line names 64 of them, the next names the rest, and other copies take both', () => {
    const { ada, a, b } = pair()
    const loose = Array.from({ length: 70 }, (_, i) => lineBy(ada, `loose ${i}`))
    for (const l of loose) assert.ok(b.receive(l).ok)
    assert.equal(b.heads().length, 70)
    assert.ok(b.heads().length > MAX_AFTER)

    const first = b.add('Ben: one line over many loose ends')
    assert.equal(first.after.length, MAX_AFTER)
    assert.equal(lineProblem(first), null, 'the line is well formed')
    assert.equal(b.heads().length, 70 - MAX_AFTER + 1, 'the loose ends not named stay heads')

    const second = b.add('Ben: and the rest')
    assert.equal(second.after.length, 70 - MAX_AFTER + 1)
    assert.deepEqual(b.heads(), [lineId(second)], 'now one head')

    // Ada's copy takes them too, and agrees on the order.
    for (const l of loose) a.receive(l)
    assert.ok(a.receive(second).waiting)
    assert.ok(a.receive(first).ok)
    assert.equal(a.waiting.size, 0)
    assert.deepEqual(a.order().map((l) => l.text), b.order().map((l) => l.text))
    assert.deepEqual(b.order().slice(-2).map((l) => l.text), ['Ben: one line over many loose ends', 'Ben: and the rest'])
  })
})

describe('no host: lines waiting for earlier lines are capped', () => {
  test('the default cap exists', () => {
    assert.equal(new Copy({ room: ROOM, members: [] }).maxWaiting, MAX_WAITING)
    assert.ok(MAX_WAITING > 0)
  })

  test('past the cap, lines naming lines not here are refused; lines that are ready are still taken', () => {
    const { ada, b } = pair({ maxWaiting: 3 })
    const never = 'f'.repeat(64) // a line id that is never sent
    for (let i = 0; i < 3; i++) {
      const r = b.receive(lineBy(ada, `waits ${i}`, [never]))
      assert.ok(r.ok && r.waiting)
    }
    assert.equal(b.waiting.size, 3)

    const over = b.receive(lineBy(ada, 'one too many', [never]))
    assert.equal(over.ok, false)
    assert.match(over.reason, /too many lines waiting/)
    assert.equal(b.waiting.size, 3, 'nothing more is held')

    // A line already waiting, sent again, is not counted twice.
    assert.ok(b.receive(lineBy(ada, 'waits 0', [never])).already)

    // A line whose earlier lines are all here is taken even when the cap is reached.
    const root = lineBy(ada, 'a root line')
    assert.ok(b.receive(root).ok)
    const child = lineBy(ada, 'after the root', [lineId(root)])
    const r = b.receive(child)
    assert.ok(r.ok && !r.waiting)
    assert.deepEqual(b.order().map((l) => l.text), ['a root line', 'after the root'])

    // And my own lines can still be added.
    assert.ok(b.add('Ben: still writing'))
  })

  test('when earlier lines arrive the waiting ones move in, and room opens up again', () => {
    const { ada, b } = pair({ maxWaiting: 2 })
    const l1 = lineBy(ada, 'first')
    const l2 = lineBy(ada, 'second', [lineId(l1)])
    const l3 = lineBy(ada, 'third', [lineId(l2)])
    assert.ok(b.receive(l3).waiting)
    assert.ok(b.receive(l2).waiting)
    assert.equal(b.receive(lineBy(ada, 'other', [lineId(l1)])).ok, false, 'cap reached')
    assert.ok(b.receive(l1).ok)
    assert.equal(b.waiting.size, 0)
    assert.deepEqual(b.order().map((l) => l.text), ['first', 'second', 'third'])
    assert.ok(b.receive(lineBy(ada, 'waits again', ['e'.repeat(64)])).waiting, 'room again')
  })
})
