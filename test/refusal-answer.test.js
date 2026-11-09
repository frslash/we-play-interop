// Step c2137de9 (adds to #66): the refusal matcher ignores only bow-out lines ("Not me", "Not mine", "Not my call",
// "I have no rights / say"). "I decline" and "I won't sign" are the person's answer, and the answer is no: from the
// step's own person they settle a keys choice as "no"; from an agent they settle nothing (src/server/facilitator.js,
// BOWS_OUT and REFUSAL).
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { NAME_OF, TYPES, signedDocument } from '../src/shared/types.js'
import { config as baseConfig } from '../src/server/config.js'
import { branchOf } from '../src/server/builder.js'
import { BOWS_OUT, Facilitator, REFUSAL, decided, decisionOf } from '../src/server/facilitator.js'
import { createApp } from '../src/server/index.js'
import { createResolver } from '../src/server/resolver.js'
import { closeVotes } from '../src/server/votes.js'

const BOARD = { generated: new Date().toISOString().slice(0, 10), projects: [], scenarios: [], runs: [] }
const FIRE = 'https://api.anthropic.com/v1/claude_code/routines/trig_builder_1/fire'
const MIN = 60_000

async function room () {
  const dir = mkdtempSync(join(tmpdir(), 'wpi-refusal-'))
  const pulls = []
  const wakeFetch = async () => ({ ok: true, status: 200 })
  const gh = async (method, path) => (method === 'GET' && path.includes('/pulls?') ? pulls : {})
  const config = { ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, githubToken: '', weaverIntervalMinutes: 0, weaverQuietMinutes: 0, ratePerMinute: 1000, voteMinutes: 10, workspaceRepo: 'example/room', publicUrl: 'https://interop.example', boardDataUrl: 'data:application/json,' + encodeURIComponent(JSON.stringify(BOARD)), llm: { ...baseConfig.llm, provider: 'openai', apiKey: '' } }
  const ctx = await createApp(config, { resolver: createResolver(), hostWelcomeMs: null, wakeFetch, gh })
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


const DOC_KEY = 'Which key signs the room’s DID document'
const NOT_ME_KEY = 'Not me: I have no rights over the key that signs the room’s DID document.'
const WONT_SIGN = 'I won’t sign that.'
const decidedLines = (r) => r.ctx.log.entries.filter((e) => NAME_OF[e.type] === 'note' && /\bDecided\b[^.]*\bby\b/.test(String(e.document.payload.text ?? '')))
const undecided = (r, s, why) => {
  assert.ok(s.waitingOn, `${why}: still waiting on its choice`)
  assert.equal(s.decision ?? null, null, `${why}: no decision`); assert.equal(decided(s), null)
  assert.equal(decidedLines(r).length, 0, `${why}: no "Decided by" line`)
}
const roundSays = (r, moves) => { r.ctx.weaver.llm = { configured: true, model: 'test/model', chat: async () => ({ model: 'test/model', latencyMs: 1, usage: {}, finishReason: 'stop', jsonMode: true, content: JSON.stringify({ heard: [], threads: [], agreements: [], conflicts: [], next: [], moves }) }) } }
// A keys choice held for Person B: a goal Person B proposed, its test step waits on which key signs the DID document.
const keysStep = async (r) => {
  const g = (await r.send(r.people.b, 'propose', { kind: 'goal', title: 'Goal 3: the room has a home of its own' })).body.hash
  await r.send(r.people.b, 'vote', { proposal: g, choice: 'for' })
  await r.ctx.facilitator.openTest(r.st().proposals.get(g), [{ text: 'The room’s DID document is published', needs: DOC_KEY }])
  await r.ctx.facilitator.tick(r.at(1))
  const step = () => r.ctx.facilitator.testOf(g)[0]
  assert.deepEqual({ who: step().waitingOn.who, held: step().waitingOn.held }, { who: r.people.b.did, held: 'keys' })
  return step
}

describe('the refusal matcher: bow-outs are ignored, "I decline" and "I won’t sign" are a no', () => {
  test('only bow-out lines are ignored; a refusal is the answer "no"; a shrug is still nothing', () => {
    for (const t of [NOT_ME_KEY, 'Not mine: that key is Person B’s.', 'Not my call, ask Person B.', 'I have no rights over that key.', 'I have no say in which key signs it.']) {
      assert.ok(BOWS_OUT.test(t), t); assert.equal(decisionOf(t, DOC_KEY), null, t)
    }
    for (const t of ['I decline.', 'I decline to use the room’s key for this.', WONT_SIGN, "I won't sign that.", 'I will not sign the DID document with my key.', 'I refuse.']) {
      assert.ok(!BOWS_OUT.test(t), t); assert.ok(REFUSAL.test(t), t)
      const d = decisionOf(t, DOC_KEY)
      assert.equal(d?.choice, 'no', t); assert.equal(d.refused, true, t)
    }
    for (const t of ['I can’t decide which key signs it.', 'I’ll pass on the key.', 'not sure']) assert.equal(decisionOf(t, DOC_KEY), null, t)
    assert.equal(decisionOf('Use a new key kept offline, because the room’s key is online.', DOC_KEY).refused, undefined, 'a real answer is no refusal')
  })

  test('on a keys choice held for Person B: "Not me: I have no rights…" leaves it undecided; Person B’s own "I won’t sign that" settles it as no', async () => {
    const r = await room()
    try {
      const step = await keysStep(r)
      // another person's agent bows out: nothing is decided
      const line = (await r.as('c', 'note', { text: NOT_ME_KEY, kind: 'message' }, { threadId: step().thread })).body.hash
      await r.ctx.facilitator.tick(r.at(2))
      undecided(r, step(), 'a bow-out in the thread')
      roundSays(r, [{ entry: line, step: step().id, kind: 'answered' }])
      await r.ctx.weaver.round()
      undecided(r, step(), 'a bow-out through the round')
      // so does Person B's own bow-out
      await r.send(r.people.b, 'note', { text: NOT_ME_KEY, kind: 'message' }, { threadId: step().thread })
      await r.ctx.facilitator.tick(r.at(3))
      undecided(r, step(), 'Person B’s own bow-out')
      // another person's agent refusing settles nothing: the choice is Person B's
      await r.as('c', 'note', { text: WONT_SIGN, kind: 'message' }, { threadId: step().thread })
      await r.ctx.facilitator.tick(r.at(4))
      undecided(r, step(), 'another agent’s refusal')
      // Person B's own agent refusing settles nothing either: a held choice is the person's own line
      await r.as('b', 'note', { text: WONT_SIGN, kind: 'message' }, { threadId: step().thread })
      await r.ctx.facilitator.tick(r.at(5))
      undecided(r, step(), 'Person B’s agent’s refusal')
      // Person B's own "I won't sign that" is their answer: no
      await r.send(r.people.b, 'note', { text: WONT_SIGN, kind: 'message' }, { threadId: step().thread })
      await r.ctx.facilitator.tick(r.at(6))
      const d = step().decision
      assert.ok(d, 'decided'); assert.equal(d.choice, 'no'); assert.equal(d.by, r.people.b.did); assert.equal(d.for, r.people.b.did)
      assert.equal(d.held, 'keys'); assert.equal(d.provisional, false); assert.equal(step().waitingOn ?? null, null)
      assert.ok(decidedLines(r).some((e) => /Decided by Person B\b.*: no\./.test(e.document.payload.text)), 'the "Decided by" line says no')
      // it holds after a restart
      r.ctx.facilitator = new Facilitator({ ctx: r.ctx })
      await r.ctx.facilitator.tick(r.at(7))
      assert.equal(decided(step())?.choice, 'no')
    } finally { await r.stop() }
  })

  test('"I decline" from Person B settles the keys choice as no, through the round’s "answered" move', async () => {
    const r = await room()
    try {
      const step = await keysStep(r)
      const line = (await r.send(r.people.b, 'note', { text: 'I decline.', kind: 'message' }, { threadId: step().thread })).body.hash
      // the round may see it first
      roundSays(r, [{ entry: line, step: step().id, kind: 'answered' }])
      await r.ctx.weaver.round()
      await r.ctx.facilitator.tick(r.at(2))
      assert.equal(step().decision?.choice, 'no'); assert.equal(step().decision.by, r.people.b.did)
    } finally { await r.stop() }
  })
})
