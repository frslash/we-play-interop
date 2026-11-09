// The weaver reads the Resources: each round's model gets the slice of the Resources tab that bears on what is being
// said (with what agents found in each source), within a budget, and the round records how much of it the model cited.
// The facilitator's step-writing gets the same, so a step's check can point to the spec or test vectors it rests on.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { TYPES, signedDocument } from '../src/shared/types.js'
import { config as baseConfig } from '../src/server/config.js'
import { createApp } from '../src/server/index.js'
import { createResolver } from '../src/server/resolver.js'
import { RESOURCE_BUDGET, resourcesFor } from '../src/server/views.js'
import { closeVotes } from '../src/server/votes.js'

const BOARD = { generated: new Date().toISOString().slice(0, 10), projects: [], scenarios: [], runs: [] }
const RLTP = 'https://github.com/real-life-org/trust-protocol' // on the curated list (public/resources.js)

describe('the weaver reads the Resources', () => {
  let ctx, base, dir
  const person = newIdentity(), other = newIdentity(), agent = newIdentity()
  let del
  const postDoc = async (doc) => { const r = await fetch(`${base}/api/entries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(doc) }); return { status: r.status, body: await r.json() } }
  const send = (id, name, payload, extra) => postDoc(signedDocument(id, { type: TYPES[name], payload, ...extra }))
  const asAgent = (name, payload, extra) => send(agent, name, payload, { onBehalfOf: person.did, delegation: del, ...extra })
  /** A model that answers `answer` and keeps what it was asked. */
  const model = (answer) => { const asked = []; return { asked, llm: { configured: true, model: 'test/model', route: () => ({}), chat: async (messages) => { asked.push(JSON.parse(messages[1].content)); return { model: 'test/model', latencyMs: 1, usage: { total_tokens: 1 }, finishReason: 'stop', jsonMode: true, content: JSON.stringify(typeof answer === 'function' ? answer(messages) : answer) } } } } }

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wpi-reading-'))
    const config = { ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, githubToken: '', weaverIntervalMinutes: 0, weaverQuietMinutes: 0, ratePerMinute: 1000, voteMinutes: 10, publicUrl: 'https://interop.example', boardDataUrl: 'data:application/json,' + encodeURIComponent(JSON.stringify(BOARD)), llm: { ...baseConfig.llm, provider: 'openai', apiKey: '' } }
    ctx = await createApp(config, { resolver: createResolver(), hostWelcomeMs: null })
    await new Promise((r) => ctx.server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${ctx.server.address().port}`
    await ctx.board.refresh()
    await send(person, 'join', { name: 'Person A' }); await send(other, 'join', { name: 'Person B' })
    del = (await send(person, 'delegate', { delegate: agent.did, scope: ['note', 'propose', 'vote'], label: 'North Agent' }, { expiresAt: new Date(Date.now() + 86400000).toISOString() })).body.hash
    // what an agent found in a listed source, and a source it added
    assert.equal((await asAgent('resource', { url: RLTP, note: 'Its carrier is the OpenVTC mediator over TSP 1.0, so anything that sends TSP through a mediator reaches it.' })).status, 201)
    assert.equal((await asAgent('resource', { url: 'https://spec.example/mls-interop-vectors', title: 'MLS interop test vectors', kind: 'Protocols and specs', status: 'draft', about: 'Welcome, add and remove vectors for two MLS stacks', note: 'Section 4 has the add and remove vectors.' })).status, 201)
    await ctx.facilitator.tick() // the room is running
  })
  after(async () => { await ctx.stop(); rmSync(dir, { recursive: true, force: true }) })

  test('each round gets the sources that bear on what was said, with what agents found in them, and records what it cited', async () => {
    await send(person, 'mode', { mode: 'weave' })
    const m = model({ heard: [], threads: [], agreements: [], conflicts: [], connections: [], next: [{ kind: 'other', action: `Check that Geb's TSP messages reach RLTP through the mediator (see ${RLTP})`, why: 'the note on RLTP says that is its carrier', holds: [] }] })
    ctx.weaver.llm = m.llm
    await send(other, 'note', { text: 'Can Geb reach RLTP over TSP, through a mediator?', kind: 'question' })
    const round = (await ctx.weaver.round()).document.payload
    const given = m.asked[0].resources
    assert.equal(given[0].url, RLTP, 'the source that bears on it most comes first')
    assert.match(given[0].found.join(' '), /OpenVTC mediator over TSP 1\.0/)
    assert.match(given[0].found[0], /^North Agent: /, 'who found it')
    assert.ok(given.some((r) => r.url === 'https://spec.example/mls-interop-vectors'), 'sources added in the room too')
    assert.equal(round.reading.resources, given.length)
    assert.equal(round.reading.of, resourcesFor(ctx, '').of, 'out of every source the room keeps')
    assert.equal(round.reading.cited, 1, 'it named the RLTP spec')
  })

  test('the facilitator writes a step’s check with the sources it rests on', async () => {
    await send(person, 'mode', { mode: 'facilitate' })
    const m = model((messages) => { const a = JSON.parse(messages[1].content).agreements[0]; return { steps: [{ id: a.id, step: 'Run the add and remove test between the two MLS stacks', done: 'Both sides pass section 4 of https://spec.example/mls-interop-vectors' }] } })
    ctx.llm = m.llm
    const pr = (await asAgent('propose', { kind: 'other', title: 'Test MLS add and remove between Geb and Keyring' })).body.hash
    await send(other, 'vote', { proposal: pr, choice: 'for' })
    await closeVotes(ctx, Date.now() + 11 * 60_000, { max: 10 })
    await ctx.facilitator.tick(Date.now() + 11 * 60_000)
    assert.ok(m.asked[0].resources.some((r) => r.url === 'https://spec.example/mls-interop-vectors'), 'the step-writer read the vectors')
    const s = [...ctx.log.state.steps.values()].find((x) => x.from === pr)
    assert.match(s.done, /section 4 of https:\/\/spec\.example\/mls-interop-vectors/)
    assert.equal(s.words.cited, 1); assert.ok(s.words.resources >= 1)
  })

  test('however many sources and notes there are, a round gets a bounded slice', async () => {
    for (let i = 0; i < 40; i++) await asAgent('resource', { url: `https://spec.example/many-${i}`, title: `Spec ${i} about mediator transport`, kind: 'Protocols and specs', note: 'mediator transport '.repeat(40).trim() })
    const slice = resourcesFor(ctx, 'mediator transport for TSP and RLTP')
    assert.ok(JSON.stringify(slice.resources).length <= RESOURCE_BUDGET + 2 * slice.resources.length + 2, 'within its budget')
    assert.ok(slice.resources.length < slice.of, 'not all of them')
    assert.ok(slice.resources.every((r) => !r.found || r.found.length <= 3), 'the latest notes only')
    assert.ok(slice.of >= 55)
  })
})
