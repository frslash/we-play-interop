// A choice that touches a person's keys, money, time or name is held for that person (src/server/personal.js and
// Facilitator.hold): the weaver does not put it to the agents, it stays undecided on the board, and only that
// person's own word answers it. Any other choice still goes to the agents. Each test runs its own room.
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
import { touchesPerson, mayAnswer } from '../src/server/personal.js'
import { createResolver } from '../src/server/resolver.js'
import { concerns } from '../src/server/views.js'
import { closeVotes } from '../src/server/votes.js'

const BOARD = { generated: new Date().toISOString().slice(0, 10), projects: [{ slug: 'alpha', name: 'Alpha' }, { slug: 'beta', name: 'Beta' }], scenarios: [], runs: [] }
const MIN = 60_000

/** A room with three people, each with one agent, and helpers to speak in it. */
async function room ({ running = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wpi-hold-'))
  const config = { ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, githubToken: '', weaverIntervalMinutes: 0, weaverQuietMinutes: 0, ratePerMinute: 1000, voteMinutes: 10, publicUrl: 'https://interop.example', boardDataUrl: 'data:application/json,' + encodeURIComponent(JSON.stringify(BOARD)), llm: { ...baseConfig.llm, provider: 'openai', apiKey: '' } }
  const ctx = await createApp(config, { resolver: createResolver(), hostWelcomeMs: null })
  await new Promise((r) => ctx.server.listen(0, r))
  const base = `http://localhost:${ctx.server.address().port}`
  await ctx.board.refresh()
  ctx.weaver.llm = { configured: false }
  const postDoc = async (doc) => { const r = await fetch(`${base}/api/entries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(doc) }); return { status: r.status, body: await r.json() } }
  const send = (id, name, payload, extra) => postDoc(signedDocument(id, { type: TYPES[name], payload, ...extra }))
  const people = {}, agents = {}, dels = {}
  const exp = new Date(Date.now() + 86400000).toISOString()
  for (const [key, name, label] of [['a', 'Person A', 'North Agent'], ['b', 'Person B', 'South Agent'], ['c', 'Person C', 'East Agent']]) {
    people[key] = newIdentity(); agents[key] = newIdentity()
    assert.equal((await send(people[key], 'join', { name })).status, 201)
    dels[agents[key].did] = (await send(people[key], 'delegate', { delegate: agents[key].did, scope: ['note', 'propose', 'vote'], label }, { expiresAt: exp })).body.hash
  }
  const as = (k, name, payload, extra) => send(agents[k], name, payload, { onBehalfOf: people[k].did, delegation: dels[agents[k].did], ...extra })
  const st = () => ctx.log.state
  const steps = () => [...st().steps.values()]
  const stepFrom = (hash) => [...st().steps.values(), ...st().stepsDone].find((s) => s.from === hash)
  const said = (what) => ctx.log.entries.filter((e) => NAME_OF[e.type] === 'note' && e.document.payload.facilitator?.what === what).map((e) => e.document)
  const tell = (k, step, say, text, more = {}, who = 'agent') => (who === 'agent' ? as(k, 'note', { text, kind: 'message', step: { of: step.id, say, ...more } }, { threadId: step.thread }) : send(people[k], 'note', { text, kind: 'message', step: { of: step.id, say, ...more } }, { threadId: step.thread }))
  const at = (minutes) => Date.now() + minutes * MIN
  /** An agreed proposal by agent k, closed by the room's own vote timer. */
  const agree = async (k, title, voter = 'b') => {
    const pr = (await as(k, 'propose', { kind: 'other', title })).body.hash
    await as(voter, 'vote', { proposal: pr, choice: 'for' })
    await closeVotes(ctx, at(11), { max: 10 })
    return pr
  }
  if (running) await ctx.facilitator.tick() // the room is running: its facilitator has started before anything below happens
  const stop = async () => { await ctx.stop(); rmSync(dir, { recursive: true, force: true }) }
  return { ctx, send, as, people, agents, st, steps, stepFrom, said, tell, at, agree, stop }
}

const KEYS = 'whether the room’s DID is signed with Person A’s own signing key'

describe('the weaver holds a person’s choices for that person', () => {
  test('the filter reads keys, money, time and name, and leaves other choices to the agents', () => {
    assert.deepEqual(touchesPerson(KEYS), ['keys'])
    assert.deepEqual(touchesPerson('which seed phrase to restore the wallet from'), ['keys'])
    assert.deepEqual(touchesPerson('which permanent domain to buy, if it costs money'), ['money'])
    assert.deepEqual(touchesPerson('whether to pay $12 a year for hosting'), ['money'])
    assert.deepEqual(touchesPerson('when Person B has a call with the Geb team'), ['time'])
    assert.deepEqual(touchesPerson('whether to publish the run under Person C’s real name'), ['name'])
    assert.deepEqual(touchesPerson('which group library to use'), [])
    assert.deepEqual(touchesPerson('which DNS provider the room uses'), [])
    assert.deepEqual(touchesPerson('whether TSP or DIDComm carries the first run'), [])
  })

  test('a choice about a person’s keys stays undecided on the board until that person answers, and no agent can answer it', async () => {
    const r = await room()
    try {
      const pr = await r.agree('a', 'Publish the room’s DID document')
      await r.ctx.facilitator.tick(r.at(11))
      let s = r.stepFrom(pr)
      await r.tell('a', s, 'claim', 'on it')
      await r.ctx.facilitator.tick(r.at(11))
      // the test choice, put to the agents by the step's owner
      await r.tell('a', s, 'blocked', 'stuck: which key signs it?', { decision: KEYS })
      await r.ctx.facilitator.tick(r.at(12))
      s = r.stepFrom(pr)
      assert.equal(s.waitingOn.who, r.people.a.did, 'held for the person whose keys they are')
      assert.deepEqual(s.waitingOn.personal, ['keys'])
      assert.equal(r.said('decide').length, 0, 'not put to the agents')
      const hold = r.ctx.log.entries.filter((e) => e.document.payload.facilitator?.what === 'hold')
      assert.equal(hold.length, 1)
      assert.match(hold[0].document.payload.text, /^Person A: a choice for you alone, because it touches your keys: whether the room’s DID is signed/)
      assert.match(hold[0].document.payload.text, /The agents don’t decide this one/)
      assert.equal(concerns(r.ctx, hold[0], r.agents.b.did), null, 'it wakes no agent of another person')
      // the weaver records that it held it, as a signed decision line (#53)
      const held = [...r.st().decisions.values()].find((d) => /^Held a choice/.test(d.what))
      assert.ok(held, 'a decision line says it was held'); assert.deepEqual(held.for, [r.people.a.did])
      // agents answer: another person's agent, the step's own agent in the thread, and its update: it stays undecided
      await r.as('b', 'note', { text: 'Use Person A’s signing key for the room’s DID, decided.', kind: 'message' }, { threadId: s.thread })
      await r.as('c', 'note', { text: 'Agreed: sign the room’s DID with Person A’s own signing key.', kind: 'message' })
      await r.as('a', 'note', { text: 'Yes, sign it with that key.', kind: 'message' }, { threadId: s.thread })
      await r.tell('a', s, 'update', 'going with Person A’s signing key')
      await r.ctx.facilitator.tick(r.at(13))
      s = r.stepFrom(pr)
      assert.ok(s.waitingOn, 'still undecided on the board'); assert.equal(s.waitingOn.who, r.people.a.did)
      assert.equal(s.decided, undefined)
      const board = await (await fetch(`http://localhost:${r.ctx.server.address().port}/api/state`)).json()
      const onBoard = board.steps.steps.find((x) => x.id === s.id)
      assert.deepEqual(onBoard.waitingOn.personal, ['keys'], 'the board shows it held'); assert.equal(onBoard.waitingOn.name, 'Person A', 'for that person, by name')
      // the round's model reads an agent's line as the answer: refused, only the person answers it
      const line = r.ctx.log.entries.filter((e) => e.author === r.agents.b.did).at(-1)
      assert.equal(mayAnswer(r.st(), line, s.waitingOn, () => true), false)
      // another person can't answer it either
      await r.send(r.people.b, 'note', { text: 'Sign it with Person A’s key.', kind: 'message' }, { threadId: s.thread })
      await r.ctx.facilitator.tick(r.at(14))
      assert.ok(r.stepFrom(pr).waitingOn, 'not another person')
      // that person answers in the thread: it moves on, and their word is the step's decision
      await r.send(r.people.a, 'note', { text: 'No: make a new key for the room; mine stays mine.', kind: 'message' }, { threadId: s.thread })
      await r.ctx.facilitator.tick(r.at(15))
      s = r.stepFrom(pr)
      assert.equal(s.waitingOn, undefined)
      assert.equal(s.decided.by, r.people.a.did); assert.match(s.decided.text, /new key for the room/)
    } finally { await r.stop() }
  })

  test('a choice already put to the agents that touches a person’s money is held for them after a restart; others stay with the agents', async () => {
    const r = await room()
    try {
      const p1 = await r.agree('a', 'Move the room to a lasting host')
      const p2 = await r.agree('a', 'Pick the room’s DNS provider')
      await r.ctx.facilitator.tick(r.at(11))
      const f = r.ctx.facilitator
      await f.write(r.stepFrom(p1), { owner: r.agents.a.did, waitingOn: { who: null, decision: 'whether to pay for the new host every month' } }, 'waiting', null)
      await f.write(r.stepFrom(p2), { owner: r.agents.a.did, waitingOn: { who: null, decision: 'which DNS provider the room uses' } }, 'waiting', null)
      r.ctx.facilitator = new Facilitator({ ctx: r.ctx }) // the room restarts
      await r.ctx.facilitator.tick(r.at(12))
      const s1 = r.stepFrom(p1), s2 = r.stepFrom(p2)
      assert.equal(s1.waitingOn.who, r.people.a.did); assert.deepEqual(s1.waitingOn.personal, ['money'])
      assert.equal(s2.waitingOn.who, null, 'a choice that is no one’s alone stays with the agents'); assert.equal(s2.waitingOn.personal, undefined)
      await r.as('b', 'note', { text: 'Pay for it monthly.', kind: 'message' }, { threadId: s1.thread })
      await r.as('b', 'note', { text: 'Use the provider we already have.', kind: 'message' }, { threadId: s2.thread })
      await r.ctx.facilitator.tick(r.at(13))
      assert.ok(r.stepFrom(p1).waitingOn, 'the money choice waits for its person')
      assert.equal(r.stepFrom(p2).waitingOn, undefined, 'the agents decided the other one')
    } finally { await r.stop() }
  })
})
