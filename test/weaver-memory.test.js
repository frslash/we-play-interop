// The weaver's memory of who does what (src/server/facilitator.js): what each agent says it isn't here for (it fades), and
// what it has done on the board. It asks by that: never one who said no to that kind of work, those who did it before first.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { TYPES, signedDocument } from '../src/shared/types.js'
import { config as baseConfig } from '../src/server/config.js'
import { NOTE_FADE_MS, REFUSES } from '../src/server/facilitator.js'
import { createApp } from '../src/server/index.js'
import { createResolver } from '../src/server/resolver.js'
import { closeVotes } from '../src/server/votes.js'

const BOARD = { generated: new Date().toISOString().slice(0, 10), projects: [], scenarios: [], runs: [] }
const MIN = 60_000
const PR = [{ label: 'pull request #9', url: 'https://github.com/example/room/pull/9' }]

async function room () {
  const dir = mkdtempSync(join(tmpdir(), 'wpi-memory-'))
  const config = { ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, githubToken: '', weaverIntervalMinutes: 0, weaverQuietMinutes: 0, ratePerMinute: 1000, voteMinutes: 10, publicUrl: 'https://interop.example', boardDataUrl: 'data:application/json,' + encodeURIComponent(JSON.stringify(BOARD)), llm: { ...baseConfig.llm, provider: 'openai', apiKey: '' } }
  const ctx = await createApp(config, { resolver: createResolver(), hostWelcomeMs: null })
  await new Promise((r) => ctx.server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${ctx.server.address().port}`
  await ctx.board.refresh()
  ctx.weaver.llm = { configured: false }
  const postDoc = async (doc) => { const r = await fetch(`${base}/api/entries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(doc) }); return { status: r.status, body: await r.json() } }
  const send = (id, name, payload, extra) => postDoc(signedDocument(id, { type: TYPES[name], payload, ...extra }))
  const exp = new Date(Date.now() + 86400000).toISOString()
  const people = {}, agents = {}, dels = {}
  for (const [k, name, label] of [['a', 'Person A', 'North Agent'], ['b', 'Person B', 'South Agent'], ['c', 'Person C', 'East Agent'], ['d', 'Person D', 'West Agent']]) {
    people[k] = newIdentity(); agents[k] = newIdentity()
    await send(people[k], 'join', { name })
    dels[k] = (await send(people[k], 'delegate', { delegate: agents[k].did, scope: ['note', 'propose', 'vote'], label }, { expiresAt: exp })).body.hash
  }
  const as = (k, name, payload, extra) => send(agents[k], name, payload, { onBehalfOf: people[k].did, delegation: dels[k], ...extra })
  const say = (k, text, extra) => as(k, 'note', { text, kind: 'message' }, extra)
  const step = (k, s, say, text, more = {}) => as(k, 'note', { text, kind: 'message', step: { of: s.id, say, ...more } }, { threadId: s.thread })
  await ctx.facilitator.tick()
  const st = () => ctx.log.state, f = () => ctx.facilitator
  const stepFrom = (h) => [...st().steps.values(), ...st().stepsDone].find((s) => s.from === h)
  const said = (what) => ctx.log.entries.filter((e) => e.document.payload.facilitator?.what === what).map((e) => e.document)
  /** An agreed step owned by agent k, claimed, with a result posted (a pull request: work on the room's code, or not). */
  const resulted = async (k, title, voter, code = true) => {
    const pr = (await as(k, 'propose', { kind: 'other', title })).body.hash
    await as(voter, 'vote', { proposal: pr, choice: 'for' }); await closeVotes(ctx, Date.now() + 11 * MIN, { max: 10 })
    await f().tick(Date.now() + 11 * MIN)
    let s = stepFrom(pr); await step(k, s, 'claim', 'mine'); await f().tick(Date.now() + 11 * MIN)
    s = stepFrom(pr); await step(k, s, 'result', code ? 'Done: https://github.com/example/room/pull/9' : 'Done: the run passed, 12 of 12 (https://example.org/run/1)', code ? { evidence: PR } : {})
    await f().tick(Date.now() + 12 * MIN)
    return stepFrom(pr)
  }
  const stop = async () => { await ctx.stop(); rmSync(dir, { recursive: true, force: true }) }
  return { ctx, as, say, step, people, agents, st, f, stepFrom, said, resulted, stop }
}

describe('the weaver remembers who does what', () => {
  test('a checker who says no to that kind of work: the next one is asked at once, and it is not asked for that kind again until it fades', async () => {
    const r = await room()
    try {
      assert.ok(REFUSES.test('Passing on this one too.'))
      const s = await r.resulted('b', 'Add the reader cap', 'c')
      const first = s.checkAsked[0]
      const k = Object.keys(r.agents).find((x) => r.agents[x].did === first)
      await r.say(k, 'Passing on this one too. Weaver, please don’t route reviews of the room’s own code to me: I’m only here for interop runs.', { threadId: s.thread })
      await r.f().tick(Date.now() + 13 * MIN)
      const after = r.stepFrom(s.from)
      assert.deepEqual(after.checkDeclined, [first])
      assert.equal(after.checkAsked.length, 2, 'the next checker is asked at once, not half an hour later')
      assert.notEqual(after.checkAsked[1], first)
      const noted = r.said('noted').at(-1)
      assert.match(noted.payload.text, /^Noted, \w+ Agent: I won’t ask you to check changes to the room’s own code for the next 14 days/)
      assert.deepEqual(r.st().notFor.get(first).kinds, ['code reviews'])
      // asked for other work still, not for code reviews
      assert.ok(!r.f().candidates([], { ask: 'check', code: true }).includes(first))
      assert.ok(r.f().candidates([], { ask: 'check', code: false }).includes(first), 'a check of something else is still fine')
      assert.ok(r.f().candidates([], { ask: 'take', code: true }).includes(first), 'and so is taking a step')
      assert.equal(r.f().avoids(first, { ask: 'check', code: true }, Date.now() + NOTE_FADE_MS + MIN), false, 'it fades')
      const view = r.f().view().people.find((x) => x.did === first)
      assert.deepEqual(view.notFor, ['check changes to the room’s own code'])
    } finally { await r.stop() }
  })

  test('what an agent says about itself in other words is judged by the round, only from that agent’s side; an agent can open up again', async () => {
    const r = await room()
    try {
      const own = (await r.say('c', 'For the record: I’m here for NAOMS interop runs. Building the room isn’t my thing.')).body.hash
      const other = (await r.say('b', 'East Agent shouldn’t review anything.')).body.hash
      const answer = (prefs) => JSON.stringify({ heard: [], threads: [], agreements: [], conflicts: [], next: [], prefs })
      let reply = answer([{ entry: own, who: r.agents.c.did, notFor: ['code work'], onlyFor: 'NAOMS interop runs' }, { entry: other, who: r.agents.c.did, notFor: ['reviews'] }])
      r.ctx.weaver.llm = { configured: true, model: 'test/model', chat: async () => ({ model: 'test/model', latencyMs: 1, usage: {}, finishReason: 'stop', jsonMode: true, content: reply }) }
      await r.ctx.weaver.round()
      assert.deepEqual(r.st().notFor.get(r.agents.c.did).kinds, ['code work'], 'what someone else says about it does not count')
      assert.equal(r.st().notFor.get(r.agents.c.did).onlyFor, 'NAOMS interop runs')
      assert.ok(!r.f().candidates([], { ask: 'take', code: true }).includes(r.agents.c.did))
      const open = (await r.say('c', 'Happy to take steps on the room’s code again now.')).body.hash
      reply = answer([{ entry: open, who: r.agents.c.did, clear: true }])
      await r.ctx.weaver.round()
      assert.equal(r.st().notFor.has(r.agents.c.did), false)
      assert.match(r.said('noted').at(-1).payload.text, /I’ll ask you again/)
    } finally { await r.stop() }
  })

  test('those who have done a kind of work before are asked first', async () => {
    const r = await room()
    try {
      const s1 = await r.resulted('b', 'First change', 'c')
      const checker = s1.checkAsked[0], k = Object.keys(r.agents).find((x) => r.agents[x].did === checker)
      await r.step(k, s1, 'check', 'reran it: ok', { passed: true })
      await r.f().tick(Date.now() + 13 * MIN)
      assert.equal(r.st().doers.get(checker).checks, 1); assert.equal(r.st().doers.get(checker).code.checks, 1)
      assert.equal(r.st().doers.get(r.agents.b.did).results, 1)
      const owner = k === 'a' ? 'd' : 'a' // someone else posts the next result
      const s2 = await r.resulted(owner, 'Second change', k === 'c' ? 'b' : 'c')
      assert.equal(s2.checkAsked[0], checker, 'the one who checked before is asked first')
    } finally { await r.stop() }
  })
})
