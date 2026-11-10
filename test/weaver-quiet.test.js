// The board is the queue: the weaver posts only when an item changes or needs someone, and then once.
// No "Listening." rounds, and a goal's status only when one of its checks moved.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { NAME_OF, TYPES, signedDocument } from '../src/shared/types.js'
import { roundText, silentRound } from '../src/shared/round.js'
import { config as baseConfig } from '../src/server/config.js'
import { createApp } from '../src/server/index.js'
import { createResolver } from '../src/server/resolver.js'
import { concerns, messages } from '../src/server/views.js'
import { closeVotes } from '../src/server/votes.js'

const BOARD = { generated: new Date().toISOString().slice(0, 10), projects: [{ slug: 'alpha', name: 'Alpha' }, { slug: 'beta', name: 'Beta' }], scenarios: [], runs: [] }
const MIN = 60_000

async function room () {
  const dir = mkdtempSync(join(tmpdir(), 'wpi-quiet-'))
  const config = { ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, githubToken: '', weaverIntervalMinutes: 0, weaverQuietMinutes: 0, ratePerMinute: 1000, voteMinutes: 10, publicUrl: 'https://interop.example', boardDataUrl: 'data:application/json,' + encodeURIComponent(JSON.stringify(BOARD)), llm: { ...baseConfig.llm, provider: 'openai', apiKey: '' } }
  const ctx = await createApp(config, { openRoom: true, resolver: createResolver(), hostWelcomeMs: null })
  await new Promise((r) => ctx.server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${ctx.server.address().port}`
  await ctx.board.refresh()
  ctx.weaver.llm = { configured: false }
  const send = async (id, name, payload, extra) => { const r = await fetch(`${base}/api/entries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signedDocument(id, { type: TYPES[name], payload, ...extra })) }); return { status: r.status, body: await r.json() } }
  const people = {}, agents = {}, dels = {}
  const exp = new Date(Date.now() + 86400000).toISOString()
  for (const [key, name, label] of [['a', 'Person A', 'North Agent'], ['b', 'Person B', 'South Agent']]) {
    people[key] = newIdentity(); agents[key] = newIdentity()
    assert.equal((await send(people[key], 'join', { name })).status, 201)
    dels[agents[key].did] = (await send(people[key], 'delegate', { delegate: agents[key].did, scope: ['note', 'propose', 'vote'], label }, { expiresAt: exp })).body.hash
  }
  const as = (k, name, payload, extra) => send(agents[k], name, payload, { onBehalfOf: people[k].did, delegation: dels[agents[k].did], ...extra })
  const said = (what) => ctx.log.entries.filter((e) => NAME_OF[e.type] === 'note' && e.document.payload.facilitator?.what === what).map((e) => e.document)
  const at = (minutes) => Date.now() + minutes * MIN
  await ctx.facilitator.tick()
  const stop = async () => { await ctx.stop(); rmSync(dir, { recursive: true, force: true }) }
  return { ctx, send, as, people, agents, said, at, stop }
}

describe('the weaver says nothing when nothing changed', () => {
  test('a round with nothing for anyone has no words', () => {
    assert.equal(roundText({ next: [], connections: [] }), '')
    assert.ok(silentRound({}))
    assert.ok(silentRound({ next: [], connections: [], facilitate: { pressed: ['x'] } }))
    assert.equal(roundText({ next: [{ action: 'Say what winning looks like here' }] }), 'Next: Say what winning looks like here')
    assert.ok(!silentRound({ connections: [{ between: ['a', 'b'], why: 'both talk about MLS' }] }))
  })

  test('a facilitate round that only presses a line is a record: no "Listening." line, and it wakes no one', async () => {
    const r = await room()
    try {
      const goal = (await r.send(r.people.a, 'propose', { kind: 'goal', title: 'Geb and Keyring members read each other in one MLS group' })).body.hash
      await r.send(r.people.a, 'vote', { proposal: goal, choice: 'for' })
      await r.ctx.facilitator.tick(r.at(0))
      const vague = (await r.as('a', 'note', { text: 'I got the group thing working on my side', kind: 'message' })).body.hash
      const answer = { heard: [], threads: [], agreements: [], conflicts: [], connections: [], next: [], vague: [{ entry: vague, missing: 'command', ask: 'Which command did you run, and what did it print?' }], converged: [] }
      r.ctx.weaver.llm = { configured: true, model: 'test/model', chat: async () => ({ model: 'test/model', latencyMs: 1, usage: {}, finishReason: 'stop', jsonMode: true, content: JSON.stringify(answer) }) }
      const round = await r.ctx.weaver.round()
      assert.ok(round, 'the round is still kept as a record')
      assert.ok(silentRound(round.document.payload))
      assert.equal(r.said('press').length, 1, 'the press is its own line, naming what is missing')
      for (const k of ['a', 'b']) {
        const items = messages(r.ctx, { me: r.agents[k].did, limit: 100 }).items
        assert.ok(!items.some((m) => m.text === 'Listening.' || m.type === 'round'), 'no weaver line for a silent round')
        assert.equal(concerns(r.ctx, round, r.agents[k].did), null)
      }
      assert.ok(!r.ctx.log.entries.some((e) => JSON.stringify(e.document.payload).includes('Listening.')))
    } finally { await r.stop() }
  })

  test('the report names only the item that moved, once, and no goal status whose checks did not move', async () => {
    const r = await room()
    try {
      const goal = (await r.send(r.people.a, 'propose', { kind: 'goal', title: 'Geb and Keyring members read each other in one MLS group' })).body.hash
      await r.send(r.people.a, 'vote', { proposal: goal, choice: 'for' })
      await r.ctx.facilitator.tick(r.at(0))
      // an agreement opens a step; its own line names it, so no report repeats it
      const pr = (await r.as('a', 'propose', { kind: 'other', title: 'Write the shared glossary of interop words' })).body.hash
      await r.as('b', 'vote', { proposal: pr, choice: 'for' })
      await closeVotes(r.ctx, r.at(11), { max: 10 })
      await r.ctx.facilitator.tick(r.at(12))
      const step = [...r.ctx.log.state.steps.values()].find((s) => s.from === pr)
      assert.ok(step, 'the agreement became a step')
      await r.ctx.facilitator.tick(r.at(25))
      assert.equal(r.said('report').length, 0, 'opening was already said in its own line')
      // it is claimed: one report, naming that step, with no goal-status line (no check moved)
      await r.as('b', 'note', { text: 'I take it', kind: 'message', step: { of: step.id, say: 'claim' } }, { threadId: step.thread })
      await r.ctx.facilitator.tick(r.at(15)) // gathered ten minutes, before its chase time
      const reports = r.said('report')
      assert.equal(reports.length, 1)
      assert.match(reports[0].payload.text, /shared glossary/)
      assert.doesNotMatch(reports[0].payload.text, /of \d+ checked/, 'no goal status: none of its checks moved')
      assert.deepEqual(reports[0].payload.facilitator.steps, [step.id], 'the report names the item it is about')
      // it stalls past its chase time: the chase is its one line, and the report does not repeat it
      await r.ctx.facilitator.tick(r.at(60))
      assert.equal(r.said('chase').length, 1)
      await r.ctx.facilitator.tick(r.at(75))
      assert.equal(r.said('report').length, 1, 'the claim was said once; the chase is not reported again')
    } finally { await r.stop() }
  })
})
