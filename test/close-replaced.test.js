import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { Executor } from '../src/server/actions.js'
import { checkPayload, MAX_REPLACES } from '../src/shared/types.js'
import { willClose } from '../src/shared/replaces.js'
import { readFileSync } from 'node:fs'

const SHA = 'a'.repeat(40)
const config = { workspaceRepo: 'x/y', githubToken: 't' }

// a fake GitHub: pull requests by number, and every call it was asked to make
function fakeGitHub (pulls) {
  const calls = []
  const gh = async (method, path, body) => {
    calls.push({ method, path, body })
    let m
    if (method === 'GET' && (m = path.match(/^\/repos\/x\/y\/pulls\/(\d+)$/))) { const p = pulls[m[1]]; if (!p) throw Object.assign(new Error('GitHub GET: 404 Not Found'), { status: 404 }); return p }
    if (method === 'PUT' && /\/pulls\/\d+\/merge$/.test(path)) return { sha: 'm'.repeat(40) }
    if (method === 'POST' && /\/statuses\//.test(path)) return {}
    if (method === 'POST' && (m = path.match(/\/issues\/(\d+)\/comments$/))) return { id: 1 }
    if (method === 'PATCH' && (m = path.match(/\/pulls\/(\d+)$/))) { pulls[m[1]].state = body.state; return pulls[m[1]] }
    throw new Error(`unexpected ${method} ${path}`)
  }
  return { gh, calls }
}

const open = (n, login = 'builder') => ({ number: n, user: { login }, state: 'open', merged: false, merged_at: null, head: { sha: SHA, ref: `branch-${n}` }, base: { ref: 'main' }, title: `pull ${n}` })
const proposal = (replaces) => ({ hash: 'h', principal: 'did:key:z1', change: { pr: 90, sha, ...(replaces ? { replaces } : {}) }, head: SHA })
const sha = SHA
const executor = (gh) => {
  const ex = new Executor({ config, log: { state: { holding: () => ({ dids: [] }), tally: () => ({}), nameOf: () => 'someone', mode: { mode: 'consensus' } } }, board: {}, gh })
  return ex
}

describe('a merged workspace-change closes the pull requests it replaces', () => {
  test('each one named is closed with "Replaced by #n", and no branch is deleted', async () => {
    const pulls = { 90: open(90), 77: open(77), 78: open(78) }
    const { gh, calls } = fakeGitHub(pulls)
    const result = await executor(gh).mergeChange(proposal([77, 78]))
    assert.equal(result.status, 'merged')
    assert.deepEqual(result.replaced.closed, [77, 78])
    assert.equal(pulls[77].state, 'closed'); assert.equal(pulls[78].state, 'closed')
    for (const n of [77, 78]) assert.ok(calls.some((c) => c.method === 'POST' && c.path === `/repos/x/y/issues/${n}/comments` && c.body.body === 'Replaced by #90'))
    assert.ok(!calls.some((c) => c.method === 'DELETE'), 'never deletes anything')
    assert.ok(!calls.some((c) => /git\/refs/.test(c.path)), 'never touches a branch')
    assert.ok(calls.filter((c) => c.method === 'PATCH').every((c) => JSON.stringify(c.body) === '{"state":"closed"}'), 'only sets the state to closed')
    assert.match(result.detail, /closed as replaced: #77, #78/)
    // the merge comes first: nothing closes before the room's merge went through
    const mergeAt = calls.findIndex((c) => c.method === 'PUT'), firstClose = calls.findIndex((c) => c.method === 'PATCH')
    assert.ok(mergeAt >= 0 && mergeAt < firstClose)
  })

  test('a proposal that names nothing closes nothing', async () => {
    const { gh, calls } = fakeGitHub({ 90: open(90) })
    const result = await executor(gh).mergeChange(proposal())
    assert.equal(result.status, 'merged'); assert.equal(result.replaced, undefined)
    assert.ok(!calls.some((c) => c.method === 'PATCH' || /comments$/.test(c.path)))
  })

  test('when the merge fails, nothing is closed', async () => {
    const pulls = { 90: { ...open(90), head: { sha: 'b'.repeat(40) } }, 77: open(77) }
    const { gh, calls } = fakeGitHub(pulls)
    await assert.rejects(executor(gh).mergeChange(proposal([77])), /changed after it was approved/)
    assert.equal(pulls[77].state, 'open')
    assert.ok(!calls.some((c) => c.method === 'PATCH'))
  })

  test('already closed, merged or missing pull requests are left alone and reported', async () => {
    const pulls = { 90: open(90), 70: { ...open(70), state: 'closed' }, 71: { ...open(71), state: 'closed', merged: true, merged_at: '2026-11-09T00:00:00Z' }, 72: open(72) }
    const { gh, calls } = fakeGitHub(pulls)
    const result = await executor(gh).mergeChange(proposal([70, 71, 72, 404]))
    assert.equal(result.status, 'merged', 'a close that cannot happen never undoes the merge')
    assert.deepEqual(result.replaced.closed, [72])
    assert.deepEqual(result.replaced.skipped.map((s) => s.pr), [70, 71, 404])
    assert.equal(calls.filter((c) => /comments$/.test(c.path)).length, 1, 'comments only on the one it closed')
  })

  test('the pull request being merged is never closed as replacing itself', async () => {
    const { gh, calls } = fakeGitHub({ 90: open(90) })
    const out = await executor(gh).closeReplaced({ change: { pr: 90, sha, replaces: [90] } })
    assert.deepEqual(out, { closed: [], skipped: [] })
    assert.ok(!calls.length)
  })
})

describe('a change merged without votes closes only its own side’s pull requests', () => {
  const small = (replaces) => ({ ...proposal(replaces), lane: 'small' })

  test('a no-vote change that names another person’s open pull request leaves it open', async () => {
    const pulls = { 90: open(90, 'builder'), 77: open(77, 'someone-else') }
    const { gh, calls } = fakeGitHub(pulls)
    const result = await executor(gh).mergeChange(small([77]))
    assert.equal(result.status, 'merged')
    assert.equal(pulls[77].state, 'open')
    assert.deepEqual(result.replaced.closed, [])
    assert.deepEqual(result.replaced.skipped.map((s) => s.pr), [77])
    assert.match(result.replaced.skipped[0].why, /without votes/)
    assert.ok(!calls.some((c) => c.method === 'PATCH' || /comments$/.test(c.path)), 'no comment and no close on another person’s pull request')
    assert.match(result.detail, /left #77 open/)
  })

  test('a no-vote change still closes a pull request by the same author', async () => {
    const pulls = { 90: open(90, 'builder'), 77: open(77, 'builder'), 78: open(78, 'someone-else') }
    const { gh } = fakeGitHub(pulls)
    const result = await executor(gh).mergeChange(small([77, 78]))
    assert.deepEqual(result.replaced.closed, [77])
    assert.equal(pulls[77].state, 'closed'); assert.equal(pulls[78].state, 'open')
  })

  test('a no-vote change whose own author is unknown closes nothing', async () => {
    const pulls = { 77: open(77, 'builder') }
    const { gh } = fakeGitHub(pulls)
    const out = await executor(gh).closeReplaced(small([77]))
    assert.deepEqual(out.closed, []); assert.equal(pulls[77].state, 'open')
  })

  test('a change the room voted on may still close another author’s pull request it names', async () => {
    const pulls = { 90: open(90, 'builder'), 77: open(77, 'someone-else') }
    const { gh } = fakeGitHub(pulls)
    const result = await executor(gh).mergeChange(proposal([77]))
    assert.deepEqual(result.replaced.closed, [77])
  })
})

describe('Decide shows what a change will close', () => {
  test('a change that lists replaces shows "will close #n"', () => {
    assert.equal(willClose({ kind: 'workspace-change', change: { pr: 90, sha, replaces: [77] } }), ' · will close #77')
    assert.equal(willClose({ kind: 'workspace-change', change: { pr: 90, sha, replaces: [77, 78] } }), ' · will close #77, #78')
    assert.match(willClose({ kind: 'workspace-change', lane: 'small', change: { pr: 90, sha, replaces: [77] } }), /^ · will close #77 \(only those its own side opened/)
  })
  test('a change that lists none shows nothing', () => {
    assert.equal(willClose({ kind: 'workspace-change', change: { pr: 90, sha } }), '')
    assert.equal(willClose({ kind: 'workspace-change', change: { pr: 90, sha, replaces: [] } }), '')
    assert.equal(willClose({ kind: 'other' }), '')
  })
  test('the Decide card puts it after the pull request link', () => {
    const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
    assert.match(app, /import \{ willClose \} from '\/shared\/replaces\.js'/)
    assert.match(app, /`pull request #\$\{p\.change\.pr\}`\), ` at \$\{p\.change\.sha\.slice\(0, 10\)\}`, willClose\(p\)\)/)
  })
})

describe('what a workspace-change may name as replaced', () => {
  const p = (change) => checkPayload('propose', { payload: { kind: 'workspace-change', title: 't', change } })
  test('a list of other pull request numbers is fine', () => {
    assert.equal(p({ pr: 90, sha, replaces: [77, 78] }), null)
    assert.equal(p({ pr: 90, sha }), null)
  })
  test('itself, repeats, non-numbers and too many are refused', () => {
    for (const replaces of [[90], [77, 77], ['77'], [0], 77, Array.from({ length: MAX_REPLACES + 1 }, (_, i) => i + 1)]) assert.match(p({ pr: 90, sha, replaces }), /change\.replaces/)
  })
})
