// Step 94166414 (adds to #64): a "Not me: I have no rights…" line is a refusal, never a decision. From another
// person's agent it leaves the step undecided, with no "Decided by" line, in the thread, through the round's
// "answered" move and after a restart; the same holds for the step's own agent (src/server/facilitator.js, BOWS_OUT).
// The two lines are written in the form of the two refusals the room saw on 2026-11-09, one on an unheld choice and
// one on a choice held for a person's keys.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { NAME_OF, TYPES, signedDocument } from '../src/shared/types.js'
import { config as baseConfig } from '../src/server/config.js'
import { branchOf } from '../src/server/builder.js'
import { BOWS_OUT, Facilitator, decided, decisionOf } from '../src/server/facilitator.js'
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
  const ctx = await createApp(config, { openRoom: true, resolver: createResolver(), hostWelcomeMs: null, wakeFetch, gh })
  await new Promise((r) => ctx.server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${ctx.server.address().port}`
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
const builderSays = (r, text, threadId) => r.ctx.builder.say(r.builder, { text, kind: 'message' }, { threadId })


const NOT_ME_CARRIER = 'Not me: I have no rights to choose the carrier the room tests first, that is for Person A’s side.'
const NOT_ME_KEY = 'Not me: I have no rights over the key that signs the room’s DID document.'
const DOC_KEY = 'Which key signs the room’s DID document'
const decidedLines = (r) => r.ctx.log.entries.filter((e) => NAME_OF[e.type] === 'note' && /\bDecided\b[^.]*\bby\b/.test(String(e.document.payload.text ?? '')))
const undecided = (r, s, why) => {
  assert.ok(s.waitingOn, `${why}: still waiting on its choice`)
  assert.equal(s.decision ?? null, null, `${why}: no decision`); assert.equal(decided(s), null)
  assert.equal(r.said('decided').length, 0, `${why}: no decided line`); assert.equal(decidedLines(r).length, 0, `${why}: no "Decided by" line`)
  const v = r.ctx.facilitator.view().steps.find((x) => x.id === s.id)
  assert.ok(!v?.decision?.holds, `${why}: the board shows no decision`)
}

describe('a "Not me…" line is a refusal, not an answer', () => {
  test('decisionOf gives nothing for it, whatever words it shares with the question; real answers still count', () => {
    for (const [t, asked] of [[NOT_ME_CARRIER, CARRIER], [NOT_ME_KEY, DOC_KEY], ['Not me — I have no rights to decide which carrier.', CARRIER], ['I have no rights to pick the carrier, that is Person A’s call.', CARRIER], ['Not my call: the carrier is up to Person A.', CARRIER]]) {
      assert.ok(BOWS_OUT.test(t), t); assert.equal(decisionOf(t, asked), null, t)
    }
    // a shrug is no answer either (UNSURE, not a bow-out)
    for (const [t, asked] of [['I can’t decide which key signs it.', DOC_KEY], ['I’ll pass on the carrier.', CARRIER]]) assert.equal(decisionOf(t, asked), null, t)
    for (const [t, asked] of [['TSP first, because RLTP already carries it.', CARRIER], ['Use a new key kept offline, because the room’s key is online.', DOC_KEY], ['Notary: a key kept offline signs it.', DOC_KEY], ['No rights issue there: use TSP first.', CARRIER]]) assert.ok(decisionOf(t, asked), t)
  })
})

describe('a "Not me: I have no rights…" line from another person’s agent is never recorded as a decision', () => {
  test('case 1, an unheld choice on Person A’s step: Person C’s agent bows out, in the thread, through the round and after a restart; so does Person A’s own agent; it stays undecided', async () => {
    const r = await room()
    try {
      const f = r.ctx.facilitator
      const p = await blockOn(r, 'Run the carrier test', `${CARRIER}?`)
      const s = r.stepFrom(p)
      assert.equal(s.waitingOn.who, null, 'not held')
      const line = (await r.as('c', 'note', { text: NOT_ME_CARRIER, kind: 'message' }, { threadId: s.thread })).body.hash
      await f.tick(r.at(17))
      undecided(r, r.stepFrom(p), 'in the thread')
      roundSays(r, [{ entry: line, step: s.id, kind: 'answered' }])
      assert.equal((await r.ctx.weaver.round()).document.payload.facilitate.moved.length, 0, 'the round’s "answered" moves nothing')
      undecided(r, r.stepFrom(p), 'through the round')
      // even the step's own person's agent: a refusal is no answer
      await builderSays(r, NOT_ME_CARRIER, s.thread)
      await f.tick(r.at(18))
      undecided(r, r.stepFrom(p), 'from the step’s own agent')
      r.ctx.facilitator = new Facilitator({ ctx: r.ctx })
      await r.ctx.facilitator.tick(r.at(19))
      undecided(r, r.stepFrom(p), 'after a restart')
      // a real answer still settles it
      await builderSays(r, 'TSP first, because RLTP already carries it.', s.thread)
      await r.ctx.facilitator.tick(r.at(20))
      assert.equal(r.stepFrom(p).decision.by, r.builder)
    } finally { await r.stop() }
  })

  test('case 2, a keys choice held for Person B on a step with no owner: Person C’s agent and Person B’s own agent bow out, in the thread, through the round and after a restart; it stays held and undecided', async () => {
    const r = await room()
    try {
      const g = (await r.send(r.people.b, 'propose', { kind: 'goal', title: 'Goal 3: the room has a home of its own' })).body.hash
      await r.send(r.people.b, 'vote', { proposal: g, choice: 'for' })
      const f = r.ctx.facilitator
      await f.openTest(r.st().proposals.get(g), [{ text: 'The room’s DID document is published', needs: DOC_KEY }])
      await f.tick(r.at(1))
      const step = () => r.ctx.facilitator.testOf(g)[0]
      assert.deepEqual({ who: step().waitingOn.who, held: step().waitingOn.held }, { who: r.people.b.did, held: 'keys' })
      const lines = [(await r.as('c', 'note', { text: NOT_ME_KEY, kind: 'message' }, { threadId: step().thread })).body.hash, (await r.as('b', 'note', { text: NOT_ME_KEY, kind: 'message' }, { threadId: step().thread })).body.hash]
      await f.tick(r.at(2))
      undecided(r, step(), 'in the thread')
      roundSays(r, lines.map((entry) => ({ entry, step: step().id, kind: 'answered' })))
      await r.ctx.weaver.round()
      undecided(r, step(), 'through the round'); assert.equal(step().waitingOn.who, r.people.b.did, 'still held for Person B')
      r.ctx.facilitator = new Facilitator({ ctx: r.ctx })
      await r.ctx.facilitator.tick(r.at(3))
      undecided(r, step(), 'after a restart'); assert.equal(step().waitingOn.who, r.people.b.did)
      // even Person B's own "Not me" is no answer; their real one is
      await r.send(r.people.b, 'note', { text: NOT_ME_KEY, kind: 'message' }, { threadId: step().thread })
      await r.ctx.facilitator.tick(r.at(4))
      undecided(r, step(), 'from Person B’s own refusal')
      await r.send(r.people.b, 'note', { text: 'Use a new key kept offline, because the room’s key is online.', kind: 'message' }, { threadId: step().thread })
      await r.ctx.facilitator.tick(r.at(5))
      assert.equal(step().decision.by, r.people.b.did)
    } finally { await r.stop() }
  })
})
