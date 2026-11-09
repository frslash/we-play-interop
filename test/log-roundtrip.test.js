// The CI job "export-roundtrip" (.github/workflows/log-roundtrip.yml) runs agent/export-log.js against the live
// room and then agent/import-log.js into an empty data dir. This runs the same two scripts, as separate
// processes, against a local room, so the job's steps are known to work before it meets the network.
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

const run = promisify(execFile)
const env = { ...process.env, DATABASE_URL: '' }
const roomConfig = (dataDir) => ({ ...baseConfig, dataDir, databaseUrl: '', workspaceKey: '', production: false, weaverIntervalMinutes: 0, weaverQuietMinutes: 0, ratePerMinute: 1000, publicUrl: 'https://interop.example', boardDataUrl: '', llm: { ...baseConfig.llm, apiKey: '' } })

describe('log round trip: export-log.js from a running room, import-log.js into an empty data dir', () => {
  test('prints ok, the entry count, the head seq and hash, and 0 unchecked signatures', async () => {
    const roomDir = mkdtempSync(join(tmpdir(), 'wpi-rt-room-')), emptyDir = mkdtempSync(join(tmpdir(), 'wpi-rt-empty-')), work = mkdtempSync(join(tmpdir(), 'wpi-rt-work-'))
    const ctx = await createApp(roomConfig(roomDir), { awayGatherMs: 0, hostWelcomeMs: null })
    try {
      await new Promise((r) => ctx.server.listen(0, r))
      const base = `http://localhost:${ctx.server.address().port}`, person = newIdentity()
      const send = async (name, payload) => (await fetch(`${base}/api/entries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signedDocument(person, { type: TYPES[name], payload })) })).json()
      await send('join', { name: 'Person A' })
      await send('card', { goals: ['interop'], workingOn: 'a thing', lookingFor: 'partners' })
      const prop = (await send('propose', { kind: 'other', title: 'Try it' })).hash
      await send('vote', { proposal: prop, choice: 'for' })
      const live = ctx.log.entries, liveHead = live.at(-1)

      const exp = await run(process.execPath, ['agent/export-log.js', base], { env, maxBuffer: 64 << 20 })
      assert.match(exp.stderr, new RegExp(`exported ${live.length} entries, head ${liveHead.seq} ${liveHead.hash}`))
      const file = join(work, 'room-export.json'); writeFileSync(file, exp.stdout)

      const imp = await run(process.execPath, ['agent/import-log.js', file, emptyDir], { env })
      const out = JSON.parse(imp.stdout)
      assert.equal(out.ok, true)
      assert.equal(out.entries, live.length)
      assert.deepEqual(out.head, { seq: liveHead.seq, hash: liveHead.hash })
      assert.equal(out.signaturesNotChecked, 0)

      // Run again into the same (now filled) dir: refused, non-zero exit, nothing overwritten.
      await assert.rejects(() => run(process.execPath, ['agent/import-log.js', file, emptyDir], { env }), (err) => err.code === 1 && /already has a log/.test(err.stderr))
    } finally {
      await ctx.stop()
      for (const d of [roomDir, emptyDir, work]) rmSync(d, { recursive: true, force: true })
    }
  })

  test('the CI job runs on every pull request and on main, export then round trip, into an empty dir, with no secrets', () => {
    // The job moved to its own workflow (.github/workflows/log-roundtrip.yml) so it also runs on main.
    const wf = readFileSync('.github/workflows/log-roundtrip.yml', 'utf8')
    assert.ok(wf.includes('\n  export-roundtrip:'), 'the job exists')
    assert.match(wf, /\n  pull_request:\n/, 'runs on every pull request')
    assert.match(wf, /push:\n\s+branches: \[main\]/, 'and on main')
    assert.match(wf, /ROOM_URL: https:\/\/inwove\.org/)
    assert.match(wf, /node agent\/export-log\.js "\$ROOM_URL"/)
    assert.match(wf, /node agent\/roundtrip-log\.js /, 're-imports, exports again and compares')
    assert.match(wf, /mkdir /, 'imports into a fresh, empty dir')
    assert.match(wf, /node agent\/roundtrip-summary\.js /, 'checks the unchecked-signature count (agent/roundtrip-summary.js, see test/roundtrip-notice.test.js)')
    const code = wf.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')
    assert.doesNotMatch(code, /secrets\.|id-token|pull_request_target|environment:/, 'stays read-only')
    assert.doesNotMatch(code, /^\s+[\w-]+:\s*write\b/m, 'asks for no write permission')
  })
})

describe('log round trip: a refused import says where the chain breaks', () => {
  test('import-log.js prints the seq and reason of each problem', async () => {
    const roomDir = mkdtempSync(join(tmpdir(), 'wpi-rt2-room-')), emptyDir = mkdtempSync(join(tmpdir(), 'wpi-rt2-empty-')), work = mkdtempSync(join(tmpdir(), 'wpi-rt2-work-'))
    const ctx = await createApp(roomConfig(roomDir), { awayGatherMs: 0, hostWelcomeMs: null })
    try {
      await ctx.log.accept(signedDocument(newIdentity(), { type: TYPES.join, payload: { name: 'Person A' } })).catch(() => {})
      const { makeExport } = await import('../src/server/export.js')
      const doc = JSON.parse(JSON.stringify(makeExport(ctx.log.entries)))
      const last = doc.entries.at(-1); last.document.payload.name = 'tampered'
      const file = join(work, 'bad.json'); writeFileSync(file, JSON.stringify(doc))
      await assert.rejects(() => run(process.execPath, ['agent/import-log.js', file, emptyDir], { env }), (err) => err.code === 1 && /the chain does not verify/.test(err.stderr) && new RegExp(`seq ${last.seq}: `).test(err.stderr))
    } finally {
      await ctx.stop()
      for (const d of [roomDir, emptyDir, work]) rmSync(d, { recursive: true, force: true })
    }
  })
})
