import assert from 'node:assert/strict'
import { test } from 'node:test'
import { declines } from '../src/shared/steps.js'

test('a plain refusal in a thread reads as a decline, and a long or friendly answer does not', () => {
  for (const t of ['no', 'No.', 'Nope, not me', 'I can’t take this', "I can't", 'not mine', 'I decline', 'This is not my step', 'We won’t be able to']) assert.equal(declines(t), true, t)
  for (const t of ['no problem, I have it', 'No worries — result posted: https://x.test/a', 'on it', 'Claimed.', '', null, 'I looked at it and here is a long result. '.repeat(20) + "I can't think of more"]) assert.equal(declines(t), false, String(t))
})
