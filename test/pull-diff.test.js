// Reading a pull request from the room (src/server/code.js pullDiff): agents whose sessions can't reach GitHub read a
// pull request of the room's own repository as plain text, its head commit at the top, through the read_pull_request
// tool or the public /api/pulls/<n>/diff link; the Builder's proposals link to it. A fake GitHub stands in for the real one.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { TYPES, signedDocument } from '../src/shared/types.js'
import { config as baseConfig } from '../src/server/config.js'
import { githubCode } from '../src/server/code.js'
import { branchOf, diffLink } from '../src/server/builder.js'
import { createApp } from '../src/server/index.js'
import { createResolver } from '../src/server/resolver.js'
import { closeVotes } from '../src/server/votes.js'

const HOLD = '+// hold: a change waits while anyone holds it, and a push voids every approval given before it'
const fakeGh = (state) => async (method, path) => {
  state.calls.push(path)
  if (method !== 'GET') throw new Error('read-only: ' + method)
  if (path.includes('/pulls?')) return state.open ?? []
  let m = /^\/repos\/example\/room\/pulls\/(\d+)$/.exec(path)
  if (m) { if (m[1] !== '40') throw Object.assign(new Error('Not Found'), { status: 404 }); return { number: 40, title: 'Hold a change', state: 'open', head: { sha: state.head, ref: 'feature/hold' }, base: { ref: 'main', sha: 'f'.repeat(40) }, additions: 2, deletions: 1, html_url: 'https://github.com/example/room/pull/40' } }
  m = /^\/repos\/example\/room\/pulls\/40\/files\?per_page=100&page=(\d+)$/.exec(path)
  if (m) {
    if (m[1] !== '1') return []
    return [
      { filename: 'src/server/votes.js', status: 'modified', additions: 1, deletions: 1, patch: `@@ -1,2 +1,2 @@\n context\n-old line\n${HOLD} (at ${state.head})` },
      { filename: 'public/logo.png', status: 'added', additions: 0, deletions: 0 },
      ...(state.big ? [{ filename: 'big.txt', status: 'added', additions: 9000, deletions: 0, patch: Array.from({ length: 9000 }, (_, i) => `+line ${i} ${'x'.repeat(20)}`).join('\n') }] : []),
    ]
  }
  throw new Error('unexpected ' + path)
}

describe('a pull request of the room’s own repository, read from the room', () => {
  test('plain text, the head commit at the top, every file’s diff; a push changes the head shown', async () => {
    const state = { head: 'a'.repeat(40), calls: [] }
    const code = githubCode({ repo: 'example/room', gh: fakeGh(state), ttlMs: 0 })
    const d = await code.pullDiff(40)
    const top = d.text.split('\n')
    assert.equal(top[0], 'Pull request #40 in example/room: Hold a change')
    assert.equal(top[1], `Head commit: ${'a'.repeat(40)}`)
    assert.equal(d.head, 'a'.repeat(40))
    assert.match(d.text, /diff --git a\/src\/server\/votes\.js b\/src\/server\/votes\.js/)
    assert.ok(d.text.includes(HOLD), 'the change itself is there to read')
    assert.match(d.text, /public\/logo\.png[\s\S]*no text diff here/)
    assert.ok(state.calls.every((p) => p.startsWith('/repos/example/room/')), 'only the room’s own repository')
    state.head = 'b'.repeat(40) // someone pushed
    const again = await code.pullDiff('40')
    assert.equal(again.text.split('\n')[1], `Head commit: ${'b'.repeat(40)}`)
    assert.match(again.text, new RegExp(`at ${'b'.repeat(40)}`), 'the files are read again for the new head')
  })

  test('a size limit, lines from..to, and a plain error for a number that is not one', async () => {
    const state = { head: 'c'.repeat(40), calls: [], big: true }
    const code = githubCode({ repo: 'example/room', gh: fakeGh(state), ttlMs: 60_000 })
    const d = await code.pullDiff(40)
    assert.ok(d.text.length < 121_000, 'cut at the limit'); assert.match(d.text, /cut at 120000 characters/)
    assert.match(d.text.split('\n')[1], /^Head commit: c{40}$/, 'the head stays at the top when cut')
    const part = await code.pullDiff(40, { from: 2, to: 3 })
    assert.equal(part.from, 2); assert.equal(part.to, 3); assert.match(part.text, /Lines 2-3 of \d+ below\.\n\nmodified, \+1 −1\n--- a\/src\/server\/votes\.js$/)
    const calls = state.calls.length
    await code.pullDiff(40, { from: 5 })
    assert.equal(state.calls.length, calls, 'kept while the head is fresh')
    for (const bad of ['../x', 0, -1, 'abc']) await assert.rejects(code.pullDiff(bad), /pr is the pull request's number/)
  })

  test('diffLink: the room’s address, or none without one', () => {
    assert.equal(diffLink('https://interop.example/', 40), 'https://interop.example/api/pulls/40/diff')
    assert.equal(diffLink('', 40), null)
  })
})

describe('from the room: the link, the agent tool and the Builder’s proposals', () => {
  const MIN = 60_000
  async function room () {
    const dir = mkdtempSync(join(tmpdir(), 'wpi-pulldiff-'))
    const state = { head: 'a'.repeat(40), calls: [], open: [] }
    const board = { generated: new Date().toISOString().slice(0, 10), projects: [], scenarios: [], runs: [] }
    const config = { ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, githubToken: '', weaverIntervalMinutes: 0, weaverQuietMinutes: 0, ratePerMinute: 1000, voteMinutes: 10, workspaceRepo: 'example/room', publicUrl: 'https://interop.example', boardDataUrl: 'data:application/json,' + encodeURIComponent(JSON.stringify(board)), llm: { ...baseConfig.llm, provider: 'openai', apiKey: '' } }
    const ctx = await createApp(config, { resolver: createResolver(), hostWelcomeMs: null, wakeFetch: async () => ({ ok: true, status: 200 }), gh: fakeGh(state) })
    await new Promise((r) => ctx.server.listen(0, r))
    const base = `http://localhost:${ctx.server.address().port}`
    await ctx.board.refresh()
    const send = async (id, name, payload, extra) => (await (await fetch(`${base}/api/entries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signedDocument(id, { type: TYPES[name], payload, ...extra })) })).json())
    const stop = async () => { await ctx.stop(); rmSync(dir, { recursive: true, force: true }) }
    return { ctx, base, state, send, stop }
  }

  test('GET /api/pulls/40/diff and read_pull_request show the head commit at the top and the change', async () => {
    const r = await room()
    try {
      let res = await fetch(`${r.base}/api/pulls/40/diff`)
      assert.equal(res.status, 200); assert.match(res.headers.get('content-type'), /^text\/plain/)
      let body = await res.text()
      assert.equal(body.split('\n')[1], `Head commit: ${'a'.repeat(40)}`); assert.ok(body.includes(HOLD))
      assert.equal(res.headers.get('x-head-commit'), 'a'.repeat(40))
      assert.equal((await fetch(`${r.base}/api/pulls/41/diff`)).status, 404)
      assert.equal((await fetch(`${r.base}/api/pulls/40/diff`, { method: 'POST' })).status !== 200, true, 'read-only')
      // an agent through its seat's plain link (the same tools as over MCP)
      const person = newIdentity()
      await r.send(person, 'join', { name: 'Person A' })
      const made = (await r.send(person, 'host', { label: 'Reader' })).hosted
      await r.send(person, 'delegate', { delegate: made.did, scope: ['note'], label: 'Reader' }, { expiresAt: new Date(Date.now() + 86400000).toISOString() })
      const seat = made.connector.replace(/^https?:\/\/[^/]+/, r.base)
      res = await fetch(`${seat}/call/read_pull_request?pr=40`)
      body = await res.text()
      assert.equal(res.status, 200, body)
      assert.match(body.split('\n')[1], /^Head commit: a{40}$/)
      assert.ok(body.includes(HOLD))
    } finally { await r.stop() }
  })

  test('the Builder’s proposal and result link to the diff, with the head commit', async () => {
    const r = await room()
    try {
      const exp = new Date(Date.now() + 86400000).toISOString()
      const a = newIdentity(), b = newIdentity(), c = newIdentity(), ab = newIdentity(), ac = newIdentity()
      for (const [p, n] of [[a, 'Person A'], [b, 'Person B'], [c, 'Person C']]) await r.send(p, 'join', { name: n })
      const db = (await r.send(b, 'delegate', { delegate: ab.did, scope: ['note', 'propose', 'vote'], label: 'South Agent' }, { expiresAt: exp })).hash
      const dc = (await r.send(c, 'delegate', { delegate: ac.did, scope: ['note', 'propose', 'vote'], label: 'East Agent' }, { expiresAt: exp })).hash
      const builder = (await r.send(a, 'host', { label: "Person A's builder" })).hosted.did
      await r.send(a, 'delegate', { delegate: builder, scope: ['note', 'propose'], label: "Person A's builder" }, { expiresAt: exp })
      await r.ctx.waker.set(builder, 'https://api.anthropic.com/v1/claude_code/routines/trig_x/fire#token=t', ['direct', 'mention'])
      await r.ctx.facilitator.tick()
      const at = (m) => Date.now() + m * MIN
      const agreed = (await r.send(ab, 'propose', { kind: 'other', title: 'Read pull requests from the room', body: "Owner: Person A's builder. Check: the diff shows." }, { onBehalfOf: b.did, delegation: db })).hash
      await r.send(ac, 'vote', { proposal: agreed, choice: 'for' }, { onBehalfOf: c.did, delegation: dc })
      await closeVotes(r.ctx, at(11), { max: 10 })
      await r.ctx.facilitator.tick(at(11)); await r.ctx.facilitator.tick(at(12))
      const st = r.ctx.log.state
      const s = [...st.steps.values()].find((x) => x.from === agreed)
      r.state.open.push({ number: 40, title: 'Hold a change', body: 'Adds the hold rule.', html_url: 'https://github.com/example/room/pull/40', head: { ref: branchOf(s), sha: 'a'.repeat(40) } })
      await r.ctx.facilitator.tick(at(15))
      const proposal = [...st.proposals.values()].find((p) => p.kind === 'workspace-change' && p.change?.pr === 40)
      assert.ok(proposal, 'proposed')
      const doc = r.ctx.log.byHash.get(proposal.hash).document.payload
      assert.match(doc.body, /Read its changes from the room: https:\/\/interop\.example\/api\/pulls\/40\/diff \(head commit a{40}\)/)
      const result = r.ctx.log.entries.map((e) => e.document.payload).find((p) => p.step?.say === 'result' && p.step.of === s.id)
      assert.ok(result.step.evidence.some((e) => e.url === 'https://interop.example/api/pulls/40/diff'))
    } finally { await r.stop() }
  })
})
