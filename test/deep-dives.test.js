// Closer looks when agents disagree (src/server/dives.js): opened from a split vote or a conflict the model names,
// judged each round from its thread, ended as agreed, different premises, or handed to the people involved.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { TYPES, signedDocument } from '../src/shared/types.js'
import { config as baseConfig } from '../src/server/config.js'
import { DIVE_ROUNDS } from '../src/server/dives.js'
import { createApp } from '../src/server/index.js'
import { createResolver } from '../src/server/resolver.js'
import { State } from '../src/server/state.js'
import { concerns } from '../src/server/views.js'

const BOARD = { generated: new Date().toISOString().slice(0, 10), projects: [{ slug: 'alpha', name: 'Alpha' }, { slug: 'beta', name: 'Beta' }], scenarios: [], runs: [] }

describe('closer looks when agents disagree', () => {
  let ctx, base, dir
  const personA = newIdentity(), personB = newIdentity(), personC = newIdentity()
  const agentA = newIdentity(), agentB = newIdentity(), agentC = newIdentity()
  const dels = {}
  const postDoc = async (doc) => { const r = await fetch(`${base}/api/entries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(doc) }); return { status: r.status, body: await r.json() } }
  const send = (id, name, payload, extra) => postDoc(signedDocument(id, { type: TYPES[name], payload, ...extra }))
  const asAgent = (agent, of, name, payload, extra) => send(agent, name, payload, { onBehalfOf: of.did, delegation: dels[agent.did], ...extra })
  const propose = async (title) => (await send(personA, 'propose', { kind: 'other', title })).body.hash
  const vote = (agent, of, proposal, choice, reason) => asAgent(agent, of, 'vote', { proposal, choice, ...(reason ? { reason } : {}) })
  const dives = () => [...ctx.log.state.dives.values()]
  const diveOn = (proposal) => dives().find((d) => d.proposal === proposal)
  const lineOf = (hash) => ctx.log.byHash.get(hash).document
  const endOf = (d) => lineOf(ctx.log.state.dives.get(d.hash).ended)
  const fakeModel = (answer) => ({ configured: true, model: 'test/model', chat: async () => ({ model: 'test/model', latencyMs: 1, usage: { total_tokens: 1 }, finishReason: 'stop', jsonMode: true, content: typeof answer === 'function' ? answer() : answer }) })
  const empty = { heard: [], threads: [], agreements: [], conflicts: [], next: [] }

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wpi-dives-'))
    const config = { ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, githubToken: '', weaverIntervalMinutes: 0, weaverQuietMinutes: 0, ratePerMinute: 1000, publicUrl: 'https://interop.example', boardDataUrl: 'data:application/json,' + encodeURIComponent(JSON.stringify(BOARD)), llm: { ...baseConfig.llm, provider: 'openai', apiKey: '' } }
    ctx = await createApp(config, { openRoom: true, resolver: createResolver(), hostWelcomeMs: null })
    await new Promise((r) => ctx.server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${ctx.server.address().port}`
    await ctx.board.refresh()
    ctx.weaver.llm = { configured: false }
    const exp = new Date(Date.now() + 86400000).toISOString()
    for (const [who, name, agent, label] of [[personA, 'Person A', agentA, 'North Agent'], [personB, 'Person B', agentB, 'South Agent'], [personC, 'Person C', agentC, 'East Agent']]) {
      assert.equal((await send(who, 'join', { name })).status, 201)
      dels[agent.did] = (await send(who, 'delegate', { delegate: agent.did, scope: ['note', 'vote'], label }, { expiresAt: exp })).body.hash
    }
  })
  after(async () => { await ctx.stop(); rmSync(dir, { recursive: true, force: true }) })

  let first
  test('a split vote from agents of two different people opens one closer look that names both', async () => {
    first = await propose('Sign the first handshake with did:key')
    await vote(agentA, personA, first, 'for', 'it runs in both projects today')
    await vote(agentB, personB, first, 'against', 'did:key cannot rotate its key')
    const r = (await ctx.weaver.round()).document.payload
    assert.equal(dives().length, 1)
    const d = diveOn(first)
    assert.equal(d.outcome, null); assert.equal(d.from, 'votes')
    assert.deepEqual(d.sides, [{ stance: 'for', who: [agentA.did] }, { stance: 'against', who: [agentB.did] }])
    const line = ctx.log.byHash.get(d.hash)
    assert.match(line.document.payload.text, /North Agent \(for Person A\), who says "it runs in both/)
    assert.match(line.document.payload.text, /South Agent \(for Person B\), who says "did:key cannot rotate/)
    assert.match(line.document.payload.text, /evidence \(a spec, a test or a run, not an opinion\) and the one check that would settle it/)
    assert.equal(concerns(ctx, line, agentA.did), 'mention', 'naming a side wakes its agent')
    assert.equal(concerns(ctx, line, agentB.did), 'mention')
    assert.deepEqual(r.dives.map((x) => [x.dive, x.did]), [[d.hash, 'opened']])
  })

  test('a second split on the same proposal does not open another', async () => {
    await vote(agentC, personC, first, 'against', 'a third view')
    const r = (await ctx.weaver.round()).document.payload
    assert.equal(dives().length, 1)
    assert.deepEqual(r.dives.map((x) => [x.did, x.round, x.of]), [['open', 1, DIVE_ROUNDS]], 'still open, and an open one makes the round speak')
  })

  test('when the two sides agree, it ends as agreed; the same proposal is not looked at again', async () => {
    await vote(agentB, personB, first, 'for', 'the rotation can come later')
    const r = (await ctx.weaver.round()).document.payload
    const d = diveOn(first)
    assert.equal(d.outcome, 'agreed'); assert.equal(d.by, 'rule')
    assert.equal(endOf(d).threadId, d.thread, 'the end is said in the dive\'s own thread')
    assert.match(endOf(d).payload.text, /^Agreed: .* Both sides now vote yes\.$/)
    assert.deepEqual(r.dives.map((x) => [x.did, x.by]), [['agreed', 'rule']])
    await vote(agentB, personB, first, 'against', 'changed my mind again')
    await ctx.weaver.round()
    assert.equal(dives().length, 1, 'one closer look per proposal')
  })

  test('with no resolution it goes to the people after its last round, and the vote closes on its own time', async () => {
    const p = await propose('Move the map to a weekly snapshot')
    await vote(agentA, personA, p, 'for')
    await vote(agentB, personB, p, 'against', 'daily runs fade faster than a week')
    await ctx.weaver.round()
    const d = diveOn(p)
    assert.ok(d && !d.outcome)
    await asAgent(agentA, personA, 'note', { text: 'Here is a run from last week that still counts.', kind: 'message' }, { threadId: d.thread })
    const { closeVotes } = await import('../src/server/votes.js')
    const closed = await closeVotes(ctx, Date.now() + 11 * 60_000, { max: 50 })
    assert.ok(closed.some((c) => c.proposal === p), 'an open closer look holds nothing up')
    for (let k = 1; k < DIVE_ROUNDS; k++) {
      const r = (await ctx.weaver.round()).document.payload
      assert.deepEqual(r.dives.filter((x) => x.dive === d.hash).map((x) => [x.did, x.round]), [['open', k]])
    }
    const r = (await ctx.weaver.round()).document.payload
    assert.deepEqual(r.dives.filter((x) => x.dive === d.hash).map((x) => [x.did, x.round]), [['handed to people', DIVE_ROUNDS]])
    assert.equal(d.outcome, 'handed to people'); assert.equal(d.by, 'rule')
    const text = endOf(d).payload.text
    assert.match(text, /What is known: The vote stands at 1 yes, 1 no\. 1 line was said here/)
    assert.match(text, /What is still a choice: whether to take .* up again \(its vote closed: not agreed\)/)
    assert.match(text, /Person A, Person B: this is yours to decide\./)
  })

  test('with a model, its judgment and its question are used; an answer that is not JSON falls back to the plain rule', async () => {
    const p = await propose('Test the connect scenario before anything else')
    await vote(agentA, personA, p, 'for')
    await vote(agentB, personB, p, 'against')
    await ctx.weaver.round()
    const d = diveOn(p)
    // the model reads the thread and finds two premises; it also names a new conflict between two people
    let sent = null
    ctx.weaver.llm = { ...fakeModel(JSON.stringify({ ...empty,
      conflicts: [{ point: 'whether did:key is enough', entries: [], between: [agentA.did, agentC.did], question: 'Does did:key alone pass the connect scenario?' }],
      dives: [{ id: d.hash, outcome: 'different premises', known: 'Both ran it; they start from different needs.', claims: [{ who: agentA.did, claim: 'A test that passes today is enough to start.' }, { who: agentB.did, claim: 'Without key rotation the test does not show safety.' }] }, { id: 'f'.repeat(64), outcome: 'agreed' }] })) }
    const chat = ctx.weaver.llm.chat; ctx.weaver.llm.chat = async (msgs) => { sent = JSON.parse(msgs[1].content); return chat() }
    const r = (await ctx.weaver.round()).document.payload
    assert.equal(r.model.ok, true)
    assert.equal(sent.deepDives.open.find((x) => x.id === d.hash).sides[1].who[0].vote, 'against', 'the model sees the sides and their votes')
    assert.equal(d.outcome, 'different premises'); assert.equal(d.by, 'model')
    assert.match(endOf(d).payload.text, /North Agent \(for Person A\): A test that passes today[\s\S]*South Agent \(for Person B\): Without key rotation/)
    assert.equal(endOf(d).payload.dive.claims.length, 2, 'both claims are recorded')
    const between = dives().find((x) => x.key.startsWith('people:'))
    assert.equal(between.question, 'Does did:key alone pass the connect scenario?'); assert.equal(between.from, 'model')
    assert.match(lineOf(between.hash).payload.text, /North Agent \(for Person A\) and East Agent \(for Person C\) differ/)
    // the same conflict named again does not open a second one while the first is open
    await ctx.weaver.round()
    assert.equal(dives().filter((x) => x.key === between.key).length, 1)
    // a split the model names with a question gets the model's question
    const q = await propose('Write the guide in two layers')
    await vote(agentA, personA, q, 'for')
    await vote(agentC, personC, q, 'against')
    ctx.weaver.llm = fakeModel(JSON.stringify({ ...empty, conflicts: [{ point: 'two layers', entries: [q], question: 'Do readers find the plain layer enough on its own?' }] }))
    await ctx.weaver.round()
    const split = diveOn(q)
    assert.equal(split.question, 'Do readers find the plain layer enough on its own?')
    // not JSON: the round is the built-in tally, and the plain rule judges (the votes now agree)
    await vote(agentC, personC, q, 'for')
    ctx.weaver.llm = fakeModel('this is not JSON at all')
    const bad = (await ctx.weaver.round()).document.payload
    assert.equal(bad.model.ok, false)
    assert.equal(split.outcome, 'agreed'); assert.equal(split.by, 'rule')
    assert.equal(between.outcome, 'handed to people', 'the other reached its last round: the plain rule hands it to the people'); assert.equal(between.by, 'rule')
    // the record is the log: replayed from scratch, every closer look comes back as it was
    const again = new State()
    for (const e of ctx.log.entries) again.apply(e)
    assert.deepEqual([...again.dives.values()], dives())
    ctx.weaver.llm = { configured: false }
  })
})
