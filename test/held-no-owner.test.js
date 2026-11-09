// Step 74d0cde7 (fixes #62): a choice that touches a person's keys or money, on a step nobody owns, is held for the
// step's person: its owner's, else its proposer's. No agent settles it, not even the proposer's own; only the
// proposer's own plain line does (src/server/facilitator.js, holdOf).
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { NAME_OF, TYPES, signedDocument } from '../src/shared/types.js'
import { config as baseConfig } from '../src/server/config.js'
import { Facilitator } from '../src/server/facilitator.js'
import { createApp } from '../src/server/index.js'
import { createResolver } from '../src/server/resolver.js'
import { closeVotes } from '../src/server/votes.js'

const BOARD = { generated: new Date().toISOString().slice(0, 10), projects: [], scenarios: [], runs: [] }
const FIRE = 'https://api.anthropic.com/v1/claude_code/routines/trig_builder_1/fire'
const MIN = 60_000

async function room () {
  const dir = mkdtempSync(join(tmpdir(), 'wpi-held-no-owner-'))
  const pulls = []
  const wakeFetch = async () => ({ ok: true, status: 200 })
  const gh = async (method, path) => (method === 'GET' && path.includes('/pulls?') ? pulls : {})
  const config = { ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, githubToken: '', weaverIntervalMinutes: 0, weaverQuietMinutes: 0, ratePerMinute: 1000, voteMinutes: 10, workspaceRepo: 'example/room', publicUrl: 'https://interop.example', boardDataUrl: 'data:application/json,' + encodeURIComponent(JSON.stringify(BOARD)), llm: { ...baseConfig.llm, provider: 'openai', apiKey: '' } }
  const ctx = await createApp(config, { resolver: createResolver(), hostWelcomeMs: null, wakeFetch, gh })
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

const KEY = 'Which key signs the room’s DID document'
const MONEY = 'Which domain the room pays for'
const roundSays = (r, moves) => { r.ctx.weaver.llm = { configured: true, model: 'test/model', chat: async () => ({ model: 'test/model', latencyMs: 1, usage: {}, finishReason: 'stop', jsonMode: true, content: JSON.stringify({ heard: [], threads: [], agreements: [], conflicts: [], next: [], moves }) }) } }

describe('a keys or money choice on a step with no owner stays held for its proposer', () => {
  test('no agent settles it, not the proposer’s own, another person’s or the builder, in the thread, through the round or after a restart; the proposer’s own line does', async () => {
    const r = await room()
    try {
      const g = (await r.send(r.people.b, 'propose', { kind: 'goal', title: 'Goal 3: the room has a home of its own' })).body.hash
      await r.send(r.people.b, 'vote', { proposal: g, choice: 'for' })
      const f = r.ctx.facilitator
      await f.openTest(r.st().proposals.get(g), [{ text: 'The room’s DID document is published', needs: KEY }, { text: 'The room answers at its own domain', needs: MONEY }])
      await f.tick(r.at(1))
      const steps = () => r.ctx.facilitator.testOf(g)
      const [keys, money] = steps()
      for (const [s, what] of [[keys, 'keys'], [money, 'money']]) {
        assert.equal(s.owner ?? null, null, 'nobody owns it')
        assert.deepEqual({ who: s.waitingOn.who, held: s.waitingOn.held }, { who: r.people.b.did, held: what }, `the ${what} choice is held for the proposer, Person B`)
      }
      // every kind of agent answers in each thread: none settles it
      const lines = [
        ['b', 'Use a new key kept offline, because the room’s key is online.', keys], ['c', 'Use the room’s own key, it already signs the log.', keys],
        ['b', 'inwove.org: it is bought and already reaches the room.', money], ['c', 'interop.example: it is cheaper.', money],
      ]
      const heard = []
      for (const [k, text, s] of lines) heard.push([(await r.as(k, 'note', { text, kind: 'message' }, { threadId: s.thread })).body.hash, s])
      await r.ctx.builder.say(r.builder, { text: 'Use the room’s own key.', kind: 'message' }, { threadId: keys.thread })
      await r.ctx.builder.say(r.builder, { text: 'Pay for inwove.org.', kind: 'message' }, { threadId: money.thread })
      await f.tick(r.at(2))
      for (const s of steps()) { assert.ok(s.waitingOn, 'an agent’s answer is only a suggestion'); assert.equal(s.decision ?? null, null) }
      // the round's model calls the agents' lines answers: still nothing is settled
      roundSays(r, heard.map(([entry, s]) => ({ entry, step: s.id, kind: 'answered' })))
      await r.ctx.weaver.round()
      for (const s of steps()) { assert.equal(s.waitingOn?.who, r.people.b.did, 'still held for Person B'); assert.equal(s.decision ?? null, null) }
      // after a restart it is still held for the proposer, and no agent's line settles it
      r.ctx.facilitator = new Facilitator({ ctx: r.ctx })
      await r.ctx.facilitator.tick(r.at(3))
      for (const s of steps()) { assert.equal(s.waitingOn?.who, r.people.b.did, 'held after a restart'); assert.equal(s.decision ?? null, null) }
      // another person's own line doesn't settle it either; the proposer's own line does
      await r.send(r.people.c, 'note', { text: 'Use the room’s own key, it already signs the log.', kind: 'message' }, { threadId: keys.thread })
      await r.ctx.facilitator.tick(r.at(4))
      assert.ok(steps()[0].waitingOn, 'held for Person B, not Person C')
      await r.send(r.people.b, 'note', { text: 'Use a new key kept offline, because the room’s key is online.', kind: 'message' }, { threadId: keys.thread })
      await r.send(r.people.b, 'note', { text: 'inwove.org: it is bought and already reaches the room.', kind: 'message' }, { threadId: money.thread })
      await r.ctx.facilitator.tick(r.at(5))
      for (const [s, what] of steps().map((s, i) => [s, ['keys', 'money'][i]])) {
        assert.equal(s.waitingOn, undefined, `the ${what} choice is settled by its person`)
        assert.equal(s.decision.by, r.people.b.did); assert.equal(s.decision.for, r.people.b.did); assert.equal(s.decision.held, what)
        assert.ok(!s.decision.provisional, 'a person’s own line, not provisional')
      }
    } finally { await r.stop() }
  })
})
