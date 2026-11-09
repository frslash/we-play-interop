// Step 8781dc4b: #54 and #57 landed in main together (with #59) through #60. This checks that, on main, #54's saved
// decision and #57's holds still work side by side: a choice about a person's keys, money, time or name is still
// recognised as theirs, and a plain choice is not. Whether #59's settling rule is the right one is open (#61, #62).
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { decisionOf, touches } from '../src/server/facilitator.js'

describe('#54 and #57 on main', () => {
  test('each kind of personal choice is still held for its person', () => {
    assert.equal(touches('Who pays for the mediator host'), 'money')
    assert.equal(touches('What deadline the demo has'), 'time')
    assert.equal(touches('Which account posts the release'), 'name')
    assert.equal(touches('Which key signs the DID document'), 'keys')
  })

  test('a plain choice is not held, and its clear answer is still saved as a decision', () => {
    const q = 'Which carrier the room tests first, TSP or DIDComm'
    assert.equal(touches(q), null)
    const d = decisionOf('DIDComm first, because the mediator speaks it.', q)
    assert.ok(d && d.parked === false)
  })
})
