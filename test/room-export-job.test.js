// The room asked for the export step to run in GitHub's runner (which reaches inwove.org), not in
// anyone's sandbox. This checks the job is there, runs the step's exact two scripts, prints and
// checks ok, count, head and unchecked signatures, and stays read-only (no secrets, no writes).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const yml = readFileSync(new URL('../.github/workflows/interop-tests.yml', import.meta.url), 'utf8')
const job = yml.slice(yml.indexOf('\n  room-export:'))

test('interop-tests has a room-export job running the step exactly', () => {
  assert.ok(yml.includes('\n  room-export:'), 'job exists')
  assert.match(job, /node agent\/export-log\.js https:\/\/inwove\.org >/)
  assert.match(job, /node agent\/import-log\.js "\$RUNNER_TEMP\/room-export\.json" "\$RUNNER_TEMP\/empty-copy"/)
  for (const s of ['ok: ', 'entries: export ', 'head export: seq ', 'head import: seq ', 'unchecked signatures: ']) assert.ok(job.includes(s), `prints ${s}`)
  assert.match(job, /signaturesNotChecked === 0/)
})

test('the workflow stays read-only', () => {
  assert.match(yml, /permissions:\n  contents: read/)
  const code = yml.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')
  for (const bad of ['secrets.', 'pull_request_target', 'workflow_run', 'id-token', 'environment:', 'git push']) assert.ok(!code.includes(bad), `no ${bad}`)
})
