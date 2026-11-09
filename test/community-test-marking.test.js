import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'

const doc = readFileSync(new URL('../docs/community-test-marking.md', import.meta.url), 'utf8')

test('the note says what marks the community as a test', () => {
  assert.match(doc, /vtc_name = ".*TEST, test keys\)"/)
  assert.match(doc, /vtc_description = "A test community\./)
})

test('the note pins the OpenVTC commit it was checked against', () => {
  assert.match(doc, /c6964c4612131089e1add0f47575894e1bd8a565/)
})

test('nothing deployable was added: there is no community/ folder', () => {
  assert.equal(existsSync(new URL('../community', import.meta.url)), false)
})
