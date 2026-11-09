// Only a whole answer decides, each decision records for whom, and a choice that touches a person's keys, money, time
// or name is held for that person: one agent's answer can't settle another person's step alone (src/server/facilitator.js).
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { NAME_OF, TYPES, signedDocument } from '../src/shared/types.js'
import { config as baseConfig } from '../src/server/config.js'
import { branchOf } from '../src/server/builder.js'
import { PARKED, decisionOf, touches } from '../src/server/facilitator.js'
import { createApp } from '../src/server/index.js'
import { createResolver } from '../src/server/resolver.js'
import { closeVotes } from '../src/server/votes.js'

const BOARD = { generated: new Date().toISOString().slice(0, 10), projects: [], scenarios: [], runs: [] }
const FIRE = 'https://api.anthropic.com/v1/claude_code/routines/trig_builder_1/fire'
const MIN = 60_000

async function room () {
  const dir = mkdtempSync(join(tmpdir(), 'wpi-held-'))
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

const ASK = 'Which key signs the DID document'
const blockOn = async (r, title, needs) => {
  const f = r.ctx.facilitator, p = await r.agreeForBuilder(title)
  await f.tick(r.at(11)); await f.tick(r.at(12))
  const s = r.stepFrom(p)
  r.pulls.push({ number: 40 + r.pulls.length, title: `Blocked: ${title}`, body: `Needs: ${needs}\nWhy: it needs a choice.\nFrom: any agent here`, html_url: 'https://github.com/example/room/pull/40', head: { ref: branchOf(s), sha: 'e'.repeat(40) } })
  await f.tick(r.at(15)); await f.tick(r.at(16))
  return p
}

describe('only a whole answer decides', () => {
  test('"parked" decides only as the whole answer, never as a word inside a sentence', () => {
    for (const t of ['Parked', 'parked: until the domain is bought', 'Park it for now.', 'Let’s park this until Monday', 'Set it aside', 'Leave it for later, the host comes first']) {
      assert.ok(PARKED.test(t), t); assert.equal(decisionOf(t, ASK)?.parked, true, t)
    }
    for (const t of ['I parked my other project', 'We parked the car outside', 'Parked my other project last week', 'The parking lot is full', 'Not parked, use option B']) assert.notEqual(decisionOf(t, ASK)?.parked, true, t)
    assert.equal(decisionOf('I parked my other project', ASK), null, 'and it is not an answer about the key either')
  })
  test('when the question is known, a line has to answer it: choose, lead with the answer, or speak to what was asked', () => {
    assert.equal(decisionOf('The room’s own key. Because it already signs the log.', ASK).choice, 'The room’s own key')
    assert.ok(decisionOf('Use a new one, kept on a hardware token', ASK))
    assert.ok(decisionOf('inwove.org: it is bought and reaches the room.', 'which permanent domain the room lives on'))
    for (const t of ['Lunch was great today', 'I will be back in an hour', 'Which one?', 'not sure']) assert.equal(decisionOf(t, ASK), null, t)
  })
  test('what a choice touches: a person’s keys, money, time or name', () => {
    assert.equal(touches('Which key signs the room’s DID'), 'keys')
    assert.equal(touches('which permanent domain, and buying it if it costs money'), 'money')
    assert.equal(touches('whether Person A can give two hours on Friday'), 'time')
    assert.equal(touches('whose name goes on the room’s account'), 'name')
    assert.equal(touches('which carrier the room tests first, TSP or DIDComm'), null)
  })
})

describe('a choice that touches a person is held for them', () => {
  test('one agent settles which key signs the room’s DID: it stays undecided until that person answers', async () => {
    const r = await room()
    try {
      const f = r.ctx.facilitator
      const p = await blockOn(r, 'Publish the room’s DID document', `${ASK}?`)
      let s = r.stepFrom(p)
      assert.deepEqual({ who: s.waitingOn.who, held: s.waitingOn.held }, { who: r.people.a.did, held: 'keys' }, 'held for the step’s owner’s person, never its proposer')
      const ask = r.said('decide').at(-1).payload.text
      assert.match(ask, /^A choice held for Person A: Which key signs/); assert.match(ask, /can’t settle it/)
      // another person's agent answers, in the thread and through the round's judgment: nothing is decided
      const line = (await r.as('c', 'note', { text: 'The room’s own key. Because it already signs the log.', kind: 'message' }, { threadId: s.thread })).body.hash
      await f.tick(r.at(17))
      r.ctx.weaver.llm = { configured: true, model: 'test/model', chat: async () => ({ model: 'test/model', latencyMs: 1, usage: {}, finishReason: 'stop', jsonMode: true, content: JSON.stringify({ heard: [], threads: [], agreements: [], conflicts: [], next: [], moves: [{ entry: line, step: s.id, kind: 'answered' }] }) }) }
      const round = (await r.ctx.weaver.round()).document.payload
      assert.equal(round.facilitate.moved.length, 0, 'the round cannot settle it for another person either')
      s = r.stepFrom(p)
      assert.ok(s.waitingOn); assert.equal(s.decision, undefined); assert.equal(r.said('decided').length, 0)
      assert.match(f.roundContext().steps.find((x) => x.id === s.id).waitingOn, /^held for Person A \(their keys\)/)
      // a restart does not hand a held choice to the agents
      const { Facilitator } = await import('../src/server/facilitator.js')
      r.ctx.facilitator = new Facilitator({ ctx: r.ctx }); await r.ctx.facilitator.tick(r.at(18))
      assert.equal(r.stepFrom(p).waitingOn.who, r.people.a.did)
      // the person answers in their own plain line: decided, and the decision records for whom
      await r.send(r.people.a, 'note', { text: 'Use a new key kept offline, because the room’s key is online.', kind: 'message' }, { threadId: s.thread })
      await r.ctx.facilitator.tick(r.at(19))
      s = r.stepFrom(p)
      assert.equal(s.waitingOn, undefined)
      assert.equal(s.decision.by, r.people.a.did); assert.equal(s.decision.for, r.people.a.did); assert.equal(s.decision.held, 'keys')
      assert.match(r.said('decided').at(-1).payload.text, /^Decided by Person A for Person A \(Which key signs/)
    } finally { await r.stop() }
  })

  test('a choice that touches nobody’s keys, money, time or name stays the agents’, and its decision still records for whom', async () => {
    const r = await room()
    try {
      const f = r.ctx.facilitator
      const p = await blockOn(r, 'Run the carrier test', 'Which carrier the room tests first, TSP or DIDComm?')
      let s = r.stepFrom(p)
      assert.equal(s.waitingOn.who, null); assert.equal(s.waitingOn.held, undefined)
      // "parked" inside a sentence is not an answer
      await r.as('c', 'note', { text: 'I parked my other project', kind: 'message' }, { threadId: s.thread })
      await f.tick(r.at(17))
      assert.ok(r.stepFrom(p).waitingOn, 'not decided, not parked')
      assert.equal(r.said('parked').length, 0); assert.equal(r.said('decided').length, 0)
      // the builder (Person A's, the step's owner) settles it, provisionally
      await r.ctx.builder.say(r.builder, { text: 'TSP first, because RLTP already carries it.', kind: 'message' }, { threadId: s.thread })
      await f.tick(r.at(18))
      s = r.stepFrom(p)
      assert.equal(s.waitingOn, undefined); assert.equal(s.decision.by, r.builder); assert.equal(s.decision.provisional, true)
      assert.equal(s.decision.for, r.people.b.did, 'for the person whose agreement the step serves'); assert.equal(s.decision.held, null)
      assert.match(f.view().steps.find((x) => x.id === s.id).where, /Decided provisionally by Person A's builder for Person B: TSP first/)
    } finally { await r.stop() }
  })
})
