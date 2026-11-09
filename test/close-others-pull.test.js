// A page-only change with no votes, proposed by one person, names in its replaces list an open pull request
// that the room's record shows was proposed for a different person. closeReplaced checks the person (not the
// GitHub login), so the other person's pull request stays open. This replaces the test #96 added, which pinned
// down the earlier behaviour (no check at all) and said to replace it once a check landed.
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

test("a page-only change with no votes leaves another person's open pull request it names as replaced open", async () => {
  const files = ['public/index.html']
  assert.equal(laneOf(rules, files), 'small', 'the change touches the page only')
  const pulls = { 91: pull(91, 'one-account'), 55: pull(55, 'one-account') } // many agents open through one GitHub account
  const { gh, calls } = fakeGitHub(pulls)
  const proposal = { hash: 'h', kind: 'workspace-change', principal: 'did:key:zPersonA', change: { pr: 91, sha: SHA, replaces: [55] }, head: SHA, lane: 'small' }
  const theirs = { hash: 'h55', kind: 'workspace-change', principal: 'did:key:zPersonB', change: { pr: 55, sha: SHA }, head: SHA }
  const state = { participants: new Map(), proposals: new Map([[proposal.hash, proposal], [theirs.hash, theirs]]), holding: () => ({ dids: [] }), tally: () => ({}), votes: () => [], nameOf: () => 'person a', mode: { mode: 'consensus' } }
  const ex = new Executor({ config, log: { state }, board: {}, gh })
  assert.equal(state.holding(proposal).dids.length, 0, 'nobody approved it')
  assert.equal(pulls[55].user.login, pulls[91].user.login, 'the same GitHub account opened both')

  const result = await ex.mergeChange(proposal)

  assert.equal(result.status, 'merged')
  assert.deepEqual(result.replaced.closed, [], "the other person's pull request was not closed")
  assert.deepEqual(result.replaced.skipped.map((s) => s.pr), [55])
  assert.equal(pulls[55].state, 'open')
  assert.ok(!calls.some((c) => c.method === 'PATCH' || /\/issues\/55\/comments$/.test(c.path)), 'no comment and no close on it')
  assert.ok(!calls.some((c) => c.method === 'DELETE' || /git\/refs/.test(c.path)))
  assert.equal(pulls[55].head.ref, 'branch-55')
})
