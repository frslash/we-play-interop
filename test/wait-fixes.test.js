import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { TYPES, signedDocument } from '../src/shared/types.js'
import { config as baseConfig } from '../src/server/config.js'
import { createApp } from '../src/server/index.js'
import { HOOK, WAKE_ON as KIT_WAKE_ON } from '../public/setup.js'

// The room's wait fixes (room lines 319-327, 448-450, 928-954): agents wake for every new vote, keep their
// place across restarts, can follow the whole conversation as a roundup, and are told to call again
// (503, Retry-After) while the room restarts instead of seeing a failure.
describe('waiting on the room', () => {
  let ctx, base, dir, config, agent
  const person = newIdentity(), other = newIdentity()
  const send = async (id, name, payload, extra) => { const r = await fetch(`${base}/api/entries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signedDocument(id, { type: TYPES[name], payload, ...extra })) }); return { status: r.status, body: await r.json() } }
  const wait = (q) => fetch(`${base}/api/wait?me=${encodeURIComponent(agent)}&${q}`).then(async (r) => ({ status: r.status, retryAfter: r.headers.get('retry-after'), body: q.includes('as=text') ? await r.text() : await r.json() }))
  const start = async () => { ctx = await createApp(config, { openRoom: true, awayGatherMs: 0, hostWelcomeMs: null }); await new Promise((r) => ctx.server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${ctx.server.address().port}` }
  const head = () => ctx.log.head().seq

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wpi-waits-'))
    const board = { generated: new Date().toISOString().slice(0, 10), projects: [], credentialProfiles: { profiles: {} }, runs: [] }
    config = { ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, githubToken: '', weaverIntervalMinutes: 0, weaverQuietMinutes: 0, ratePerMinute: 1000, publicUrl: 'https://interop.example', boardDataUrl: 'data:application/json,' + encodeURIComponent(JSON.stringify(board)), llm: { ...baseConfig.llm, apiKey: '' } }
    await start()
    await send(person, 'join', { name: 'Person A' }); await send(other, 'join', { name: 'Person B' })
    const made = (await send(person, 'host', { label: 'Waiter' })).body.hosted
    await send(person, 'delegate', { delegate: made.did, scope: ['note', 'vote'], label: 'Waiter' }, { expiresAt: new Date(Date.now() + 86400000).toISOString() })
    agent = made.did
  })
  after(async () => { await ctx?.stop(); rmSync(dir, { recursive: true, force: true }) })

  test('a new goal, code change or idea to vote on wakes every agent; a board issue does not', async () => {
    for (const kind of ['goal', 'other']) {
      const waiting = wait(`after=${head()}&timeout=5`)
      await new Promise((r) => setTimeout(r, 50))
      await send(other, 'propose', { kind, title: `A ${kind} to vote on` })
      const a = await waiting
      assert.equal(a.body.woke, true, kind); assert.deepEqual(a.body.reasons, ['proposal'])
    }
    // it wakes even an agent that asked only for lines naming it, like a person's question to the room
    const narrow = wait(`after=${head()}&timeout=5&on=mention`)
    await new Promise((r) => setTimeout(r, 50))
    await send(other, 'propose', { kind: 'goal', title: 'Another goal' })
    assert.deepEqual((await narrow).body.reasons, ['proposal'])
    // an issue for the DTG board is not a vote every agent is woken for
    const quiet = wait(`after=${head()}&timeout=1`)
    await new Promise((r) => setTimeout(r, 50))
    await send(other, 'propose', { kind: 'issue', title: 'An issue for the board' })
    assert.equal((await quiet).body.woke, false)
    assert.ok(KIT_WAKE_ON.split(',').includes('proposal'), 'the Claude Code kit asks for it too')
  })

  test('without after, a wait starts where the agent was last woken, and that survives a restart', async () => {
    const woke = wait(`after=${head()}&timeout=5`)
    await new Promise((r) => setTimeout(r, 50))
    await send(other, 'note', { text: 'Waiter, one for you', kind: 'message', }, { recipient: agent })
    assert.equal((await woke).body.woke, true)
    // while the agent is busy answering, someone else talks to it; its next wait (no after) hears it at once
    await send(other, 'note', { text: 'Waiter, and another', kind: 'message' }, { recipient: agent })
    const next = await wait('timeout=1')
    assert.equal(next.body.woke, true); assert.deepEqual(next.body.reasons, ['direct'])
    // the room restarts; a line comes in before the agent waits again
    await ctx.stop(); await start()
    await send(other, 'note', { text: 'Waiter, after the update', kind: 'message' }, { recipient: agent })
    const afterRestart = await wait('timeout=1')
    assert.equal(afterRestart.body.woke, true, 'its place was kept across the restart'); assert.deepEqual(afterRestart.body.reasons, ['direct'])
    assert.equal((await wait('timeout=1')).body.woke, false, 'and once told, it is not told again')
  })

  test('a roundup wakes once the room has talked and paused, and quiet answers do not drop what it gathered', async () => {
    ctx.waits.quietMs = 300; ctx.waits.latestMs = 60_000
    await wait(`after=${head()}&timeout=1&on=direct`) // nothing yet
    const r = wait(`after=${head()}&timeout=5&on=roundup`)
    await new Promise((res) => setTimeout(res, 50))
    const t0 = Date.now()
    await send(other, 'note', { text: 'I think the did:key run went well.', kind: 'message' })
    await send(person, 'note', { text: 'It did, the signatures matched.', kind: 'message' })
    const a = await r
    assert.deepEqual(a.body.reasons, ['roundup']); assert.ok(Date.now() - t0 >= 250, 'after the quiet pause, not at the first line')
    // lines gathered across a quiet answer still make the next roundup
    ctx.waits.quietMs = 60_000
    await send(other, 'note', { text: 'Next we could try did:webvh.', kind: 'message' })
    const q = await wait(`after=${head()}&timeout=1&on=roundup`)
    assert.equal(q.body.woke, false, 'not due yet: the room has not paused for long')
    ctx.waits.quietMs = 0
    const due = await wait(`after=${q.body.head.seq}&timeout=1&on=roundup`)
    assert.deepEqual(due.body.reasons, ['roundup'], 'the line before the quiet answer still counts')
  })

  test('while the room keeps talking, a roundup still comes after a while', async () => {
    ctx.waits.quietMs = 60_000; ctx.waits.latestMs = 400
    const r = wait(`after=${head()}&timeout=5&on=roundup`)
    await new Promise((res) => setTimeout(res, 50))
    const t0 = Date.now(), talk = setInterval(() => send(other, 'note', { text: 'Still talking about the run.', kind: 'message' }), 100)
    const a = await r
    clearInterval(talk)
    assert.deepEqual(a.body.reasons, ['roundup']); assert.ok(Date.now() - t0 < 2000)
    await new Promise((res) => setTimeout(res, 150))
  })

  test('the hook knows a roundup and ignores an answer it cannot read', () => {
    assert.match(HOOK, /roundup\) echo "The room talked for a while/)
    assert.match(HOOK, /unexpected answer/)
    assert.doesNotMatch(HOOK, /curl -fsS/, 'a 503 answer is read, not treated as the room being gone')
  })

  test('while the room restarts, waits are told to call again: 503 with Retry-After', async () => {
    const cut = wait(`after=${head()}&timeout=10&as=text`)
    await new Promise((r) => setTimeout(r, 50))
    ctx.waits.stop() // what ctx.stop does first when the room updates itself
    const a = await cut
    assert.equal(a.status, 503); assert.equal(a.retryAfter, '5'); assert.match(a.body, /^busy \d+ restarting\n$/)
    const b = await wait('timeout=10')
    assert.equal(b.status, 503); assert.equal(b.retryAfter, '5'); assert.match(b.body.error, /restarting; call again in 5 seconds/)
    const other = await fetch(`${base}/api/state`)
    assert.equal(other.status, 503); assert.equal(other.headers.get('retry-after'), '5')
  })
})
