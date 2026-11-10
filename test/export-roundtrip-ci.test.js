// The export round trip as CI runs it: export a running room, re-import into an empty data folder,
// export again from the copy, and compare entry by entry (agent/roundtrip-log.js, src/server/export.js).
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { promisify } from 'node:util'
import { newIdentity } from '../src/shared/did.js'
import { TYPES, signedDocument } from '../src/shared/types.js'
import { config as baseConfig } from '../src/server/config.js'
import { createApp } from '../src/server/index.js'
import { openDb } from '../src/server/db.js'
import { compareExports, makeExport, roundTrip } from '../src/server/export.js'
import { passed } from '../agent/roundtrip-summary.js'

const run = promisify(execFile)
const env = { ...process.env, DATABASE_URL: '' }
const roomConfig = (dataDir) => ({ ...baseConfig, dataDir, databaseUrl: '', workspaceKey: '', production: false, weaverIntervalMinutes: 0, weaverQuietMinutes: 0, ratePerMinute: 1000, publicUrl: 'https://interop.example', boardDataUrl: '', llm: { ...baseConfig.llm, apiKey: '' } })

async function liveRoom () {
  const roomDir = mkdtempSync(join(tmpdir(), 'wpi-ert-room-'))
  const ctx = await createApp(roomConfig(roomDir), { openRoom: true, awayGatherMs: 0, hostWelcomeMs: null })
  await new Promise((r) => ctx.server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${ctx.server.address().port}`, person = newIdentity()
  const send = async (name, payload) => (await fetch(`${base}/api/entries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signedDocument(person, { type: TYPES[name], payload })) })).json()
  await send('join', { name: 'Person A' })
  await send('card', { goals: ['interop'], workingOn: 'a thing', lookingFor: 'partners' })
  const prop = (await send('propose', { kind: 'other', title: 'Try it' })).hash
  await send('vote', { proposal: prop, choice: 'for' })
  return { ctx, base, stop: async () => { await ctx.stop(); rmSync(roomDir, { recursive: true, force: true }) } }
}

describe('export round trip: export, re-import, compare', () => {
  test('the scripts CI runs: same entries back, same head, 0 unchecked, and the summary passes', async () => {
    const room = await liveRoom(), work = mkdtempSync(join(tmpdir(), 'wpi-ert-work-'))
    try {
      const exp = await run(process.execPath, ['agent/export-log.js', room.base], { env, maxBuffer: 64 << 20 })
      const file = join(work, 'room-export.json'); writeFileSync(file, exp.stdout)
      const again = join(work, 're-export.json'), dataDir = join(work, 'empty')
      const out = await run(process.execPath, ['agent/roundtrip-log.js', file, dataDir, again], { env })
      const r = JSON.parse(out.stdout)
      const doc = JSON.parse(readFileSync(file, 'utf8'))
      assert.equal(r.ok, true); assert.equal(r.same, true); assert.equal(r.firstDifference, null)
      assert.equal(r.entries, doc.count); assert.deepEqual(r.head, doc.head); assert.deepEqual(r.reexport.head, doc.head)
      assert.equal(r.signaturesNotChecked, 0)
      assert.equal(passed(r), true)
      assert.deepEqual(JSON.parse(readFileSync(again, 'utf8')).entries, doc.entries, 'the re-export holds the same entries')
      // The data folder now has a log: a second round trip into it is refused, never merged.
      await assert.rejects(() => run(process.execPath, ['agent/roundtrip-log.js', file, dataDir], { env }), (err) => err.code === 1 && /already has a log/.test(err.stderr) && JSON.parse(err.stdout).ok === false)
    } finally { await room.stop(); rmSync(work, { recursive: true, force: true }) }
  })

  test('a tampered export fails the round trip and says why', async () => {
    const room = await liveRoom(), work = mkdtempSync(join(tmpdir(), 'wpi-ert-bad-'))
    try {
      const doc = JSON.parse(JSON.stringify(makeExport(room.ctx.log.entries)))
      doc.entries[1].document.payload.name = 'tampered'
      const file = join(work, 'bad.json'); writeFileSync(file, JSON.stringify(doc))
      await assert.rejects(() => run(process.execPath, ['agent/roundtrip-log.js', file, join(work, 'empty')], { env }), (err) => err.code === 1 && /the chain does not verify/.test(err.stderr) && /seq 1: /.test(err.stderr) && passed(JSON.parse(err.stdout)) === false)
    } finally { await room.stop(); rmSync(work, { recursive: true, force: true }) }
  })

  test('compareExports names the first entry that differs, and a missing one', () => {
    const a = { count: 3, head: { seq: 2, hash: 'c' }, entries: [{ seq: 0, hash: 'a' }, { seq: 1, hash: 'b' }, { seq: 2, hash: 'c' }] }
    assert.deepEqual(compareExports(a, JSON.parse(JSON.stringify(a))), { same: true, sameCount: true, sameHead: true, firstDifference: null })
    const changed = JSON.parse(JSON.stringify(a)); changed.entries[1].x = 1
    assert.equal(compareExports(a, changed).firstDifference, 1)
    assert.equal(compareExports(a, changed).same, false)
    const short = { count: 2, head: { seq: 1, hash: 'b' }, entries: a.entries.slice(0, 2) }
    const c = compareExports(a, short)
    assert.equal(c.same, false); assert.equal(c.sameCount, false); assert.equal(c.sameHead, false); assert.equal(c.firstDifference, 2)
    // Key order does not matter: entries are compared as canonical JSON.
    const reordered = { ...a, entries: a.entries.map(({ seq, hash }) => ({ hash, seq })) }
    assert.equal(compareExports(a, reordered).same, true)
  })

  test('roundTrip in process refuses a non-empty database', async () => {
    const room = await liveRoom(), work = mkdtempSync(join(tmpdir(), 'wpi-ert-db-'))
    const db = await openDb({ databaseUrl: '', dataDir: work })
    try {
      const doc = JSON.parse(JSON.stringify(makeExport(room.ctx.log.entries)))
      const r = await roundTrip(db, doc)
      assert.equal(r.ok, true); assert.equal(r.entries, doc.count)
      await assert.rejects(() => roundTrip(db, doc), /already has a log/)
    } finally { await db.close(); await room.stop(); rmSync(work, { recursive: true, force: true }) }
  })
})
