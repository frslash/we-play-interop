import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { promisify } from 'node:util'
import { newIdentity } from '../src/shared/did.js'
import { TYPES, signedDocument } from '../src/shared/types.js'
import { config as baseConfig } from '../src/server/config.js'
import { createApp } from '../src/server/index.js'

const run = promisify(execFile)
const cfg = (dataDir) => ({ ...baseConfig, dataDir, databaseUrl: '', workspaceKey: '', production: false, weaverIntervalMinutes: 0, weaverQuietMinutes: 0, ratePerMinute: 1000, publicUrl: 'https://interop.example', boardDataUrl: '', llm: { ...baseConfig.llm, apiKey: '' } })
const clone = (x) => JSON.parse(JSON.stringify(x))

// A small room's whole record, with the room's server stopped.
async function aRecord () {
  const dir = mkdtempSync(join(tmpdir(), 'wpi-rbr-'))
  const ctx = await createApp(cfg(dir), { awayGatherMs: 0, hostWelcomeMs: null })
  const a = newIdentity()
  await ctx.log.accept(signedDocument(a, { type: TYPES.join, payload: { name: 'Person A' } }))
  await ctx.log.accept(signedDocument(a, { type: TYPES.card, payload: { goals: ['interop'], workingOn: 'a thing', lookingFor: 'partners' } }))
  const entries = clone(ctx.log.entries)
  await ctx.stop(); rmSync(dir, { recursive: true, force: true })
  return entries
}

describe('agent/rebuild.js refuses to run without --room', () => {
  test('no --room, or a --room that is not a DID: exits with an error and rebuilds nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wpi-rbr-'))
    try {
      const entries = await aRecord(), file = join(dir, 'copy.json'), out = join(dir, 'out.json')
      writeFileSync(file, JSON.stringify(entries))
      for (const extra of [[], ['--room'], ['--room', 'not-a-did'], ['--out', out]]) {
        await assert.rejects(run(process.execPath, ['agent/rebuild.js', file, ...extra]), (err) => {
          assert.equal(err.code, 2, `exit code for ${extra.join(' ') || 'no flags'}`)
          assert.equal(err.stdout, '', 'no result is printed')
          assert.match(err.stderr, /--room/)
          return true
        })
      }
      // with the room named, the same copy rebuilds
      const { stdout } = await run(process.execPath, ['agent/rebuild.js', file, '--room', entries[0].author])
      assert.equal(JSON.parse(stdout).ok, true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test("one whole copy of a different room, with --room set to this room's DID, does not report ok", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wpi-rbr-'))
    try {
      const ours = await aRecord(), theirs = await aRecord()
      assert.notEqual(ours[0].author, theirs[0].author, 'two rooms, two keys')
      const file = join(dir, 'theirs.json'), out = join(dir, 'out.json')
      writeFileSync(file, JSON.stringify(theirs))
      await assert.rejects(run(process.execPath, ['agent/rebuild.js', file, '--room', ours[0].author, '--out', out]), (err) => {
        assert.equal(err.code, 1)
        const r = JSON.parse(err.stdout)
        assert.equal(r.ok, false)
        assert.equal(r.written, null, 'nothing is written')
        return true
      })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
