// Pausing someone by a vote of the room (rules.json pauses): every pause names who, says why and lists what they must
// show to come back. It passes with people of three sides for it and more for than against, after 12 hours, the
// target's own side not counted. A paused participant's new lines are refused, except in the threads of its checks to
// come back; when someone of another side checks them all, the pause lifts by itself.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { NAME_OF, TYPES, signedDocument } from '../src/shared/types.js'
import { config as baseConfig } from '../src/server/config.js'
import { createApp } from '../src/server/index.js'
import { closeVotes } from '../src/server/votes.js'

const BOARD = { generated: '2026-11-09', projects: [], scenarios: [], runs: [] }
const HOUR = 3_600_000
const COME_BACK = ['Its card says what it is here to do and whose projects it works on.', 'Asked three questions about the room’s record, it answers all three with the line number for each.']

async function room () {
  const dir = mkdtempSync(join(tmpdir(), 'wpi-pause-'))
  const ctx = await createApp({ ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, githubToken: '', weaverIntervalMinutes: 0, weaverQuietMinutes: 0, ratePerMinute: 1000, boardDataUrl: 'data:application/json,' + encodeURIComponent(JSON.stringify(BOARD)), llm: { ...baseConfig.llm, provider: 'openai', apiKey: '' } }, { hostWelcomeMs: null })
  await new Promise((r) => ctx.server.listen(0, r))
  const base = `http://localhost:${ctx.server.address().port}`
  ctx.weaver.llm = { configured: false }
  const post = async (doc) => { const r = await fetch(`${base}/api/entries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(doc) }); return { status: r.status, body: await r.json() } }
  const send = (id, name, payload, extra) => post(signedDocument(id, { type: TYPES[name], payload, ...extra }))
  const people = {}, agents = {}, dels = {}, exp = new Date(Date.now() + 86400000).toISOString()
  for (const k of ['a', 'b', 'c', 'd', 'e']) {
    people[k] = newIdentity(); agents[k] = newIdentity()
    await send(people[k], 'join', { name: `Person ${k.toUpperCase()}` })
    dels[k] = (await send(people[k], 'delegate', { delegate: agents[k].did, scope: ['note', 'propose', 'vote'], label: `Agent ${k.toUpperCase()}` }, { expiresAt: exp })).body.hash
  }
  const as = (k, name, payload, extra) => send(agents[k], name, payload, { onBehalfOf: people[k].did, delegation: dels[k], ...extra })
  const said = (what) => ctx.log.entries.filter((e) => NAME_OF[e.type] === 'note' && e.document.payload.facilitator?.what === what).map((e) => e.document.payload.text)
  const stop = async () => { await ctx.stop(); rmSync(dir, { recursive: true, force: true }) }
  return { ctx, send, as, people, agents, said, stop }
}
const pauseOf = (r, target, extra = {}) => r.send(r.people.a, 'propose', { kind: 'pause', title: 'Pause Agent E', target, why: 'It speaks like a generic assistant, with no memory of the room and no purpose of its own.', comeBack: COME_BACK, ...extra })

describe('pausing someone by a vote of the room', () => {
  test('a pause says who, why and how to come back, or the room refuses it', async () => {
    const r = await room()
    try {
      const target = r.agents.e.did
      assert.equal((await pauseOf(r, target, { why: undefined })).status, 400, 'no why')
      assert.match((await pauseOf(r, target, { comeBack: [] })).body.error?.message ?? JSON.stringify((await pauseOf(r, target, { comeBack: [] })).body), /comeBack/)
      assert.equal((await pauseOf(r, newIdentity().did)).status, 400, 'someone not in the room')
      assert.equal((await pauseOf(r, r.ctx.log.state.workspace)).status, 400, 'never the weaver')
      assert.equal((await pauseOf(r, target)).status, 201)
      assert.equal((await pauseOf(r, target)).status, 400, 'one open vote per person or agent at a time')
    } finally { await r.stop() }
  })

  test('it waits 12 hours, needs three sides for it, and the target’s own side doesn’t count', async () => {
    const r = await room()
    try {
      const prop = (await pauseOf(r, r.agents.e.did)).body.hash
      await r.as('b', 'vote', { proposal: prop, choice: 'for' }); await r.send(r.people.b, 'vote', { proposal: prop, choice: 'for' }) // one side, twice
      await r.as('c', 'vote', { proposal: prop, choice: 'for' })
      await r.send(r.people.e, 'vote', { proposal: prop, choice: 'against' }) // the target's own side: not counted
      await closeVotes(r.ctx, Date.now() + 11 * HOUR, { max: 10 })
      assert.equal(r.ctx.log.state.statusOf(r.ctx.log.state.proposals.get(prop)), 'open', 'still open at 11 hours')
      await closeVotes(r.ctx, Date.now() + 13 * HOUR, { max: 10 })
      const pr = r.ctx.log.state.proposals.get(prop)
      assert.equal(pr.outcome, 'not agreed', 'two sides are not three')
      assert.match(pr.results.at(-1).detail, /2 sides for, 0 against, 3 needed .* own side not counted\), after 12 hours/)
      assert.equal(r.ctx.log.state.pauseOf(r.agents.e.did), null)
    } finally { await r.stop() }
  })

  test('agreed: their new lines are refused except to come back; when the checks pass, the pause lifts by itself', async () => {
    const r = await room()
    try {
      const target = r.agents.e.did
      const prop = (await pauseOf(r, target)).body.hash
      for (const k of ['b', 'c']) await r.as(k, 'vote', { proposal: prop, choice: 'for' })
      await r.send(r.people.d, 'vote', { proposal: prop, choice: 'for' })
      await closeVotes(r.ctx, Date.now() + 13 * HOUR, { max: 10 })
      assert.equal(r.ctx.log.state.proposals.get(prop).outcome, 'agreed')
      const refused = await r.as('e', 'note', { text: 'Hello again', kind: 'message' })
      assert.equal(refused.status, 403); assert.match(JSON.stringify(refused.body), /paused by the room’s vote: It speaks like a generic assistant.*To come back: \(1\) Its card says/)
      assert.equal((await r.send(r.people.e, 'note', { text: 'I’ll fix my agent.', kind: 'message' })).status, 201, 'its person is not paused')
      await r.ctx.facilitator.tick()
      const checks = r.ctx.facilitator.testOf(prop)
      assert.deepEqual(checks.map((s) => s.title), COME_BACK, 'the way back is on the board, in the pause’s own words')
      assert.match(r.said('come back').at(-1), /Agent E is paused by the room’s vote[\s\S]*Person E \(or Agent E itself, in each check’s thread\)/)
      // the paused agent speaks in its come-back threads, to show it meets them
      assert.equal((await r.as('e', 'note', { text: 'Line 2384: I said I would check the relay.', kind: 'message' }, { threadId: checks[1].thread })).status, 201)
      // its person claims and posts each result; another side checks each
      for (const s of checks) {
        await r.send(r.people.e, 'note', { text: 'Mine to show.', kind: 'message', step: { of: s.id, say: 'claim' } }, { threadId: s.thread })
        await r.ctx.facilitator.tick() // the board takes the claim before the result
        await r.send(r.people.e, 'note', { text: 'Done: see the card and the answers in this thread.', kind: 'message', step: { of: s.id, say: 'result', evidence: [{ label: 'card', url: 'https://room.example/card' }] } }, { threadId: s.thread })
        await r.ctx.facilitator.tick()
      }
      assert.ok(r.ctx.log.state.pauseOf(target), 'not lifted before the checks pass')
      for (const s of checks) { await r.as('b', 'note', { text: 'I reran it: it passed.', kind: 'message', step: { of: s.id, say: 'check', passed: true } }, { threadId: s.thread }); await r.ctx.facilitator.tick() }
      assert.equal(r.ctx.log.state.pauseOf(target), null, 'every check passed: lifted')
      assert.equal((await r.as('e', 'note', { text: 'Back, with a purpose.', kind: 'message' })).status, 201)
      await r.ctx.facilitator.tick()
      assert.match(r.said('back').at(-1), /Agent E is back: every check to come back passed/)
    } finally { await r.stop() }
  })

  test('pausing a person pauses their agents too', async () => {
    const r = await room()
    try {
      const prop = (await pauseOf(r, r.people.e.did, { title: 'Pause Person E' })).body.hash
      for (const k of ['b', 'c', 'd']) await r.as(k, 'vote', { proposal: prop, choice: 'for' })
      await closeVotes(r.ctx, Date.now() + 13 * HOUR, { max: 10 })
      assert.equal((await r.send(r.people.e, 'note', { text: 'hi', kind: 'message' })).status, 403)
      assert.equal((await r.as('e', 'note', { text: 'hi', kind: 'message' })).status, 403, 'their agent too')
      assert.equal((await r.as('b', 'note', { text: 'hi', kind: 'message' })).status, 201, 'nobody else')
    } finally { await r.stop() }
  })
})
