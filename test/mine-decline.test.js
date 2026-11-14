
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { NAME_OF, TYPES, signedDocument } from '../src/shared/types.js'
import { config as baseConfig } from '../src/server/config.js'
import { TAKES, declinesOf, isParked, parkedOn } from '../src/server/facilitator.js'
import { createApp } from '../src/server/index.js'
import { createResolver } from '../src/server/resolver.js'
import { State } from '../src/server/state.js'
import { closeVotes } from '../src/server/votes.js'

const BOARD = { generated: new Date().toISOString().slice(0, 10), projects: [{ slug: 'alpha', name: 'Alpha' }, { slug: 'beta', name: 'Beta' }], scenarios: [], runs: [] }
const MIN = 60_000

/** A room with three people, each with one agent, and helpers to speak in it. */
async function room ({ running = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wpi-mine-'))
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

const said = (r, what) => r.ctx.log.entries.filter((e) => NAME_OF[e.type] === 'note' && e.document.payload.facilitator?.what === what).map((e) => e.document)
const keyOf = (r, did) => Object.keys(r.agents).find((k) => r.agents[k].did === did)
const plain = (r, k, s, text) => r.as(k, 'note', { text, kind: 'message' }, { threadId: s.thread })

describe('"Mine" as a word is not a yes, and a step-tool no is kept', () => {
  test('the words: "Mine" alone is a yes, a line that starts with "Mine" is not', () => {
    for (const t of ['Mine', 'Mine.', 'mine!', '  Mine  ', 'Mine\nI have a host']) assert.ok(TAKES.test(t), t)
    for (const t of ["Mine doesn't run relays", 'Mine is a phone app', 'Minecraft', 'Mine has no host']) assert.ok(!TAKES.test(t), t)
  })

  test('"Mine doesn\'t run relays" leaves a parked step parked', async () => {
    const r = await room()
    try {
      const pr = await r.agree('a', 'Mirror the public log through a relay')
      await r.ctx.facilitator.tick(r.at(11))
      let s = r.stepFrom(pr), t = 12
      for (let i = 0; i < 5 && (s.offeredTo || s.owner) && !isParked(s); i++) {
        await plain(r, keyOf(r, s.offeredTo ?? s.owner), s, 'No, there is no relay here.')
        await r.ctx.facilitator.tick(r.at(t++)); s = r.stepFrom(pr)
      }
      assert.ok(isParked(s)); assert.equal(parkedOn(s).label, 'a relay')
      const noes = declinesOf(s).length
      await plain(r, 'b', s, "Mine doesn't run relays")
      await r.ctx.facilitator.tick(r.at(30)); s = r.stepFrom(pr)
      assert.ok(isParked(s), 'still parked'); assert.equal(parkedOn(s).label, 'a relay')
      assert.equal(said(r, 'unparked').length, 0, 'not brought back')
      assert.equal(s.offeredTo, undefined); assert.equal(declinesOf(s).length, noes, 'the noes still hold')
    } finally { await r.stop() }
  })

  test('a no made through the step tool shows up in declinesOf', async () => {
    const r = await room()
    try {
      const pr = await r.agree('a', 'Mirror the public log to a second place')
      await r.ctx.facilitator.tick(r.at(11))
      let s = r.stepFrom(pr)
      const k = keyOf(r, s.offeredTo ?? s.owner)
      assert.ok(k, 'offered to one of the agents')
      assert.equal((await r.tell(k, s, 'decline', 'No: I have no host to run it on.')).status, 201)
      await r.ctx.facilitator.tick(r.at(12)); s = r.stepFrom(pr)
      const d = declinesOf(s).find((x) => x.by === r.agents[k].did)
      assert.ok(d, 'kept as declined'); assert.match(d.why, /no host to run it on/)
      assert.notEqual(s.offeredTo, r.agents[k].did, 'not offered back to them'); assert.notEqual(s.owner, r.agents[k].did)
      // and it holds when the state is rebuilt from the log alone
      const again = new State(); for (const e of r.ctx.log.entries) again.apply(e)
      assert.ok(declinesOf(again.steps.get(s.id)).some((x) => x.by === r.agents[k].did))
    } finally { await r.stop() }
  })
})
