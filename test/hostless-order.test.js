// No-host check (4): two members add lines at the same moment with no server, and every copy
// ends up in the same order. Each member's agent keeps its own copy; lines go copy to copy.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { Copy, exchange, lineId, lineProblem } from '../src/shared/hostless.js'
import { sign } from '../src/shared/proof.js'

const ROOM = 'did:example:room-test'
const SAME_MOMENT = () => '2026-11-09T12:00:00.000Z'
const texts = (copy) => copy.order().map((l) => l.text)

function members (n) {
  const ids = Array.from({ length: n }, () => newIdentity())
  const dids = ids.map((i) => i.did)
  return ids.map((me) => new Copy({ room: ROOM, members: dids, me, now: SAME_MOMENT }))
}

// A seeded shuffle, so delivery order differs between copies but the test is repeatable.
function shuffled (list, seed) {
  const a = [...list]; let s = seed
  for (let i = a.length - 1; i > 0; i--) { s = (s * 1103515245 + 12345) % 2147483648; const j = s % (i + 1); [a[i], a[j]] = [a[j], a[i]] }
  return a
}

describe('no host: every copy ends up in the same order', () => {
  test('two members add a line at the same moment, each without seeing the other’s', () => {
    const [a, b] = members(2)
    const la = a.add('Ada: hello from my side')
    const lb = b.add('Ben: hello from mine')
    assert.equal(la.created, lb.created, 'same moment')
    assert.deepEqual(la.after, []); assert.deepEqual(lb.after, [])
    assert.notDeepEqual(texts(a), texts(b), 'before they meet each copy has only its own line')
    a.receive(lb); b.receive(la) // passed directly, no server
    assert.deepEqual(texts(a), texts(b))
    assert.equal(texts(a).length, 2)
    assert.deepEqual(a.heads(), b.heads())
  })

  test('both keep adding while apart; after they meet, the order is the same and each side’s own lines keep their order', () => {
    const [a, b] = members(2)
    for (let i = 1; i <= 5; i++) { a.add(`a${i}`); b.add(`b${i}`) }
    exchange(a, b)
    assert.deepEqual(texts(a), texts(b))
    const order = texts(a)
    for (const side of ['a', 'b']) {
      const own = order.filter((t) => t.startsWith(side))
      assert.deepEqual(own, [1, 2, 3, 4, 5].map((i) => side + i), `${side}'s lines stay in the order written`)
    }
    // A line written after meeting comes after everything both had seen.
    const next = a.add('after we met')
    b.receive(next)
    assert.deepEqual(texts(a), texts(b))
    assert.equal(texts(b).at(-1), 'after we met')
  })

  test('the order does not depend on the order lines arrive in', () => {
    const [a, b, c] = members(3)
    const lines = []
    for (let round = 0; round < 4; round++) {
      lines.push(a.add(`a-${round}`), b.add(`b-${round}`))
      if (round === 1) { exchange(a, b) } // they meet once in the middle
    }
    // c gets every line from a and b, in many different orders, into fresh copies.
    const want = (() => { const x = new Copy({ room: ROOM, members: [...a.members] }); for (const l of lines) x.receive(l); return texts(x) })()
    for (let seed = 1; seed <= 25; seed++) {
      const fresh = new Copy({ room: ROOM, members: [...a.members] })
      for (const l of shuffled(lines, seed)) fresh.receive(structuredClone(l))
      assert.equal(fresh.waiting.size, 0)
      assert.deepEqual(texts(fresh), want, `delivery order ${seed}`)
    }
    exchange(a, b); exchange(b, c); exchange(a, c)
    assert.deepEqual(texts(a), want); assert.deepEqual(texts(b), want); assert.deepEqual(texts(c), want)
  })

  test('a line that names one not here yet waits for it, and says what it wants', () => {
    const [a, b] = members(2)
    const l1 = a.add('first'), l2 = a.add('second')
    assert.deepEqual(l2.after, [lineId(l1)])
    const r = b.receive(l2)
    assert.ok(r.ok && r.waiting)
    assert.deepEqual(texts(b), [])
    assert.deepEqual(b.wanted(), [lineId(l1)])
    b.receive(l1)
    assert.deepEqual(texts(b), ['first', 'second'])
    assert.deepEqual(b.wanted(), [])
    assert.ok(b.receive(l1).already, 'a line seen twice is taken once')
    assert.equal(texts(b).length, 2)
  })

  test('nothing without a valid signature from a member', () => {
    const [a, b] = members(2)
    const line = a.add('signed by Ada')
    assert.equal(lineProblem(line), null)
    assert.match(b.receive({ ...line, text: 'changed on the way' }).reason, /does not verify/)
    const stranger = newIdentity()
    const theirs = new Copy({ room: ROOM, members: [stranger.did], me: stranger, now: SAME_MOMENT }).add('not a member')
    assert.match(b.receive(theirs).reason, /not a member/)
    const otherRoom = new Copy({ room: 'did:example:elsewhere', members: [...a.members], me: a.me }).add('wrong room')
    assert.match(b.receive(otherRoom).reason, /another room/)
    // Signed by Ada's key but claiming Ben as issuer.
    const { proof, ...unsigned } = line
    const spoof = sign({ ...unsigned, issuer: b.me.did }, { seed: a.me.seed, verificationMethod: a.me.verificationMethod, created: line.created })
    assert.match(b.receive(spoof).reason, /not the issuer/)
    assert.deepEqual(texts(b), [])
  })
})
