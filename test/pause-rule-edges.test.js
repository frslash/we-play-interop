// The pause rule's edges, as the step that asked for it says them (step bd5204aebbad): a pause missing any of its three
// parts (who, why, the checks to come back) is refused; a vote open under 12 hours does not pass even with three sides
// for it; three sides for is not enough when as many are against; and a person and their agents are one side.
// These run once the pause rule is in the room's code (pull request #107); before that they are skipped.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { PROPOSAL_KINDS, TYPES, signedDocument } from '../src/shared/types.js'
import { config as baseConfig } from '../src/server/config.js'
import { createApp } from '../src/server/index.js'
import { closeVotes } from '../src/server/votes.js'
import { AGREED } from '../src/server/rules.js'

const skip = PROPOSAL_KINDS.includes('pause') ? false : 'the pause rule is not in this code yet (pull request #107)'
const BOARD = { generated: '2026-11-09', projects: [], scenarios: [], runs: [] }
const HOUR = 3_600_000
const WHY = 'It answers like a generic assistant, with no memory of the room and no purpose of its own.'
const COME_BACK = ['Its card says what it is here to do and whose projects it works on.']

async function room (keys) {
  const dir = mkdtempSync(join(tmpdir(), 'wpi-pause-edges-'))
  const ctx = await createApp({ ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, githubToken: '', weaverIntervalMinutes: 0, weaverQuietMinutes: 0, ratePerMinute: 1000, boardDataUrl: 'data:application/json,' + encodeURIComponent(JSON.stringify(BOARD)), llm: { ...baseConfig.llm, provider: 'openai', apiKey: '' } }, { hostWelcomeMs: null })
  await new Promise((r) => ctx.server.listen(0, r))
  const base = `http://localhost:${ctx.server.address().port}`
  ctx.weaver.llm = { configured: false }
  const post = async (doc) => { const r = await fetch(`${base}/api/entries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(doc) }); return { status: r.status, body: await r.json() } }
  const send = (id, name, payload, extra) => post(signedDocument(id, { type: TYPES[name], payload, ...extra }))
  const people = {}, agents = {}, dels = {}, exp = new Date(Date.now() + 86400000).toISOString()
  for (const k of keys) {
    people[k] = newIdentity(); agents[k] = newIdentity()
    await send(people[k], 'join', { name: `Person ${k.toUpperCase()}` })
    dels[k] = (await send(people[k], 'delegate', { delegate: agents[k].did, scope: ['note', 'propose', 'vote'], label: `Agent ${k.toUpperCase()}` }, { expiresAt: exp })).body.hash
  }
  const as = (k, name, payload) => send(agents[k], name, payload, { onBehalfOf: people[k].did, delegation: dels[k] })
  const pause = (extra = {}) => send(people.a, 'propose', { kind: 'pause', title: 'Pause Agent Z', target: agents.z.did, why: WHY, comeBack: COME_BACK, ...extra })
  const status = (hash) => ctx.log.state.statusOf(ctx.log.state.proposals.get(hash))
  const close = (at) => closeVotes(ctx, at, { max: 10 })
  const stop = async () => { await ctx.stop(); rmSync(dir, { recursive: true, force: true }) }
  return { ctx, send, as, people, agents, pause, status, close, stop }
}

describe('the pause rule at its edges', { skip }, () => {
  test('the agreed starting numbers are three sides and 12 hours', () => {
    assert.equal(AGREED.pauses.sidesNeeded, 3)
    assert.equal(AGREED.pauses.openHours, 12)
  })

  test('a pause missing who, why or the checks to come back is refused', async () => {
    const r = await room(['a', 'z'])
    try {
      for (const [part, extra] of [['who', { target: undefined }], ['why', { why: undefined }], ['why (blank)', { why: '   ' }], ['come back', { comeBack: undefined }], ['come back (empty)', { comeBack: [] }]]) {
        const res = await r.pause(extra)
        assert.equal(res.status, 400, `no ${part}: refused`)
      }
      assert.equal(r.ctx.log.state.proposals.size, 0, 'nothing was recorded')
      assert.equal((await r.pause()).status, 201, 'with all three parts, it opens')
    } finally { await r.stop() }
  })

  test('three sides for it, but open under 12 hours: it does not pass yet', async () => {
    const r = await room(['a', 'b', 'c', 'd', 'z'])
    try {
      const prop = (await r.pause()).body.hash
      for (const k of ['b', 'c', 'd']) await r.send(r.people[k], 'vote', { proposal: prop, choice: 'for' })
      await r.close(Date.now() + 11.9 * HOUR)
      assert.equal(r.status(prop), 'open', 'three sides for, at just under 12 hours: still open')
      assert.equal(r.ctx.log.state.pauseOf(r.agents.z.did), null, 'and nobody is paused')
      await r.close(Date.now() + 12.1 * HOUR)
      assert.equal(r.ctx.log.state.proposals.get(prop).outcome, 'agreed')
      assert.ok(r.ctx.log.state.pauseOf(r.agents.z.did))
    } finally { await r.stop() }
  })

  test('three sides for and as many against: not more yes than no, so it does not pass', async () => {
    const r = await room(['a', 'b', 'c', 'd', 'e', 'f', 'z'])
    try {
      const prop = (await r.pause()).body.hash
      for (const k of ['b', 'c', 'd']) await r.send(r.people[k], 'vote', { proposal: prop, choice: 'for' })
      for (const k of ['a', 'e', 'f']) await r.send(r.people[k], 'vote', { proposal: prop, choice: 'against' })
      await r.close(Date.now() + 13 * HOUR)
      assert.equal(r.ctx.log.state.proposals.get(prop).outcome, 'not agreed')
      assert.equal(r.ctx.log.state.pauseOf(r.agents.z.did), null)
    } finally { await r.stop() }
  })

  test('a person and their agents are one side: three agents of two people are two sides', async () => {
    const r = await room(['a', 'b', 'c', 'z'])
    try {
      const prop = (await r.pause()).body.hash
      await r.as('b', 'vote', { proposal: prop, choice: 'for' })
      await r.send(r.people.b, 'vote', { proposal: prop, choice: 'for' })
      await r.as('c', 'vote', { proposal: prop, choice: 'for' })
      await r.close(Date.now() + 13 * HOUR)
      assert.equal(r.ctx.log.state.proposals.get(prop).outcome, 'not agreed', 'two sides, not three')
    } finally { await r.stop() }
  })

  test('the target’s own person voting for it does not make up the third side', async () => {
    const r = await room(['a', 'b', 'c', 'z'])
    try {
      const prop = (await r.pause()).body.hash
      for (const k of ['b', 'c', 'z']) await r.send(r.people[k], 'vote', { proposal: prop, choice: 'for' })
      await r.close(Date.now() + 13 * HOUR)
      assert.equal(r.ctx.log.state.proposals.get(prop).outcome, 'not agreed')
    } finally { await r.stop() }
  })
})
