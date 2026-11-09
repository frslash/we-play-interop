// Steps and goal checks are data the weaver edits (src/server/facilitator.js: edit). Anyone asks for new words with a
// signed note; the weaver writes a step line carrying the old words, the new words, who and why; anyone can undo it; and
// a change to a goal's check waits until an agent of a different person confirms it. The Workshop tab lists every edit.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { held, whyNot } from '../src/shared/steps.js'
import { checkPayload, NAME_OF, TYPES, signedDocument } from '../src/shared/types.js'
import { config as baseConfig } from '../src/server/config.js'
import { createApp } from '../src/server/index.js'
import { createResolver } from '../src/server/resolver.js'
import { closeVotes } from '../src/server/votes.js'

const BOARD = { generated: new Date().toISOString().slice(0, 10), projects: [], scenarios: [], runs: [] }
const MIN = 60_000

async function room () {
  const dir = mkdtempSync(join(tmpdir(), 'wpi-edits-'))
  const config = { ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, githubToken: '', weaverIntervalMinutes: 0, weaverQuietMinutes: 0, ratePerMinute: 1000, voteMinutes: 10, publicUrl: 'https://interop.example', boardDataUrl: 'data:application/json,' + encodeURIComponent(JSON.stringify(BOARD)), llm: { ...baseConfig.llm, provider: 'openai', apiKey: '' } }
  const ctx = await createApp(config, { resolver: createResolver(), hostWelcomeMs: null, wakeFetch: async () => ({ ok: true, status: 200 }), gh: async () => [] })
  await new Promise((r) => ctx.server.listen(0, r))
  const base = `http://localhost:${ctx.server.address().port}`
  await ctx.board.refresh()
  ctx.weaver.llm = { configured: false }
  const postDoc = async (doc) => { const r = await fetch(`${base}/api/entries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(doc) }); return { status: r.status, body: await r.json() } }
  const send = (id, name, payload, extra) => postDoc(signedDocument(id, { type: TYPES[name], payload, ...extra }))
  const exp = new Date(Date.now() + 86400000).toISOString()
  const people = {}, agents = {}, dels = {}
  for (const [k, name, label] of [['a', 'Person A', 'North Agent'], ['b', 'Person B', 'South Agent']]) {
    people[k] = newIdentity(); agents[k] = newIdentity()
    await send(people[k], 'join', { name })
    dels[k] = (await send(people[k], 'delegate', { delegate: agents[k].did, scope: ['note', 'propose', 'vote'], label }, { expiresAt: exp })).body.hash
  }
  const as = (k, name, payload, extra) => send(agents[k], name, payload, { onBehalfOf: people[k].did, delegation: dels[k], ...extra })
  const f = () => ctx.facilitator
  await f().tick()
  const st = () => ctx.log.state
  const find = (id) => f().find(id)
  const stepNote = (k, s, step, text) => as(k, 'note', { text, kind: 'message', step: { of: s.id, ...step } }, { threadId: s.thread })
  const byPerson = (k, s, step, text) => send(people[k], 'note', { text, kind: 'message', step: { of: s.id, ...step } }, { threadId: s.thread })
  const tick = () => f().tick()
  const workshop = async () => (await fetch(`${base}/api/workshop`)).json()
  const steps = async () => (await fetch(`${base}/api/steps`)).json()
  const agreed = async () => {
    const pr = (await as('a', 'propose', { kind: 'other', title: 'Make the board editable as data' })).body.hash
    await as('b', 'vote', { proposal: pr, choice: 'for' }); await closeVotes(ctx, Date.now() + 11 * MIN, { max: 10 }); await tick()
    return [...st().steps.values()].find((s) => s.from === pr)
  }
  const goal = async () => {
    const g = (await send(people.a, 'propose', { kind: 'goal', title: 'Goal 2: the room moves onto encrypted spaces its people hold' })).body.hash
    await send(people.a, 'vote', { proposal: g, choice: 'for' }); await tick(); return g
  }
  const stop = async () => { await ctx.stop(); rmSync(dir, { recursive: true, force: true }) }
  return { ctx, send, as, people, agents, st, find, stepNote, byPerson, tick, workshop, steps, agreed, goal, stop }
}

describe('steps and goal checks are data the weaver edits', () => {
  test('the shapes: edit needs new words, undo and confirm name an edit', () => {
    const note = (step) => checkPayload('note', { payload: { text: 'why', kind: 'message', step } })
    const of = 'a'.repeat(64)
    assert.match(note({ of, say: 'edit' }), /title or step.done/)
    assert.match(note({ of, say: 'edit', title: 'x' }), /3 to 300/)
    assert.equal(note({ of, say: 'edit', title: 'Run the tests again' }), null)
    assert.match(note({ of, say: 'undo' }), /step.edit/)
    assert.equal(note({ of, say: 'confirm', edit: 'b'.repeat(64) }), null)
    assert.equal(held({ title: 'a step' }, { title: {} }), false)
    assert.equal(held({ title: 'a step' }, { done: {} }), true)
    assert.equal(held({ title: 'a check', test: { n: 1 } }, { title: {} }), true)
    const personOf = (d) => ({ agentA: 'A', agentB: 'B' }[d] ?? d)
    const s = { state: 'open', pendingEdits: [{ id: 'c'.repeat(64), by: 'agentA' }] }
    assert.match(whyNot(s, { say: 'confirm' }, 'A', personOf), /not a person/)
    assert.match(whyNot(s, { say: 'confirm' }, 'agentA', personOf), /another person than the one who asked/)
    assert.equal(whyNot(s, { say: 'confirm' }, 'agentB', personOf), null)
    assert.match(whyNot({ state: 'checked' }, { say: 'edit' }, 'A', personOf), /done/)
  })

  test('anyone rewords a step: a signed line with old words, new words, who and why, shown on the Workshop tab, and undone', async () => {
    const r = await room()
    try {
      const s = await r.agreed()
      assert.ok(s, 'the agreement has its step')
      const old = s.title
      const ask = (await r.byPerson('b', s, { say: 'edit', title: 'Store steps and goal checks as signed log lines' }, 'shorter and plainer')).body
      await r.tick()
      const now = r.find(s.id)
      assert.equal(now.title, 'Store steps and goal checks as signed log lines')
      assert.equal(now.change, 'edited')
      const line = r.ctx.log.byHash.get(now.hash)
      assert.equal(NAME_OF[line.type], 'step'); assert.equal(line.author, r.st().workspace)
      assert.ok(line.document.proof, 'the weaver signs it')
      assert.deepEqual(line.document.payload.edit, { id: ask.hash, fields: { title: { old, new: now.title } }, by: r.people.b.did, why: 'shorter and plainer' })
      assert.ok((await r.ctx.log.verify()).ok, 'the log still verifies')

      const w = await r.workshop()
      const e = w.edits.find((x) => x.id === ask.hash)
      assert.equal(e.status, 'applied'); assert.equal(e.byName, 'Person B'); assert.equal(e.why, 'shorter and plainer'); assert.equal(e.fields.title.old, old)

      // someone else undoes it
      assert.equal((await r.stepNote('a', r.find(s.id), { say: 'undo', edit: ask.hash }, 'the old words named the room')).status, 201)
      await r.tick()
      assert.equal(r.find(s.id).title, old)
      assert.equal(r.find(s.id).change, 'undone')
      const after = (await r.workshop()).edits
      assert.equal(after.find((x) => x.id === ask.hash).status, 'undone')
      assert.equal(after.find((x) => x.id === ask.hash).undoneByName, 'North Agent')
      assert.equal(after[0].undoes, ask.hash)
      // an undo is not undone again
      const seq = r.find(s.id).seq
      await r.byPerson('b', r.find(s.id), { say: 'undo', edit: after[0].id }, 'redo'); await r.tick()
      assert.equal(r.find(s.id).seq, seq)
    } finally { await r.stop() }
  })

  test('a change to a goal check waits until an agent of a different person confirms it', async () => {
    const r = await room()
    try {
      const g = await r.goal()
      const one = r.ctx.facilitator.testOf(g).find((x) => x.test.n === 1)
      const old = one.title, looser = 'Private notebooks live in sealed rooms.'
      const ask = (await r.stepNote('a', one, { say: 'edit', title: looser }, 'the community room part is a later check')).body
      await r.tick()
      let now = r.find(one.id)
      assert.equal(now.title, old, 'held: the words have not changed')
      assert.equal(now.change, 'edit held')
      assert.equal(now.pendingEdits.length, 1)
      assert.deepEqual(now.pendingEdits[0].fields, { title: { old, new: looser }, done: { old: one.done, new: looser } })
      assert.equal((await r.steps()).goals[0].test.find((x) => x.id === one.id).pendingEdits[0].byName, 'North Agent')
      assert.equal((await r.workshop()).edits.find((x) => x.id === ask.hash).status, 'pending')

      // its own person, and its own side's agent, don't confirm it
      await r.byPerson('a', now, { say: 'confirm', edit: ask.hash }, 'yes'); await r.tick()
      await r.byPerson('b', now, { say: 'confirm', edit: ask.hash }, 'yes, as a person'); await r.tick()
      await r.stepNote('a', now, { say: 'confirm', edit: ask.hash }, 'my own'); await r.tick()
      now = r.find(one.id)
      assert.equal(now.title, old); assert.equal(now.pendingEdits.length, 1)

      // an agent of another person does
      await r.stepNote('b', now, { say: 'confirm', edit: ask.hash }, 'agreed in the room'); await r.tick()
      now = r.find(one.id)
      assert.equal(now.title, looser); assert.equal(now.done, looser); assert.equal(now.change, 'edit confirmed')
      assert.equal(now.pendingEdits, undefined)
      const e = (await r.workshop()).edits.find((x) => x.id === ask.hash)
      assert.equal(e.status, 'applied'); assert.equal(e.confirmedByName, 'South Agent'); assert.equal(e.held, true)

      // a held edit can be withdrawn by anyone
      const ask2 = (await r.stepNote('b', now, { say: 'edit', title: 'Anything at all' }, 'test')).body
      await r.tick()
      await r.byPerson('a', r.find(one.id), { say: 'undo', edit: ask2.hash }, 'no'); await r.tick()
      now = r.find(one.id)
      assert.equal(now.title, looser); assert.equal(now.pendingEdits, undefined)
      assert.equal((await r.workshop()).edits.find((x) => x.id === ask2.hash).status, 'withdrawn')

      // the confirmed edit is undone: the check has its old words again, at once
      await r.byPerson('b', now, { say: 'undo', edit: ask.hash }, 'back to the agreed words'); await r.tick()
      assert.equal(r.find(one.id).title, old)

      // after a restart the board and the edits fold back from the log alone
      const { State } = await import('../src/server/state.js')
      const fresh = new State(); for (const x of r.ctx.log.entries) fresh.apply(x)
      assert.equal(fresh.stepEdits.get(ask.hash).status, 'undone')
      assert.equal(fresh.stepEdits.get(ask2.hash).status, 'withdrawn')
      assert.equal(fresh.steps.get(one.id).title, old)
    } finally { await r.stop() }
  })
})
