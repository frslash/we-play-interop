// No-host copies: the cap on lines waiting for earlier lines is per member, so one member who
// fills their share cannot stall everyone else's waiting lines.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { Copy, LINE_TYPE, lineId } from '../src/shared/hostless.js'
import { sign } from '../src/shared/proof.js'

const ROOM = 'did:example:room-test'
const AT = '2026-11-09T12:00:00.000Z'
const NEVER = 'f'.repeat(64) // a line id that is never sent

function lineBy (me, text, after = []) {
  const unsigned = { type: LINE_TYPE, room: ROOM, issuer: me.did, text, after: [...after].sort(), created: AT }
  return sign(unsigned, { seed: me.seed, verificationMethod: me.verificationMethod, created: AT })
}

function three (maxWaiting) {
  const ada = newIdentity(), ben = newIdentity(), cy = newIdentity()
  const copy = new Copy({ room: ROOM, members: [ada.did, ben.did, cy.did], me: cy, now: () => AT, maxWaiting })
  return { ada, ben, cy, copy }
}

describe('no host: the waiting cap is per member', () => {
  test('one member fills their cap; another member\'s waiting line is still accepted', () => {
    const { ada, ben, copy } = three(3)
    for (let i = 0; i < 3; i++) assert.ok(copy.receive(lineBy(ada, `ada waits ${i}`, [NEVER])).waiting)
    assert.equal(copy.waitingOf(ada.did), 3)

    const over = copy.receive(lineBy(ada, 'ada one too many', [NEVER]))
    assert.equal(over.ok, false)
    assert.match(over.reason, /too many lines waiting/)

    const benLine = copy.receive(lineBy(ben, 'ben waits', [NEVER]))
    assert.ok(benLine.ok && benLine.waiting, 'ben\'s waiting line is taken although ada filled hers')
    assert.equal(copy.waitingOf(ben.did), 1)
    assert.equal(copy.waiting.size, 4)
  })

  test('each member gets a full share, and no more', () => {
    const { ada, ben, copy } = three(2)
    for (const who of [ada, ben]) {
      for (let i = 0; i < 2; i++) assert.ok(copy.receive(lineBy(who, `waits ${i}`, [NEVER])).waiting)
      assert.equal(copy.receive(lineBy(who, 'over', [NEVER])).ok, false)
    }
    assert.equal(copy.waiting.size, 4)
  })

  test('when a member\'s lines move in, their share opens up again', () => {
    const { ada, ben, copy } = three(2)
    const root = lineBy(ben, 'ben root')
    assert.ok(copy.receive(lineBy(ada, 'ada a', [lineId(root)])).waiting)
    assert.ok(copy.receive(lineBy(ada, 'ada b', [lineId(root)])).waiting)
    assert.equal(copy.receive(lineBy(ada, 'ada c', [NEVER])).ok, false)
    assert.ok(copy.receive(root).ok)
    assert.equal(copy.waitingOf(ada.did), 0)
    assert.equal(copy.waiting.size, 0)
    assert.ok(copy.receive(lineBy(ada, 'ada c', [NEVER])).waiting, 'room again for ada')
  })

  test('a line counts against its signed issuer, whoever passes it on', () => {
    const { ada, ben, copy } = three(1)
    const adas = lineBy(ada, 'ada waits', [NEVER])
    assert.ok(copy.receive(structuredClone(adas)).waiting) // relayed by anyone, it is still ada's
    assert.equal(copy.waitingOf(ada.did), 1)
    assert.equal(copy.waitingOf(ben.did), 0)
    assert.ok(copy.receive(lineBy(ben, 'ben waits', [NEVER])).waiting)
  })

  test('the copy\'s own lines still go in while others are capped', () => {
    const { ada, copy } = three(1)
    assert.ok(copy.receive(lineBy(ada, 'ada waits', [NEVER])).waiting)
    assert.ok(copy.add('Cy: still writing'))
  })
})
