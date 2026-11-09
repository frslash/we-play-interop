// The referee (src/referee): GitHub's own runner merges the room's code from the room's signed record, so no host and
// no admin decide. It checks the record itself, applies the agreed rules, marks what passes and merges it; what
// doesn't pass shows why on its commit. And the room stops merging by itself once main requires the referee's mark.
import assert from 'node:assert/strict'
import { createVerify, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { TYPES, signedDocument } from '../src/shared/types.js'
import { config as baseConfig } from '../src/server/config.js'
import { createApp } from '../src/server/index.js'
import { APPROVAL_CONTEXT } from '../src/server/actions.js'
import { appJwt, installationToken } from '../src/referee/app-token.js'
import { round, summary } from '../src/referee/referee.js'

const A = 'a'.repeat(40), B = 'b'.repeat(40), M = 'd'.repeat(40), MIN = 60_000
const BOARD = { generated: new Date().toISOString().slice(0, 10), projects: [], scenarios: [], runs: [] }

/** A pretend GitHub, as the referee's app: pull requests with their files, tests, marks and merges. */
function github (pulls) {
  const calls = []
  const gh = async (method, path, body) => {
    calls.push({ method, path, body })
    let m
    if (method === 'GET' && (m = /\/pulls\/(\d+)$/.exec(path))) return { state: 'open', title: pulls[m[1]].title, base: { ref: 'main' }, head: { sha: pulls[m[1]].sha }, changed_files: pulls[m[1]].count ?? pulls[m[1]].files.length }
    if (method === 'GET' && (m = /\/pulls\/(\d+)\/files\?per_page=100&page=(\d+)/.exec(path))) return pulls[m[1]].files.slice((m[2] - 1) * 100, m[2] * 100).map((f) => (typeof f === 'string' ? { filename: f } : f))
    if (method === 'GET' && path.includes('/actions/runs?head_sha=')) return { workflow_runs: [{ name: 'test', status: 'completed', conclusion: 'success', html_url: 'https://github.com/x/actions/runs/1' }] }
    if (method === 'GET' && /\/commits\/\w+\/status$/.test(path)) return { statuses: calls.filter((c) => c.method === 'POST' && c.path.endsWith(path.split('/commits/')[1].replace('/status', ''))).map((c) => c.body).reverse() }
    if (method === 'POST' && path.includes('/statuses/')) return {}
    if (method === 'PUT' && path.endsWith('/merge')) return { sha: M }
    throw new Error('unexpected ' + method + ' ' + path)
  }
  return { gh, calls }
}

describe('the referee merges from the signed record, with no host and no admin', () => {
  let ctx, base, dir
  const people = { a: newIdentity(), b: newIdentity(), c: newIdentity(), d: newIdentity() }, agents = { b: newIdentity(), c: newIdentity(), d: newIdentity() }, dels = {}
  const send = async (id, name, payload, extra) => { const r = await fetch(`${base}/api/entries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signedDocument(id, { type: TYPES[name], payload, ...extra })) }); return { status: r.status, body: await r.json() } }
  const as = (k, name, payload) => send(agents[k], name, payload, { onBehalfOf: people[k].did, delegation: dels[k] })
  const record = () => structuredClone(ctx.log.entries)
  const propose = async (pr, title, sha = A) => (await send(people.a, 'propose', { kind: 'workspace-change', title, change: { pr, sha } })).body.hash

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wpi-referee-'))
    // the room itself never acts here (no token): the referee does
    ctx = await createApp({ ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, githubToken: '', weaverIntervalMinutes: 0, weaverQuietMinutes: 0, ratePerMinute: 1000, publicUrl: 'https://room.example', boardDataUrl: 'data:application/json,' + encodeURIComponent(JSON.stringify(BOARD)), llm: { ...baseConfig.llm, provider: 'openai', apiKey: '' } })
    await new Promise((r) => ctx.server.listen(0, r))
    base = `http://localhost:${ctx.server.address().port}`
    const exp = new Date(Date.now() + 86400000).toISOString()
    for (const k of ['a', 'b', 'c', 'd']) await send(people[k], 'join', { name: `Person ${k.toUpperCase()}` })
    for (const k of ['b', 'c', 'd']) dels[k] = (await send(people[k], 'delegate', { delegate: agents[k].did, scope: ['note', 'propose', 'vote'], label: `${k} agent` }, { expiresAt: exp })).body.hash
  })
  after(async () => { await ctx.stop(); rmSync(dir, { recursive: true, force: true }) })

  test('agents of three other people approve, the window passes, the tests pass: it marks the commit and merges exactly it', async () => {
    const prop = await propose(7, 'Steps tab: show each step’s pull request')
    for (const k of ['b', 'c', 'd']) assert.equal((await as(k, 'approve', { proposal: prop, sha: A })).status, 201)
    const { gh, calls } = github({ 7: { title: 'Steps tab', sha: A, files: ['src/server/weaver.js'] } })
    const early = await round({ entries: record(), gh, repo: 'example/room', publicUrl: 'https://room.example' })
    assert.equal(early.decisions.find((d) => d.pr === 7).outcome, 'waiting', 'not inside the veto window')
    assert.ok(!calls.some((c) => c.method === 'PUT'))
    const out = await round({ entries: record(), gh, repo: 'example/room', publicUrl: 'https://room.example', now: Date.now() + 11 * MIN })
    const d = out.decisions.find((x) => x.pr === 7)
    assert.equal(d.outcome, 'merged'); assert.equal(d.approvals, 3)
    const marks = calls.filter((c) => c.method === 'POST' && c.path.includes(`/statuses/${A}`)).map((c) => c.body)
    assert.equal(marks.at(-1).state, 'success'); assert.equal(marks.at(-1).context, APPROVAL_CONTEXT)
    assert.match(marks.at(-1).description, /^Approved in the room: 3 approvals of aaaaaaa, no veto$/)
    assert.equal(marks.at(-1).target_url, `https://room.example/api/log/${prop}`)
    const iMark = calls.findIndex((c) => c.method === 'POST' && c.body?.state === 'success'), iMerge = calls.findIndex((c) => c.method === 'PUT')
    assert.ok(iMark >= 0 && iMark < iMerge, 'marked before it merges: main refuses it without the mark')
    assert.equal(calls[iMerge].body.sha, A, 'exactly the commit they approved')
    assert.match(summary(out, 'https://room.example'), /#7 Steps tab: show each step’s pull request: \*\*merged\*\* \(as ddddddd, 3 approvals\)/)
    await send(people.a, 'veto', { target: prop, reason: 'done with this test' })
  })

  test('too few approvals, or a protected file without a person: it waits, and says why on the commit, once', async () => {
    const two = await propose(8, 'Two approvals only')
    for (const k of ['b', 'c']) await as(k, 'approve', { proposal: two, sha: A })
    const guarded = await propose(9, 'Changes the rules', B)
    for (const k of ['b', 'c', 'd']) await as(k, 'approve', { proposal: guarded, sha: B })
    const { gh, calls } = github({ 8: { title: 'Two', sha: A, files: ['src/server/weaver.js'] }, 9: { title: 'Rules', sha: B, files: ['rules.json'] } })
    const later = Date.now() + 11 * MIN
    const out = await round({ entries: record(), gh, repo: 'example/room', publicUrl: 'https://room.example', now: later })
    assert.equal(out.decisions.find((d) => d.pr === 8).outcome, 'waiting')
    assert.match(out.decisions.find((d) => d.pr === 8).why, /agent/)
    assert.match(out.decisions.find((d) => d.pr === 9).why, /a person approves it too/)
    assert.ok(!calls.some((c) => c.method === 'PUT'), 'nothing merges')
    const pending = calls.filter((c) => c.method === 'POST' && c.body?.state === 'pending')
    assert.ok(pending.every((c) => /^Waiting: /.test(c.body.description) && c.body.description.length <= 140))
    const before = pending.length
    await round({ entries: record(), gh, repo: 'example/room', publicUrl: 'https://room.example', now: later })
    assert.equal(calls.filter((c) => c.method === 'POST' && c.body?.state === 'pending').length, before, 'the same reason is not written again')
    await send(people.a, 'veto', { target: two, reason: 'done' }); await send(people.a, 'veto', { target: guarded, reason: 'done' })
  })

  test('a big change is judged on every file: a protected file after the first hundred, or a renamed one, still needs a person', async () => {
    const files = [...Array.from({ length: 100 }, (_, i) => `public/page-${i}.js`), 'src/server/log.js']
    const big = await propose(12, 'A hundred page files and one more', 'c'.repeat(40))
    for (const k of ['b', 'c', 'd']) await as(k, 'approve', { proposal: big, sha: 'c'.repeat(40) })
    const moved = await propose(13, 'Moves the rules file', 'e'.repeat(40))
    for (const k of ['b', 'c', 'd']) await as(k, 'approve', { proposal: moved, sha: 'e'.repeat(40) })
    const huge = await propose(14, 'Too big to list', 'f'.repeat(40))
    for (const k of ['b', 'c', 'd']) await as(k, 'approve', { proposal: huge, sha: 'f'.repeat(40) })
    const { gh, calls } = github({
      12: { title: 'big', sha: 'c'.repeat(40), files },
      13: { title: 'moved', sha: 'e'.repeat(40), files: [{ filename: 'docs/old-rules.json', previous_filename: 'rules.json' }] },
      14: { title: 'huge', sha: 'f'.repeat(40), files: ['public/a.js'], count: 3001 },
    })
    const out = await round({ entries: record(), gh, repo: 'example/room', now: Date.now() + 11 * MIN })
    const of = (n) => out.decisions.find((d) => d.pr === n)
    assert.match(of(12).why, /safety \(src\/server\/log\.js\), so a person approves it too/, 'the 101st file counts')
    assert.ok(calls.some((c) => c.path.endsWith('/pulls/12/files?per_page=100&page=2')), 'it read the second page')
    assert.match(of(13).why, /safety \(.*rules\.json.*\), so a person approves it too/, 'a renamed file counts under its old name')
    assert.equal(of(14).outcome, 'will not merge as it is'); assert.match(of(14).why, /3001 files, more than the 3000 GitHub can list/)
    assert.ok(!calls.some((c) => c.method === 'PUT'), 'none of them merges')
    for (const p of [big, moved, huge]) await send(people.a, 'veto', { target: p, reason: 'done' })
  })

  test('a record that doesn’t verify is refused whole: nothing is read on GitHub, nothing merges', async () => {
    const prop = await propose(10, 'Approved, but the copy was tampered with')
    for (const k of ['b', 'c', 'd']) await as(k, 'approve', { proposal: prop, sha: A })
    const forged = record(), i = forged.findIndex((e) => e.hash === prop)
    forged[i].document.payload.change.pr = 11 // whoever serves the copy edits one line
    const { gh, calls } = github({ 10: { title: 'x', sha: A, files: ['public/app.js'] }, 11: { title: 'y', sha: A, files: ['public/app.js'] } })
    const out = await round({ entries: forged, gh, repo: 'example/room', now: Date.now() + 11 * MIN })
    assert.equal(out.ok, false); assert.match(out.why, /did not verify/)
    assert.equal(calls.length, 0)
    assert.match(summary(out, 'https://room.example'), /\*\*Nothing merged\.\*\*/)
    await send(people.a, 'veto', { target: prop, reason: 'done' })
  })
})

describe('once main requires the referee’s mark, the room stops merging by itself', () => {
  test('an approved change waits for the referee instead of being merged by the room', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wpi-referee-room-'))
    const calls = []
    const gh = async (method, path, body) => {
      calls.push({ method, path, body })
      if (path.endsWith('/rules/branches/main')) return [{ type: 'pull_request', parameters: {} }, { type: 'required_status_checks', parameters: { required_status_checks: [{ context: APPROVAL_CONTEXT, integration_id: 123456 }] } }]
      if (method === 'GET' && /\/pulls\/\d+$/.test(path)) return { state: 'open', title: 'A change', base: { ref: 'main' }, head: { sha: A } }
      if (method === 'GET' && /\/pulls\/\d+\/files/.test(path)) return [{ filename: 'public/app.js' }]
      if (method === 'GET' && path.includes('/actions/runs?head_sha=')) return { workflow_runs: [{ name: 'test', status: 'completed', conclusion: 'success' }] }
      return {}
    }
    const ctx = await createApp({ ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, githubToken: 'test', vetoWindowMinutes: 0, approvalsRequired: 1, weaverIntervalMinutes: 0, weaverQuietMinutes: 0, ratePerMinute: 1000, workspaceRepo: 'example/room', boardDataUrl: 'data:application/json,' + encodeURIComponent(JSON.stringify(BOARD)), llm: { ...baseConfig.llm, provider: 'openai', apiKey: '' } }, { gh })
    await new Promise((r) => ctx.server.listen(0, r))
    try {
      const base = `http://localhost:${ctx.server.address().port}`
      const send = async (id, name, payload) => (await (await fetch(`${base}/api/entries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signedDocument(id, { type: TYPES[name], payload })) })).json())
      const a = newIdentity(), b = newIdentity()
      await send(a, 'join', { name: 'Person A' }); await send(b, 'join', { name: 'Person B' })
      const prop = (await send(a, 'propose', { kind: 'workspace-change', title: 'A change', change: { pr: 5, sha: A } })).hash
      await send(b, 'approve', { proposal: prop, sha: A })
      await ctx.executor.tick()
      assert.ok(!calls.some((c) => c.method === 'PUT' && c.path.endsWith('/merge')), 'the room did not merge it')
      assert.match(ctx.log.state.proposals.get(prop).notYet, /GitHub’s referee merges it/)
      assert.equal(calls.filter((c) => c.path.endsWith('/rules/branches/main')).length, 1)
      await ctx.executor.tick()
      assert.equal(calls.filter((c) => c.path.endsWith('/rules/branches/main')).length, 1, 'main’s rules are read every ten minutes, not every tick')
    } finally { await ctx.stop(); rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('the referee’s GitHub login', () => {
  test('a token signed with the app’s key, which GitHub can check, for nine minutes', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
    const now = Date.parse('2026-11-09T18:00:00Z'), jwt = appJwt(123, privateKey, now), [h, b, s] = jwt.split('.')
    assert.ok(createVerify('RSA-SHA256').update(`${h}.${b}`).verify(publicKey, Buffer.from(s, 'base64url')))
    const claims = JSON.parse(Buffer.from(b, 'base64url'))
    assert.deepEqual(claims, { iat: now / 1000 - 60, exp: now / 1000 - 60 + 540, iss: '123' })
  })

  test('an installation token for this one repository', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
    const calls = []
    const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => (url.endsWith('/installation') ? { id: 42, app_slug: 'room-referee' } : { token: 'ghs_test', expires_at: '2026-11-09T19:00:00Z' }) } }
    const t = await installationToken({ appId: 123, privateKey, repo: 'example/room', fetchImpl })
    assert.deepEqual(t, { token: 'ghs_test', expiresAt: '2026-11-09T19:00:00Z', installation: 42, app: 'room-referee' })
    assert.equal(calls[0].url, 'https://api.github.com/repos/example/room/installation')
    assert.equal(calls[1].url, 'https://api.github.com/app/installations/42/access_tokens')
    assert.deepEqual(JSON.parse(calls[1].init.body), { repositories: ['room'] })
    assert.match(calls[0].init.headers.authorization, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/)
  })
})
