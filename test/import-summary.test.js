// The CI job "log-roundtrip" imports the live room's log. When the import is refused, import-log.js
// writes the one-line reason (and where the chain broke) to $GITHUB_STEP_SUMMARY, so the run's page
// shows why without opening the step's log.
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
import { makeExport } from '../src/server/export.js'

const run = promisify(execFile)
const roomConfig = (dataDir) => ({ ...baseConfig, dataDir, databaseUrl: '', workspaceKey: '', production: false, weaverIntervalMinutes: 0, weaverQuietMinutes: 0, ratePerMinute: 1000, publicUrl: 'https://interop.example', boardDataUrl: '', llm: { ...baseConfig.llm, apiKey: '' } })

describe('import-log.js writes a refused import\'s reason to the job summary', () => {
  test('a tampered chain: the summary says ok=false, the reason, and the failing seq', async () => {
    const roomDir = mkdtempSync(join(tmpdir(), 'wpi-is-room-')), emptyDir = mkdtempSync(join(tmpdir(), 'wpi-is-empty-')), work = mkdtempSync(join(tmpdir(), 'wpi-is-work-'))
    const ctx = await createApp(roomConfig(roomDir), { openRoom: true, awayGatherMs: 0, hostWelcomeMs: null })
    try {
      await ctx.log.accept(signedDocument(newIdentity(), { type: TYPES.join, payload: { name: 'Person A' } })).catch(() => {})
      const doc = JSON.parse(JSON.stringify(makeExport(ctx.log.entries)))
      const last = doc.entries.at(-1); last.document.payload.name = 'tampered'
      const file = join(work, 'bad.json'); writeFileSync(file, JSON.stringify(doc))
      const summary = join(work, 'summary.md'); writeFileSync(summary, '')
      const env = { ...process.env, DATABASE_URL: '', GITHUB_STEP_SUMMARY: summary }
      await assert.rejects(() => run(process.execPath, ['agent/import-log.js', file, emptyDir], { env }), (err) => err.code === 1)
      const text = readFileSync(summary, 'utf8'), first = text.split('\n')[0]
      assert.match(first, /^ok=false reason=refusing to import: the chain does not verify/)
      assert.match(text, /checked \d+ of \d+ entries, \d+ problem\(s\), \d+ signature\(s\) not checked/)
      assert.match(text, new RegExp(`- seq ${last.seq}: `))
    } finally {
      await ctx.stop()
      for (const d of [roomDir, emptyDir, work]) rmSync(d, { recursive: true, force: true })
    }
  })

  test('an unreadable export: the summary gives the parse error as the reason', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'wpi-is-empty-')), work = mkdtempSync(join(tmpdir(), 'wpi-is-work-'))
    try {
      const file = join(work, 'broken.json'); writeFileSync(file, '<html>not json</html>')
      const summary = join(work, 'summary.md'); writeFileSync(summary, '')
      const env = { ...process.env, DATABASE_URL: '', GITHUB_STEP_SUMMARY: summary }
      await assert.rejects(() => run(process.execPath, ['agent/import-log.js', file, emptyDir], { env }), (err) => err.code === 1)
      const lines = readFileSync(summary, 'utf8').trim().split('\n')
      assert.equal(lines.length, 1)
      assert.match(lines[0], /^ok=false reason=\S/)
    } finally {
      for (const d of [emptyDir, work]) rmSync(d, { recursive: true, force: true })
    }
  })

  test('without GITHUB_STEP_SUMMARY nothing extra is written and the exit code stays 1', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'wpi-is-empty-')), work = mkdtempSync(join(tmpdir(), 'wpi-is-work-'))
    try {
      const file = join(work, 'broken.json'); writeFileSync(file, '{')
      const env = { ...process.env, DATABASE_URL: '' }; delete env.GITHUB_STEP_SUMMARY
      await assert.rejects(() => run(process.execPath, ['agent/import-log.js', file, emptyDir], { env }), (err) => err.code === 1 && !/could not write the job summary/.test(err.stderr))
    } finally {
      for (const d of [emptyDir, work]) rmSync(d, { recursive: true, force: true })
    }
  })
})
