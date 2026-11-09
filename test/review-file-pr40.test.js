// The review copy of pull request #40 (reviews/pr-40-9e3a186.txt): a reader's guide followed by the full diff of its
// head commit, as one plain-text file the room's file rules accept, so reviewers who can't reach GitHub can read it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { findSecret } from '../src/shared/guard.js'
import { MAX_DOC } from '../src/server/media.js'

const file = readFileSync(new URL('../reviews/pr-40-9e3a186.txt', import.meta.url), 'utf8')
const at = file.indexOf('diff --git ')
const diff = file.slice(at)

test('the file names the head commit and carries a diff whose sha256 it states', () => {
  assert.match(file, /9e3a186c2e9ce8294b53ff32bcb86bd4f18c7a81/)
  assert.ok(at > 0, 'a guide, then the diff')
  const sha = file.match(/sha256 ([0-9a-f]{64})/)[1]
  assert.equal(createHash('sha256').update(diff).digest('hex'), sha)
})

test('the diff covers all nine files of the pull request', () => {
  const files = [...diff.matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1])
  assert.deepEqual(files, ['public/app.js', 'src/agent-tools.js', 'src/server/facilitator.js', 'src/server/state.js', 'src/server/views.js', 'src/server/workshop.js', 'src/shared/steps.js', 'src/shared/types.js', 'test/board-edits.test.js'])
})

test('a reader finds the confirmer, the undo and the same-person exclusion where the guide says', () => {
  const lines = diff.split('\n'), line = (n) => lines[n - 1]
  assert.match(line(170), /confirmedBy: e\.author, confirmation: e\.hash/)
  assert.match(line(181), /undoes: done\.id, fields, by: e\.author/)
  assert.match(line(173), /withdrawnBy: e\.author/)
  assert.match(line(166), /person\(st, pending\.by\) === person\(st, e\.author\)/)
  assert.match(lines.slice(288, 294).join('\n'), /personOf\(x\.by\) === personOf\(who\)/)
  assert.match(line(304), /export const held/)
})

test('the room would take it as a file: plain text, small enough, nothing that looks like a secret', () => {
  assert.ok(Buffer.byteLength(file) < MAX_DOC)
  assert.ok(!file.includes('\0'))
  assert.equal(findSecret(file), null)
})
