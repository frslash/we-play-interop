// The weaver's facilitate mode (src/server/facilitator.js): the step board, its timers, and the rule that every
// agreement ends with a next step, an owner and a check (room lines 1078-1079). Each test runs its own room.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { NAME_OF, TYPES, signedDocument } from '../src/shared/types.js'
import { config as baseConfig } from '../src/server/config.js'
import { STALE_MS } from '../src/server/facilitator.js'
const REPORT_MS = 60 * 60_000
import { createApp } from '../src/server/index.js'
import { createResolver } from '../src/server/resolver.js'
import { State } from '../src/server/state.js'
import { concerns } from '../src/server/views.js'
import { closeVotes } from '../src/server/votes.js'

const BOARD = { generated: new Date().toISOString().slice(0, 10), projects: [{ slug: 'alpha', name: 'Alpha' }, { slug: 'beta', name: 'Beta' }], scenarios: [], runs: [] }
const MIN = 60_000

/** A room with three people, each with one agent, and helpers to speak in it. */
async function room ({ running = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wpi-facilitate-'))
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

describe('the weaver facilitates: a board of steps toward the held goals', () => {
  test('facilitate is the default mode, and the data-room goal gets its done-test once, with the check that needs a person sent to them', async () => {
    const r = await room()
    try {
      assert.equal(r.st().mode.mode, 'facilitate')
      const goal2 = (await r.send(r.people.a, 'propose', { kind: 'goal', title: 'Goal 2: the room moves onto encrypted spaces its people hold' })).body.hash
      const goal1 = (await r.send(r.people.b, 'propose', { kind: 'goal', title: 'Goal 1: the room\'s surface works well' })).body.hash
      await r.send(r.people.a, 'vote', { proposal: goal2, choice: 'for' })
      await r.send(r.people.b, 'vote', { proposal: goal1, choice: 'for' })
      await r.ctx.facilitator.tick(r.at(0))
      const test6 = r.ctx.facilitator.testOf(goal2)
      assert.equal(test6.length, 6, 'six checks, each a step')
      assert.deepEqual(test6.map((s) => s.test.n), [1, 2, 5, 3, 4, 6], 'the checks for now first, the later ones after')
      assert.ok(test6.every((s) => s.state === 'open' && s.goal === goal2))
      assert.match(test6.find((s) => s.test.n === 3).title, /Geb member and a Keyring member/)
      // (5) needs a person (a domain costs money): it waits on the goal's proposer from the start, by name
      assert.equal(test6.find((s) => s.test.n === 5).waitingOn.who, null) // money, but no owner yet and never held for the goal's proposer: the agents
      assert.equal(test6.find((s) => s.test.n === 5).waitingOn.held, undefined)
      const seed = r.said('seed')
      assert.equal(seed.length, 1)
      assert.match(seed[0].payload.text, /Check \(5\) waits on a choice first, for the agents here: which permanent domain/)
      // the other held goal has no done-test: the room is asked for one, naming whose goal it is
      const ask = r.said('ask test')
      assert.equal(ask.length, 1); assert.match(ask[0].payload.text, /Goal 1.*\(Person B\)/)
      assert.deepEqual(ask[0].payload.facilitator.goals, [goal1])
      // a second pass: nothing new, nothing repeated
      await r.ctx.facilitator.tick(r.at(1))
      assert.equal(r.ctx.facilitator.testOf(goal2).length, 6)
      assert.equal(r.said('seed').length, 1); assert.equal(r.said('ask test').length, 1)
      // an agent writes Goal 1's done-test with the step tool's line; it becomes steps, and a second one is refused
      await r.as('c', 'note', { text: 'A done-test for Goal 1', kind: 'message', step: { say: 'test', goal: goal1, checks: ['The page loads in under 2 s on a phone (Lighthouse score above 90)', 'A newcomer joins and their agent says hello within 5 min'] } })
      await r.ctx.facilitator.tick(r.at(2))
      assert.equal(r.ctx.facilitator.testOf(goal1).length, 2)
      await r.as('b', 'note', { text: 'Another', kind: 'message', step: { say: 'test', goal: goal1, checks: ['something else entirely'] } })
      await r.ctx.facilitator.tick(r.at(3))
      assert.equal(r.ctx.facilitator.testOf(goal1).length, 2, 'a goal keeps its done-test; changing it is a vote')
      // a malformed step line is refused at the door, with the reason
      const bad = await r.as('c', 'note', { text: 'x', kind: 'message', step: { say: 'check', of: test6[0].id } })
      assert.equal(bad.status, 400); assert.match(bad.body.payload.message, /step.passed/)
    } finally { await r.stop() }
  })

  test('every agreement ends with a next step, an owner and a check (lines 1078-1079)', async () => {
    const r = await room()
    try {
      const pr = await r.agree('a', 'Run the Keyring handshake test with throwaway keys')
      assert.ok(r.ctx.log.entries.some((e) => NAME_OF[e.type] === 'result' && e.document.payload.proposal === pr && e.document.payload.status === 'agreed'))
      const no = (await r.as('b', 'propose', { kind: 'other', title: 'Rewrite the room in another language' })).body.hash
      await r.as('c', 'vote', { proposal: no, choice: 'against' })
      await closeVotes(r.ctx, r.at(11), { max: 10 })
      await r.ctx.facilitator.tick(r.at(11))
      const s = r.stepFrom(pr)
      assert.ok(s, 'the agreement got a step')
      assert.equal(s.owner, r.agents.a.did, 'the agent that proposed it owns it')
      assert.equal(s.state, 'open'); assert.ok(s.done.length > 10, 'a check'); assert.ok(s.agreedAt)
      assert.ok(!r.stepFrom(no), 'what was not agreed gets no step')
      const open = r.said('open')
      assert.equal(open.length, 1)
      assert.match(open[0].payload.text, /North Agent, it’s yours if you take it/)
      assert.match(open[0].payload.text, /Done when:/)
      assert.equal(open[0].threadId, s.thread, 'it speaks in the step’s thread')
      assert.equal(concerns(r.ctx, r.ctx.log.byHash.get([...r.ctx.log.entries].reverse().find((e) => e.document.payload.facilitator?.what === 'open').hash), r.agents.a.did), 'mention', 'naming the owner wakes it')
      // once only
      await r.ctx.facilitator.tick(r.at(12))
      assert.equal(r.steps().filter((x) => x.from === pr).length, 1); assert.equal(r.said('open').length, 1)
      // with a model, the model writes the step and its check (and the line records which model wrote it)
      r.ctx.llm = { configured: true, model: 'test/model', route: () => ({}), chat: async (messages) => { const id = JSON.parse(messages[1].content).agreements[0].id; return { model: 'test/model', latencyMs: 3, usage: { total_tokens: 9 }, finishReason: 'stop', content: JSON.stringify({ steps: [{ id, step: 'Post one Welcome for Geb’s test key from a Keyring group', done: 'Geb reads the Welcome and both sides post the same group epoch' }] }) } } }
      const pr2 = await r.agree('c', 'Try the MLS add and remove with Geb')
      await r.ctx.facilitator.tick(r.at(12))
      const s2 = r.stepFrom(pr2)
      assert.equal(s2.title, 'Post one Welcome for Geb’s test key from a Keyring group')
      assert.match(s2.done, /same group epoch/)
      assert.equal(s2.words.model, 'test/model'); assert.equal(s2.words.used, 1)
      // a person's proposal is owned by their agent; the agent does the work, the person decides
      const pr3 = (await r.send(r.people.b, 'propose', { kind: 'other', title: 'Publish the room export as one file' })).body.hash
      await r.as('c', 'vote', { proposal: pr3, choice: 'for' })
      await closeVotes(r.ctx, r.at(11), { max: 10 })
      await r.ctx.facilitator.tick(r.at(13))
      assert.equal(r.stepFrom(pr3).owner, r.agents.b.did)
    } finally { await r.stop() }
  })

  test('agreements from before the board started are not opened all at once; the ones after it are', async () => {
    const r = await room({ running: false })
    try {
      const before = await r.agree('a', 'Something the room agreed yesterday')
      await r.ctx.facilitator.tick(r.at(11))
      assert.ok(!r.stepFrom(before), 'no backlog')
      assert.equal(r.said('open').length, 0)
      const after = await r.agree('b', 'Something the room agrees now')
      await r.ctx.facilitator.tick(r.at(12))
      assert.equal(r.stepFrom(after).owner, r.agents.b.did)
    } finally { await r.stop() }
  })

  test('the board moves on what owners say, and only another side checks a result', async () => {
    const r = await room()
    try {
      const pr = await r.agree('a', 'Verify the public log with the room server off')
      await r.ctx.facilitator.tick(r.at(11))
      let s = r.stepFrom(pr)
      // someone else can't post its result; the owner claims it, then posts one with nothing to check
      await r.tell('b', s, 'result', 'Done!')
      await r.ctx.facilitator.tick(r.at(12)); s = r.stepFrom(pr)
      assert.equal(s.state, 'open', 'only its owner posts the result')
      await r.tell('a', s, 'claim', 'I take it')
      await r.ctx.facilitator.tick(r.at(12)); s = r.stepFrom(pr)
      assert.equal(s.state, 'claimed'); assert.equal(s.owner, r.agents.a.did); assert.ok(s.claimedAt)
      await r.tell('a', s, 'update', 'Halfway: the mirror is up')
      await r.ctx.facilitator.tick(r.at(13)); s = r.stepFrom(pr)
      assert.equal(s.state, 'in progress')
      await r.tell('a', s, 'result', 'It works now')
      await r.ctx.facilitator.tick(r.at(14)); s = r.stepFrom(pr)
      assert.equal(s.state, 'result posted')
      // a result with no link, command or value is pressed for the exact thing, once
      const press = r.said('press')
      assert.equal(press.length, 1); assert.match(press[0].payload.text, /^North Agent: can you add what shows it worked/)
      // someone of another side is asked to check it
      const ask = r.said('check')
      assert.equal(ask.length, 1); assert.match(ask[0].payload.text, /^(South|East) Agent: please check/)
      assert.ok(!ask[0].payload.text.startsWith('North'), 'never its own owner')
      // the owner's own person can't check it
      await r.tell('a', s, 'check', 'looks good to me', { passed: true }, 'person')
      await r.ctx.facilitator.tick(r.at(15)); s = r.stepFrom(pr)
      assert.equal(s.state, 'result posted', 'its own side does not check it')
      // another side reruns it: it fails, goes back to the owner, who fixes it with evidence; then it passes
      await r.tell('b', s, 'check', 'verify-log says 3 bad signatures', { passed: false })
      await r.ctx.facilitator.tick(r.at(16)); s = r.stepFrom(pr)
      assert.equal(s.state, 'in progress')
      assert.match(r.said('check failed')[0].payload.text, /^North Agent: the check on .* didn’t pass/)
      await r.tell('a', s, 'result', 'Fixed: `node agent/verify-log.js` prints ok for 1101 entries', { evidence: [{ label: 'the run', url: 'https://example.org/run/1' }] })
      await r.ctx.facilitator.tick(r.at(17)); s = r.stepFrom(pr)
      assert.equal(s.state, 'result posted'); assert.equal(r.said('press').length, 1, 'this one had its evidence')
      await r.tell('b', s, 'check', 'reran it: ok', { passed: true })
      await r.ctx.facilitator.tick(r.at(18)); s = r.stepFrom(pr)
      assert.equal(s.state, 'checked'); assert.equal(s.checkedBy, r.agents.b.did)
      assert.ok(!r.st().steps.has(s.id), 'a checked step leaves the active set'); assert.ok(r.st().stepsDone.some((x) => x.id === s.id))
      // the record per day, and the board read back from the log alone (a restart) is the same board
      const day = r.ctx.facilitator.view().days.at(-1)
      assert.deepEqual([day.opened, day.claimed, day.resulted, day.checked], [1, 1, 1, 1])
      assert.ok(day.medianAgreementToFirstResultMinutes !== null)
      const again = new State(); for (const e of r.ctx.log.entries) again.apply(e)
      assert.deepEqual(again.stepsDone.map((x) => [x.id, x.state, x.owner]), r.st().stepsDone.map((x) => [x.id, x.state, x.owner]))
      assert.equal(again.stepsHeard, r.st().stepsHeard)
    } finally { await r.stop() }
  })

  test('a seat can say a plain no to a step with the step tool: it goes on to another side, and only its holder can', async () => {
    const r = await room()
    try {
      const pr = await r.agree('a', 'Mirror the public log to a third host')
      await r.ctx.facilitator.tick(r.at(11))
      let s = r.stepFrom(pr)
      await r.tell('b', s, 'decline', 'not me')
      await r.ctx.facilitator.tick(r.at(12)); s = r.stepFrom(pr)
      assert.notEqual(s.change, 'declined', 'someone who does not hold it cannot decline it')
      await r.tell('a', s, 'claim', 'I take it')
      await r.ctx.facilitator.tick(r.at(12)); s = r.stepFrom(pr)
      assert.equal(s.owner, r.agents.a.did)
      await r.tell('a', s, 'decline', 'I can’t take this one, sorry')
      await r.ctx.facilitator.tick(r.at(13)); s = r.stepFrom(pr)
      assert.equal(s.owner, undefined); assert.equal(s.state, 'open'); assert.equal(s.previousOwner, r.agents.a.did)
      assert.notEqual(s.offeredTo, r.agents.a.did, 'never offered straight back to the one who said no')
    } finally { await r.stop() }
  })

  test('a quiet step: its owner is asked by name, then it is offered to another agent, then it goes to a person', async () => {
    const r = await room()
    try {
      const pr = await r.agree('c', 'Mirror the public log to a second host')
      await r.ctx.facilitator.tick(r.at(11))
      let s = r.stepFrom(pr)
      await r.tell('c', s, 'claim', 'mine') // claimed now: the clock below runs from here
      await r.ctx.facilitator.tick(r.at(1))
      await r.ctx.facilitator.tick(r.at(0) + STALE_MS - MIN) // not yet half an hour
      assert.equal(r.said('chase').length, 0)
      await r.ctx.facilitator.tick(r.at(0) + STALE_MS + MIN)
      assert.equal(r.said('chase').length, 1)
      assert.match(r.said('chase')[0].payload.text, /^East Agent: any news on/)
      s = r.stepFrom(pr); assert.equal(s.chases, 1)
      // a second silence: offered to an agent of another person, and the owner's side is not offered it again
      await r.ctx.facilitator.tick(r.at(0) + 2 * STALE_MS + 2 * MIN)
      s = r.stepFrom(pr)
      assert.equal(s.owner, undefined); assert.equal(s.state, 'open'); assert.equal(s.previousOwner, r.agents.c.did)
      assert.ok([r.agents.a.did, r.agents.b.did].includes(s.offeredTo))
      const offer = r.said('offer')
      assert.equal(offer.length, 1); assert.match(offer[0].payload.text, /will you take .* East Agent had it and went quiet/)
      // the offered agent stays quiet too: it goes to the agents as a choice, never on to a third agent, never to a person
      await r.ctx.facilitator.tick(r.at(0) + 3 * STALE_MS + 3 * MIN)
      s = r.stepFrom(pr)
      assert.equal(s.waitingOn.who, null)
      const up = r.said('decide')
      assert.equal(up.length, 1); assert.match(up[0].payload.text, /^A choice for the agents here: who takes/)
      assert.ok(!/Person [ABC]: one decision/.test(up[0].payload.text))
      assert.equal(r.said('offer').length, 1, 'offered once, not bounced')
      // a step that waits on a person is not chased
      await r.ctx.facilitator.tick(r.at(0) + 5 * STALE_MS)
      assert.equal(r.said('chase').length, 1); assert.equal(r.said('decide').length, 1)
      // someone answers in the step's thread: it moves again
      await r.send(r.people.c, 'note', { text: 'Give it to South Agent, please', kind: 'message' }, { threadId: s.thread })
      await r.ctx.facilitator.tick(r.at(1)) // a pass right after the reply (the clock above ran ahead)
      assert.equal(r.stepFrom(pr).waitingOn, undefined)
      assert.ok(['unblocked', 'answered'].includes(r.stepFrom(pr).change), 'the wait cleared')
    } finally { await r.stop() }
  })

  test('a seat that re-posts "blocked" makes one question, and an agent’s answer is kept as the step’s decision', async () => {
    const r = await room()
    try {
      const pr = await r.agree('b', 'Move the room to a new host')
      await r.ctx.facilitator.tick(r.at(11))
      let s = r.stepFrom(pr)
      await r.tell('b', s, 'claim', 'on it')
      await r.ctx.facilitator.tick(r.at(11))
      s = r.stepFrom(pr)
      for (let i = 0; i < 5; i++) await r.tell('b', s, 'blocked', 'I am stuck on the host move', { decision: 'which host to move to' })
      await r.ctx.facilitator.tick(r.at(12))
      assert.equal(r.said('decide').length, 1, 'five re-posts in a minute: one question')
      s = r.stepFrom(pr)
      await r.as('c', 'note', { text: 'Use the Railway host for now.', kind: 'message' }, { threadId: s.thread })
      await r.ctx.facilitator.tick(r.at(13)); s = r.stepFrom(pr)
      assert.equal(s.waitingOn, undefined, 'the answer clears the wait')
      assert.match(s.decided.text, /Railway/, 'and stays as the step’s decision')
      await r.tell('b', s, 'blocked', 'I am still stuck on the host move', { decision: 'which host to move to' })
      await r.ctx.facilitator.tick(r.at(14))
      assert.equal(r.said('decide').length, 1, 'the answered question is not asked again')
      assert.equal(r.stepFrom(pr).waitingOn, undefined)
      assert.ok(r.ctx.facilitator.loopsHeld >= 1, 'the guard counts what it held back')
    } finally { await r.stop() }
  })

  test('a choice a step waits on goes to the agents, once, and the step is never handed to another agent meanwhile; a reply from the owner resets the clock', async () => {
    const r = await room()
    try {
      const pr = await r.agree('b', 'Put the room’s DID on a lasting address')
      await r.ctx.facilitator.tick(r.at(11))
      let s = r.stepFrom(pr)
      await r.tell('b', s, 'claim', 'on it')
      await r.ctx.facilitator.tick(r.at(11))
      s = r.stepFrom(pr)
      await r.tell('b', s, 'blocked', 'This needs a carrier picked', { on: r.people.a.did, decision: 'which carrier the room tests first, TSP or DIDComm' })
      await r.ctx.facilitator.tick(r.at(12))
      s = r.stepFrom(pr)
      assert.equal(s.waitingOn.who, null, 'even when a line names a person, the agents decide')
      assert.match(r.said('decide')[0].payload.text, /^A choice for the agents here: which carrier the room tests first, TSP or DIDComm\?/)
      for (const k of [1, 2, 3]) await r.ctx.facilitator.tick(r.at(12) + k * (STALE_MS + MIN))
      assert.equal(r.said('chase').length, 0); assert.equal(r.said('offer').length, 0); assert.equal(r.said('decide').length, 1)
      assert.equal(r.stepFrom(pr).owner, r.agents.b.did, 'it stays with its owner while it waits')
      // the owner's word clears the wait; then a plain reply in the step's thread resets the chase
      await r.tell('b', s, 'update', 'Person A picked a domain; setting it up')
      await r.ctx.facilitator.tick(r.at(13)); s = r.stepFrom(pr)
      assert.equal(s.waitingOn, undefined)
      await r.ctx.facilitator.tick(r.at(13) + STALE_MS + MIN)
      assert.equal(r.said('chase').length, 1)
      await r.as('b', 'note', { text: 'still on it, DNS is propagating', kind: 'message' }, { threadId: s.thread })
      await r.ctx.facilitator.tick(r.at(13) + STALE_MS + 2 * MIN)
      assert.equal(r.stepFrom(pr).chases, 0, 'heard')
      await r.ctx.facilitator.tick(r.at(13) + 2 * STALE_MS + 3 * MIN)
      assert.equal(r.said('offer').length, 0, 'after a reply the next silence is asked about again, not offered away')
      assert.equal(r.said('chase').length, 2)
    } finally { await r.stop() }
  })

  test('it reports only what moved, gathered for a little while, never when nothing did, and the report wakes no one', async () => {
    const r = await room()
    try {
      const goal = (await r.send(r.people.a, 'propose', { kind: 'goal', title: 'Goal 2: the room moves onto encrypted spaces its people hold' })).body.hash
      await r.send(r.people.a, 'vote', { proposal: goal, choice: 'for' })
      await r.ctx.facilitator.tick(r.at(0))
      assert.equal(r.said('report').length, 0, 'not on top of the seed')
      // the seed's own line named every check it opened: the report does not say them again
      await r.ctx.facilitator.tick(r.at(11))
      assert.equal(r.said('report').length, 0)
      // nothing moved: silent, even an hour later
      await r.ctx.facilitator.tick(r.at(11) + REPORT_MS + MIN)
      assert.equal(r.said('report').length, 0)
      // a check is claimed: reported once, after the changes are gathered (ten minutes), not at once
      const check3 = r.ctx.facilitator.testOf(goal).find((s) => s.test.n === 3)
      await r.tell('b', check3, 'claim', 'I take the MLS check')
      await r.ctx.facilitator.tick(r.at(5))
      assert.equal(r.said('report').length, 0, 'not five minutes after the claim')
      await r.ctx.facilitator.tick(r.at(11))
      const first = r.said('report')
      assert.equal(first.length, 1)
      assert.match(first[0].payload.text, /0 of 6 checked/)
      assert.match(first[0].payload.text, /\(3\) .*Claimed: South Agent/)
      assert.doesNotMatch(first[0].payload.text, /\(1\) |\(2\) |\(4\) /, 'only the check that moved')
      // once: the same claim is not reported again
      await r.ctx.facilitator.tick(r.at(30))
      assert.equal(r.said('report').length, 1)
      // the report names South Agent but does not wake it
      const line = r.ctx.log.entries.filter((e) => e.document.payload.facilitator?.report).at(-1)
      assert.equal(concerns(r.ctx, line, r.agents.b.did), null)
    } finally { await r.stop() }
  })

  test('in its round the model only judges: vague lines are pressed, convergence opens a step, nothing new is proposed', async () => {
    const r = await room()
    try {
      const goal = (await r.send(r.people.a, 'propose', { kind: 'goal', title: 'Geb and Keyring members read each other in one MLS group' })).body.hash
      await r.send(r.people.a, 'vote', { proposal: goal, choice: 'for' })
      await r.ctx.facilitator.tick(r.at(0))
      const vague = (await r.as('a', 'note', { text: 'I got the group thing working on my side', kind: 'message' })).body.hash
      const b1 = (await r.as('b', 'note', { text: 'Then the next step is the add and remove test, both sides reading after the remove', kind: 'message' })).body.hash
      const a2 = (await r.as('a', 'note', { text: 'Agreed, let us do the add and remove test next', kind: 'message' })).body.hash
      const proposalsBefore = r.st().proposals.size
      const answer = { heard: [], threads: [], agreements: [], conflicts: [], connections: [{ between: [r.agents.a.did, r.agents.c.did], why: 'they should talk' }], next: [{ kind: 'other', action: 'Start a brand new direction', why: 'because' }],
        vague: [{ entry: vague, missing: 'command', ask: 'Which command did you run, and what did it print?' }, { entry: 'f'.repeat(64), missing: 'file', ask: 'not a real line' }],
        converged: [{ entries: [b1, a2], step: 'Run the add and remove test with Keyring members in one MLS group', done: 'Both sides post the same group epoch after the remove' }] }
      r.ctx.weaver.llm = { configured: true, model: 'test/model', chat: async () => ({ model: 'test/model', latencyMs: 2, usage: { total_tokens: 5 }, finishReason: 'stop', jsonMode: true, content: JSON.stringify(answer) }) }
      const round = (await r.ctx.weaver.round()).document.payload
      assert.equal(round.mode, 'facilitate')
      assert.deepEqual(round.facilitate.pressed, [vague])
      assert.equal(round.facilitate.opened.length, 1)
      assert.equal(r.st().proposals.size, proposalsBefore, 'it proposes nothing new')
      assert.deepEqual(round.connections, []); assert.ok(!round.next.some((x) => x.kind !== 'ask'))
      const press = r.said('press')
      assert.equal(press.length, 1); assert.equal(press[0].payload.text, 'North Agent: Which command did you run, and what did it print?')
      assert.equal(press[0].threadId, r.ctx.log.byHash.get(vague).document.id, 'asked as a reply to the line')
      const s = r.st().steps.get(round.facilitate.opened[0])
      assert.equal(s.title, 'Run the add and remove test with Keyring members in one MLS group')
      assert.equal(s.owner, r.agents.a.did, 'the agent that spoke last')
      assert.equal(s.goal, goal, 'the step serves the goal its words name')
      // the same judgments again: no second press, no second step
      await r.as('c', 'note', { text: 'sounds good', kind: 'message' })
      const again = await r.ctx.weaver.round()
      assert.equal(r.said('press').length, 1)
      assert.equal(r.steps().filter((x) => x.title === s.title).length, 1)
      assert.ok(again === null || !again.document.payload.facilitate.opened.length)
      // no model, nothing to assign, chase, sharpen or check: silence
      r.ctx.weaver.llm = { configured: false }
      await r.as('c', 'note', { text: 'nice evening, everyone', kind: 'message' })
      assert.equal(await r.ctx.weaver.round(), null)
    } finally { await r.stop() }
  })

  test('agents use the steps and step tools, and hear the reason when a move isn’t theirs to make', async () => {
    const r = await room()
    try {
      const made = await r.send(r.people.c, 'host', { label: 'Hosted Agent' })
      const hosted = made.body.hosted.did, link = made.body.hosted.connector.replace(/^https?:\/\/[^/]+/, `http://localhost:${r.ctx.server.address().port}`)
      await r.send(r.people.c, 'delegate', { delegate: hosted, scope: ['note', 'propose', 'vote'], label: 'Hosted Agent' }, { expiresAt: new Date(Date.now() + 86400000).toISOString() })
      const call = async (tool, args) => { const res = await fetch(`${link}/call/${tool}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args ?? {}) }); return { status: res.status, text: await res.text() } }
      const pr = await r.agree('a', 'Write the wallet join walkthrough')
      await r.ctx.facilitator.tick(r.at(11))
      const s = r.stepFrom(pr)
      const board = JSON.parse((await call('steps')).text)
      assert.equal(board.steps[0].id, s.id); assert.equal(board.steps[0].owner, 'North Agent')
      const taken = await call('step', { say: 'claim', step: s.id.slice(0, 8), text: 'I can take this one' })
      assert.equal(taken.status, 200, taken.text)
      await r.ctx.facilitator.tick(r.at(12))
      assert.equal(r.stepFrom(pr).owner, hosted, 'an open step goes to whoever claims it first')
      const own = await call('step', { say: 'check', step: s.id, text: 'fine', passed: true })
      assert.equal(own.status, 400); assert.match(own.text, /no result to check yet/)
      await call('step', { say: 'result', step: s.id, text: 'The walkthrough: https://example.org/walkthrough' })
      await r.ctx.facilitator.tick(r.at(13))
      const mine = await call('step', { say: 'check', step: s.id, text: 'fine', passed: true })
      assert.match(mine.text, /another person’s side/)
      assert.equal(r.said('press').length, 0, 'a link is the exact thing')
    } finally { await r.stop() }
  })
})
