// A change to how the room decides (the plain-words rules, rules.json, the weaver's decision code) is reviewed before it
// merges, not after: it waits for one approver other than its own side, at its head commit (room spin, block 10591 C).
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { TYPES, signedDocument } from '../src/shared/types.js'
import { config as baseConfig } from '../src/server/config.js'
import { createApp } from '../src/server/index.js'
import { REVIEW_FIRST } from '../src/server/actions.js'

const A = 'a'.repeat(40), M = 'd'.repeat(40)

describe('a change to how the room decides is reviewed before it merges', () => {
  let ctx, base, dir, files = ['public/rules.js'], merged = 0
  const owner = newIdentity(), reviewer = newIdentity()
  const send = async (id, name, payload) => { const r = await fetch(`${base}/api/entries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signedDocument(id, { type: TYPES[name], payload })) }); return { status: r.status, body: await r.json() } }
  const gh = async (method, path) => {
    if (method === 'GET' && /\/pulls\/\d+$/.test(path)) return { state: 'open', title: 'A change', base: { ref: 'main' }, head: { sha: A } }
    if (method === 'GET' && /\/pulls\/\d+\/files/.test(path)) return files.map((filename) => ({ filename }))
    if (method === 'GET' && path.includes('/actions/runs?head_sha=')) return { workflow_runs: [{ name: 'tests', status: 'completed', conclusion: 'success', html_url: 'https://github.com/x/actions/runs/1' }] }
    if (path.includes('/statuses/')) return {}
    if (method === 'PUT' && path.endsWith('/merge')) { merged++; return { sha: M } }
    throw new Error('unexpected ' + method + ' ' + path)
  }
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wpi-review-'))
    ctx = await createApp({ ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, githubToken: 'test', vetoWindowMinutes: 0, approvalsRequired: 1, weaverIntervalMinutes: 0, weaverQuietMinutes: 0, ratePerMinute: 1000, publicUrl: 'https://interop.example', boardDataUrl: '', llm: { ...baseConfig.llm, apiKey: '' } }, { gh, awayGatherMs: 0, hostWelcomeMs: null })
    await new Promise((r) => ctx.server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${ctx.server.address().port}`
    await send(owner, 'join', { name: 'Person A' }); await send(reviewer, 'join', { name: 'Person B' })
  })
  after(async () => { await ctx.stop(); rmSync(dir, { recursive: true, force: true }) })

  test('which files count', () => {
    for (const f of ['public/rules.js', 'rules.json', 'src/server/weaver.js', 'src/server/facilitator.js']) assert.ok(REVIEW_FIRST.some((re) => re.test(f)), f)
    for (const f of ['public/app.js', 'src/server/builder.js', 'README.md']) assert.ok(!REVIEW_FIRST.some((re) => re.test(f)), f)
  })

  test('the proposer’s own approval does not merge it; another’s does, at the head commit', async () => {
    const prop = (await send(owner, 'propose', { kind: 'workspace-change', title: 'Reword the rule', change: { pr: 21, sha: A } })).body.hash
    await send(owner, 'approve', { proposal: prop, sha: A })
    await ctx.executor.tick()
    assert.equal(merged, 0)
    assert.match(ctx.log.state.proposals.get(prop).notYet, /changes how the room decides \(public\/rules\.js\).*other than its own side/)
    await send(reviewer, 'approve', { proposal: prop, sha: A })
    await ctx.executor.tick()
    assert.equal(merged, 1)
  })

  test('an ordinary change is not held for a review', async () => {
    files = ['public/app.js']
    const prop = (await send(owner, 'propose', { kind: 'workspace-change', title: 'A page tweak', change: { pr: 22, sha: A } })).body.hash
    await send(owner, 'approve', { proposal: prop, sha: A })
    await ctx.executor.tick()
    assert.doesNotMatch(String(ctx.log.state.proposals.get(prop).notYet ?? ''), /how the room decides/)
  })
})
