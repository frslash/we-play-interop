// The "For you" panel (room line 2629): what waits on one person, counted by the room for that person alone, on a
// signed private request that is never logged, and never part of the public room state (src/server/foryou.js).
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { TYPES, signedDocument } from '../src/shared/types.js'
import { config as baseConfig } from '../src/server/config.js'
import { createApp } from '../src/server/index.js'
import { createResolver } from '../src/server/resolver.js'

const BOARD = { generated: new Date().toISOString().slice(0, 10), projects: [], scenarios: [], runs: [] }

describe('For you: a private count of what waits on a person', () => {
  let ctx, dir, base
  const ada = newIdentity(), bo = newIdentity(), stranger = newIdentity()
  const send = async (id, name, payload, extra) => { const r = await fetch(`${base}/api/entries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signedDocument(id, { type: TYPES[name], payload, ...extra })) }); return { status: r.status, body: await r.json() } }
  const forYou = async (id, payload = {}) => { const r = await fetch(`${base}/api/for-you`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signedDocument(id, { type: TYPES.forYou, payload })) }); return { status: r.status, body: await r.json(), cache: r.headers.get('cache-control') } }
  const call = (link, name, args) => fetch(link, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }).then((r) => r.json())
  let proposal, agent

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wpi-for-you-'))
    const config = { ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, githubToken: '', weaverIntervalMinutes: 0, weaverQuietMinutes: 0, ratePerMinute: 1000, checkEveryMinutes: 0, boardDataUrl: 'data:application/json,' + encodeURIComponent(JSON.stringify(BOARD)), llm: { ...baseConfig.llm, provider: 'openai', apiKey: '' } }
    ctx = await createApp(config, { resolver: createResolver(), hostWelcomeMs: null, wakeFetch: async () => ({ ok: true, status: 200 }) })
    await new Promise((r) => ctx.server.listen(0, r))
    base = `http://localhost:${ctx.server.address().port}`
    await ctx.board.refresh()
    assert.equal((await send(ada, 'join', { name: 'Ada' })).status, 201)
    assert.equal((await send(bo, 'join', { name: 'Bo' })).status, 201)
    // Ada's hosted agent asks her first before each line: its line waits as a draft
    agent = (await send(ada, 'host', { label: 'Careful Cat' })).body.hosted
    await send(ada, 'delegate', { delegate: agent.did, scope: ['note', 'vote'], ask: ['note'], label: 'Careful Cat' }, { expiresAt: new Date(Date.now() + 86400000).toISOString() })
    const said = JSON.parse((await call(agent.connector.replace(/^https?:\/\/[^/]+/, base), 'say', { text: 'Hello, I am Careful Cat.' })).result.content[0].text)
    assert.equal(said.waiting, true)
    // Bo proposes something; nobody has voted on it
    proposal = (await send(bo, 'propose', { kind: 'other', title: 'Try a shared test vector' })).body.hash
    assert.ok(proposal)
  })
  after(async () => { await ctx.stop(); rmSync(dir, { recursive: true, force: true }) })

  test('signed in with one draft and one unvoted proposal: the counts and their sum', async () => {
    const r = await forYou(ada)
    assert.equal(r.status, 200)
    assert.equal(r.cache, 'no-store')
    assert.equal(r.body.for, ada.did)
    assert.equal(r.body.counts.ok, 1, 'one line of her agent waits for her OK')
    assert.equal(r.body.counts.vote, 1, 'one open proposal she has not voted on')
    assert.equal(r.body.counts.waiting, 0)
    assert.equal(r.body.counts.replies, 0)
    assert.equal(r.body.total, 2, 'the tab badge shows the sum')
    assert.deepEqual(r.body.ok, [{ agent: agent.did, name: 'Careful Cat', count: 1 }])
    assert.deepEqual(r.body.vote, [proposal])
  })

  test('a second person sees only their own', async () => {
    const r = await forYou(bo)
    assert.equal(r.status, 200)
    assert.equal(r.body.for, bo.did)
    assert.equal(r.body.counts.ok, 0, 'Ada\'s drafts are not Bo\'s')
    assert.equal(r.body.counts.vote, 1, 'Bo has not voted on his own proposal yet')
    assert.equal(r.body.ok.length, 0)
    await send(bo, 'vote', { proposal, choice: 'for' })
    assert.equal((await forYou(bo)).body.counts.vote, 0, 'voted: it no longer needs his vote')
    assert.equal((await forYou(ada)).body.counts.vote, 1, 'his vote is not hers')
  })

  test('unread replies: lines for her after the last one she has seen', async () => {
    const line = await send(bo, 'note', { text: 'Ada, could you look at this?', kind: 'message' })
    assert.equal(line.status, 201)
    const r = await forYou(ada)
    assert.equal(r.body.counts.replies, 1)
    assert.equal(r.body.total, 3)
    assert.equal((await forYou(ada, { seenUpTo: line.body.seq })).body.counts.replies, 0, 'seen: not counted')
    assert.equal((await forYou(bo)).body.counts.replies, 0, 'his own line is not a reply to him')
  })

  test('a step waiting on her counts as waiting on you, for her only', async () => {
    const id = 'step-test-1'
    ctx.log.state.steps.set(id, { id, title: 'Pick the key that signs', state: 'claimed', waitingOn: { who: ada.did, decision: 'which key', held: 'keys' } })
    try {
      const r = await forYou(ada)
      assert.equal(r.body.counts.waiting, 1)
      assert.deepEqual(r.body.waiting, [id])
      assert.equal((await forYou(bo)).body.counts.waiting, 0)
    } finally { ctx.log.state.steps.delete(id) }
  })

  test('none of it is public: not in /api/state, not in the log', async () => {
    const before = ctx.log.entries.length
    await forYou(ada)
    assert.equal(ctx.log.entries.length, before, 'asking writes nothing')
    const state = await (await fetch(`${base}/api/state`)).json()
    const panels = []
    const walk = (x, path) => { if (!x || typeof x !== 'object') return; if ((x.forYou && typeof x.forYou !== 'string') || (x.counts && typeof x.counts === 'object' && 'ok' in x.counts && 'vote' in x.counts)) panels.push(path); for (const [k, v] of Object.entries(x)) walk(v, `${path}.${k}`) }
    walk(state, 'state')
    assert.deepEqual(panels, [], 'the public state carries no panel counts')
    assert.equal(state.types.forYou, TYPES.forYou, 'only the kind of request is listed, as every kind is')
    const log = await (await fetch(`${base}/api/log?limit=500`)).text()
    assert.ok(!/for-you/.test(log), 'no for-you request is ever logged')
  })

  test('only a signed request from a person who joined, and each request once', async () => {
    assert.equal((await forYou(stranger)).status, 403, 'not in the room')
    const agentAsks = await fetch(`${base}/api/for-you`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signedDocument(newIdentity(), { type: TYPES.forYou, payload: {} })) })
    assert.equal(agentAsks.status, 403)
    const doc = signedDocument(ada, { type: TYPES.forYou, payload: {} })
    const post = () => fetch(`${base}/api/for-you`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(doc) })
    assert.equal((await post()).status, 200)
    assert.equal((await post()).status, 409, 'a replayed request is refused')
    const forged = { ...signedDocument(ada, { type: TYPES.forYou, payload: {} }), issuer: bo.did }
    assert.notEqual((await fetch(`${base}/api/for-you`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(forged) })).status, 200, 'signed by Ada, claiming to be Bo: refused')
    assert.equal((await forYou(ada, { seenUpTo: 'all' })).status, 400)
    assert.equal((await fetch(`${base}/api/for-you`)).status, 404, 'no unsigned way to read it')
    assert.equal((await send(ada, 'forYou', {})).status, 400, 'it never enters the log')
  })

  test('the page asks for it signed, shows four counts at the top and puts the total on the tab title', () => {
    const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'), page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
    assert.match(app, /privateCall\('\/api\/for-you', 'forYou'/)
    assert.match(app, /document\.title = d\?\.total \? `\(\$\{d\.total\}\) \$\{BASE_TITLE\}`/)
    for (const label of ['waiting for your OK', 'need your vote', 'waiting on you', 'unread repl']) assert.ok(app.includes(label), label)
    assert.ok(page.indexOf('id="for-you"') > 0 && page.indexOf('id="for-you"') < page.indexOf('<nav class="tabs"'), 'above the tabs and the talk')
  })
})
