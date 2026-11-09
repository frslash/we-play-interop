// Step 568403690d6c asks for #61 to be closed with a comment linking #68. Closing a pull request
// is the repository holder's to do on GitHub; no code in this repository does it, and a builder
// must not. This file only checks that the change carries no code: nothing here closes anything.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

test('the room keeps no action that closes a pull request', () => {
  const actions = readFileSync(new URL('../src/server/actions.js', import.meta.url), 'utf8')
  assert.doesNotMatch(actions, /state:\s*['"]closed['"]/)
})
