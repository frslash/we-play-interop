import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { TYPES, checkPayload, signedDocument } from '../src/shared/types.js'
import { ROOM_INSTRUCTIONS } from '../src/agent-tools.js'
import { config as baseConfig } from '../src/server/config.js'
import { createApp } from '../src/server/index.js'

describe('an agent says which model it runs on and where', () => {
  let ctx, base, dir
  const A = newIdentity(), B = newIdentity()
  const post = async (doc) => { const r = await fetch(`${base}/api/entries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(doc) }); return { status: r.status, body: await r.json() } }
  const send = (id, name, payload, extra) => post(signedDocument(id, { type: TYPES[name], payload, ...extra }))
  const rpc = async (url, name, args = {}) => { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }); const j = await r.json(); return j.result?.isError ? { error: j.result.content[0].text } : JSON.parse(j.result.content[0].text) }
  const hostAgent = async (person, label) => {
    const made = await send(person, 'host', { label })
    const did = made.body.hosted.did, url = made.body.hosted.connector.replace(/^https?:\/\/[^/]+/, base)
    await send(person, 'delegate', { delegate: did, scope: ['note', 'card'], label }, { expiresAt: new Date(Date.now() + 86400000).toISOString() })
    return { did, url }
  }
  const state = async () => (await (await fetch(`${base}/api/state`)).json()).people
  let agentA, agentB

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wpi-model-'))
    const config = { ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, weaverIntervalMinutes: 0, weaverQuietMinutes: 0, ratePerMinute: 1000, publicUrl: 'https://interop.example', llm: { ...baseConfig.llm, apiKey: '' } }
    ctx = await createApp(config, { hostWelcomeMs: null, awayGatherMs: 0 })
    await new Promise((r) => ctx.server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${ctx.server.address().port}`
    await send(A, 'join', { name: 'Person A' }); await send(B, 'join', { name: 'Person B' })
    agentA = await hostAgent(A, 'Agent A'); agentB = await hostAgent(B, 'Agent B')
  })
  after(async () => { await ctx.stop(); rmSync(dir, { recursive: true, force: true }) })

  test('the agent sets both through update_card and /api/state shows them on that agent only', async () => {
    const r = await rpc(agentA.url, 'update_card', { workingOn: 'Credentials', model: 'Claude Opus 5.5', runsOn: 'Anthropic\'s servers, via Claude Code on a laptop' })
    assert.equal(r.accepted, true)
    const people = await state()
    const a = people.find((p) => p.did === agentA.did), b = people.find((p) => p.did === agentB.did), person = people.find((p) => p.did === A.did)
    assert.equal(a.runsOnSaid.model, 'Claude Opus 5.5')
    assert.equal(a.runsOnSaid.runsOn, 'Anthropic\'s servers, via Claude Code on a laptop')
    assert.equal(b.runsOnSaid, undefined, 'another agent is not touched')
    assert.equal(person.runsOnSaid, undefined, 'the person has none')
    assert.equal(person.card.workingOn, 'Credentials')
  })

  test('an update that leaves them out keeps them; a new value replaces them', async () => {
    await rpc(agentA.url, 'update_card', { lookingFor: 'people with VMC' })
    assert.equal((await state()).find((p) => p.did === agentA.did).runsOnSaid.model, 'Claude Opus 5.5')
    await rpc(agentA.url, 'update_card', { model: 'a local model', runsOn: 'local' })
    const a = (await state()).find((p) => p.did === agentA.did)
    assert.deepEqual([a.runsOnSaid.model, a.runsOnSaid.runsOn], ['a local model', 'local'])
  })

  test('too-long, non-text and multi-line values are refused', () => {
    assert.match(checkPayload('card', { payload: { model: 'x'.repeat(81) } }), /model/)
    assert.match(checkPayload('card', { payload: { runsOn: 'x'.repeat(121) } }), /runsOn/)
    assert.match(checkPayload('card', { payload: { model: 42 } }), /model/)
    assert.match(checkPayload('card', { payload: { runsOn: { host: 'x' } } }), /runsOn/)
    assert.match(checkPayload('card', { payload: { model: 'one\ntwo' } }), /model/)
    assert.equal(checkPayload('card', { payload: { model: 'Claude Opus 5.5', runsOn: 'local' } }), null)
  })

  test('a refused value never reaches the room, and a secret in one is refused too', async () => {
    const tooLong = await rpc(agentA.url, 'update_card', { model: 'x'.repeat(200) })
    assert.ok(tooLong.error)
    const secret = await rpc(agentA.url, 'update_card', { runsOn: 'my key is sk-ant-api03-' + 'A'.repeat(40) })
    assert.ok(secret.error, 'the secret guard still runs on the card')
    assert.equal((await state()).find((p) => p.did === agentA.did).runsOnSaid.model, 'a local model')
  })

  test('a person cannot set an agent\'s model, and no one can set another agent\'s', async () => {
    const byPerson = await send(A, 'card', { model: 'Claude Opus 5.5' })
    assert.equal(byPerson.status, 403)
    // agent B signs for B's person: it lands on agent B, never on agent A
    await rpc(agentB.url, 'update_card', { model: 'a different model', runsOn: 'a named host' })
    const people = await state()
    assert.equal(people.find((p) => p.did === agentB.did).runsOnSaid.model, 'a different model')
    assert.equal(people.find((p) => p.did === agentA.did).runsOnSaid.model, 'a local model')
  })

  test('agents are told to set them', () => {
    assert.match(ROOM_INSTRUCTIONS('x', ''), /model, runsOn/)
  })
})
