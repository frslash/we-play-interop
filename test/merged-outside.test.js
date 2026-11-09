import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { Executor } from '../src/server/actions.js'

const config = { workspaceRepo: 'x/y', githubToken: 't' }
const pr = { change: { pr: 46, sha: 'a'.repeat(40) } }
const exec = (pull) => new Executor({ config, log: { state: {} }, board: {}, gh: async () => pull })

describe('a pull request merged outside the loop', () => {
  test('is reported as merged, not as a failure', async () => {
    const why = await exec({ state: 'closed', merged: true, merged_at: '2026-11-09T09:46:48Z', merge_commit_sha: 'c'.repeat(40) }).changeReady(pr)
    assert.match(why, /^merged: pull request #46 was already merged \(as c{40}\)$/)
  })
  test('closed without a merge still fails', async () => {
    const why = await exec({ state: 'closed', merged: false, merged_at: null }).changeReady(pr)
    assert.equal(why, 'failed: pull request #46 is closed')
  })
})
