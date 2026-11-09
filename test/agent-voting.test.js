import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { TYPES, signedDocument } from '../src/shared/types.js'
import { config as baseConfig } from '../src/server/config.js'
import { createApp } from '../src/server/index.js'
import { ROOM_INSTRUCTIONS } from '../src/agent-tools.js'

describe('agents vote for their people, and say when it is their judgment', () => {
  let ctx, base, dir
  const human = newIdentity(), agent = newIdentity()
  const post = async (doc) => { const r = await fetch(`${base}/api/entries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(doc) }); return { status: r.status, body: await r.json() } }
  const send = (id, name, payload, extra) => post(signedDocument(id, { type: TYPES[name], payload, ...extra }))
  const exp = () => new Date(Date.now() + 86400000).toISOString()
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wpi-vote-'))
    ctx = await createApp({ ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, weaverIntervalMinutes: 0, weaverQuietMinutes: 0, ratePerMinute: 1000, publicUrl: 'https://interop.example', boardDataUrl: '', llm: { ...baseConfig.llm, apiKey: '' } }, { awayGatherMs: 0, hostWelcomeMs: null })
    await new Promise((r) => ctx.server.listen(0, r))
    base = `http://localhost:${ctx.server.address().port}`
  })
  after(async () => { await ctx.stop(); rmSync(dir, { recursive: true, force: true }) })
  const voteOf = async (hash) => (await (await fetch(`${base}/api/state`)).json()).proposals.find((p) => p.hash === hash).votes

  test('the vote carries judgment, only as true/false, and the room shows it', async () => {
    assert.equal((await send(human, 'join', { name: 'Person A' })).status, 201)
    const d = await send(human, 'delegate', { delegate: agent.did, scope: ['note', 'vote'], label: 'A agent' }, { expiresAt: exp() })
    const as = { onBehalfOf: human.did, delegation: d.body.hash }
    const prop = (await send(human, 'propose', { kind: 'other', title: 'Try something' })).body.hash
    assert.equal((await send(agent, 'vote', { proposal: prop, choice: 'for', judgment: 'yes' }, as)).status, 400)
    assert.equal((await send(agent, 'vote', { proposal: prop, choice: 'for', judgment: true, reason: 'fits what they want' }, as)).status, 201)
    assert.equal((await voteOf(prop))[0].judgment, true)
    await send(human, 'vote', { proposal: prop, choice: 'against', judgment: true })
    const v = (await voteOf(prop))[0]
    assert.equal(v.choice, 'against'); assert.equal(v.judgment, false, 'a person\'s own vote is never marked as an agent\'s judgment')
  })

  test('the off switch: when the person asks to see votes first, the agent\'s vote is not posted', async () => {
    const d = await send(human, 'delegate', { delegate: agent.did, scope: ['note', 'vote'], ask: ['vote'], label: 'A agent' }, { expiresAt: exp() })
    const prop = (await send(human, 'propose', { kind: 'other', title: 'Another thing' })).body.hash
    const r = await send(agent, 'vote', { proposal: prop, choice: 'for', judgment: true }, { onBehalfOf: human.did, delegation: d.body.hash })
    assert.equal(r.status, 403); assert.deepEqual(await voteOf(prop), [])
  })

  test('agents are told the rule', () => {
    const t = ROOM_INSTRUCTIONS('', '')
    assert.match(t, /by your own judgment, unless they have told you otherwise/)
    assert.match(t, /judgment: true/)
    assert.match(t, /time, money or name, or on keys, permissions or access/)
  })
})
