// What closeReplaced does today when a page-only change with no votes, authored by one person, names in its
// replaces list an open pull request that a different person opened. closeReplaced checks no author: it closes
// any open pull request the merged proposal names. This test pins that down. If the room adds an author check
// (another person's pull request stays open), this test fails and should be replaced by one that expects that.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Executor } from '../src/server/actions.js'
import { laneOf } from '../src/shared/rules.js'

const SHA = 'c'.repeat(40)
const config = { workspaceRepo: 'x/y', githubToken: 't' }
const rules = JSON.parse(readFileSync(new URL('../rules.json', import.meta.url), 'utf8'))

function fakeGitHub (pulls) {
  const calls = []
  const gh = async (method, path, body) => {
    calls.push({ method, path, body })
    let m
    if (method === 'GET' && (m = path.match(/^\/repos\/x\/y\/pulls\/(\d+)$/))) return pulls[m[1]]
    if (method === 'PUT' && /\/pulls\/\d+\/merge$/.test(path)) return { sha: 'm'.repeat(40) }
    if (method === 'POST' && /\/statuses\//.test(path)) return {}
    if (method === 'POST' && /\/issues\/\d+\/comments$/.test(path)) return { id: 1 }
    if (method === 'PATCH' && (m = path.match(/\/pulls\/(\d+)$/))) { pulls[m[1]].state = body.state; return pulls[m[1]] }
    throw new Error(`unexpected ${method} ${path}`)
  }
  return { gh, calls }
}

const pull = (n, login) => ({ number: n, state: 'open', merged: false, merged_at: null, user: { login }, head: { sha: SHA, ref: `branch-${n}` }, base: { ref: 'main' }, title: `pull ${n}` })

test("a page-only change with no votes closes another person's open pull request it names as replaced", async () => {
  const files = ['public/index.html']
  assert.equal(laneOf(rules, files), 'small', 'the change touches the page only')
  const pulls = { 91: pull(91, 'person-a'), 55: pull(55, 'person-b') }
  const { gh, calls } = fakeGitHub(pulls)
  const state = { holding: () => ({ dids: [] }), tally: () => ({}), votes: () => [], nameOf: () => 'person a', mode: { mode: 'consensus' } }
  const ex = new Executor({ config, log: { state }, board: {}, gh })
  const proposal = { hash: 'h', principal: 'did:key:zPersonA', change: { pr: 91, sha: SHA, replaces: [55] }, head: SHA, lane: 'small' }
  assert.equal(state.holding(proposal).dids.length, 0, 'nobody approved it')
  assert.notEqual(pulls[55].user.login, pulls[91].user.login, 'the named pull request is another person\'s')

  const result = await ex.mergeChange(proposal)

  assert.equal(result.status, 'merged')
  assert.deepEqual(result.replaced.closed, [55], "the other person's pull request was closed: no author check")
  assert.equal(pulls[55].state, 'closed')
  assert.ok(calls.some((c) => c.method === 'POST' && c.path === '/repos/x/y/issues/55/comments' && c.body.body === 'Replaced by #91'))
  // still reopenable: only its state changed, nothing was deleted and its branch was not touched
  assert.ok(calls.filter((c) => c.method === 'PATCH').every((c) => JSON.stringify(c.body) === '{"state":"closed"}'))
  assert.ok(!calls.some((c) => c.method === 'DELETE' || /git\/refs/.test(c.path)))
  assert.equal(pulls[55].head.ref, 'branch-55')
  await gh('PATCH', '/repos/x/y/pulls/55', { state: 'open' })
  assert.equal(pulls[55].state, 'open', 'reopening it is a plain state change')
})
