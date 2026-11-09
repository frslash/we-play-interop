// The Talk tab shows a person every draft waiting for their OK, from all of their agents, with a plain count on the
// tab ("2 waiting for your OK"). Drafts stay private: another person cannot list them.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { TYPES, signedDocument } from '../src/shared/types.js'
import { allDrafts, waitingForOk, waitingLabel } from '../src/shared/presence.js'
import { config as baseConfig } from '../src/server/config.js'
import { createApp } from '../src/server/index.js'
import { createResolver } from '../src/server/resolver.js'

const BOARD = { generated: new Date().toISOString().slice(0, 10), projects: [], scenarios: [], runs: [] }

describe('waiting for your OK', () => {
  test('the count adds up every live agent of the person, and says it in plain words', () => {
    const people = [
      { kind: 'agent', did: 'a1', principal: 'p', delegation: 'h1', waiting: 1 },
      { kind: 'agent', did: 'a2', principal: 'p', delegation: 'h2', waiting: 1 },
      { kind: 'agent', did: 'a3', principal: 'p', delegation: null, waiting: 4 }, // permission stopped: can't be sent
      { kind: 'agent', did: 'a4', principal: 'p', delegation: 'h4', waiting: 3, removed: true },
      { kind: 'agent', did: 'b1', principal: 'q', delegation: 'h5', waiting: 5 }, // someone else's
      { kind: 'human', did: 'p', waiting: 9 },
    ]
    assert.equal(waitingForOk(people, 'p'), 2)
    assert.equal(waitingForOk(people, 'q'), 5)
    assert.equal(waitingForOk(people, null), 0)
    assert.equal(waitingLabel(2), '2 waiting for your OK')
    assert.equal(waitingLabel(1), '1 waiting for your OK')
    assert.equal(waitingLabel(0), '')
  })

  test('drafts from all agents come together, oldest first, each with its agent', () => {
    const a = { did: 'a1', name: 'One' }, b = { did: 'a2', name: 'Two' }
    const all = allDrafts([{ agent: a, drafts: [{ id: 'x', at: '2026-11-09T10:00:00Z' }] }, { agent: b, drafts: [{ id: 'y', at: '2026-11-09T09:00:00Z' }] }, { agent: b, drafts: null }])
    assert.deepEqual(all.map((d) => [d.id, d.agent.name]), [['y', 'Two'], ['x', 'One']])
  })

  test('a person with two held agents sees both drafts and the count; another person sees neither', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wpi-talkwait-'))
    const config = { ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, githubToken: '', weaverIntervalMinutes: 0, weaverQuietMinutes: 0, ratePerMinute: 1000, voteMinutes: 10, workspaceRepo: 'example/room', publicUrl: 'https://interop.example', boardDataUrl: 'data:application/json,' + encodeURIComponent(JSON.stringify(BOARD)), llm: { ...baseConfig.llm, provider: 'openai', apiKey: '' } }
    const ctx = await createApp(config, { resolver: createResolver(), hostWelcomeMs: null, wakeFetch: async () => ({ ok: true, status: 200 }), gh: async () => ({}) })
    await new Promise((r) => ctx.server.listen(0, r))
    const base = `http://localhost:${ctx.server.address().port}`
    try {
      const send = async (id, name, payload, extra) => (await (await fetch(`${base}/api/entries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signedDocument(id, { type: TYPES[name], payload, ...extra })) })).json())
      const call = (link, name, args) => fetch(link, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }).then((x) => x.json())
      const drafts = async (who, agent) => { const r = await fetch(`${base}/api/drafts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signedDocument(who, { type: TYPES.draft, payload: { agent, op: 'list' } })) }); return { status: r.status, body: await r.json() } }
      const day = newIdentity(), other = newIdentity(), exp = new Date(Date.now() + 86400000).toISOString()
      await send(day, 'join', { name: 'Day' }); await send(other, 'join', { name: 'Other' })
      const agents = []
      for (const label of ['First Helper', 'Second Helper']) {
        const made = (await send(day, 'host', { label })).hosted
        await send(day, 'delegate', { delegate: made.did, scope: ['note'], ask: ['note'], label }, { expiresAt: exp })
        const said = JSON.parse((await call(made.connector.replace(/^https?:\/\/[^/]+/, base), 'say', { text: `Hello from ${label}.` })).result.content[0].text)
        assert.equal(said.waiting, true, 'held for its person')
        agents.push(made.did)
      }
      const state = await (await fetch(`${base}/api/state`)).json()
      assert.equal(waitingForOk(state.people, day.did), 2)
      assert.equal(waitingLabel(waitingForOk(state.people, day.did)), '2 waiting for your OK')
      const lists = []
      for (const a of agents) { const r = await drafts(day, a); assert.equal(r.status, 200); lists.push({ agent: { did: a }, drafts: r.body.drafts }) }
      assert.deepEqual(allDrafts(lists).map((d) => d.payload.text).sort(), ['Hello from First Helper.', 'Hello from Second Helper.'])
      for (const a of agents) assert.equal((await drafts(other, a)).status, 403, 'only its person sees its drafts')
    } finally { await ctx.stop(); rmSync(dir, { recursive: true, force: true }) }
  })

  test('the page asks every held agent for its drafts and puts the count on the Talk tab', () => {
    const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
    assert.match(app, /import \{[^}]*\bwaitingForOk\b[^}]*\bwaitingLabel\b[^}]*\} from '\/shared\/presence\.js'/)
    assert.match(app, /holders\.map\(\(a\) => privateCall\('\/api\/drafts', 'draft', \{ agent: a\.did, op: 'list' \}\)\)/)
    assert.match(app, /data-tab="talk"[\s\S]{0,600}waitingLabel\(w\)/)
    assert.match(app, /talk\.waiting = h\('div', \{ class: 'waiting-strip'/)
  })
})
