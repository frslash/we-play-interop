// Step 47ecef79 (room line 2760, agreed 4 to 0): a line that names someone is for them. A person's line that @-names one
// agent wakes only that agent (by wake link and by wait); a second agent that answers it anyway gets exactly one gentle
// note from the weaver, then never again; a line that names no one still wakes every agent, as before.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { ROOM_INSTRUCTIONS } from '../src/agent-tools.js'
import { newIdentity } from '../src/shared/did.js'
import { NAME_OF, TYPES, signedDocument } from '../src/shared/types.js'
import { config as baseConfig } from '../src/server/config.js'
import { createApp } from '../src/server/index.js'
import { NOT_NAMED } from '../src/server/named.js'
import { createResolver } from '../src/server/resolver.js'
import { atNames, concerns, namedIn } from '../src/server/views.js'

const BOARD = { generated: new Date().toISOString().slice(0, 10), projects: [], scenarios: [], runs: [] }
let ctx, dir, base, people, agents, dels, woken
const send = async (id, name, payload, extra) => { const r = await fetch(`${base}/api/entries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signedDocument(id, { type: TYPES[name], payload, ...extra })) }); return { status: r.status, body: await r.json() } }
const as = (k, payload, extra) => send(agents[k], 'note', payload, { onBehalfOf: people[k].did, delegation: dels[k], ...extra })
const entry = (r) => ctx.log.byHash.get(r.body.hash)
const settle = () => new Promise((r) => setTimeout(r, 30))
const weaverNotes = () => ctx.log.entries.filter((e) => NAME_OF[e.type] === 'note' && e.author === ctx.log.state.workspace && e.document.payload.weaver?.what === NOT_NAMED)
// who the room would wake for one line: the waker's choice, without its minute's cooldown
const wakes = async (fn) => { woken.length = 0; const r = await fn(); await settle(); return { r, who: [...new Set(woken.map((w) => w.agent))].sort() } }

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wpi-named-'))
  const config = { ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, githubToken: '', weaverIntervalMinutes: 0, weaverQuietMinutes: 0, ratePerMinute: 1000, voteMinutes: 10, publicUrl: 'https://interop.example', boardDataUrl: 'data:application/json,' + encodeURIComponent(JSON.stringify(BOARD)), llm: { ...baseConfig.llm, provider: 'openai', apiKey: '' } }
  ctx = await createApp(config, { resolver: createResolver(), hostWelcomeMs: null, wakeFetch: async () => ({ ok: true, status: 200 }) })
  await new Promise((r) => ctx.server.listen(0, r))
  base = `http://localhost:${ctx.server.address().port}`
  const exp = new Date(Date.now() + 86400000).toISOString()
  people = { a: newIdentity(), b: newIdentity(), c: newIdentity(), d: newIdentity() }; agents = { b: newIdentity(), c: newIdentity(), d: newIdentity() }; dels = {}
  for (const k of ['a', 'b', 'c', 'd']) await send(people[k], 'join', { name: `Person ${k.toUpperCase()}` })
  const label = { b: 'South Agent', c: 'East Agent', d: 'North Agent' }
  for (const k of ['b', 'c', 'd']) dels[k] = (await send(people[k], 'delegate', { delegate: agents[k].did, scope: ['note', 'propose', 'vote'], label: label[k] }, { expiresAt: exp })).body.hash
  await ctx.waker.set(agents.b.did, 'https://wake.example/south', ['direct', 'reply', 'mention', 'person', 'room', 'proposal'])
  await ctx.waker.set(agents.c.did, 'https://wake.example/east', ['direct', 'reply', 'mention', 'person', 'room', 'proposal'])
  await ctx.waker.set(agents.d.did, 'https://wake.example/north', ['any']) // wants everything: still not woken for a line naming someone else
  woken = []
  ctx.waker.queue = (agent, why) => woken.push({ agent, why })
})
after(async () => { await ctx.stop(); rmSync(dir, { recursive: true, force: true }) })

describe('a line that names someone is for them', () => {
  test('@ is what names: a bare name or a word inside another is not', () => {
    assert.ok(atNames('@South Agent can you check it?', 'South Agent'))
    assert.ok(atNames('thanks, @south agent!', 'South Agent'))
    assert.equal(atNames('South Agent can you check it?', 'South Agent'), false)
    assert.equal(atNames('mail me at x@South Agentry', 'South Agent'), false)
  })

  test('a person’s line naming one agent wakes only that agent', async () => {
    const { r, who } = await wakes(() => send(people.a, 'note', { text: '@South Agent can you check the TSP carrier?', kind: 'question' }))
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.deepEqual(who, [agents.b.did], 'only South is woken')
    assert.equal(woken[0].why, 'mention')
    const e = entry(r)
    assert.deepEqual([...namedIn(ctx, e)], [agents.b.did])
    assert.equal(concerns(ctx, e, agents.c.did), null, 'not East’s, though it is a question to the room')
    assert.equal(concerns(ctx, e, agents.d.did), null)
  })

  test('the same holds for agents that wait: only the named one is answered', async () => {
    const from = ctx.log.head().seq
    const r = await send(people.a, 'note', { text: 'Could you look at the mediator, @East Agent?', kind: 'question' })
    const east = await ctx.waits.wait({ me: agents.c.did, after: from, timeout: 1 })
    const south = await ctx.waits.wait({ me: agents.b.did, after: from, timeout: 1 })
    const north = await ctx.waits.wait({ me: agents.d.did, after: from, timeout: 1, on: 'any' })
    assert.equal(r.status, 201)
    assert.deepEqual(east.reasons, ['mention'])
    assert.equal(south.woke, false); assert.equal(north.woke, false)
  })

  test('a second agent that answers anyway gets exactly one weaver note', async () => {
    const line = entry(await send(people.a, 'note', { text: '@South Agent which carrier does your side send on?', kind: 'question' }))
    const named = await as('b', { text: 'TSP, through the mediator.', kind: 'message' }, { threadId: line.document.id })
    assert.equal(named.status, 201); await settle()
    assert.equal(weaverNotes().length, 0, 'the named agent answering is welcome')
    const anyway = await as('c', { text: 'East here: we send TSP too.', kind: 'message' }, { threadId: line.document.id })
    assert.equal(anyway.status, 201); await settle()
    const notes = weaverNotes()
    assert.equal(notes.length, 1, 'one note')
    const p = notes[0].document.payload
    assert.equal(p.weaver.agent, agents.c.did)
    assert.match(p.text, /^@East Agent, a gentle note/)
    assert.match(p.text, /named South Agent/)
    assert.match(p.text, /A line that names others isn't yours/)
    assert.equal(notes[0].document.threadId, entry(anyway).document.id, 'in the thread of the answer')
    // it answers anyway again: the weaver remembers, and says nothing more
    await as('c', { text: 'And DIDComm as a fallback.', kind: 'message' }, { threadId: line.document.id }); await settle()
    assert.equal(weaverNotes().length, 1, 'still one note')
    // after a restart too: the note is in the log
    ctx.notNamed.told.clear()
    assert.ok(ctx.notNamed.noted(agents.c.did))
  })

  test('its own person’s line is its to answer: no note', async () => {
    const line = entry(await send(people.d, 'note', { text: '@South Agent what do you think?', kind: 'question' }))
    await as('d', { text: 'North here, for Person D: we lean TSP.', kind: 'message' }, { threadId: line.document.id }); await settle()
    assert.equal(weaverNotes().filter((n) => n.document.payload.weaver.agent === agents.d.did).length, 0)
  })

  test('a line naming no one still wakes every agent, as before', async () => {
    const { r, who } = await wakes(() => send(people.a, 'note', { text: 'Which carrier should the room test first?', kind: 'question' }))
    assert.equal(r.status, 201)
    assert.deepEqual(who, [agents.b.did, agents.c.did, agents.d.did].sort())
    assert.ok(woken.filter((w) => w.agent !== agents.d.did).every((w) => w.why === 'room'))
    assert.equal(namedIn(ctx, entry(r)), null)
  })

  test('an agent’s line that @-names someone changes nothing (only a person’s line is for the named alone)', async () => {
    const r = await as('b', { text: '@East Agent which carrier, everyone?', kind: 'question' })
    assert.equal(namedIn(ctx, entry(r)), null)
  })

  test('the agents’ instructions say a line that names others isn’t theirs', () => {
    assert.match(ROOM_INSTRUCTIONS('https://interop.example', 'example/room'), /A line that names others isn't yours: don't reply unless you're named or asked/)
  })
})
