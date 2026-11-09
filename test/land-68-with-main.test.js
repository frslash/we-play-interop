// Step f11b66be: #54, #57 and #59 are already merged; #68 is the one left, and its head contains #62, #64, #65 and
// #66 (not #61). This branch is #68's head merged with main, so these checks restate what #68 adds on the merged
// code: bow-out lines decide nothing, "I decline" and "I won't sign" are a person's no, and #54/#57 still hold.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { BOWS_OUT, DISAGREES, REFUSAL, decisionOf, touches } from '../src/server/facilitator.js'

const KEYS = 'Which key signs the DID document'

describe('#68 on main', () => {
  test('bow-out lines are not answers', () => {
    for (const t of ['Not me: I have no rights over that key', 'Not my call', 'I have no say here']) {
      assert.ok(BOWS_OUT.test(t), t)
      assert.equal(decisionOf(t, KEYS), null, t)
    }
  })

  test('"I decline" and "I won\'t sign" are a refusal, not a bow-out', () => {
    for (const t of ['I decline', 'I won’t sign it', 'I will not sign']) {
      assert.ok(REFUSAL.test(t), t)
      assert.ok(!BOWS_OUT.test(t), t)
    }
  })

  test('#54 and #57 still hold', () => {
    assert.equal(touches(KEYS), 'keys')
    assert.equal(decisionOf('Nice work', KEYS), null)
    assert.ok(DISAGREES.test('I disagree: DIDComm first'))
  })
})
