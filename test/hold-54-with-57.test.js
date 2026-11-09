// Step 8781dc4b: #54 is held and lands together with #57, after #57's open points are fixed. This branch is #59's head
// (which contains #54 and #57) merged with main. These checks restate the step's own done-test on the merged code:
// #54's decisions still hold, #57's whole-answer rule still holds, and "Nice work" never reopens a decided choice.
// The rule that the step's own agent can't settle it runs end to end in test/decider-other-person.test.js.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { DISAGREES, PARKED, decided, decisionOf, stateKey, touches } from '../src/server/facilitator.js'

const CARRIER = 'Which carrier the room tests first, TSP or DIDComm'

describe('#54 and #57 together', () => {
  test('#54: a clear answer is a decision that holds while the step stays as it was', () => {
    const d = decisionOf('TSP first, because RLTP already carries it.', CARRIER)
    assert.equal(d.parked, false); assert.match(d.why, /RLTP already carries it/)
    const step = { state: 'blocked', owner: 'did:key:builder', result: null }
    const held = { ...step, decision: { ...d, stateKey: stateKey(step) } }
    assert.ok(decided(held))
    assert.equal(decided({ ...held, state: 'in progress' }), null, 'it lapses when the step changes')
  })

  test('#57: only a whole answer decides or parks', () => {
    for (const t of ['I parked my other project', 'We parked the car outside']) assert.equal(decisionOf(t, CARRIER), null, t)
    assert.ok(PARKED.test('Parked: until the domain is bought'))
    assert.equal(touches('Which key signs the DID document'), 'keys')
    assert.equal(touches(CARRIER), null)
  })

  test('"Nice work" neither decides nor reopens a decided choice', () => {
    for (const t of ['Nice work', 'Nice work, thanks', 'Thanks!', 'I don’t disagree']) {
      assert.ok(!DISAGREES.test(t), `${t} is not a disagreement`)
      assert.equal(decisionOf(t, CARRIER), null, `${t} is not a new answer`)
    }
    assert.ok(DISAGREES.test('I disagree: DIDComm first'))
  })
})
