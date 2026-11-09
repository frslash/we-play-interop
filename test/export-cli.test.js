// The export step's exact commands, run as the room's pass test asks, against a local room:
//   node agent/export-log.js <room url> > room-export.json
//   node agent/import-log.js room-export.json <data-dir>
// Pass: the import prints ok:true, the entry count matches, the head (seq and hash) is the same,
// and signaturesNotChecked is 0.
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
const script = (name) => new URL(`../agent/${name}`, import.meta.url).pathname

describe('export step: the two agent scripts, end to end', () => {
  test('export from a running room, import into an empty data folder: ok, same count, same head, 0 unchecked', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wpi-cli-src-')), out = mkdtempSync(join(tmpdir(), 'wpi-cli-out-'))
    const ctx = await createApp({ ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, weaverIntervalMinutes: 0, weaverQuietMinutes: 0, ratePerMinute: 1000, publicUrl: 'https://interop.example', boardDataUrl: '', llm: { ...baseConfig.llm, apiKey: '' } }, { awayGatherMs: 0, hostWelcomeMs: null })
    await new Promise((r) => ctx.server.listen(0, r))
    const base = `http://localhost:${ctx.server.address().port}`, person = newIdentity()
    const send = async (name, payload) => (await fetch(`${base}/api/entries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signedDocument(person, { type: TYPES[name], payload })) })).json()
    try {
      await send('join', { name: 'Person A' })
      await send('card', { goals: ['interop'], workingOn: 'a thing', lookingFor: 'partners' })
      const env = { ...process.env, DATABASE_URL: '' }
      const exp = await run(process.execPath, [script('export-log.js'), base], { env, maxBuffer: 64 << 20 })
      const file = join(out, 'room-export.json'); writeFileSync(file, exp.stdout)
      const doc = JSON.parse(readFileSync(file, 'utf8'))
      assert.equal(doc.count, ctx.log.entries.length)

      const imp = await run(process.execPath, [script('import-log.js'), file, join(out, 'data')], { env })
      const r = JSON.parse(imp.stdout)
      assert.equal(r.ok, true)
      assert.equal(r.entries, doc.count, 'entry count matches the export')
      assert.deepEqual(r.head, doc.head, 'same chain head, seq and hash')
      assert.equal(r.signaturesNotChecked, 0, 'no signature goes unchecked')
    } finally {
      await ctx.stop(); rmSync(dir, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true })
    }
  })
})
