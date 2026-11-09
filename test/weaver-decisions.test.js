import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { checkDecision, NAME_OF, TYPES, signedDocument } from '../src/shared/types.js'
import { config as baseConfig } from '../src/server/config.js'
import { createApp } from '../src/server/index.js'
import { decide } from '../src/server/decisions.js'
import { closeVotes } from '../src/server/votes.js'

// Room line 1689: decisions agents make here are provisional, visible and reversible by any person. Every decision
// the weaver makes is one signed line naming who decided, for whom, why and which lines it rests on; a person's word
// marks it reversed, and the record keeps both lines.
describe('the weaver\'s decisions: one signed line each, reversible by any person', () => {
  let ctx, base, dir, grantA, grantB, proposal, decision
  const personA = newIdentity(), personB = newIdentity(), agentA = newIdentity(), agentB = newIdentity()
  const until = new Date(Date.now() + 86400000).toISOString()
  const post = async (doc) => { const r = await fetch(`${base}/api/entries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(doc) }); return { status: r.status, body: await r.json() } }
  const send = (id, name, payload, extra) => post(signedDocument(id, { type: TYPES[name], payload, ...extra }))
  const state = async () => (await fetch(`${base}/api/state`)).json()
  const decisionLines = () => ctx.log.entries.filter((e) => NAME_OF[e.type] === 'decision')

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wpi-decisions-'))
    const board = { generated: new Date().toISOString().slice(0, 10), projects: [], credentialProfiles: { profiles: {} }, runs: [] }
    ctx = await createApp({ ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, githubToken: '', weaverIntervalMinutes: 0, weaverQuietMinutes: 0, ratePerMinute: 1000, publicUrl: 'https://interop.example', boardDataUrl: 'data:application/json,' + encodeURIComponent(JSON.stringify(board)), llm: { ...baseConfig.llm, apiKey: '' } }, { awayGatherMs: 0, hostWelcomeMs: null })
    await new Promise((r) => ctx.server.listen(0, r))
    base = `http://localhost:${ctx.server.address().port}`
    await send(personA, 'join', { name: 'Person A' }); await send(personB, 'join', { name: 'Person B' })
    grantA = (await send(personA, 'delegate', { delegate: agentA.did, scope: ['note', 'propose', 'vote'], label: 'Agent A' }, { expiresAt: until })).body.hash
    grantB = (await send(personB, 'delegate', { delegate: agentB.did, scope: ['note', 'propose', 'vote'], label: 'Agent B' }, { expiresAt: until })).body.hash
  })
  after(async () => { await ctx.stop(); rmSync(dir, { recursive: true, force: true }) })

  test('a decision line says who, for whom, what, why and what it rests on, or it is refused', () => {
    const h = 'a'.repeat(64), did = personA.did
    assert.equal(checkDecision({ by: [did], for: ['the room'], what: 'Opened a step', why: 'They agree.', rests: [h] }), null)
    assert.match(checkDecision({ by: [], for: ['the room'], what: 'x x x', why: 'y y y', rests: [h] }), /^by/)
    assert.match(checkDecision({ by: [did], for: ['nobody'], what: 'x x x', why: 'y y y', rests: [h] }), /^for/)
    assert.match(checkDecision({ by: [did], for: [did], what: 'x x x', why: '', rests: [h] }), /^why/)
    assert.match(checkDecision({ by: [did], for: [did], what: 'x x x', why: 'y y y', rests: [] }), /^rests/)
  })

  test('closing a vote is written as a signed decision resting on the proposal and its result', async () => {
    proposal = (await send(agentA, 'propose', { kind: 'other', title: 'Try a test decision', body: 'A small one.' }, { onBehalfOf: personA.did, delegation: grantA })).body.hash
    await send(agentB, 'vote', { proposal, choice: 'for', judgment: true }, { onBehalfOf: personB.did, delegation: grantB })
    const closed = await closeVotes(ctx, Date.now() + 11 * 60_000)
    assert.equal(closed.length, 1); assert.equal(closed[0].agreed, true)
    const [line] = decisionLines()
    assert.ok(line, 'a decision line is in the log')
    decision = line.hash
    const p = line.document.payload, result = ctx.log.state.proposals.get(proposal).results.at(-1)
    assert.equal(line.author, ctx.log.state.workspace)
    assert.deepEqual(p.by, [ctx.log.state.workspace]); assert.deepEqual(p.for, ['the room'])
    assert.match(p.what, /Closed the vote on “Try a test decision”: agreed/); assert.match(p.why, /1 yes, 0 no/)
    assert.deepEqual(p.rests, [proposal, result.hash]); assert.deepEqual(p.about, { kind: 'proposal', ref: proposal })
    const d = (await state()).decisions.find((x) => x.hash === decision)
    assert.equal(d.reversed, null); assert.deepEqual(d.byNames, ['the weaver'])
  })

  test('agents agreeing: the step the weaver opens is a decision by the weaver and those agents, resting on their lines', async () => {
    const a = (await send(agentA, 'note', { kind: 'idea', text: 'Let us write the decision rule into the Rules tab.' }, { onBehalfOf: personA.did, delegation: grantA })).body.hash
    const b = (await send(agentB, 'note', { kind: 'idea', text: 'Agreed: the decision rule goes into the Rules tab.' }, { onBehalfOf: personB.did, delegation: grantB })).body.hash
    const out = await ctx.facilitator.fromRound({ converged: [{ entries: [a, b], step: 'Write the decision rule into the Rules tab.', done: 'The Rules tab shows it.' }] })
    assert.equal(out.opened.length, 1)
    const line = decisionLines().at(-1), p = line.document.payload
    assert.deepEqual(new Set(p.rests), new Set([a, b]))
    assert.ok(p.by.includes(ctx.log.state.workspace) && p.by.includes(agentA.did) && p.by.includes(agentB.did))
    assert.ok(p.for.includes('the room'))
    assert.deepEqual(p.about, { kind: 'step', ref: out.opened[0] })
    assert.match(p.what, /Opened the next step/)
  })

  test('nobody but the workspace writes a decision line', async () => {
    const r = await send(personA, 'decision', { by: [personA.did], for: ['the room'], what: 'I decide this', why: 'Because.', rests: [proposal] })
    assert.equal(r.status, 403)
  })

  test('an agent cannot reverse a decision: that stays a person\'s word', async () => {
    const r = await send(agentA, 'reverse', { decision }, { onBehalfOf: personA.did, delegation: grantA })
    assert.equal(r.status, 403); assert.match(r.body.payload.message, /stays with humans/)
  })

  test('a person reverses it: the record keeps the signed decision and the reversal, and shows it as reversed', async () => {
    assert.equal((await send(personB, 'reverse', { decision: 'b'.repeat(64) })).status, 400, 'only a decision that exists')
    const before = ctx.log.entries.length
    const r = await send(personB, 'reverse', { decision, why: 'Not this one: a test of the rule.' })
    assert.equal(r.status, 201)
    const reversal = ctx.log.byHash.get(r.body.hash)
    assert.equal(NAME_OF[reversal.type], 'reverse'); assert.equal(reversal.author, personB.did); assert.equal(reversal.seq, before)
    assert.ok(ctx.log.byHash.get(decision), 'the original decision line stays in the record')
    const d = (await state()).decisions.find((x) => x.hash === decision)
    assert.equal(d.reversed.by, personB.did); assert.equal(d.reversed.name, 'Person B'); assert.equal(d.reversed.hash, r.body.hash)
    assert.equal(d.reversed.why, 'Not this one: a test of the rule.')
    assert.equal((await send(personA, 'reverse', { decision })).status, 403, 'once reversed, it stays reversed')
    const v = await (await fetch(`${base}/api/verify`)).json()
    assert.equal(v.ok, true, 'the chain, with both lines, still checks out')
  })

  test('the fold gives the same answer after a restart: replaying the log reverses it again', async () => {
    const { State } = await import('../src/server/state.js')
    const st = new State()
    for (const e of ctx.log.entries) st.apply(e)
    assert.equal(st.decisions.get(decision).reversed.by, personB.did)
  })

  test('a decision resting on no line in the log is not written', async () => {
    const n = decisionLines().length
    assert.equal(await decide(ctx.log, { what: 'Something', why: 'No reason given here.', rests: ['c'.repeat(64)] }), null)
    assert.equal(decisionLines().length, n)
  })
})
