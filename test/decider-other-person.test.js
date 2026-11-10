// Step 189c1171 (changes #59): an unheld choice is settled by a person, or provisionally by the step's own person's
// agent (any person can reopen it); an agent of another person alone can't settle it. A choice that names no one is
// held for the step's owner's person, also when that person proposed it (with no owner, for its proposer: test/held-no-owner.test.js). Only a clear disagreement, or a person's
// plain new answer, reopens a decision, a limited number of times for agents (src/server/facilitator.js).
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { NAME_OF, TYPES, signedDocument } from '../src/shared/types.js'
import { config as baseConfig } from '../src/server/config.js'
import { branchOf } from '../src/server/builder.js'
import { DISAGREES, MAX_REOPENS, decided, mayDecide } from '../src/server/facilitator.js'
import { createApp } from '../src/server/index.js'
import { createResolver } from '../src/server/resolver.js'
import { closeVotes } from '../src/server/votes.js'

const BOARD = { generated: new Date().toISOString().slice(0, 10), projects: [], scenarios: [], runs: [] }
const FIRE = 'https://api.anthropic.com/v1/claude_code/routines/trig_builder_1/fire'
const MIN = 60_000

async function room () {
  const dir = mkdtempSync(join(tmpdir(), 'wpi-decider-'))
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

describe('what reopens a decision', () => {
  test('a clear disagreement does; praise, thanks or a negated disagreement does not', () => {
    for (const t of ['I disagree: DIDComm first', 'Disagree, Geb speaks DIDComm', 'I object to that', 'No, use DIDComm first', 'That’s wrong, it is DIDComm', 'Let’s not do TSP first', 'I don’t agree with TSP first', 'Reopen this, please', 'Not parked, the domain is bought']) assert.ok(DISAGREES.test(t), t)
    for (const t of ['Nice work', 'I don’t disagree', 'I don\'t disagree with that', 'Not that I disagree', 'Good, no objection', 'Thanks!', 'No worries', 'Nobody disagrees']) assert.ok(!DISAGREES.test(t), t)
  })
})

describe('who settles a choice that is not held', () => {
  test('Person C’s agent alone does not settle Person A’s unheld choice, in the thread or through the round; Person A’s own agent does, provisionally, and any person can reopen it', async () => {
    const r = await room()
    try {
      const f = r.ctx.facilitator
      const p = await blockOn(r, 'Run the carrier test', `${CARRIER}?`)
      let s = r.stepFrom(p)
      assert.equal(s.owner, r.builder, 'Person A’s step (their builder has it)'); assert.equal(s.waitingOn.who, null, 'not held')
      assert.match(r.said('decide').at(-1).payload.text, /another person’s agent alone can only suggest/)
      // East Agent (Person C's) answers: only a suggestion
      const other = (await r.as('c', 'note', { text: 'TSP first, because RLTP already carries it.', kind: 'message' }, { threadId: s.thread })).body.hash
      await f.tick(r.at(17))
      assert.ok(r.stepFrom(p).waitingOn, 'Person C’s agent alone does not settle it in the thread')
      roundSays(r, [{ entry: other, step: s.id, kind: 'answered' }])
      assert.equal((await r.ctx.weaver.round()).document.payload.facilitate.moved.length, 0, 'nor through the round')
      assert.ok(r.stepFrom(p).waitingOn); assert.equal(r.said('decided').length, 0)
      assert.equal(mayDecide(r.st(), r.agents.c.did, s), false); assert.equal(mayDecide(r.st(), r.builder, s), true); assert.equal(mayDecide(r.st(), r.people.c.did, s), true)
      // the builder (Person A's own agent) answers: decided, provisionally
      await builderSays(r, 'TSP first, because RLTP already carries it.', s.thread)
      await f.tick(r.at(18))
      s = r.stepFrom(p)
      assert.equal(s.waitingOn, undefined); assert.equal(s.decision.by, r.builder); assert.equal(s.decision.provisional, true)
      assert.match(r.said('decided').at(-1).payload.text, /^Decided provisionally by Person A's builder[\s\S]*Any person can reopen it/)
      assert.equal(r.ctx.facilitator.view().steps.find((x) => x.id === s.id).decision.provisional, true)
      // any person (here Person C, neither the step's nor its proposer) reopens it by disagreeing
      await r.send(r.people.c, 'note', { text: 'I disagree: DIDComm first, because Geb speaks it.', kind: 'message' }, { threadId: s.thread })
      await f.tick(r.at(19))
      s = r.stepFrom(p)
      assert.ok(s.waitingOn, 'reopened'); assert.equal(s.reopens, 1); assert.equal(r.said('reopened').length, 1)
      // another person's line on Person A's step settles it only provisionally (step 18a6010b); Person A's own is not provisional
      await r.send(r.people.c, 'note', { text: 'DIDComm first, because Geb speaks it.', kind: 'message' }, { threadId: s.thread })
      await f.tick(r.at(20))
      s = r.stepFrom(p)
      assert.equal(s.decision.by, r.people.c.did); assert.equal(s.decision.provisional, true)
    } finally { await r.stop() }
  })
})

describe('a held choice', () => {
  test('a held choice is settled only by its person’s own plain line, not by their agent', async () => {
    const r = await room()
    try {
      const f = r.ctx.facilitator
      const p = await blockOn(r, 'Publish the room’s DID document', `${KEY}?`)
      let s = r.stepFrom(p)
      assert.deepEqual({ who: s.waitingOn.who, held: s.waitingOn.held }, { who: r.people.a.did, held: 'keys' }, 'held for the owner’s person (the builder’s), not the proposer')
      await builderSays(r, 'Use a new key kept offline, because the room’s key is online.', s.thread)
      await r.send(r.people.b, 'note', { text: 'Use the room’s own key, because it already signs the log.', kind: 'message' }, { threadId: s.thread })
      await f.tick(r.at(17))
      assert.ok(r.stepFrom(p).waitingOn, 'neither the person’s own agent nor the proposer settles it')
      await r.send(r.people.a, 'note', { text: 'Use a new key kept offline, because the room’s key is online.', kind: 'message' }, { threadId: s.thread })
      await f.tick(r.at(18))
      s = r.stepFrom(p)
      assert.equal(s.decision.by, r.people.a.did); assert.equal(s.decision.for, r.people.a.did)
    } finally { await r.stop() }
  })

  test('a choice that names no one is held for the step’s person (owner, else proposer), also when the owner proposed it; one that names a person is held for them', async () => {
    const r = await room()
    try {
      const f = r.ctx.facilitator, p = await r.agreeForBuilder('Publish the room’s DID document') // proposed for Person B
      assert.deepEqual(f.holdOf({ owner: r.builder, from: p }, KEY), { who: r.people.a.did, held: 'keys' })
      assert.deepEqual(f.holdOf({ owner: r.agents.b.did, from: p }, KEY), { who: r.people.b.did, held: 'keys' }, 'the owner is the proposer’s own agent: the hold stays, for Person B')
      assert.deepEqual(f.holdOf({ owner: r.people.b.did, from: p }, KEY), { who: r.people.b.did, held: 'keys' }, 'the owner is the proposer themself: the hold stays')
      assert.deepEqual(f.holdOf({ from: p }, KEY), { who: r.people.b.did, held: 'keys' }, 'no owner: held for the proposer')
      assert.deepEqual(f.holdOf({ owner: r.builder, from: p }, 'whether Person C pays for the domain'), { who: r.people.c.did, held: 'money' })
      assert.equal(f.holdOf({ owner: r.builder, from: p }, CARRIER), null, 'touches nobody')
    } finally { await r.stop() }
  })
})

describe('only a clear disagreement or a person’s plain line reopens a decision, a limited number of times', () => {
  test('"Nice work" and "I don’t disagree" don’t reopen; a disagreement or a person’s new answer does, and agents only twice', async () => {
    const r = await room()
    try {
      const f = r.ctx.facilitator
      const p = await blockOn(r, 'Run the carrier test', `${CARRIER}?`)
      const thread = r.stepFrom(p).thread
      let t = 17
      const tick = () => f.tick(r.at(t++))
      const settle = async () => { await builderSays(r, 'TSP first, because RLTP already carries it.', thread); await tick(); assert.ok(decided(r.stepFrom(p)), 'decided') }
      await settle()
      for (const [who, text] of [['person', 'Nice work'], ['agent', 'I don’t disagree'], ['agent', 'Nice work, thanks'], ['person', 'I don’t disagree'], ['person', 'Thanks, that works for me']]) {
        if (who === 'person') await r.send(r.people.b, 'note', { text, kind: 'message' }, { threadId: thread })
        else await r.as('b', 'note', { text, kind: 'message' }, { threadId: thread })
        await tick()
        assert.ok(decided(r.stepFrom(p)), `“${text}” from a ${who} does not reopen it`)
      }
      assert.equal(r.said('reopened').length, 0)
      // a person's plain line that answers differently reopens it
      await r.send(r.people.b, 'note', { text: 'DIDComm first, because Geb speaks it.', kind: 'message' }, { threadId: thread })
      await tick()
      let s = r.stepFrom(p)
      assert.ok(s.waitingOn); assert.equal(s.reopens, 1); assert.equal(r.said('reopened').length, 1)
      // agents' disagreements: up to the limit
      await settle()
      await r.as('b', 'note', { text: 'I disagree: DIDComm first.', kind: 'message' }, { threadId: thread }); await tick()
      assert.equal(r.stepFrom(p).reopens, MAX_REOPENS); assert.ok(r.stepFrom(p).waitingOn)
      await settle()
      await r.as('b', 'note', { text: 'I disagree: DIDComm first.', kind: 'message' }, { threadId: thread }); await tick()
      assert.ok(decided(r.stepFrom(p)), 'past the limit an agent can’t reopen it'); assert.equal(r.said('reopened').length, MAX_REOPENS)
      // a person still can
      await r.send(r.people.b, 'note', { text: 'I disagree, DIDComm first.', kind: 'message' }, { threadId: thread }); await tick()
      s = r.stepFrom(p)
      assert.ok(s.waitingOn); assert.equal(s.reopens, MAX_REOPENS + 1)
    } finally { await r.stop() }
  })
})
