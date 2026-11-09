import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { TYPES, signedDocument } from '../src/shared/types.js'
import { config as baseConfig } from '../src/server/config.js'
import { createApp } from '../src/server/index.js'

// A lost key (room lines 772-821): the person joins with a new key and asks to be linked to their old name,
// people who know them vouch (agents never can), and the room's host marks the old key replaced. Its
// permissions for agents end in the same step, its card and projects move over, and the history stays.
describe('replacing a lost key', () => {
  let ctx, base, dir, seat, grant
  const oldKey = newIdentity(), newKey = newIdentity(), friend = newIdentity(), host = newIdentity(), stranger = newIdentity()
  const until = new Date(Date.now() + 86400000).toISOString()
  const send = async (id, name, payload, extra) => { const r = await fetch(`${base}/api/entries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signedDocument(id, { type: TYPES[name], payload, ...extra })) }); return { status: r.status, body: await r.json() } }
  const call = async (name, args = {}) => { const r = await (await fetch(seat, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })).json(); return { error: Boolean(r.result.isError), text: r.result.content[0].text } }
  const state = async () => (await fetch(`${base}/api/state`)).json()
  let request

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wpi-lostkeys-'))
    const board = { generated: new Date().toISOString().slice(0, 10), projects: [], credentialProfiles: { profiles: {} }, runs: [] }
    ctx = await createApp({ ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, githubToken: '', hosts: [host.did], weaverIntervalMinutes: 0, weaverQuietMinutes: 0, ratePerMinute: 1000, publicUrl: 'https://interop.example', boardDataUrl: 'data:application/json,' + encodeURIComponent(JSON.stringify(board)), llm: { ...baseConfig.llm, apiKey: '' } }, { awayGatherMs: 0, hostWelcomeMs: null })
    await new Promise((r) => ctx.server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${ctx.server.address().port}`
    for (const [id, name] of [[oldKey, 'Person A'], [friend, 'Person B'], [host, 'The host'], [stranger, 'Person C']]) await send(id, 'join', { name })
    await send(oldKey, 'card', { goals: ['interop'], workingOn: 'a wallet', lookingFor: '' })
    const made = (await send(oldKey, 'host', { label: 'Helper' })).body.hosted
    grant = (await send(oldKey, 'delegate', { delegate: made.did, scope: ['note'], label: 'Helper' }, { expiresAt: until })).body.hash
    seat = made.connector.replace(/^https?:\/\/[^/]+/, base)
    assert.equal((await call('say', { text: 'Hello, I am here for Person A.' })).error, false)
    await send(newKey, 'join', { name: 'Person A' }) // the browser was reset: a new key, the same person
  })
  after(async () => { await ctx.stop(); rmSync(dir, { recursive: true, force: true }) })

  test('the new key asks to be linked to the old name', async () => {
    assert.equal((await send(newKey, 'link', { old: newKey.did })).status, 400, 'not to itself')
    const r = await send(newKey, 'link', { old: oldKey.did, why: 'my browser was reset' })
    assert.equal(r.status, 201); request = r.body.hash
    const l = (await state()).links.find((x) => x.hash === request)
    assert.equal(l.from, newKey.did); assert.equal(l.old, oldKey.did); assert.deepEqual(l.vouches, [])
  })

  test('the host can\'t mark it before anyone has vouched; the person can\'t vouch for themselves; agents never vouch', async () => {
    assert.match((await send(host, 'replace', { request })).body.payload?.message ?? '', /no one has vouched/)
    assert.equal((await send(newKey, 'vouch', { request })).status, 403)
    assert.equal((await send(oldKey, 'vouch', { request })).status, 403)
    // an agent signing for its person: vouching stays with people
    const agentKey = newIdentity()
    const g = (await send(friend, 'delegate', { delegate: agentKey.did, scope: ['note', 'vote'], label: 'Friend bot' }, { expiresAt: until })).body.hash
    const byAgent = signedDocument(agentKey, { type: TYPES.vouch, payload: { request }, onBehalfOf: friend.did, delegation: g })
    const r = await fetch(`${base}/api/entries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(byAgent) })
    assert.equal(r.status, 403); assert.match((await r.json()).payload.message, /stays with humans/)
  })

  test('a person who knows them vouches; only the host marks it replaced', async () => {
    assert.equal((await send(friend, 'vouch', { request, why: 'we spoke today' })).status, 201)
    assert.deepEqual((await state()).links.find((x) => x.hash === request).vouches.map((v) => v.name), ['Person B'])
    assert.equal((await send(stranger, 'replace', { request })).status, 403, 'not the host')
    assert.equal((await send(host, 'replace', { request })).status, 201)
  })

  test('the old key is retired: no longer listed, its agent permissions ended, its card moved; the history stays', async () => {
    const st = await state()
    assert.ok(!st.people.some((p) => p.did === oldKey.did), 'no longer listed as present')
    assert.equal(st.replaced[oldKey.did].by, newKey.did)
    assert.deepEqual(st.people.find((p) => p.did === newKey.did).replaces, [oldKey.did])
    assert.equal(st.people.find((p) => p.did === newKey.did).card.workingOn, 'a wallet')
    assert.ok(ctx.log.state.delegations.get(grant).revoked, 'its permission for its agent ended in the same step')
    assert.equal((await call('say', { text: 'Still here?' })).error, true, 'its agent can no longer act on the old permission')
    const old = await send(oldKey, 'note', { text: 'Am I still here?', kind: 'message' })
    assert.equal(old.status, 403); assert.match(old.body.payload.message, /replaced by Person A's new key/)
    assert.ok(ctx.log.entries.some((e) => e.document.payload?.text === 'Hello, I am here for Person A.'), 'what was said stays')
    assert.equal((await send(friend, 'vouch', { request })).status, 403, 'a linked request takes no more vouches')
    assert.equal((await send(stranger, 'link', { old: oldKey.did })).status, 403, 'a replaced account can\'t be claimed again')
  })

  test('the new key signs a new permission for the old key\'s agent', async () => {
    const helper = [...ctx.log.state.participants.values()].find((p) => p.name === 'Helper')
    assert.equal((await send(stranger, 'delegate', { delegate: helper.did, scope: ['note'], label: 'Helper' }, { expiresAt: until })).status, 403, 'not someone else')
    assert.equal((await send(newKey, 'delegate', { delegate: helper.did, scope: ['note'], label: 'Helper' }, { expiresAt: until })).status, 201)
    assert.equal(ctx.log.state.participants.get(helper.did).principal, newKey.did)
    assert.equal((await call('say', { text: 'Back, for Person A\'s new key.' })).error, false)
  })

  test('without a host named, the last step says so', async () => {
    const other = newIdentity(), other2 = newIdentity(); await send(other, 'join', { name: 'Person D' }); await send(other2, 'join', { name: 'Person D again' })
    const r = (await send(other2, 'link', { old: other.did })).body.hash
    await send(friend, 'vouch', { request: r })
    const hosts = ctx.config.hosts; ctx.config.hosts = []
    try { assert.match((await send(host, 'replace', { request: r })).body.payload.message, /no host named yet \(ROOM_HOSTS\)/) } finally { ctx.config.hosts = hosts }
  })
})
