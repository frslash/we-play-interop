// A choice answered once stays answered (the room's agreement "Stop the repeat loop: a decided or parked step stays
// decided until its state changes"). The first clear answer in a step's thread is saved on the step as its decision,
// with who and why; the weaver doesn't ask it again, the builder doesn't report the same "stuck" again, a parked step
// is not chased or reported, and a clear disagreement (or a person's plain new answer) reopens it.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { NAME_OF, TYPES, signedDocument } from '../src/shared/types.js'
import { config as baseConfig } from '../src/server/config.js'
import { BUILD_MS, branchOf } from '../src/server/builder.js'
import { decided, decisionOf, isParked } from '../src/server/facilitator.js'
import { createApp } from '../src/server/index.js'
import { createResolver } from '../src/server/resolver.js'
import { closeVotes } from '../src/server/votes.js'

const BOARD = { generated: new Date().toISOString().slice(0, 10), projects: [], scenarios: [], runs: [] }
const FIRE = 'https://api.anthropic.com/v1/claude_code/routines/trig_builder_1/fire'
const MIN = 60_000

async function room () {
  const dir = mkdtempSync(join(tmpdir(), 'wpi-decided-'))
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

describe('what a line decides', () => {
  test('an option or "parked" is a clear answer; a question or a shrug is not', () => {
    assert.deepEqual(decisionOf('The room’s own key. Because it already signs the log.'), { choice: 'The room’s own key', parked: false, why: 'it already signs the log.' })
    assert.equal(decisionOf('Parked: it waits on the domain.').parked, true)
    assert.equal(decisionOf('parked').choice, 'parked')
    assert.equal(decisionOf('Not parked, use option B').parked, false)
    for (const t of ['Not sure, which would you pick?', 'Which one?', 'ok', 'Thanks', '', 'I don’t know yet']) assert.equal(decisionOf(t), null, t)
  })
  test('a decision holds only while the step is as it was when it was decided', () => {
    const s = { state: 'claimed', owner: 'did:x', decision: { choice: 'A', stateKey: 'claimed|did:x|' } }
    assert.ok(decided(s))
    assert.equal(decided({ ...s, state: 'result posted', result: 'h' }), null)
    assert.equal(decided({ ...s, owner: 'did:y' }), null)
    assert.equal(isParked({ ...s, decision: { ...s.decision, parked: true } }), true)
  })
})

describe('a choice answered once stays answered', () => {
  test('saved with who and why; not asked again; a person reopens it; parked is not chased or reported stuck', async () => {
    const r = await room()
    try {
      const f = r.ctx.facilitator, b = r.ctx.builder
      const p1 = await r.agreeForBuilder('Publish the room’s DID document')
      await f.tick(r.at(11)); await f.tick(r.at(12))
      const s1 = r.stepFrom(p1)
      r.pulls.push({ number: 42, title: 'Blocked: publish the room’s DID document', body: 'Needs: Which key signs the DID document?\nWhy: the DID log needs an update key.\nFrom: any agent here', html_url: 'https://github.com/example/room/pull/42', head: { ref: branchOf(s1), sha: 'c'.repeat(40) } })
      await f.tick(r.at(15)); await f.tick(r.at(16))
      assert.ok(r.stepFrom(p1).waitingOn, 'the choice is put to the agents')
      assert.equal(r.said('decide').length, 1); assert.equal(r.stuckLines(), 1)

      // which key signs is a person's keys: held for the step's owner's person (Person A, the builder's), before the proposer
      assert.equal(r.stepFrom(p1).waitingOn.who, r.people.a.did); assert.equal(r.stepFrom(p1).waitingOn.held, 'keys')
      // a shrug is not an answer, and neither is another person's agent: the choice stays undecided on the board
      await r.as('b', 'note', { text: 'Not sure, which would you pick?', kind: 'message' }, { threadId: s1.thread })
      await f.tick(r.at(17))
      assert.ok(r.stepFrom(p1).waitingOn, 'still waiting after a question')
      await r.as('c', 'note', { text: 'The room’s own key. Because it already signs the log.', kind: 'message' }, { threadId: s1.thread })
      await f.tick(r.at(17) + 30_000)
      assert.ok(r.stepFrom(p1).waitingOn, 'one agent cannot settle another person’s step alone')
      assert.equal(r.stepFrom(p1).decision, undefined); assert.equal(r.said('decided').length, 0)
      assert.match(f.view().steps.find((x) => x.id === s1.id).where, /^Waiting on Person A: Which key signs.*Held for Person A: it touches their keys/)
      // nor the proposer: the hold is the owner's person's
      await r.send(r.people.b, 'note', { text: 'The room’s own key. Because it already signs the log.', kind: 'message' }, { threadId: s1.thread })
      await f.tick(r.at(17) + 45_000)
      assert.ok(r.stepFrom(p1).waitingOn, 'the proposer cannot settle a hold either')
      // that person answers: now it is decided, with who, for whom and why
      await r.send(r.people.a, 'note', { text: 'The room’s own key. Because it already signs the log.', kind: 'message' }, { threadId: s1.thread })
      await f.tick(r.at(18))
      let s = r.stepFrom(p1)
      assert.equal(s.waitingOn, undefined)
      assert.equal(s.decision.by, r.people.a.did); assert.equal(s.decision.for, r.people.a.did); assert.equal(s.decision.held, 'keys')
      assert.equal(s.decision.choice, 'The room’s own key'); assert.match(s.decision.why, /already signs the log/)
      assert.match(s.decision.asked, /Which key signs the DID document/)
      const card = f.view().steps.find((x) => x.id === s.id)
      assert.equal(card.decision.byName, 'Person A'); assert.equal(card.decision.forName, 'Person A'); assert.equal(card.decision.holds, true)
      assert.match(card.where, /Decided by Person A for Person A: The room’s own key/)
      assert.equal(r.said('decided').length, 1)
      assert.ok(f.roundContext().steps.find((x) => x.id === s.id).decided, 'the weaver’s round sees it as decided')

      // the next several rounds: the Blocked: pull request is still open, the builder is restarted, the room redeploys
      for (let i = 1; i <= 8; i++) {
        if (i % 3 === 0) b.reported.clear() // a restart forgets what the builder reported in memory
        await f.tick(r.at(18) + i * (BUILD_MS / 2))
      }
      assert.equal(r.stuckLines(), 1, 'not reported stuck again with the same question')
      assert.equal(r.said('decide').length, 1, 'the choice is not asked again')
      assert.ok(decided(r.stepFrom(p1)))

      // a clear disagreement in the thread reopens it, and it is held for its person again
      await r.send(r.people.c, 'note', { text: 'I disagree: I’d use a new key just for the DID', kind: 'message' }, { threadId: s1.thread })
      await f.tick(r.at(18) + 5 * BUILD_MS)
      s = r.stepFrom(p1)
      assert.equal(s.decision, undefined); assert.match(s.waitingOn.decision, /Which key signs/); assert.equal(s.waitingOn.who, r.people.a.did)
      assert.equal(r.said('reopened').length, 1); assert.match(r.said('reopened')[0].payload.text, /reopened the choice/)

      // parked: on the board as parked, nobody chased, never in the stuck reports
      await r.send(r.people.a, 'note', { text: 'Parked: until the key ceremony.', kind: 'message' }, { threadId: s1.thread })
      await f.tick(r.at(18) + 5 * BUILD_MS + MIN)
      s = r.stepFrom(p1)
      assert.equal(isParked(s), true); assert.equal(s.decision.by, r.people.a.did); assert.equal(s.decision.for, r.people.a.did)
      const parkedCard = f.view().steps.find((x) => x.id === s.id)
      assert.equal(parkedCard.parked, true); assert.match(parkedCard.where, /^Parked by Person A: until the key ceremony/)
      const before = { stuck: r.stuckLines(), decide: r.said('decide').length, chase: r.said('chase').length, lines: r.ctx.log.entries.length }
      r.pulls[0].body += '\n\nUpdated.' // even a changed Blocked: pull request is not reported for a parked step
      for (let i = 1; i <= 6; i++) { b.reported.clear(); await f.tick(r.at(18) + 5 * BUILD_MS + i * BUILD_MS) }
      assert.equal(r.stuckLines(), before.stuck, 'a parked step is absent from the stuck reports')
      assert.equal(r.said('decide').length, before.decide); assert.equal(r.said('chase').length, before.chase)
      assert.ok(!r.ctx.log.entries.slice(before.lines).some((e) => e.document.payload?.facilitator?.steps?.includes(s.id)), 'nothing at all is said about it')
    } finally { await r.stop() }
  })

  test('the stuck report survives a restart: what was reported is kept on the step', async () => {
    const r = await room()
    try {
      const f = r.ctx.facilitator, b = r.ctx.builder
      const p1 = await r.agreeForBuilder('Publish the room’s DID document')
      await f.tick(r.at(11)); await f.tick(r.at(12))
      const s1 = r.stepFrom(p1)
      r.pulls.push({ number: 43, title: 'Blocked: publish it', body: 'Needs: Which key?', html_url: 'https://github.com/example/room/pull/43', head: { ref: branchOf(s1), sha: 'd'.repeat(40) } })
      const t0 = r.at(30)
      await b.look(t0)
      await f.tick(t0 + 1000)
      assert.ok(r.stepFrom(p1).stuck?.sig, 'the report is on the step')
      const real = f.steps.bind(f)
      f.steps = () => real().map((s) => s.id === s1.id ? { ...s, waitingOn: null } : s) // cleared without a decision (an owner's update)
      b.reported.clear()
      await b.look(t0 + 15 * MIN)
      assert.equal(r.stuckLines(), 1, 'not posted again after a restart')
    } finally { await r.stop() }
  })
})
