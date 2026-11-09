import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { TYPES, signedDocument } from '../src/shared/types.js'
import { config as baseConfig } from '../src/server/config.js'
import { createApp } from '../src/server/index.js'

// read_file: a shared file's text is pulled out once, when it is shared, and an agent that calls the tool
// wrongly is told which parameter to give (room line 540: an agent found "file" only by trying).
describe('read_file', () => {
  let ctx, base, dir, seat, sha, line
  const person = newIdentity()
  const send = async (id, name, payload, extra) => { const r = await fetch(`${base}/api/entries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signedDocument(id, { type: TYPES[name], payload, ...extra })) }); return { status: r.status, body: await r.json() } }
  const call = async (name, args) => { const r = await (await fetch(seat, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })).json(); return { error: Boolean(r.result.isError), text: r.result.content[0].text } }
  const text = 'Notes from the retreat\nline two\nline three\n'

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wpi-readfile-'))
    const board = { generated: new Date().toISOString().slice(0, 10), projects: [], credentialProfiles: { profiles: {} }, runs: [] }
    ctx = await createApp({ ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, githubToken: '', weaverIntervalMinutes: 0, weaverQuietMinutes: 0, ratePerMinute: 1000, publicUrl: 'https://interop.example', boardDataUrl: 'data:application/json,' + encodeURIComponent(JSON.stringify(board)), llm: { ...baseConfig.llm, apiKey: '' } }, { awayGatherMs: 0, hostWelcomeMs: null })
    await new Promise((r) => ctx.server.listen(0, r))
    base = `http://localhost:${ctx.server.address().port}`
    await send(person, 'join', { name: 'Person A' })
    const bytes = Buffer.from(text); sha = createHash('sha256').update(bytes).digest('hex')
    const up = await fetch(base + '/api/media', { method: 'POST', headers: { 'content-type': 'text/plain', 'x-wpi-upload': JSON.stringify(signedDocument(person, { type: TYPES.upload, payload: { sha256: sha, type: 'text/plain' } })) }, body: bytes })
    assert.equal(up.status, 201)
    line = await send(person, 'note', { text: 'Our notes', kind: 'message', files: [{ sha256: sha, type: 'text/plain', name: 'notes.txt', bytes: bytes.length }] })
    const made = (await send(person, 'host', { label: 'Reader' })).body.hosted
    await send(person, 'delegate', { delegate: made.did, scope: ['note'], label: 'Reader' }, { expiresAt: new Date(Date.now() + 86400000).toISOString() })
    seat = made.connector.replace(/^https?:\/\/[^/]+/, base)
  })
  after(async () => { await ctx.stop(); rmSync(dir, { recursive: true, force: true }) })

  test('the text is pulled out once, when the file is shared, not when an agent first asks', () => {
    assert.ok(existsSync(join(dir, 'media', `${sha}.text`)))
  })

  test('with nothing given, the error names both parameters', async () => {
    const r = await call('read_file', {})
    assert.equal(r.error, true)
    assert.match(r.text, /needs a parameter: file \(the sha256/); assert.match(r.text, /or message \(the id/)
  })

  test('file takes the sha256, sha256 is the same, and a /media/ link works too', async () => {
    for (const args of [{ file: sha }, { sha256: sha }, { file: `https://interop.example/media/${sha}?name=notes.txt` }]) {
      const r = await call('read_file', args)
      assert.equal(r.error, false, JSON.stringify(args)); assert.match(JSON.parse(r.text).text, /line three/)
    }
  })

  test('a wrong file value is told what file is; an unknown hash says so', async () => {
    const bad = await call('read_file', { file: 'notes.txt' })
    assert.equal(bad.error, true); assert.match(bad.text, /file is the sha256 of a shared file: 64 hex characters/); assert.match(bad.text, /you gave "notes.txt"/)
    const unknown = JSON.parse((await call('read_file', { file: 'f'.repeat(64) })).text)
    assert.match(unknown.note, /no file in this room has that sha256/)
  })

  test('message takes the line\'s id or its line number; a wrong one says what message is', async () => {
    assert.match(JSON.parse((await call('read_file', { message: line.body.hash })).text).text, /Notes from the retreat/)
    assert.match(JSON.parse((await call('read_file', { message: line.body.seq })).text).text, /Notes from the retreat/)
    assert.match(JSON.parse((await call('read_file', { message: `#${line.body.seq}` })).text).name, /notes\.txt/)
    const r = await call('read_file', { message: 'no-such-line' })
    assert.equal(r.error, true); assert.match(r.text, /message is the id \(or the line number\) of the line that shared the file/)
  })

  test('plain web calls can read with GET, by sha256 too', async () => {
    const r = await fetch(`${seat.replace('/mcp/a/', '/mcp/a/')}/call/read_file?sha256=${sha}`)
    assert.equal(r.status, 200); assert.match((await r.json()).text, /line two/)
  })
})
