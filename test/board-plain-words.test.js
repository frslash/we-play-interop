// The board hears plain words (src/server/facilitator.js): most agents have no step tool, and people decide in the open.
// A decision given anywhere by the person a step waits on clears the wait; a plain "no" from whoever has a step moves it
// on (to the builder, when the line names it); the round's model judges the less plain cases (answered, declined,
// handed to someone) and a goal's done-test revised by its own side.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { NAME_OF, TYPES, signedDocument } from '../src/shared/types.js'
import { config as baseConfig } from '../src/server/config.js'
import { Facilitator, REFUSES } from '../src/server/facilitator.js'
import { createApp } from '../src/server/index.js'
import { createResolver } from '../src/server/resolver.js'
import { concerns } from '../src/server/views.js'
import { closeVotes } from '../src/server/votes.js'

const BOARD = { generated: new Date().toISOString().slice(0, 10), projects: [], scenarios: [], runs: [] }
const FIRE = 'https://api.anthropic.com/v1/claude_code/routines/trig_builder_2/fire'
const MIN = 60_000

async function room () {
  const dir = mkdtempSync(join(tmpdir(), 'wpi-plain-'))
  const fired = []
  const config = { ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, githubToken: '', weaverIntervalMinutes: 0, weaverQuietMinutes: 0, ratePerMinute: 1000, voteMinutes: 10, publicUrl: 'https://interop.example', boardDataUrl: 'data:application/json,' + encodeURIComponent(JSON.stringify(BOARD)), llm: { ...baseConfig.llm, provider: 'openai', apiKey: '' } }
  const ctx = await createApp(config, { resolver: createResolver(), hostWelcomeMs: null, wakeFetch: async (url, init) => { fired.push(JSON.parse(init.body)); return { ok: true, status: 200 } }, gh: async () => [] })
  await new Promise((r) => ctx.server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${ctx.server.address().port}`
  await ctx.board.refresh()
  ctx.weaver.llm = { configured: false }
  const postDoc = async (doc) => { const r = await fetch(`${base}/api/entries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(doc) }); return { status: r.status, body: await r.json() } }
  const send = (id, name, payload, extra) => postDoc(signedDocument(id, { type: TYPES[name], payload, ...extra }))
  const exp = new Date(Date.now() + 86400000).toISOString()
  const people = {}, agents = {}, dels = {}
  for (const [k, name, label] of [['a', 'Person A', 'North Agent'], ['b', 'Person B', 'South Agent'], ['c', 'Person C', 'East Agent']]) {
    people[k] = newIdentity(); agents[k] = newIdentity()
    await send(people[k], 'join', { name })
    dels[k] = (await send(people[k], 'delegate', { delegate: agents[k].did, scope: ['note', 'propose', 'vote'], label }, { expiresAt: exp })).body.hash
  }
  const builder = (await send(people.a, 'host', { label: 'Builder' })).body.hosted.did
  await send(people.a, 'delegate', { delegate: builder, scope: ['note', 'propose'], label: 'Builder' }, { expiresAt: exp })
  await ctx.waker.set(builder, `${FIRE}#token=t`, ['direct'])
  const as = (k, name, payload, extra) => send(agents[k], name, payload, { onBehalfOf: people[k].did, delegation: dels[k], ...extra })
  const say = (k, text, extra) => as(k, 'note', { text, kind: 'message' }, extra)
  await ctx.facilitator.tick()
  const st = () => ctx.log.state
  const stepFrom = (h) => [...st().steps.values(), ...st().stepsDone].find((s) => s.from === h)
  const agree = async (k, title, voter) => { const pr = (await as(k, 'propose', { kind: 'other', title })).body.hash; await as(voter, 'vote', { proposal: pr, choice: 'for' }); await closeVotes(ctx, Date.now() + 11 * MIN, { max: 10 }); return pr }
  const goal2 = async () => { const g = (await send(people.a, 'propose', { kind: 'goal', title: 'Goal 2: the room moves onto encrypted spaces its people hold' })).body.hash; await send(people.a, 'vote', { proposal: g, choice: 'for' }); await ctx.facilitator.tick(); return g }
  const at = (m) => Date.now() + m * MIN
  const stop = async () => { await ctx.stop(); rmSync(dir, { recursive: true, force: true }) }
  return { ctx, send, as, say, people, agents, builder, fired, st, stepFrom, agree, goal2, at, stop }
}

describe('the board hears plain words', () => {
  test('a choice a step waits on is the agents’ to make, unless it is held for its person: an answer in its thread clears it (after a restart too), and older choices put to a person move to the agents', async () => {
    const r = await room()
    try {
      const g = await r.goal2()
      const five = () => r.ctx.facilitator.testOf(g).find((x) => x.test.n === 5)
      // check (5) costs money and names no one; it has no owner yet, so it is held for the goal's proposer, Person A
      assert.equal(five().waitingOn.who, r.people.a.did, 'held for the step’s person: no owner, so its proposer'); assert.equal(five().waitingOn.held, 'money')
      await r.send(r.people.b, 'note', { text: 'the permanent domain should be inwove.org', kind: 'message' })
      await r.ctx.facilitator.tick()
      assert.ok(five().waitingOn, 'talk elsewhere is not the answer')
      // held for Person A: no agent settles it, not even Person A's own; Person A's own line does
      await r.say('a', 'inwove.org: it is bought and already reaches the room.', { threadId: five().thread })
      await r.ctx.facilitator.tick()
      assert.ok(five().waitingOn, 'an agent’s answer is only a suggestion')
      await r.send(r.people.a, 'note', { text: 'inwove.org: it is bought and already reaches the room.', kind: 'message' }, { threadId: five().thread })
      await r.ctx.facilitator.tick()
      assert.equal(five().waitingOn, undefined); assert.equal(five().change, 'answered')
      // an older step that still waits on a person: after a restart it goes to the agents, in one line that wakes them
      const s3 = r.ctx.facilitator.testOf(g).find((x) => x.test.n === 3)
      await r.ctx.facilitator.write(s3, { waitingOn: { who: r.people.a.did, decision: 'which group library to use' } }, 'waiting', null)
      r.ctx.facilitator = new Facilitator({ ctx: r.ctx })
      await r.ctx.facilitator.tick()
      assert.equal(r.ctx.facilitator.testOf(g).find((x) => x.test.n === 3).waitingOn.who, null)
      const line = r.ctx.log.entries.filter((e) => e.document.payload.facilitator?.what === 'decide').at(-1)
      assert.match(line.document.payload.text, /The agents decide them now[\s\S]*which group library to use\?/)
      assert.ok(!/Person A/.test(line.document.payload.text), 'names no person')
      assert.equal(concerns(r.ctx, line, r.agents.b.did), 'ask', 'it wakes the agents')
      assert.equal(concerns(r.ctx, line, r.people.a.did), null, 'and no person')
    } finally { await r.stop() }
    // an answer the room read past without knowing, then a restart
    const q = await room()
    try {
      const g = await q.goal2()
      const f = q.ctx.facilitator, five = f.testOf(g).find((x) => x.test.n === 5)
      const answer = (await q.send(q.people.a, 'note', { text: 'decided: inwove.org', kind: 'message' }, { threadId: five.thread })).body
      f.heard = answer.seq // as if an older board had read past it without knowing
      await f.tick()
      assert.ok(f.testOf(g).find((x) => x.test.n === 5).waitingOn, 'not heard yet')
      q.ctx.facilitator = new Facilitator({ ctx: q.ctx }) // the room restarts
      await q.ctx.facilitator.tick()
      assert.equal(q.ctx.facilitator.testOf(g).find((x) => x.test.n === 5).waitingOn, undefined)
    } finally { await q.stop() }
  })

  test('a plain no from whoever has a step moves it on; one that names the builder hands it to the builder, which starts it', async () => {
    const r = await room()
    try {
      assert.ok(REFUSES.test('No, I won’t take this one.')); assert.ok(REFUSES.test('I can’t take this: no host here')); assert.ok(!REFUSES.test('Not yet, still running the tests'))
      const p1 = await r.agree('b', 'Run the host-move test twice', 'c')
      await r.ctx.facilitator.tick(r.at(11))
      const s1 = r.stepFrom(p1)
      assert.equal(s1.owner, r.agents.b.did)
      await r.say('b', 'On it, I will report soon.', { threadId: s1.thread })
      await r.ctx.facilitator.tick(r.at(12))
      assert.equal(r.stepFrom(p1).owner, r.agents.b.did, 'not a no')
      await r.say('b', 'No, I can’t take this: I don’t run a room host.', { threadId: s1.thread })
      await r.ctx.facilitator.tick(r.at(13))
      const after = r.stepFrom(p1)
      assert.equal(after.owner, undefined); assert.equal(after.previousOwner, r.agents.b.did)
      assert.ok([r.agents.a.did, r.agents.c.did].includes(after.offeredTo), 'offered to another agent')
      const p2 = await r.agree('c', 'Stand up the community on the permanent domain', 'b')
      await r.ctx.facilitator.tick(r.at(14))
      const s2 = r.stepFrom(p2)
      await r.say('c', 'I won’t take this one; the builder should own it, since it is already standing up the host.', { threadId: s2.thread })
      await r.ctx.facilitator.tick(r.at(15))
      assert.equal(r.stepFrom(p2).owner, r.builder, 'handed to the builder')
      await r.ctx.facilitator.tick(r.at(16))
      assert.ok(r.fired.some((b) => b.text?.includes(`JOB step: ${s2.id}`)), 'and the board started it')
    } finally { await r.stop() }
  })

  test('the round’s model judges the less plain ones: answered, declined and handed to someone, each only by whoever may', async () => {
    const r = await room()
    try {
      const g = await r.goal2()
      const p1 = await r.agree('b', 'Write up the carrier test', 'c')
      await r.ctx.facilitator.tick(r.at(11))
      const s1 = r.stepFrom(p1), five = r.ctx.facilitator.testOf(g).find((x) => x.test.n === 5)
      // the goal's own person answers (their own agent could not: the deciding agent belongs to another person than the step's)
      const decided = (await r.send(r.people.a, 'note', { text: 'Settled: we use the one I bought tonight.', kind: 'message' })).body.hash
      const passOn = (await r.say('b', 'This one is really East Agent’s area, they wrote the carrier.')).body.hash
      const stranger = (await r.say('c', 'Give check 5 to me.')).body.hash
      const moves = [{ entry: decided, step: five.id, kind: 'answered' }, { entry: passOn, step: s1.id, kind: 'declined', to: r.agents.c.did }, { entry: stranger, step: five.id, kind: 'handTo', to: r.agents.c.did }, { entry: 'f'.repeat(64), step: s1.id, kind: 'declined' }]
      r.ctx.weaver.llm = { configured: true, model: 'test/model', chat: async () => ({ model: 'test/model', latencyMs: 1, usage: {}, finishReason: 'stop', jsonMode: true, content: JSON.stringify({ heard: [], threads: [], agreements: [], conflicts: [], next: [], moves }) }) }
      const round = (await r.ctx.weaver.round()).document.payload
      assert.equal(round.facilitate.moved.length, 2)
      assert.equal(r.ctx.facilitator.testOf(g).find((x) => x.test.n === 5).waitingOn, undefined, 'answered by its person')
      assert.equal(r.stepFrom(p1).offeredTo, r.agents.c.did, 'declined, and offered where it said')
      assert.equal(r.ctx.facilitator.testOf(g).find((x) => x.test.n === 5).offeredTo, undefined, 'someone it is not with cannot hand it to themselves')
    } finally { await r.stop() }
  })

  test('a done-test revised by its goal’s own side: unchanged checks keep their progress, new ones open, dropped ones leave; no one else can revise it', async () => {
    const r = await room()
    try {
      const g = await r.goal2()
      const f = r.ctx.facilitator, old = f.testOf(g)
      await r.as('b', 'note', { text: 'mine', kind: 'message', step: { of: old[2].id, say: 'claim' } }, { threadId: old[2].thread })
      await f.tick()
      const checks = [old[4].title, 'The room’s shared talk lives in an encrypted community room.', old[0].title, old[2].title]
      const answer = (entries) => ({ heard: [], threads: [], agreements: [], conflicts: [], next: [], revisedTest: { goal: g, checks, entries } })
      const someone = (await r.say('c', 'Reorder Goal 2: domain first, then shared talk, notebooks, MLS.')).body.hash
      r.ctx.weaver.llm = { configured: true, model: 'test/model', chat: async () => ({ model: 'test/model', latencyMs: 1, usage: {}, finishReason: 'stop', jsonMode: true, content: JSON.stringify(answer([someone])) }) }
      await r.ctx.weaver.round()
      assert.deepEqual(f.testOf(g).map((s) => s.id), old.map((s) => s.id), 'another person’s side cannot revise it')
      const mine = (await r.say('a', 'Yes: reorder Goal 2 like that, domain first.')).body.hash
      r.ctx.weaver.llm.chat = async () => ({ model: 'test/model', latencyMs: 1, usage: {}, finishReason: 'stop', jsonMode: true, content: JSON.stringify(answer([someone, mine])) })
      await r.ctx.weaver.round()
      const now = f.testOf(g)
      assert.deepEqual(now.map((s) => s.title), checks)
      assert.deepEqual(now.map((s) => s.test.n), [1, 2, 3, 4])
      assert.equal(now[0].id, old[4].id, 'the domain check kept its step'); assert.equal(now[3].id, old[2].id)
      assert.equal(now[3].owner, r.agents.b.did, 'and its progress'); assert.equal(now[3].state, 'claimed')
      assert.ok(!r.st().steps.has(old[1].id), 'a dropped check leaves the board')
      assert.match(r.ctx.log.entries.filter((e) => e.document.payload.facilitator?.what === 'revised').at(-1).document.payload.text, /revised as Person A's side agreed\. 4 checks/)
    } finally { await r.stop() }
  })
})
