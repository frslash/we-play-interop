// Moving WORKSPACE_KEY host to host (agent/export-workspace-key.js, agent/import-workspace-key.js). The commands run as child
// processes, the way a person would run them. Every key here is a throwaway made in the test.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'

const EXPORT = new URL('../agent/export-workspace-key.js', import.meta.url).pathname
const IMPORT = new URL('../agent/import-workspace-key.js', import.meta.url).pathname
const roots = []
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }) })

const seen = [] // every stdout and stderr this file produced
const run = (script, args, env = {}) => {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } })
  seen.push(r.stdout, r.stderr)
  return r
}
const mode = (p) => statSync(p).mode & 0o777

/** A fresh scene: an old server's env file with a planted key, and a new server's wrapping pair. */
function scene () {
  const root = mkdtempSync(join(tmpdir(), 'wkm-'))
  roots.push(root)
  const id = newIdentity()
  const oldEnv = join(root, 'old.env'), newEnv = join(root, 'new.env'), dir = join(root, 'wrap'), file = join(root, 'wrapped.json')
  writeFileSync(oldEnv, `PUBLIC_HOST=x.example\nWORKSPACE_KEY=${id.seedHex}\nOTHER=1\n`, { mode: 0o600 })
  const init = run(IMPORT, ['init', dir])
  assert.equal(init.status, 0, init.stderr)
  const pub = /public half: (\S+)/.exec(init.stdout)[1]
  return { root, id, oldEnv, newEnv, dir, file, pub, initOut: init.stdout }
}
const exportTo = (s, extra = []) => run(EXPORT, [s.pub, s.file, '--env-file', s.oldEnv, ...extra])
const openIt = (s, file = s.file) => run(IMPORT, ['open', s.dir, file, '--into', s.newEnv])
const walk = (d) => readdirSync(d, { withFileTypes: true, recursive: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name))

describe('the round trip', () => {
  test('the same key ends in the env file, and both sides print the same public fingerprint', () => {
    const s = scene()
    assert.match(s.initOut, /fingerprint: [0-9a-f]{24}\n/)
    assert.equal(mode(join(s.dir, 'wrap-key')), 0o600)
    const ex = exportTo(s)
    assert.equal(ex.status, 0, ex.stderr)
    assert.ok(ex.stdout.includes(s.file) && ex.stdout.includes(s.initOut.match(/fingerprint: (\S+)/)[1]))
    assert.equal(mode(s.file), 0o600)
    const op = openIt(s)
    assert.equal(op.status, 0, op.stderr)
    assert.ok(ex.stdout.includes(s.id.did) && op.stdout.includes(s.id.did))
    assert.equal(readFileSync(s.newEnv, 'utf8'), `WORKSPACE_KEY=${s.id.seedHex}\n`)
    assert.equal(mode(s.newEnv), 0o600)
    assert.ok(!existsSync(s.file) && !existsSync(join(s.dir, 'wrap-key')), 'the ciphertext and the wrapping private half are gone')
  })

  test('the key comes from the environment too; an existing env file keeps its other lines and its mode', () => {
    const s = scene()
    writeFileSync(s.newEnv, 'A=1\nWORKSPACE_KEY=old\nB=2\n', { mode: 0o600 })
    const ex = run(EXPORT, [s.pub, s.file], { WORKSPACE_KEY: s.id.seedHex })
    assert.equal(ex.status, 0, ex.stderr)
    assert.equal(openIt(s).status, 0)
    assert.equal(readFileSync(s.newEnv, 'utf8'), `A=1\nWORKSPACE_KEY=${s.id.seedHex}\nB=2\n`)
    assert.equal(mode(s.newEnv), 0o600)
  })

  test('--recovery writes a second file that only the recovery key opens', () => {
    const s = scene()
    const rec = run(IMPORT, ['init', join(s.root, 'rec')])
    const recPub = /public half: (\S+)/.exec(rec.stdout)[1]
    const ex = exportTo(s, ['--recovery', recPub])
    assert.equal(ex.status, 0, ex.stderr)
    assert.equal(mode(s.file + '.recovery'), 0o600)
    const wrong = run(IMPORT, ['open', s.dir, s.file + '.recovery', '--into', s.newEnv])
    assert.notEqual(wrong.status, 0)
    assert.ok(!existsSync(s.newEnv))
    const ok = run(IMPORT, ['open', join(s.root, 'rec'), s.file + '.recovery', '--into', s.newEnv])
    assert.equal(ok.status, 0, ok.stderr)
    assert.equal(readFileSync(s.newEnv, 'utf8'), `WORKSPACE_KEY=${s.id.seedHex}\n`)
  })
})

describe('what fails, and fails cleanly', () => {
  const failsWithNothingWritten = (s, r) => {
    assert.equal(r.status, 2)
    assert.ok(!existsSync(s.newEnv), 'no env file was written')
    assert.ok(existsSync(join(s.dir, 'wrap-key')), 'the wrapping key is kept, so a good file can still be opened')
  }

  test('a wrong wrapping key', () => {
    const s = scene()
    assert.equal(exportTo(s).status, 0)
    const other = run(IMPORT, ['init', join(s.root, 'other')])
    assert.equal(other.status, 0)
    copyFileSync(join(s.root, 'other', 'wrap-key'), join(s.dir, 'wrap-key'))
    failsWithNothingWritten(s, openIt(s))
  })

  test('a changed byte', () => {
    const s = scene()
    exportTo(s)
    const f = JSON.parse(readFileSync(s.file, 'utf8'))
    const ct = Buffer.from(f.ct, 'base64url'); ct[0] ^= 1
    writeFileSync(s.file, JSON.stringify({ ...f, ct: ct.toString('base64url') }))
    failsWithNothingWritten(s, openIt(s))
    const g = JSON.parse(readFileSync(s.file, 'utf8'))
    writeFileSync(s.file, JSON.stringify({ ...g, ct: f.ct, epk: Buffer.alloc(32, 7).toString('base64url') }))
    failsWithNothingWritten(s, openIt(s))
    writeFileSync(s.file, 'not json')
    failsWithNothingWritten(s, openIt(s))
  })

  test('an env file that anyone but its owner can read is refused and left alone; an owner-only one works', () => {
    const s = scene()
    exportTo(s)
    writeFileSync(s.newEnv, 'A=1\n', { mode: 0o644 })
    chmodSync(s.newEnv, 0o644)
    const r = openIt(s)
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /readable only by its owner/)
    assert.equal(readFileSync(s.newEnv, 'utf8'), 'A=1\n')
    assert.equal(mode(s.newEnv), 0o644)
    assert.ok(existsSync(s.file))
    chmodSync(s.newEnv, 0o600)
    const ok = openIt(s)
    assert.equal(ok.status, 0, ok.stderr)
    assert.equal(readFileSync(s.newEnv, 'utf8'), `A=1\nWORKSPACE_KEY=${s.id.seedHex}\n`)
  })

  test('a wrong fingerprint', () => {
    const s = scene()
    exportTo(s)
    const f = JSON.parse(readFileSync(s.file, 'utf8'))
    writeFileSync(s.file, JSON.stringify({ ...f, to: '0'.repeat(24) }))
    const r = openIt(s)
    failsWithNothingWritten(s, r)
    assert.match(r.stderr, /different public half/)
  })

  test('a file that was already opened', () => {
    const s = scene()
    exportTo(s)
    const copy = join(s.root, 'copy.json')
    copyFileSync(s.file, copy)
    assert.equal(openIt(s).status, 0)
    rmSync(s.newEnv)
    const again = openIt(s, copy)
    assert.equal(again.status, 2)
    assert.ok(!existsSync(s.newEnv))
  })

  test('an output file is never overwritten, and a wrapping key is never made twice', () => {
    const s = scene()
    assert.equal(exportTo(s).status, 0)
    assert.equal(exportTo(s).status, 2)
    assert.equal(run(IMPORT, ['init', s.dir]).status, 2)
  })

  test('no key, a short key, a bad public half and bad usage', () => {
    const s = scene()
    assert.equal(run(EXPORT, [s.pub, s.file]).status, 2)
    assert.equal(run(EXPORT, [s.pub, s.file], { WORKSPACE_KEY: 'abcd' }).status, 2)
    assert.equal(run(EXPORT, ['nonsense', s.file], { WORKSPACE_KEY: s.id.seedHex }).status, 2)
    assert.equal(run(EXPORT, [s.pub], { WORKSPACE_KEY: s.id.seedHex }).status, 2)
    assert.equal(run(IMPORT, ['open', s.dir, s.file]).status, 2)
    assert.equal(run(IMPORT, []).status, 2)
    assert.ok(!existsSync(s.file))
  })
})

describe('the key is never shown, and never an argument', () => {
  test('a key given as an argument is refused, and not echoed', () => {
    const s = scene()
    for (const [script, args] of [[EXPORT, [s.pub, s.file, s.id.seedHex]], [EXPORT, [s.id.seedHex, s.file]], [EXPORT, [s.pub, s.id.seedHex]], [IMPORT, ['open', s.dir, s.file, '--into', s.id.seedHex]], [IMPORT, ['init', s.id.seedHex]], [IMPORT, ['open', s.dir, s.id.seedHex, '--into', s.newEnv]]]) {
      const r = run(script, args, { WORKSPACE_KEY: s.id.seedHex })
      assert.equal(r.status, 2)
      assert.match(r.stderr, /never given as an argument/)
      assert.ok(!(r.stdout + r.stderr).includes(s.id.seedHex))
    }
    assert.ok(!existsSync(s.file) && !existsSync(s.newEnv))
  })

  test('a planted key is in no output and no file except the two env files, across success and every failure', () => {
    const s = scene()
    const rec = run(IMPORT, ['init', join(s.root, 'rec')])
    const recPub = /public half: (\S+)/.exec(rec.stdout)[1]
    const outs = []
    const go = (script, args, env) => { const r = run(script, args, env); outs.push(r); return r }
    go(EXPORT, [s.pub, s.file, '--env-file', s.oldEnv, '--recovery', recPub])
    go(EXPORT, [s.pub, s.file, '--env-file', s.oldEnv]) // refused: exists
    go(EXPORT, [s.pub, join(s.root, 'e2'), '--env-file', s.oldEnv, '--bogus'])
    go(EXPORT, [s.pub, join(s.root, 'e3')], { WORKSPACE_KEY: s.id.seedHex })
    go(EXPORT, ['bad', join(s.root, 'e4')], { WORKSPACE_KEY: s.id.seedHex })
    go(EXPORT, [s.pub, join(s.root, 'e5')], { WORKSPACE_KEY: s.id.seedHex.slice(0, 60) })
    go(IMPORT, ['open', s.dir, s.file + '.recovery', '--into', s.newEnv]) // wrong wrapping key
    go(IMPORT, ['open', s.dir, join(s.root, 'missing'), '--into', s.newEnv])
    const f = JSON.parse(readFileSync(s.file, 'utf8')); f.ct = f.ct.slice(0, -2) + 'AA'
    const bad = join(s.root, 'bad.json'); writeFileSync(bad, JSON.stringify(f))
    go(IMPORT, ['open', s.dir, bad, '--into', s.newEnv])
    go(IMPORT, ['open', s.dir, s.file, '--into', s.newEnv]) // the good one
    go(IMPORT, ['open', s.dir, s.file, '--into', s.newEnv]) // reused
    const key = s.id.seedHex
    const keyBytes = Buffer.from(key, 'hex')
    const all = [...outs.map((r) => r.stdout + r.stderr), ...seen].join('\n')
    assert.ok(!all.includes(key) && !all.includes(key.toUpperCase()), 'the key is in an output')
    assert.ok(!all.includes(keyBytes.toString('base64')) && !all.includes(keyBytes.toString('base64url')), 'the key is in an output (base64)')
    for (const f of walk(s.root)) {
      if (f === s.oldEnv || f === s.newEnv) continue
      const b = readFileSync(f)
      assert.ok(!b.includes(key) && !b.includes(keyBytes), `the key is in ${f}`)
    }
    assert.ok(readFileSync(s.newEnv, 'utf8').includes(key))
    assert.ok(outs.at(-2).stdout.includes(s.id.did), outs.at(-2).stderr)
  })
})
