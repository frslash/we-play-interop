// Step 74d0cde7 (#62/#64): the room's own case. A step's choice asked "can someone who is allowed to close pull
// requests close #61?"; one agent of another person answered "Not me ... it's for whoever owns it, <person> as far as
// I know", and the live code wrote "Decided by <agent> for <person>". An agent of another person alone only suggests:
// its line, in the thread or through the round's `answered` move, settles nothing (src/server/facilitator.js, mayDecide).
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { NAME_OF, TYPES, signedDocument } from '../src/shared/types.js'
import { config as baseConfig } from '../src/server/config.js'
import { branchOf } from '../src/server/builder.js'
import { mayDecide } from '../src/server/facilitator.js'
import { createApp } from '../src/server/index.js'
import { createResolver } from '../src/server/resolver.js'
import { closeVotes } from '../src/server/votes.js'

const BOARD = { generated: new Date().toISOString().slice(0, 10), projects: [], scenarios: [], runs: [] }
const FIRE = 'https://api.anthropic.com/v1/claude_code/routines/trig_builder_1/fire'
const MIN = 60_000

async function room () {
  const dir = mkdtempSync(join(tmpdir(), 'wpi-not-me-'))
  const pulls = []
  const wakeFetch = async () => ({ ok: true, status: 200 })
  const gh = async (method, path) => (method === 'GET' && path.includes('/pulls?') ? pulls : {})
  const config = { ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, githubToken: '', weaverIntervalMinutes: 0, weaverQuietMinutes: 0, ratePerMinute: 1000, voteMinutes: 10, workspaceRepo: 'example/room', publicUrl: 'https://interop.example', boardDataUrl: 'data:application/json,' + encodeURIComponent(JSON.stringify(BOARD)), llm: { ...baseConfig.llm, provider: 'openai', apiKey: '' } }
  const ctx = await createApp(config, { resolver: createResolver(), hostWelcomeMs: null, wakeFetch, gh })
  await new Promise((r) => ctx.server.listen(0, r))
  const base = `http://localhost:${ctx.server.address().port}`
  await ctx.board.refresh()
  const send = async (id, name, payload, extra) => { const r = await fetch(`${base}/api/entries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signedDocument(id, { type: TYPES[name], payload, ...extra })) }); return { status: r.status, body: await r.json() } }
  const exp = new Date(Date.now() + 86400000).toISOString()
  const people = { a: newIdentity(), b: newIdentity(), c: newIdentity() }, agents = { b: newIdentity(), c: newIdentity() }, dels = {}
  for (const k of ['a', 'b', 'c']) await send(people[k], 'join', { name: `Person ${k.toUpperCase()}` })
  for (const k of ['b', 'c']) dels[k] = (await send(people[k], 'delegate', { delegate: agents[k].did, scope: ['note', 'propose', 'vote'], label: k === 'b' ? 'South Agent' : 'East Agent' }, { expiresAt: exp })).body.hash
  const builder = (await send(people.a, 'host', { label: "Person A's builder" })).body.hosted.did
  await send(people.a, 'delegate', { delegate: builder, scope: ['note', 'propose'], label: "Person A's builder" }, { expiresAt: exp })
  await ctx.waker.set(builder, `${FIRE}#token=secret-token`, ['direct', 'mention'])
  const as = (k, name, payload, extra) => send(agents[k], name, payload, { onBehalfOf: people[k].did, delegation: dels[k], ...extra })
  await ctx.facilitator.tick()
  const st = () => ctx.log.state
  const stepFrom = (h) => [...st().steps.values(), ...st().stepsDone].find((s) => s.from === h)
  const said = (what) => ctx.log.entries.filter((e) => NAME_OF[e.type] === 'note' && e.document.payload.facilitator?.what === what).map((e) => e.document)
  const stuckLines = () => ctx.log.entries.filter((e) => e.author === builder && e.document.payload.step?.say === 'blocked').length
  const at = (m) => Date.now() + m * MIN
  const agreeForBuilder = async (title) => {
    const pr = (await as('b', 'propose', { kind: 'other', title, body: "Owner: Person A's builder. Check: the Steps tab shows it." })).body.hash
    await as('c', 'vote', { proposal: pr, choice: 'for' })
    await closeVotes(ctx, at(11), { max: 10 })
    return pr
  }
  const stop = async () => { await ctx.stop(); rmSync(dir, { recursive: true, force: true }) }
  return { ctx, send, as, people, agents, builder, pulls, st, stepFrom, said, stuckLines, at, agreeForBuilder, stop }
}

const CARRIER = 'Which carrier the room tests first, TSP or DIDComm'
const KEY = 'Which key signs the DID document'
const blockOn = async (r, title, needs) => {
  const f = r.ctx.facilitator, p = await r.agreeForBuilder(title)
  await f.tick(r.at(11)); await f.tick(r.at(12))
  const s = r.stepFrom(p)
  r.pulls.push({ number: 40 + r.pulls.length, title: `Blocked: ${title}`, body: `Needs: ${needs}\nWhy: it needs a choice.\nFrom: any agent here`, html_url: 'https://github.com/example/room/pull/40', head: { ref: branchOf(s), sha: 'e'.repeat(40) } })
  await f.tick(r.at(15)); await f.tick(r.at(16))
  return p
}
const roundSays = (r, moves) => { r.ctx.weaver.llm = { configured: true, model: 'test/model', chat: async () => ({ model: 'test/model', latencyMs: 1, usage: {}, finishReason: 'stop', jsonMode: true, content: JSON.stringify({ heard: [], threads: [], agreements: [], conflicts: [], next: [], moves }) }) } }

const CLOSE = 'Can someone who is allowed to close pull requests close #61? It is replaced by #62, and builders may never close one'
const NOT_ME = 'Not me: I have no rights on the repository. Closing #61 is for whoever owns it, Person A as far as I know. It’s safe to close: #62 replaces it.'

describe('one agent of another person saying "Not me" settles nothing', () => {
  test('East Agent’s "Not me … Person A as far as I know" is no decision for Person A, in the thread or through the round', async () => {
    const r = await room()
    try {
      const f = r.ctx.facilitator
      const p = await blockOn(r, 'Fix #62 and close #61', `${CLOSE}?`)
      const s = r.stepFrom(p)
      assert.equal(s.owner, r.builder, 'the builder’s step, so Person A’s')
      assert.ok(s.waitingOn, 'it waits on the choice')
      assert.equal(mayDecide(r.st(), r.agents.c.did, s), false, 'Person C’s agent alone may not settle it')
      const line = (await r.as('c', 'note', { text: NOT_ME, kind: 'message' }, { threadId: s.thread })).body.hash
      await f.tick(r.at(17))
      assert.ok(r.stepFrom(p).waitingOn, 'not settled in the thread')
      roundSays(r, [{ entry: line, step: s.id, kind: 'answered' }])
      await r.ctx.weaver.round()
      await f.tick(r.at(18))
      const now = r.stepFrom(p)
      assert.ok(now.waitingOn, 'not settled through the round either')
      assert.equal(now.decision ?? null, null)
      assert.equal(r.said('decided').length, 0, 'no "Decided by East Agent for Person A" line')
      assert.ok(!r.ctx.log.entries.some((e) => /Decided by East Agent/.test(e.document.payload?.text ?? '')))
    } finally { await r.stop() }
  })
})
