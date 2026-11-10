import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { TYPES, signedDocument } from '../src/shared/types.js'
import { config as baseConfig } from '../src/server/config.js'
import { createApp } from '../src/server/index.js'
import { openDb, loadEntries } from '../src/server/db.js'
import { checkExport, importExport, makeExport } from '../src/server/export.js'
import { State } from '../src/server/state.js'

describe('export: the public record leaves whole, and comes back to the same head', () => {
  test('export, import into a clean instance, same chain head and same meaning', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wpi-exp-')), dir2 = mkdtempSync(join(tmpdir(), 'wpi-imp-'))
    const ctx = await createApp({ ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, weaverIntervalMinutes: 0, weaverQuietMinutes: 0, ratePerMinute: 1000, publicUrl: 'https://interop.example', boardDataUrl: '', llm: { ...baseConfig.llm, apiKey: '' } }, { openRoom: true, awayGatherMs: 0, hostWelcomeMs: null })
    await new Promise((r) => ctx.server.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${ctx.server.address().port}`, person = newIdentity()
    const send = async (name, payload) => (await fetch(`${base}/api/entries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signedDocument(person, { type: TYPES[name], payload })) })).json()
    await send('join', { name: 'Person A' })
    await send('card', { goals: ['interop'], workingOn: 'a thing', lookingFor: 'partners' })
    const prop = (await send('propose', { kind: 'other', title: 'Try it' })).hash
    await send('vote', { proposal: prop, choice: 'for' })
    const doc = makeExport(ctx.log.entries)
    await ctx.stop(); rmSync(dir, { recursive: true, force: true })

    assert.equal(doc.head.hash, ctx.log.entries.at(-1).hash); assert.deepEqual(doc.includes, ['log'])
    assert.equal(JSON.stringify(doc).includes('notebook_enc'), false)
    const db = await openDb({ databaseUrl: '', dataDir: dir2 })
    const r = await importExport(db, JSON.parse(JSON.stringify(doc)))
    assert.deepEqual(r.head, doc.head)
    const back = await loadEntries(db)
    const st = new State(); for (const e of back) st.apply(e)
    assert.equal(st.proposals.get(prop).votes.size, 1, 'the vote folds the same')
    assert.equal(st.participants.get(person.did).card.workingOn, 'a thing')
    await assert.rejects(() => importExport(db, doc), /already has a log/, 'never into a log that exists')
    await db.close(); rmSync(dir2, { recursive: true, force: true })
  })

  test('a tampered, truncated or wrong-version export is refused', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wpi-exp2-'))
    const ctx = await createApp({ ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, weaverIntervalMinutes: 0, weaverQuietMinutes: 0, ratePerMinute: 1000, publicUrl: 'https://interop.example', boardDataUrl: '', llm: { ...baseConfig.llm, apiKey: '' } }, { openRoom: true, awayGatherMs: 0, hostWelcomeMs: null })
    const person = newIdentity()
    await ctx.log.accept(signedDocument(person, { type: TYPES.join, payload: { name: 'Person A' } })).catch(() => {})
    const good = makeExport(ctx.log.entries)
    await ctx.stop(); rmSync(dir, { recursive: true, force: true })
    assert.equal((await checkExport(good)).ok, true)
    const tampered = JSON.parse(JSON.stringify(good)); tampered.entries[0].document.payload.name = 'x'
    assert.equal((await checkExport(tampered)).ok, false)
    assert.match((await checkExport({ ...good, version: 2 })).problem, /version/)
    assert.match((await checkExport({ ...good, head: { seq: 0, hash: 'f'.repeat(64) } })).problem, /head/)
    assert.match((await checkExport({ ...good, count: 99 })).problem, /count/)
  })
})
