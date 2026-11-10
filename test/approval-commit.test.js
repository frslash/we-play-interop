import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { TYPES, signedDocument } from '../src/shared/types.js'
import { config as baseConfig } from '../src/server/config.js'
import { createApp } from '../src/server/index.js'

const A = 'a'.repeat(40), B = 'b'.repeat(40), M = 'd'.repeat(40)

describe('an approval names the commit it read, and a later push voids it', () => {
  let ctx, base, dir, head = A, calls = []
  const human = newIdentity(), other = newIdentity()
  const send = async (id, name, payload) => { const r = await fetch(`${base}/api/entries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signedDocument(id, { type: TYPES[name], payload })) }); return { status: r.status, body: await r.json() } }
  const view = async (hash) => (await (await fetch(`${base}/api/state`)).json()).proposals.find((p) => p.hash === hash)
  // a pretend GitHub whose pull request can be pushed to
  const gh = async (method, path, body) => {
    calls.push({ method, path, body })
    if (method === 'GET' && /\/pulls\/\d+$/.test(path)) return { state: 'open', title: 'A change', base: { ref: 'main' }, head: { sha: head } }
    if (method === 'GET' && /\/pulls\/\d+\/files/.test(path)) return [{ filename: 'src/server/weaver.js' }]
    if (method === 'GET' && path.includes('/actions/runs?head_sha=')) return { workflow_runs: [{ name: 'tests', status: 'completed', conclusion: 'success', html_url: 'https://github.com/x/actions/runs/1' }] }
    if (path.includes('/statuses/')) return {}
    if (method === 'PUT' && path.endsWith('/merge')) return { sha: M }
    throw new Error('unexpected ' + method + ' ' + path)
  }

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wpi-sha-'))
    ctx = await createApp({ ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, githubToken: 'test', vetoWindowMinutes: 0, approvalsRequired: 1, weaverIntervalMinutes: 0, weaverQuietMinutes: 0, ratePerMinute: 1000, publicUrl: 'https://interop.example', boardDataUrl: '', llm: { ...baseConfig.llm, apiKey: '' } }, { openRoom: true, gh, awayGatherMs: 0, hostWelcomeMs: null })
    await new Promise((r) => ctx.server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${ctx.server.address().port}`
    await send(human, 'join', { name: 'Person A' }); await send(other, 'join', { name: 'Person B' })
  })
  after(async () => { await ctx.stop(); rmSync(dir, { recursive: true, force: true }) })

  test('the sha must be a full commit', async () => {
    const prop = (await send(human, 'propose', { kind: 'workspace-change', title: 'Bad sha', change: { pr: 3, sha: A } })).body.hash
    assert.equal((await send(other, 'approve', { proposal: prop, sha: 'abc' })).status, 400)
    await send(human, 'veto', { target: prop, reason: 'only a test' })
  })

  test('the approval shows its commit; a push voids it; approving the new commit revives it and that commit merges', async () => {
    head = A; calls = []
    const prop = (await send(human, 'propose', { kind: 'workspace-change', title: 'Pinned approvals', change: { pr: 5, sha: A } })).body.hash
    assert.equal((await send(other, 'approve', { proposal: prop, sha: A })).status, 201)
    let p = await view(prop)
    assert.equal(p.head, A)
    assert.deepEqual(p.approvals.map((a) => [a.sha, a.void]), [[A, false]])
    assert.equal(p.status, 'approved')

    head = B // someone pushes to the pull request
    await ctx.executor.tick()
    p = await view(prop)
    assert.equal(p.head, B)
    assert.deepEqual(p.approvals.map((a) => [a.sha, a.void]), [[A, true]], 'the approval still shows the commit it read, and shows as void')
    assert.equal(p.status, 'open')
    assert.match(ctx.log.state.proposals.get(prop).notYet, /new commit .*void until someone reads it/)
    assert.ok(!calls.some((c) => c.path.endsWith('/merge')), 'nothing merges on a void approval')
    assert.match(ctx.executor.waitingFor(ctx.log.state.proposals.get(prop)), /or a person/)

    assert.equal((await send(other, 'approve', { proposal: prop, sha: B })).status, 201) // read again
    p = await view(prop)
    assert.deepEqual(p.approvals.map((a) => [a.sha, a.void]), [[B, false]])
    await ctx.executor.tick()
    assert.equal((await view(prop)).status, 'done')
    const merge = calls.find((c) => c.path.endsWith('/pulls/5/merge'))
    assert.equal(merge.body.sha, B, 'it merges exactly the commit the approval read')
    assert.match(merge.body.commit_message, new RegExp(`for commit ${B}`))
  })

  test('an approval without a sha covers the commit the proposal names; a yes vote stops counting after a push', async () => {
    head = A
    const prop = (await send(human, 'propose', { kind: 'workspace-change', title: 'Old clients', change: { pr: 6, sha: A } })).body.hash
    await send(other, 'approve', { proposal: prop })
    assert.deepEqual((await view(prop)).approvals.map((a) => [a.sha, a.void]), [[A, false]])
    const voted = (await send(human, 'propose', { kind: 'workspace-change', title: 'By a vote', change: { pr: 9, sha: A } })).body.hash
    await send(other, 'vote', { proposal: voted, choice: 'for' })
    const pr = ctx.log.state.proposals.get(voted)
    assert.equal(ctx.executor.waitingFor(pr), null, 'a person\'s yes counts while the commit is the proposed one')
    ctx.log.state.setHead(pr, B)
    assert.match(ctx.executor.waitingFor(pr), /more person's agent\(s\) \(or a person\)/, 'a vote names no commit, so a push voids it too')
    await send(human, 'veto', { target: prop, reason: 'only a test' }); await send(human, 'veto', { target: voted, reason: 'only a test' })
  })

  test('the workshop reads the heads of open pull requests and moves them', async () => {
    const prop = (await send(human, 'propose', { kind: 'workspace-change', title: 'Read from GitHub', change: { pr: 11, sha: A } })).body.hash
    await send(other, 'approve', { proposal: prop, sha: A })
    ctx.workshop.heads([{ number: 11, state: 'open', head: { sha: B } }, { number: 12, state: 'open', head: { sha: 'zzz' } }])
    const p = await view(prop)
    assert.equal(p.head, B); assert.equal(p.approvals[0].void, true)
  })
})
