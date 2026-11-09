// Step 18a6010b (changes #65): a keys or money choice on a step no person has (no human owner or proposer: the weaver
// opened it) stays held for the room's people: no agent settles it, only a person's own line does. And a person who
// decides a choice on someone else's step settles it only provisionally: the step's own person can reopen it
// (src/server/facilitator.js: holdOf, decide, reopen).
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { NAME_OF, TYPES, signedDocument } from '../src/shared/types.js'
import { config as baseConfig } from '../src/server/config.js'
import { branchOf } from '../src/server/builder.js'
import { Facilitator, ownerPerson, proposerOf } from '../src/server/facilitator.js'
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

const KEY = 'Which key signs the room’s DID document'
const MONEY = 'Which domain the room pays for'
const CARRIER = 'Which carrier the room tests first, TSP or DIDComm'
const roundSays = (r, moves) => { r.ctx.weaver.llm = { configured: true, model: 'test/model', chat: async () => ({ model: 'test/model', latencyMs: 1, usage: {}, finishReason: 'stop', jsonMode: true, content: JSON.stringify({ heard: [], threads: [], agreements: [], conflicts: [], next: [], moves }) }) } }
const builderSays = (r, text, threadId) => r.ctx.builder.say(r.builder, { text, kind: 'message' }, { threadId })
// a step the weaver opened on its own: no owner, no agreement or goal of a person behind it, then a choice it waits on
const weaverStep = async (r, title, needs) => {
  const f = r.ctx.facilitator
  const s = await f.write(null, { title, done: 'Post the result in this step’s thread.', state: 'open' }, 'opened', null)
  await f.escalate(s, null, needs, null, f.holdOf(s, needs))
  return s.id
}

describe('a keys or money choice on a step the weaver opened', () => {
  test('stays held for the room’s people: no agent settles it, in the thread, through the round or after a restart; a person’s own line does', async () => {
    const r = await room()
    try {
      const ids = [await weaverStep(r, 'Publish the room’s DID document', KEY), await weaverStep(r, 'Give the room a domain of its own', MONEY)]
      const steps = () => ids.map((id) => r.ctx.facilitator.steps().find((s) => s.id === id) ?? r.st().stepsDone.find((s) => s.id === id))
      for (const [s, what] of steps().map((s, i) => [s, ['keys', 'money'][i]])) {
        assert.equal(s.owner ?? null, null); assert.equal(ownerPerson(r.st(), s), null); assert.equal(proposerOf(r.st(), s), null, 'no person has it')
        assert.deepEqual({ who: s.waitingOn.who, held: s.waitingOn.held }, { who: null, held: what }, `the ${what} choice is held, for no one person`)
      }
      const asks = r.said('decide').slice(-2).map((d) => d.payload.text)
      for (const t of asks) assert.match(t, /^A choice held for the room’s people: [\s\S]*waits for a person here[\s\S]*Agents can suggest options here, but can’t settle it/)
      assert.match(r.ctx.facilitator.where(steps()[0]), /Held for the room’s people: it touches keys, and only a person settles it/)
      // every kind of agent answers, in each thread: none settles it
      const [keys, money] = steps(), heard = []
      for (const [k, text, s] of [['b', 'Use a new key kept offline, because the room’s key is online.', keys], ['c', 'Use the room’s own key, it already signs the log.', keys], ['b', 'inwove.org: it is bought and already reaches the room.', money], ['c', 'interop.example: it is cheaper.', money]]) heard.push([(await r.as(k, 'note', { text, kind: 'message' }, { threadId: s.thread })).body.hash, s])
      await builderSays(r, 'Use the room’s own key.', keys.thread)
      await builderSays(r, 'Pay for inwove.org.', money.thread)
      await r.ctx.facilitator.tick(r.at(2))
      for (const s of steps()) { assert.ok(s.waitingOn?.held, 'an agent’s answer is only a suggestion'); assert.equal(s.decision ?? null, null) }
      // the round's model calls the agents' lines answers: still nothing is settled
      roundSays(r, heard.map(([entry, s]) => ({ entry, step: s.id, kind: 'answered' })))
      await r.ctx.weaver.round()
      for (const s of steps()) { assert.ok(s.waitingOn?.held, 'still held'); assert.equal(s.decision ?? null, null) }
      assert.equal(r.said('decided').length, 0, 'no agent’s line was recorded as a decision')
      // after a restart it is still held, and no agent's line settles it
      r.ctx.facilitator = new Facilitator({ ctx: r.ctx })
      await r.ctx.facilitator.tick(r.at(3))
      await r.as('c', 'note', { text: 'Use the room’s own key, because it already signs the log.', kind: 'message' }, { threadId: keys.thread })
      await r.ctx.facilitator.tick(r.at(4))
      for (const [s, what] of steps().map((s, i) => [s, ['keys', 'money'][i]])) { assert.deepEqual({ who: s.waitingOn?.who, held: s.waitingOn?.held }, { who: null, held: what }, 'held after a restart'); assert.equal(s.decision ?? null, null) }
      // a person's own line settles it, and not provisionally: no person has the step, so it is the room's people's
      await r.send(r.people.c, 'note', { text: 'Use a new key kept offline, because the room’s key is online.', kind: 'message' }, { threadId: keys.thread })
      await r.send(r.people.b, 'note', { text: 'inwove.org: it is bought and already reaches the room.', kind: 'message' }, { threadId: money.thread })
      await r.ctx.facilitator.tick(r.at(5))
      const [k2, m2] = steps()
      assert.equal(k2.waitingOn, undefined); assert.equal(k2.decision.by, r.people.c.did); assert.equal(k2.decision.held, 'keys'); assert.equal(k2.decision.provisional, false)
      assert.equal(m2.waitingOn, undefined); assert.equal(m2.decision.by, r.people.b.did); assert.equal(m2.decision.held, 'money'); assert.equal(m2.decision.provisional, false)
      // reopened, it is held for the room's people again: an agent still can't settle it
      await r.send(r.people.b, 'note', { text: 'I disagree: use the room’s own key.', kind: 'message' }, { threadId: keys.thread })
      await r.ctx.facilitator.tick(r.at(6))
      assert.deepEqual({ who: steps()[0].waitingOn?.who, held: steps()[0].waitingOn?.held }, { who: null, held: 'keys' }, 'reopened, still held')
      await r.as('b', 'note', { text: 'Use the room’s own key, because it already signs the log.', kind: 'message' }, { threadId: keys.thread })
      await r.ctx.facilitator.tick(r.at(7))
      assert.ok(steps()[0].waitingOn, 'an agent still can’t settle it')
    } finally { await r.stop() }
  })

  test('a time or name choice on such a step still goes to the agents', async () => {
    const r = await room()
    try {
      const f = r.ctx.facilitator
      assert.equal(f.holdOf({}, 'Which hours the room keeps its weekly call'), null)
      assert.deepEqual(f.holdOf({}, KEY), { who: null, held: 'keys' })
      assert.deepEqual(f.holdOf({}, MONEY), { who: null, held: 'money' })
    } finally { await r.stop() }
  })
})

const blockOn = async (r, title, needs) => {
  const f = r.ctx.facilitator, p = await r.agreeForBuilder(title)
  await f.tick(r.at(11)); await f.tick(r.at(12))
  const s = r.stepFrom(p)
  r.pulls.push({ number: 40 + r.pulls.length, title: `Blocked: ${title}`, body: `Needs: ${needs}\nWhy: it needs a choice.\nFrom: any agent here`, html_url: 'https://github.com/example/room/pull/40', head: { ref: branchOf(s), sha: 'e'.repeat(40) } })
  await f.tick(r.at(15)); await f.tick(r.at(16))
  return p
}

describe('a person deciding on someone else’s step', () => {
  test('counts only provisionally, shows as “provisionally”, and the step’s own person can reopen it and settle it', async () => {
    const r = await room()
    try {
      const f = r.ctx.facilitator
      const p = await blockOn(r, 'Run the carrier test', `${CARRIER}?`)
      let s = r.stepFrom(p)
      assert.equal(s.owner, r.builder, 'Person A’s step (their builder has it)'); assert.equal(s.waitingOn.who, null); assert.ok(!s.waitingOn.held)
      // Person C (not the step's person) decides: provisional
      await r.send(r.people.c, 'note', { text: 'TSP first, because RLTP already carries it.', kind: 'message' }, { threadId: s.thread })
      await f.tick(r.at(17))
      s = r.stepFrom(p)
      assert.equal(s.waitingOn, undefined); assert.equal(s.decision.by, r.people.c.did); assert.equal(s.decision.provisional, true)
      assert.match(r.said('decided').at(-1).payload.text, /^Decided provisionally by Person C[\s\S]*It’s Person A’s step, so Person A can reopen it by disagreeing here/)
      assert.match(f.where(s), /Decided provisionally by Person C/)
      assert.equal(f.view().steps.find((x) => x.id === s.id).decision.provisional, true)
      // the step's own person reopens it by disagreeing, and their own answer then settles it, not provisionally
      await r.send(r.people.a, 'note', { text: 'I disagree: DIDComm first, because Geb speaks it.', kind: 'message' }, { threadId: s.thread })
      await f.tick(r.at(18))
      s = r.stepFrom(p)
      assert.ok(s.waitingOn, 'reopened by the step’s own person'); assert.equal(s.decision ?? null, null); assert.equal(r.said('reopened').length, 1)
      await r.send(r.people.a, 'note', { text: 'DIDComm first, because Geb speaks it.', kind: 'message' }, { threadId: s.thread })
      await f.tick(r.at(19))
      s = r.stepFrom(p)
      assert.equal(s.decision.by, r.people.a.did); assert.equal(s.decision.provisional, false, 'the step’s own person’s line is not provisional')
      assert.doesNotMatch(r.said('decided').at(-1).payload.text, /provisionally/)
    } finally { await r.stop() }
  })

  test('the step’s own person can reopen another person’s decision with a plain different answer', async () => {
    const r = await room()
    try {
      const f = r.ctx.facilitator
      const p = await blockOn(r, 'Run the carrier test', `${CARRIER}?`)
      let s = r.stepFrom(p)
      await r.send(r.people.c, 'note', { text: 'TSP first, because RLTP already carries it.', kind: 'message' }, { threadId: s.thread })
      await f.tick(r.at(17))
      assert.equal(r.stepFrom(p).decision.provisional, true)
      await r.send(r.people.a, 'note', { text: 'DIDComm first, because Geb speaks it.', kind: 'message' }, { threadId: s.thread })
      await f.tick(r.at(18))
      s = r.stepFrom(p)
      assert.equal(r.said('reopened').length, 1, 'Person A’s different answer reopens it')
      await f.tick(r.at(19))
      s = r.stepFrom(p)
      assert.ok(s.waitingOn, 'it waits on the choice again'); assert.equal(s.decision ?? null, null)
      await r.send(r.people.a, 'note', { text: 'DIDComm first, because Geb speaks it.', kind: 'message' }, { threadId: s.thread })
      await f.tick(r.at(20))
      s = r.stepFrom(p)
      assert.equal(s.decision.by, r.people.a.did); assert.equal(s.decision.provisional, false)
    } finally { await r.stop() }
  })
})
