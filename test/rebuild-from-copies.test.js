import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { promisify } from 'node:util'
import { newIdentity } from '../src/shared/did.js'
import { TYPES, signedDocument } from '../src/shared/types.js'
import { rebuildFromCopies } from '../src/shared/rebuild.js'
import { hashCore, entryCore } from '../src/shared/chain.js'
import { config as baseConfig } from '../src/server/config.js'
import { createApp } from '../src/server/index.js'
import { checkExport } from '../src/server/export.js'

const run = promisify(execFile)
const cfg = (dataDir) => ({ ...baseConfig, dataDir, databaseUrl: '', workspaceKey: '', production: false, weaverIntervalMinutes: 0, weaverQuietMinutes: 0, ratePerMinute: 1000, publicUrl: 'https://interop.example', boardDataUrl: '', llm: { ...baseConfig.llm, apiKey: '' } })
const freePort = () => new Promise((r) => { const s = createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)) }) })
const clone = (x) => JSON.parse(JSON.stringify(x))

async function aRoom () {
  const dir = mkdtempSync(join(tmpdir(), 'wpi-rb-'))
  const ctx = await createApp(cfg(dir), { awayGatherMs: 0, hostWelcomeMs: null })
  const a = newIdentity(), b = newIdentity()
  const say = (who, name, payload) => ctx.log.accept(signedDocument(who, { type: TYPES[name], payload }))
  await say(a, 'join', { name: 'Person A' }); await say(b, 'join', { name: 'Person B' })
  await say(a, 'card', { goals: ['interop'], workingOn: 'a thing', lookingFor: 'partners' })
  const prop = (await say(a, 'propose', { kind: 'other', title: 'Try it' })).entry.hash
  await say(b, 'vote', { proposal: prop, choice: 'for' })
  await say(b, 'card', { goals: ['interop'], workingOn: 'another thing', lookingFor: 'a run' })
  return { ctx, dir }
}

describe('the record rebuilds from members\' copies with the server off', () => {
  test('partial, behind and tampered copies: the whole record comes back and every signature checks', async () => {
    const { ctx, dir } = await aRoom()
    const all = clone(ctx.log.entries), n = all.length
    await ctx.stop(); rmSync(dir, { recursive: true, force: true }) // the server is gone
    assert.ok(n >= 7)

    const tampered = clone(all); tampered[3].document.payload.name = 'someone else'
    const forged = clone(all); forged[4].timestamp = '2020-01-01T00:00:00.000Z'; forged[4].hash = hashCore(entryCore(forged[4])) // rehashed, but the witness no longer fits
    const copies = [
      { name: 'behind', entries: all.slice(0, 3) },
      { name: 'tampered', entries: tampered },
      { name: 'forged', entries: forged },
      { name: 'tail only', entries: all.slice(3).reverse() },
    ]
    const r = await rebuildFromCopies(copies)
    assert.equal(r.ok, true, JSON.stringify(r.report.problems))
    assert.equal(r.entries.length, n)
    assert.deepEqual(r.entries, all, 'byte for byte the record the room held')
    assert.equal(r.report.signaturesNotChecked, 0)
    assert.equal(r.room, all[0].author)
    const by = Object.fromEntries(r.copies.map((c) => [c.name, c]))
    assert.equal(by.tampered.disagreesAt, 3); assert.match(by.tampered.problem, /hash/)
    assert.equal(by.forged.disagreesAt, 4); assert.match(by.forged.problem, /witness/)
    assert.equal(by['tail only'].used, n - 3)
    assert.equal(by.behind.agreesUpTo, 2)
  })

  test('a gap no copy covers, a fork, or the wrong room never passes', async () => {
    const { ctx, dir } = await aRoom()
    const all = clone(ctx.log.entries)
    await ctx.stop(); rmSync(dir, { recursive: true, force: true })

    const gap = await rebuildFromCopies([{ name: 'a', entries: all.slice(0, 2) }, { name: 'b', entries: all.slice(3) }])
    assert.equal(gap.entries.length, 2, 'stops where no copy has a good entry; never skips one')
    assert.equal(gap.ok, false); assert.deepEqual(gap.missing, { from: 2, to: all.length - 1 })
    const broken = clone(all); broken[2].document.payload.name = 'x'
    assert.equal((await rebuildFromCopies([{ name: 'broken', entries: broken }])).ok, false, 'a copy that breaks halfway is not a whole record')
    assert.equal((await rebuildFromCopies([{ name: 'whole', entries: all }], { room: newIdentity().did })).ok, false)
    assert.equal((await rebuildFromCopies([])).ok, false)

    // Another room's genesis (a different key) next to the real one is a fork: people decide, not code.
    const other = await aRoom(), theirs = clone(other.ctx.log.entries)
    await other.ctx.stop(); rmSync(other.dir, { recursive: true, force: true })
    const fork = await rebuildFromCopies([{ name: 'ours', entries: all }, { name: 'theirs', entries: theirs }])
    assert.equal(fork.ok, false); assert.equal(fork.fork.seq, 0)
    assert.equal((await rebuildFromCopies([{ name: 'ours', entries: all }, { name: 'theirs', entries: theirs }], { room: all[0].author })).ok, true, 'naming the room settles it')
  })

  test('from running mirrors, after the room is switched off (agent/mirror.js, agent/rebuild.js)', { timeout: 60_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wpi-rbm-'))
    const ctx = await createApp(cfg(dir), { awayGatherMs: 0, hostWelcomeMs: null })
    await new Promise((r) => ctx.server.listen(0, r))
    const room = `http://localhost:${ctx.server.address().port}`
    const a = newIdentity()
    for (const name of ['Person A']) await ctx.log.accept(signedDocument(a, { type: TYPES.join, payload: { name } }))
    await ctx.log.accept(signedDocument(a, { type: TYPES.card, payload: { goals: ['interop'], workingOn: 'a thing', lookingFor: 'partners' } }))
    const all = clone(ctx.log.entries)

    const mirrors = [], kids = []
    try {
      for (let i = 0; i < 2; i++) {
        const port = await freePort(), mdir = join(dir, `mirror-${i}`)
        const kid = spawn(process.execPath, ['agent/mirror.js', room, '--dir', mdir, '--port', String(port), '--every', '1'], { stdio: 'ignore' })
        kids.push(kid); mirrors.push({ url: `http://localhost:${port}`, dir: mdir })
      }
      for (const m of mirrors) {
        for (let t = 0; ; t++) {
          const got = await fetch(`${m.url}/`).then((r) => r.json()).catch(() => null)
          if (got?.entries === all.length && got.checksOut) break
          if (t > 200) throw new Error('mirror never caught up')
          await new Promise((r) => setTimeout(r, 100))
        }
      }
      await ctx.stop() // the room's server is off from here on
      assert.equal(await fetch(`${room}/api/log`).then(() => 'up', () => 'down'), 'down')

      const out = join(dir, 'rebuilt.json')
      // one mirror by its address, the other from the file it keeps
      const { stdout } = await run(process.execPath, ['agent/rebuild.js', mirrors[0].url, join(mirrors[1].dir, 'entries.jsonl'), '--out', out])
      const r = JSON.parse(stdout)
      assert.equal(r.ok, true); assert.equal(r.entries, all.length); assert.equal(r.signaturesNotChecked, 0)
      assert.deepEqual(r.head, { seq: all.at(-1).seq, hash: all.at(-1).hash })
      const doc = JSON.parse(readFileSync(out, 'utf8'))
      assert.equal((await checkExport(doc)).ok, true, 'the rebuilt record imports like any export')
      assert.deepEqual(doc.entries, all)

      // a bad copy alone fails, with exit code 1
      const bad = clone(all); bad[1].document.payload.name = 'x'
      writeFileSync(join(dir, 'bad.json'), JSON.stringify(bad))
      await assert.rejects(run(process.execPath, ['agent/rebuild.js', join(dir, 'bad.json')]), (err) => err.code === 1 && JSON.parse(err.stdout).ok === false)
    } finally {
      for (const k of kids) k.kill()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
