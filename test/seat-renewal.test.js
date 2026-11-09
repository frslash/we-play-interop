// Renewing an agent's seat from the page (src/shared/seats.js, public/app.js): in a seat's last two weeks its person
// sees "Renew for 90 days", which signs the same permission and asks with a later end. Before this, a week-long seat
// could only be re-made by hand in the form, which also reset what the agent asks its person first.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { AGENT_SCOPES, TYPES, signedDocument } from '../src/shared/types.js'
import { RENEW_DAYS, RENEW_WITHIN_DAYS, renewal, renewed } from '../src/shared/seats.js'
import { config as baseConfig } from '../src/server/config.js'
import { createApp } from '../src/server/index.js'
import { createResolver } from '../src/server/resolver.js'

const DAY = 86_400_000, NOW = Date.parse('2026-11-09T16:00:00Z')
const seat = (days, extra = {}) => ({ did: 'did:key:z6MkAgent', name: 'Ember', delegation: 'h1', scope: ['note', 'propose', 'vote'], ask: ['vote'], until: new Date(NOW + days * DAY).toISOString(), ...extra })

describe('renewing an agent’s seat', () => {
  test('offered in the last two weeks of a running seat, and only then', () => {
    assert.deepEqual(renewal(seat(5.8), NOW), { days: 6, until: new Date(NOW + 5.8 * DAY).toISOString() })
    assert.equal(renewal(seat(RENEW_WITHIN_DAYS), NOW)?.days, RENEW_WITHIN_DAYS)
    assert.equal(renewal(seat(0.2), NOW)?.days, 1)
    assert.equal(renewal(seat(30), NOW), null, 'a fresh seat never nags')
    assert.equal(renewal(seat(-1), NOW), null, 'an ended seat is not this button’s: the form signs a new one')
    assert.equal(renewal(seat(5, { delegation: null }), NOW), null, 'nor a stopped one')
    assert.equal(renewal(seat(5, { until: null }), NOW), null)
  })

  test('the renewal keeps what it may do, what it asks first and its name, and ends 90 days on', () => {
    const r = renewed(seat(5), AGENT_SCOPES, NOW)
    assert.deepEqual(r.payload, { delegate: 'did:key:z6MkAgent', scope: ['note', 'propose', 'vote'], ask: ['vote'], label: 'Ember' })
    assert.equal(r.issuedAt, new Date(NOW).toISOString()); assert.equal(Date.parse(r.expiresAt) - NOW, RENEW_DAYS * DAY)
    assert.deepEqual(renewed(seat(5, { scope: [], ask: undefined }), AGENT_SCOPES, NOW).payload.scope, AGENT_SCOPES, 'an old seat with no scope listed gets the agent scopes')
  })

  test('the room takes it: the agent’s live permission now ends 90 days on, with the same asks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wpi-renew-'))
    const BOARD = { generated: new Date().toISOString().slice(0, 10), projects: [], scenarios: [], runs: [] }
    const config = { ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, githubToken: '', weaverIntervalMinutes: 0, weaverQuietMinutes: 0, ratePerMinute: 1000, boardDataUrl: 'data:application/json,' + encodeURIComponent(JSON.stringify(BOARD)), llm: { ...baseConfig.llm, provider: 'openai', apiKey: '' } }
    const ctx = await createApp(config, { resolver: createResolver(), hostWelcomeMs: null })
    await new Promise((r) => ctx.server.listen(0, r))
    try {
      const base = `http://localhost:${ctx.server.address().port}`
      const send = async (id, name, payload, extra) => { const r = await fetch(`${base}/api/entries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signedDocument(id, { type: TYPES[name], payload, ...extra })) }); return { status: r.status, body: await r.json() } }
      const person = newIdentity(), agent = newIdentity(), now = Date.now()
      await send(person, 'join', { name: 'Person A' })
      const week = await send(person, 'delegate', { delegate: agent.did, scope: ['note', 'propose', 'vote'], ask: ['vote'], label: 'Ember' }, { expiresAt: new Date(now + 7 * DAY).toISOString() })
      assert.equal(week.status, 201)
      const view = { did: agent.did, name: 'Ember', delegation: week.body.hash, scope: ['note', 'propose', 'vote'], ask: ['vote'], until: new Date(now + 7 * DAY).toISOString() }
      assert.ok(renewal(view), 'a week-long seat is offered a renewal')
      const r = renewed(view, AGENT_SCOPES)
      const again = await send(person, 'delegate', r.payload, { expiresAt: r.expiresAt })
      assert.equal(again.status, 201)
      const live = ctx.log.state.activeDelegation(agent.did)
      assert.equal(live.hash, again.body.hash); assert.ok(Date.parse(live.expiresAt) - now > 89 * DAY)
      assert.deepEqual(live.ask, ['vote']); assert.deepEqual(live.scope, ['note', 'propose', 'vote'])
    } finally { await ctx.stop(); rmSync(dir, { recursive: true, force: true }) }
  })
})
