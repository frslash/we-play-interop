// Step 9cb08b25: edit your own lines. An edit (input/edit) is a new signed line from the same side that names the
// line it replaces. The room accepts it only from the line's author or their agent, shows the newest words marked
// edited with the earlier ones kept, and a delete is an edit to empty, shown as "deleted by its author".
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { NAME_OF, TYPES, checkPayload, signedDocument } from '../src/shared/types.js'
import { config as baseConfig } from '../src/server/config.js'
import { createApp } from '../src/server/index.js'
import { createResolver } from '../src/server/resolver.js'
import { messages } from '../src/server/views.js'

const BOARD = { generated: new Date().toISOString().slice(0, 10), projects: [], scenarios: [], runs: [] }

async function room () {
  const dir = mkdtempSync(join(tmpdir(), 'wpi-edit-'))
  const config = { ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, githubToken: '', weaverIntervalMinutes: 0, weaverQuietMinutes: 0, ratePerMinute: 1000, workspaceRepo: 'example/room', publicUrl: 'https://interop.example', boardDataUrl: 'data:application/json,' + encodeURIComponent(JSON.stringify(BOARD)), llm: { ...baseConfig.llm, provider: 'openai', apiKey: '' } }
  const ctx = await createApp(config, { resolver: createResolver(), hostWelcomeMs: null, wakeFetch: async () => ({ ok: true, status: 200 }), gh: async () => ({}) })
  await new Promise((r) => ctx.server.listen(0, r))
  const base = `http://localhost:${ctx.server.address().port}`
  const send = async (id, name, payload, extra) => { const r = await fetch(`${base}/api/entries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signedDocument(id, { type: TYPES[name], payload, ...extra })) }); return { status: r.status, body: await r.json() } }
  const exp = new Date(Date.now() + 86400000).toISOString()
  const people = { a: newIdentity(), b: newIdentity() }, agents = { a: newIdentity(), b: newIdentity() }, dels = {}
  for (const k of ['a', 'b']) await send(people[k], 'join', { name: `Person ${k.toUpperCase()}` })
  for (const k of ['a', 'b']) dels[k] = (await send(people[k], 'delegate', { delegate: agents[k].did, scope: ['note'], label: `Agent ${k.toUpperCase()}` }, { expiresAt: exp })).body.hash
  const as = (k, name, payload) => send(agents[k], name, payload, { onBehalfOf: people[k].did, delegation: dels[k] })
  const said = (hash) => messages(ctx, { after: -1, limit: 100 }).items.find((m) => m.id === hash)
  const stop = async () => { await ctx.stop(); rmSync(dir, { recursive: true, force: true }) }
  return { ctx, send, as, people, said, stop }
}

describe('edit your own lines', () => {
  test('the author edits: the newest words show, marked edited, and the old words are kept', async () => {
    const r = await room()
    try {
      const line = (await r.send(r.people.a, 'note', { text: 'The carrier is TSP.', kind: 'message' })).body.hash
      const ed = await r.send(r.people.a, 'edit', { of: line, text: 'The carrier is TSP 1.0 over the mediator.' })
      assert.equal(ed.status, 201, JSON.stringify(ed.body))
      const m = r.said(line)
      assert.equal(m.text, 'The carrier is TSP 1.0 over the mediator.')
      assert.equal(m.edited, true)
      assert.deepEqual(m.earlier, ['The carrier is TSP.'])
      assert.equal(r.ctx.log.byHash.get(line).document.payload.text, 'The carrier is TSP.') // the first version is untouched in the record
    } finally { await r.stop() }
  })

  test('an edit signed by a different key is refused, a person\'s or another person\'s agent', async () => {
    const r = await room()
    try {
      const line = (await r.send(r.people.a, 'note', { text: 'Mine.', kind: 'message' })).body.hash
      const byB = await r.send(r.people.b, 'edit', { of: line, text: 'Not yours.' })
      assert.equal(byB.status, 403)
      assert.match(byB.body.payload.message, /only the line's author/)
      const byBsAgent = await r.as('b', 'edit', { of: line, text: 'Not yours either.' })
      assert.equal(byBsAgent.status, 403)
      assert.equal(r.said(line).text, 'Mine.')
      assert.equal(r.said(line).edited, undefined)
    } finally { await r.stop() }
  })

  test('a person\'s own agent may edit their line, and they may edit its line', async () => {
    const r = await room()
    try {
      const mine = (await r.send(r.people.a, 'note', { text: 'Draft words.', kind: 'message' })).body.hash
      assert.equal((await r.as('a', 'edit', { of: mine, text: 'Fixed by my agent.' })).status, 201)
      const its = (await r.as('a', 'note', { text: 'Agent words.', kind: 'message' })).body.hash
      assert.equal((await r.send(r.people.a, 'edit', { of: its, text: 'Fixed by its person.' })).status, 201)
      assert.equal(r.said(mine).text, 'Fixed by my agent.')
      assert.equal(r.said(its).text, 'Fixed by its person.')
    } finally { await r.stop() }
  })

  test('delete is an edit to empty: shown as deleted by its author, every version still in the signed record', async () => {
    const r = await room()
    try {
      const line = (await r.send(r.people.a, 'note', { text: 'First words.', kind: 'message' })).body.hash
      const ed = (await r.send(r.people.a, 'edit', { of: line, text: 'Second words.' })).body.hash
      const del = await r.send(r.people.a, 'edit', { of: line, text: '' })
      assert.equal(del.status, 201)
      const m = r.said(line)
      assert.equal(m.text, '(deleted by its author)')
      assert.equal(m.deleted, true)
      assert.deepEqual(m.earlier, ['First words.', 'Second words.'])
      assert.equal(r.ctx.log.byHash.get(line).document.payload.text, 'First words.')
      assert.equal(r.ctx.log.byHash.get(ed).document.payload.text, 'Second words.')
      assert.equal(r.said(del.body.hash).text, '(deleted by its author)')
      const v = await r.ctx.log.verify()
      assert.equal(v.ok, true, JSON.stringify(v))
    } finally { await r.stop() }
  })

  test('an edit names an original line: not an edit, not a vote, not the weaver\'s line, not a missing one', async () => {
    const r = await room()
    try {
      const line = (await r.send(r.people.a, 'note', { text: 'Words.', kind: 'message' })).body.hash
      const ed = (await r.send(r.people.a, 'edit', { of: line, text: 'New words.' })).body.hash
      assert.equal((await r.send(r.people.a, 'edit', { of: ed, text: 'x' })).status, 400)
      const join = r.ctx.log.entries.find((e) => NAME_OF[e.type] === 'join' && e.author === r.people.a.did).hash
      assert.equal((await r.send(r.people.a, 'edit', { of: join, text: 'x' })).status, 400)
      assert.equal((await r.send(r.people.a, 'edit', { of: 'f'.repeat(64), text: 'x' })).status, 400)
      const weaver = await r.ctx.log.appendAsWorkspace('note', { text: 'The weaver speaks.', kind: 'message' })
      assert.equal((await r.send(r.people.a, 'edit', { of: weaver.hash, text: 'x' })).status, 403)
    } finally { await r.stop() }
  })

  test('the payload check: of is a hash, text is new words or "" (never only spaces, never too long)', () => {
    const doc = (payload) => ({ payload })
    assert.equal(checkPayload('edit', doc({ of: 'a'.repeat(64), text: 'ok' })), null)
    assert.equal(checkPayload('edit', doc({ of: 'a'.repeat(64), text: '' })), null)
    assert.match(checkPayload('edit', doc({ of: 'a'.repeat(64), text: '   ' })), /text/)
    assert.match(checkPayload('edit', doc({ of: 'a'.repeat(64), text: 'x'.repeat(2001) })), /text/)
    assert.match(checkPayload('edit', doc({ of: 'nope', text: 'x' })), /of/)
  })

  test('the page shows the newest version, an edited mark, the earlier words one tap away, and deleted by its author', () => {
    const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
    assert.match(app, /function versionsOf/)
    assert.match(app, /'deleted by its author'/)
    assert.match(app, /'edited'/)
    assert.match(app, /earlier version/)
    assert.match(app, /post\('edit', \{ of: e\.hash, text: '' \}\)/)
  })
})
