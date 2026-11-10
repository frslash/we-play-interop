import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { heard, lineIsFor, namesIn } from '../src/shared/presence.js'
import { TYPES, signedDocument } from '../src/shared/types.js'
import { config as baseConfig } from '../src/server/config.js'
import { createApp } from '../src/server/index.js'

// Presence (room lines 570-573): an agent joins the room's lists once it is heard, and until then it shows as
// being set up on its person's card only; a line that tags a person is marked for them.
describe('who is in the room, and what is for you', () => {
  const line = (type, author, payload, extra = {}) => ({ type: TYPES[type], author, document: { payload, ...extra } })
  const ada = { did: 'did:key:zAda', name: 'Ada' }

  test('an agent is heard once it has acted; people always are', () => {
    assert.equal(heard({ kind: 'agent' }), false); assert.equal(heard({ kind: 'agent', firstSaid: '2026-11-09T00:00:00Z' }), true)
    assert.equal(heard({ kind: 'human' }), true)
  })

  test('a line is for a person when it names them, is addressed to them, or answers them', () => {
    assert.equal(lineIsFor(line('note', 'did:key:zB', { text: '@Ada can you check this?' }), ada), true)
    assert.equal(lineIsFor(line('note', 'did:key:zB', { text: 'ada, your run passed' }), ada), true, 'any case, with or without @')
    assert.equal(lineIsFor(line('note', 'did:key:zB', { text: 'Adam said hi' }), ada), false, 'a whole word only')
    assert.equal(lineIsFor(line('note', 'did:key:zB', { text: 'Thanks' }, { recipient: ada.did }), ada), true)
    assert.equal(lineIsFor(line('note', 'did:key:zB', { text: 'Ada knows this' }, { recipient: 'did:key:zC' }), ada), false, 'a line to someone else is theirs')
    assert.equal(lineIsFor(line('note', 'did:key:zB', { text: 'Agreed' }), ada, ada.did), true, 'an answer to her line')
    assert.equal(lineIsFor(line('propose', 'did:key:zB', { kind: 'goal', title: 'Ada and Bo run did:key' }), ada), true)
    assert.equal(lineIsFor(line('note', ada.did, { text: 'I, Ada, agree' }), ada), false, 'never her own line')
    assert.equal(lineIsFor({ ...line('note', 'did:key:zHerAgent', { text: 'Hello, I am here for Ada.' }), onBehalfOf: ada.did }, ada), false, 'nor her own agent speaking for her')
    assert.equal(lineIsFor({ ...line('note', 'did:key:zHerAgent', { text: 'A question' }, { recipient: ada.did }), onBehalfOf: ada.did }, ada), true, 'unless it talks to her')
    assert.equal(lineIsFor(line('vote', 'did:key:zB', { text: 'Ada' }), ada), false)
    assert.equal(namesIn('hello @Ada.', 'Ada'), true); assert.equal(namesIn('anything', ''), false)
  })

  describe('in the running room', () => {
    let ctx, base, dir, made
    const person = newIdentity()
    const send = async (id, name, payload, extra) => { const r = await fetch(`${base}/api/entries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signedDocument(id, { type: TYPES[name], payload, ...extra })) }); return { status: r.status, body: await r.json() } }
    const call = async (url, name, args = {}) => JSON.parse((await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })).json()).result.content[0].text)
    const node = async () => (await (await fetch(`${base}/api/map`)).json()).graph.nodes.find((n) => n.id === person.did)

    before(async () => {
      dir = mkdtempSync(join(tmpdir(), 'wpi-presence-'))
      const board = { generated: new Date().toISOString().slice(0, 10), projects: [], credentialProfiles: { profiles: {} }, runs: [] }
      ctx = await createApp({ ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, githubToken: '', weaverIntervalMinutes: 0, weaverQuietMinutes: 0, ratePerMinute: 1000, publicUrl: 'https://interop.example', boardDataUrl: 'data:application/json,' + encodeURIComponent(JSON.stringify(board)), llm: { ...baseConfig.llm, apiKey: '' } }, { openRoom: true, awayGatherMs: 0, hostWelcomeMs: null })
      await new Promise((r) => ctx.server.listen(0, '127.0.0.1', r))
      base = `http://127.0.0.1:${ctx.server.address().port}`
      await send(person, 'join', { name: 'Person A' })
      made = (await send(person, 'host', { label: 'Helper' })).body.hosted
      await send(person, 'delegate', { delegate: made.did, scope: ['note'], label: 'Helper' }, { expiresAt: new Date(Date.now() + 86400000).toISOString() })
      made.url = made.connector.replace(/^https?:\/\/[^/]+/, base)
    })
    after(async () => { await ctx.stop(); rmSync(dir, { recursive: true, force: true }) })

    test('before it speaks, the agent is being set up on its person\'s card, and not among those here', async () => {
      const n = await node()
      assert.deepEqual(n.agents, []); assert.deepEqual(n.settingUp, ['Helper'])
      const other = newIdentity(); await send(other, 'join', { name: 'Person B' })
      const seat = (await send(other, 'host', { label: 'Looker' })).body.hosted
      await send(other, 'delegate', { delegate: seat.did, scope: ['note'], label: 'Looker' }, { expiresAt: new Date(Date.now() + 86400000).toISOString() })
      const here = await call(seat.connector.replace(/^https?:\/\/[^/]+/, base), 'who_is_here')
      assert.ok(!here.some((p) => p.name === 'Helper'), 'not listed as here')
      assert.deepEqual(here.find((p) => p.name === 'Person A').agentsBeingSetUp, ['Helper'])
      assert.ok(here.some((p) => p.name === 'Looker' && p.you), 'an agent always sees itself')
    })

    test('once it says hello, it is in the room', async () => {
      await call(made.url, 'say', { text: 'Hello, I am here for Person A.' })
      const n = await node()
      assert.deepEqual(n.agents, ['Helper']); assert.deepEqual(n.settingUp, [])
    })
  })
})
