// The log-roundtrip job posts its four values (ok, entries, head seq and hash, unchecked signatures)
// as a notice annotation, which is public on a public repository without signing in and needs no
// write permission. These run the scripts as processes and read the "::notice" lines they print.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { promisify } from 'node:util'
import { escapeData, escapeProperty, notice, noticeLine } from '../agent/roundtrip-summary.js'

const run = promisify(execFile)
const work = () => mkdtempSync(join(tmpdir(), 'wpi-rn-'))

describe('roundtrip-summary.js posts the four values as a notice', () => {
  test('a good import: one notice with ok, entries, head seq:hash and unchecked=0; summary as before; exit 0', async () => {
    const dir = work()
    try {
      const file = join(dir, 'import.json'), summary = join(dir, 'summary.md')
      writeFileSync(file, JSON.stringify({ ok: true, entries: 42, head: { seq: 41, hash: 'abc123' }, signaturesNotChecked: 0 }))
      writeFileSync(summary, '')
      const { stdout } = await run(process.execPath, ['agent/roundtrip-summary.js', file], { env: { ...process.env, GITHUB_STEP_SUMMARY: summary } })
      const notices = stdout.split('\n').filter((l) => l.startsWith('::notice'))
      assert.deepEqual(notices, ['::notice title=log-roundtrip::ok=true entries=42 head=41:abc123 unchecked=0'])
      assert.equal(readFileSync(summary, 'utf8'), 'ok=true entries=42 head.seq=41 head.hash=abc123 signaturesNotChecked=0\n')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('unchecked signatures: the notice says so and the step fails', async () => {
    const dir = work()
    try {
      const file = join(dir, 'import.json')
      writeFileSync(file, JSON.stringify({ ok: true, entries: 3, head: { seq: 2, hash: 'h' }, signaturesNotChecked: 1 }))
      const env = { ...process.env }; delete env.GITHUB_STEP_SUMMARY
      await assert.rejects(() => run(process.execPath, ['agent/roundtrip-summary.js', file], { env }), (err) => err.code === 1 && /::notice title=log-roundtrip::ok=true entries=3 head=2:h unchecked=1/.test(err.stdout))
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('an unreadable result still posts a notice, with ok=false', async () => {
    const dir = work()
    try {
      const file = join(dir, 'import.json'); writeFileSync(file, 'refusing to import')
      const env = { ...process.env }; delete env.GITHUB_STEP_SUMMARY
      await assert.rejects(() => run(process.execPath, ['agent/roundtrip-summary.js', file], { env }), (err) => err.code === 1 && /^::notice title=log-roundtrip::ok=false /m.test(err.stdout))
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('message and title are escaped so one notice stays one line', () => {
    assert.equal(escapeData('50%\r\nx'), '50%25%0D%0Ax')
    assert.equal(escapeProperty('a:b,c'), 'a%3Ab%2Cc')
    assert.equal(notice('t', 'a\nb'), '::notice title=t::a%0Ab')
    assert.equal(noticeLine({}), 'ok=undefined entries=undefined head=undefined:undefined unchecked=undefined')
  })
})

describe('import-log.js posts a notice when it refuses an import on Actions', () => {
  test('GITHUB_ACTIONS=true: one ok=false notice with the reason', async () => {
    const dir = work(), empty = work()
    try {
      const file = join(dir, 'broken.json'); writeFileSync(file, '<html>not json</html>')
      const env = { ...process.env, DATABASE_URL: '', GITHUB_ACTIONS: 'true' }; delete env.GITHUB_STEP_SUMMARY
      await assert.rejects(() => run(process.execPath, ['agent/import-log.js', file, empty], { env }), (err) => {
        const notices = err.stdout.split('\n').filter((l) => l.startsWith('::notice'))
        return err.code === 1 && notices.length === 1 && /^::notice title=log-roundtrip::ok=false .* reason=\S/.test(notices[0])
      })
    } finally { for (const d of [dir, empty]) rmSync(d, { recursive: true, force: true }) }
  })

  test('off Actions: no notice line', async () => {
    const dir = work(), empty = work()
    try {
      const file = join(dir, 'broken.json'); writeFileSync(file, '{')
      const env = { ...process.env, DATABASE_URL: '' }; delete env.GITHUB_ACTIONS; delete env.GITHUB_STEP_SUMMARY
      await assert.rejects(() => run(process.execPath, ['agent/import-log.js', file, empty], { env }), (err) => err.code === 1 && !err.stdout.includes('::notice'))
    } finally { for (const d of [dir, empty]) rmSync(d, { recursive: true, force: true }) }
  })
})
