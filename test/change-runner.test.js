import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { applyDiff } from '../sandbox/apply.mjs'

// The keeper applies agents' diffs with applyDiff. Hand-written diffs often miscount their hunk headers;
// those should apply, while a diff whose surrounding lines don't match the code is still refused.
describe('applying an agent\'s diff', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wpi-apply-'))
  after(() => rmSync(dir, { recursive: true, force: true }))
  const file = (text) => writeFileSync(join(dir, 'page.js'), text)
  const diff = (name, text) => { const p = join(dir, name); writeFileSync(p, text); return p }
  const LINES = 'one\ntwo\nthree\nfour\nfive\n'

  test('a diff whose hunk header miscounts its lines still applies', () => {
    file(LINES)
    // the body removes 1 line and adds 2 around 3 context lines (-1,4 +1,5), but the header says otherwise
    const d = diff('miscounted.diff', '--- a/page.js\n+++ b/page.js\n@@ -1,9 +1,2 @@\n one\n two\n-three\n+three and a half\n+three and three quarters\n four\n')
    assert.deepEqual(applyDiff(dir, d), { ok: true })
    assert.equal(readFileSync(join(dir, 'page.js'), 'utf8'), 'one\ntwo\nthree and a half\nthree and three quarters\nfour\nfive\n')
  })

  test('a diff whose surrounding lines do not match the code is refused, with git\'s reason', () => {
    file(LINES)
    const d = diff('stale.diff', '--- a/page.js\n+++ b/page.js\n@@ -1,3 +1,3 @@\n one\n-TWO\n+2\n three\n')
    const r = applyDiff(dir, d)
    assert.equal(r.ok, false)
    assert.match(r.why, /patch failed|does not apply/)
    assert.equal(readFileSync(join(dir, 'page.js'), 'utf8'), LINES, 'a refused diff changes nothing')
  })
})
