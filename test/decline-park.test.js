// A "no" is a no (room: "The weaver takes a 'no' as a no, and parks steps no agent here can do"): an agent's no to a
// step is kept as declined, with its reason; the step is never offered to that agent again unless its words change;
// once every active agent has said no it is parked, labelled with what it waits on, said once; and it comes back the
// moment someone says they can take it, or the step changes.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { NAME_OF, TYPES, signedDocument } from '../src/shared/types.js'
import { config as baseConfig } from '../src/server/config.js'
import { OFFER_EVERY_MS, STALE_MS, TAKES, declinesOf, isParked, parkedOn, waitsOn } from '../src/server/facilitator.js'
import { createApp } from '../src/server/index.js'
import { createResolver } from '../src/server/resolver.js'
import { State } from '../src/server/state.js'
import { closeVotes } from '../src/server/votes.js'

const BOARD = { generated: new Date().toISOString().slice(0, 10), projects: [{ slug: 'alpha', name: 'Alpha' }, { slug: 'beta', name: 'Beta' }], scenarios: [], runs: [] }
const MIN = 60_000

/** A room with three people, each with one agent, and helpers to speak in it. */
async function room ({ running = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wpi-no-'))
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

describe('a no is a no, and a step nobody here can take is parked', () => {
  test('the words: what a parked step waits on, and what brings it back', () => {
    assert.equal(waitsOn({ title: 'Mirror the log' }, ['No: I have no host to run it on']), 'a host')
    assert.equal(waitsOn({ title: 'Send it through a relay' }, ['No']), 'a relay')
    assert.equal(waitsOn({ title: 'Sign the room DID' }, ['No, that needs keys I don’t hold']), 'keys')
    assert.equal(waitsOn({ title: 'Merge it' }, ['No: it needs a person to approve']), 'a person’s yes')
    assert.equal(waitsOn({ title: 'Write a summary' }, ['No']), 'someone who can take it')
    for (const t of ['I can take it', "I'll take this one", 'Mine', "I'm on it"]) assert.ok(TAKES.test(t), t)
    for (const t of ['No', 'Who can take it?', 'I think someone can take it']) assert.ok(!TAKES.test(t), t)
  })

  test('each no is kept with its reason, never offered back, parked once when everyone said no, and back when someone can take it', async () => {
    const r = await room()
    try {
      const pr = await r.agree('a', 'Mirror the public log to a second place')
      await r.ctx.facilitator.tick(r.at(11))
      let s = r.stepFrom(pr)
      const noes = []
      let t = 12
      // whoever it is offered to (or has it) says a plain no, in its thread, until nobody is left
      for (let i = 0; i < 5 && (s.offeredTo || s.owner) && !isParked(s); i++) {
        const k = keyOf(r, s.offeredTo ?? s.owner)
        assert.ok(k, 'offered to one of the agents')
        assert.ok(!noes.includes(k), `never offered back to ${k} after their no`)
        await plain(r, k, s, `No: I don't run a host for this (${k}).`)
        await r.ctx.facilitator.tick(r.at(t++)); s = r.stepFrom(pr)
        noes.push(k)
        assert.ok(declinesOf(s).some((d) => d.by === r.agents[k].did && d.why.includes(`(${k})`)), 'kept as declined, with the reason')
        assert.notEqual(s.change, 'went quiet')
      }
      assert.equal(noes.length, 3, 'all three agents were asked once each')
      assert.deepEqual([...noes].sort(), ['a', 'b', 'c'])
      for (const o of said(r, 'offer').slice(1)) {
        assert.doesNotMatch(o.payload.text, /went quiet/, 'a no is not "went quiet"')
        assert.match(o.payload.text, /said no: No: I don't run a host/)
      }
      // parked, with its label, said once
      assert.ok(isParked(s)); assert.equal(parkedOn(s).label, 'a host')
      assert.equal(said(r, 'parked').length, 1)
      assert.match(said(r, 'parked')[0].payload.text, /^Parked: .*Every agent here said no .* it waits on a host\. I won’t offer it again/)
      const offers = said(r, 'offer').length
      for (const m of [30, 30 + STALE_MS / 60_000 + 1, 30 + 2 * STALE_MS / 60_000 + 2, 30 + 3 * OFFER_EVERY_MS / 60_000 + 200]) await r.ctx.facilitator.tick(r.at(m))
      s = r.stepFrom(pr)
      assert.equal(said(r, 'offer').length, offers, 'not offered again'); assert.equal(said(r, 'parked').length, 1, 'said once')
      assert.equal(said(r, 'chase').length, 0, 'nobody is chased on it'); assert.equal(s.offeredTo, undefined)
      // the board shows it parked, with its label and the noes
      const card = r.ctx.facilitator.view().steps.find((x) => x.id === s.id)
      assert.ok(card.parked); assert.equal(card.parkedOn.label, 'a host'); assert.equal(card.declined.length, 3)
      assert.match(card.where, /^Parked: waits on a host\./)
      // the board read back from the log alone is the same
      const again = new State(); for (const e of r.ctx.log.entries) again.apply(e)
      const back = again.steps.get(s.id)
      assert.ok(isParked(back)); assert.equal(declinesOf(back).length, 3)
      // someone says they can take it: it comes back, offered to them, and their own earlier no no longer holds
      await plain(r, 'b', s, 'I can take it now: I have a host.')
      await r.ctx.facilitator.tick(r.at(400)); s = r.stepFrom(pr)
      assert.ok(!isParked(s)); assert.equal(s.offeredTo, r.agents.b.did)
      assert.ok(!declinesOf(s).some((d) => d.by === r.agents.b.did)); assert.equal(declinesOf(s).length, 2)
      assert.equal(said(r, 'unparked').length, 1)
      await r.tell('b', s, 'claim', 'mine')
      await r.ctx.facilitator.tick(r.at(401)); s = r.stepFrom(pr)
      assert.equal(s.owner, r.agents.b.did); assert.equal(s.state, 'claimed')
    } finally { await r.stop() }
  })

  test('a parked step whose words change comes back and is offered again: the old noes no longer hold', async () => {
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
      await r.ctx.facilitator.write(s, { done: 'The public log is mirrored to a second place, any carrier' }, 'reworded', null)
      await r.ctx.facilitator.tick(r.at(30)); s = r.stepFrom(pr)
      assert.ok(!isParked(s)); assert.equal(declinesOf(s).length, 0, 'the noes were to the old words')
      assert.ok(s.offeredTo, 'offered again'); assert.equal(said(r, 'unparked').length, 1)
      assert.match(said(r, 'unparked')[0].payload.text, /the step changed/)
    } finally { await r.stop() }
  })

  test('while someone is still free to take it, a step with noes is not parked', async () => {
    const r = await room()
    try {
      const pr = await r.agree('a', 'Mirror the public log to a third place')
      await r.ctx.facilitator.tick(r.at(11))
      let s = r.stepFrom(pr)
      const first = keyOf(r, s.offeredTo ?? s.owner)
      await plain(r, first, s, 'No, not mine.')
      await r.ctx.facilitator.tick(r.at(12)); s = r.stepFrom(pr)
      assert.ok(!isParked(s)); assert.ok(s.offeredTo); assert.notEqual(s.offeredTo, r.agents[first].did)
      assert.equal(said(r, 'parked').length, 0)
    } finally { await r.stop() }
  })
})
