// The command-line tools against a members-only room: they sign in with a member's key (agent/member-session.js), read the
// whole record (people-only lines included), and say one line, never a raw 401, when there is no key or the key is no member's.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { promisify } from 'node:util'
import { newIdentity } from '../src/shared/did.js'
import { startRoom } from './helpers/room.js'
import { NEED_KEY, RoomReadError, memberIdentity, readWholeLog, roomFetch } from '../agent/member-session.js'

const run = promisify(execFile)
const PEOPLE = 'people-only-marigold-4417'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// a tool's environment: no key variables inherited from the test runner's own
const envWith = (extra = {}) => { const e = { ...process.env, DATABASE_URL: '' }; delete e.WPI_MEMBER_KEY; delete e.WPI_MEMBER_KEY_FILE; delete e.WPI_URL; return { ...e, ...extra } }
const fails = (cmd, args, env) => run(process.execPath, [cmd, ...args], { env, maxBuffer: 64 << 20 }).then(() => assert.fail('should have failed'), (err) => err)

describe('the tools read a members-only room as a member', () => {
  let room, A, work, keyFile, outsiderFile, memberEnv
  before(async () => {
    room = await startRoom(); A = await room.firstMember('Person A')
    await room.say(A.id, 'card', { goals: ['interop'], workingOn: 'a thing', lookingFor: 'partners' })
    await room.say(A.id, 'note', { text: 'A line everyone can read', kind: 'message' })
    const r = await room.say(A.id, 'note', { text: `Only people ${PEOPLE}`, kind: 'message', audience: 'people' })
    assert.equal(r.status, 201)
    work = mkdtempSync(join(tmpdir(), 'wpi-member-tools-'))
    keyFile = join(work, 'key'); writeFileSync(keyFile, A.id.seedHex + '\n', { mode: 0o600 })
    outsiderFile = join(work, 'outsider'); writeFileSync(outsiderFile, newIdentity().seedHex, { mode: 0o600 })
    memberEnv = envWith({ WPI_MEMBER_KEY_FILE: keyFile })
  })
  after(async () => { await room.stop(); rmSync(work, { recursive: true, force: true }) })

  test('the room really is closed: a plain read of the log is a 401', async () => {
    assert.equal((await room.call('/api/log')).status, 401)
  })

  test('export with the member\'s key holds every line, the people-only one too; the room\'s own count says so', async () => {
    const out = await run(process.execPath, ['agent/export-log.js', room.base], { env: memberEnv, maxBuffer: 64 << 20 })
    const doc = JSON.parse(out.stdout)
    assert.equal(doc.count, room.ctx.log.entries.length, 'every line')
    assert.deepEqual(doc.head, { seq: room.ctx.log.entries.at(-1).seq, hash: room.ctx.log.entries.at(-1).hash })
    assert.ok(out.stdout.includes(PEOPLE), 'the people-only note is in it')
    assert.equal((await (await fetch(room.base + '/healthz')).json()).entries, doc.count, 'the open /healthz agrees')
  })

  test('the key can be in WPI_MEMBER_KEY instead of a file', async () => {
    const out = await run(process.execPath, ['agent/export-log.js', room.base], { env: envWith({ WPI_MEMBER_KEY: A.id.seedHex }), maxBuffer: 64 << 20 })
    assert.equal(JSON.parse(out.stdout).count, room.ctx.log.entries.length)
  })

  test('verify with the key: the whole chain checks out', async () => {
    const out = await run(process.execPath, ['agent/verify-log.js', room.base], { env: memberEnv, maxBuffer: 64 << 20 })
    const rep = JSON.parse(out.stdout)
    assert.equal(rep.ok, true); assert.equal(rep.head.seq, room.ctx.log.entries.at(-1).seq)
  })

  test('mirror with the key: a copy with every line, served on this computer only', async () => {
    const dir = join(work, 'mirror'), port = 30000 + Math.floor(Math.random() * 20000)
    const child = spawn(process.execPath, ['agent/mirror.js', room.base, '--dir', dir, '--port', String(port), '--every', '1'], { env: memberEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    let said = ''; child.stdout.on('data', (d) => { said += d }); child.stderr.on('data', (d) => { said += d })
    try {
      let status
      for (let i = 0; i < 100; i++) {
        await sleep(100)
        try { status = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8')) } catch { continue }
        if (status.entries === room.ctx.log.entries.length && status.report?.ok) break
      }
      assert.equal(status?.entries, room.ctx.log.entries.length, said); assert.equal(status.report.ok, true)
      assert.ok(readFileSync(join(dir, 'entries.jsonl'), 'utf8').includes(PEOPLE))
      const seen = await (await fetch(`http://127.0.0.1:${port}/`)).json()
      assert.equal(seen.entries, room.ctx.log.entries.length); assert.equal(seen.checksOut, true)
      assert.match(said, /on 127\.0\.0\.1:/, 'it says it listens on this computer only')
    } finally { child.kill() }
  })

  test('rebuild reads a members-only room\'s address with the key', async () => {
    const out = await run(process.execPath, ['agent/rebuild.js', room.base, '--room', room.ctx.log.entries[0].author, '--out', join(work, 'rebuilt.json')], { env: memberEnv, maxBuffer: 64 << 20 }).catch((e) => e)
    const r = JSON.parse(out.stdout)
    assert.equal(r.unreadable.length, 0); assert.equal(r.entries, room.ctx.log.entries.length)
  })

  test('import of the member\'s export into an empty data folder gives the same head', async () => {
    const exp = await run(process.execPath, ['agent/export-log.js', room.base], { env: memberEnv, maxBuffer: 64 << 20 })
    const file = join(work, 'export.json'); writeFileSync(file, exp.stdout)
    const doc = JSON.parse(exp.stdout), dir = join(work, 'fresh')
    const out = JSON.parse((await run(process.execPath, ['agent/import-log.js', file, dir], { env: envWith() })).stdout)
    assert.equal(out.ok, true); assert.equal(out.entries, doc.count); assert.deepEqual(out.head, doc.head); assert.equal(out.signaturesNotChecked, 0)
    const rt = JSON.parse((await run(process.execPath, ['agent/roundtrip-log.js', file, join(work, 'fresh2')], { env: envWith() })).stdout)
    assert.equal(rt.ok, true); assert.equal(rt.same, true)
  })

  test('without a key each tool says what to set, in one line, and exits 2', async () => {
    for (const [tool, args] of [['export-log', [room.base]], ['verify-log', [room.base]], ['mirror', [room.base, '--dir', join(work, 'm2'), '--port', '0']]]) {
      const err = await fails(`agent/${tool}.js`, args, envWith())
      assert.equal(err.code, 2, tool); assert.equal(err.stderr.trim(), NEED_KEY, tool)
      assert.ok(!/401|Sign in first/.test(err.stderr), tool)
    }
    const reb = await fails('agent/rebuild.js', [room.base, '--room', room.ctx.log.entries[0].author], envWith())
    assert.equal(reb.code, 1); assert.ok(reb.stderr.split('\n').includes(NEED_KEY)); assert.match(reb.stdout, /set WPI_MEMBER_KEY_FILE/)
  })

  test('a key that is no member\'s is refused in one line', async () => {
    for (const tool of ['export-log', 'verify-log']) {
      const err = await fails(`agent/${tool}.js`, [room.base], envWith({ WPI_MEMBER_KEY_FILE: outsiderFile }))
      assert.equal(err.code, 2); assert.equal(err.stderr.trim(), 'that key belongs to no member of this room')
    }
  })

  test('a malformed key, or a key file that is not there, is one line too', async () => {
    const bad = await fails('agent/export-log.js', [room.base], envWith({ WPI_MEMBER_KEY: 'not-hex' }))
    assert.equal(bad.code, 2); assert.match(bad.stderr, /64 hex characters/); assert.ok(!bad.stderr.includes('not-hex'))
    const gone = await fails('agent/export-log.js', [room.base], envWith({ WPI_MEMBER_KEY_FILE: join(work, 'nope') }))
    assert.equal(gone.code, 2); assert.match(gone.stderr, /cannot be read/)
  })

  test('the key and the cookie are never printed, logged or written: a planted key and the real session stay out of every output', async () => {
    const secrets = [A.id.seedHex]
    // the real session cookie the room hands this key
    const cookie = room.cookieOf(await room.signInWithKey(A.id)); secrets.push(cookie.split('=')[1])
    const outputs = []
    const ok = await run(process.execPath, ['agent/verify-log.js', room.base], { env: memberEnv, maxBuffer: 64 << 20 }); outputs.push(ok.stdout, ok.stderr)
    const exp = await run(process.execPath, ['agent/export-log.js', room.base], { env: memberEnv, maxBuffer: 64 << 20 }); outputs.push(exp.stdout, exp.stderr)
    const planted = newIdentity().seedHex
    for (const env of [envWith({ WPI_MEMBER_KEY: planted }), envWith({ WPI_MEMBER_KEY: planted.slice(0, 40) }), envWith({ WPI_MEMBER_KEY: planted, WPI_MEMBER_KEY_FILE: join(work, 'nope') })]) {
      const err = await fails('agent/export-log.js', [room.base], env); outputs.push(err.stdout, err.stderr, err.message)
    }
    secrets.push(planted)
    for (const o of outputs) for (const s of secrets) assert.ok(!String(o).includes(s), 'a secret leaked into an output')
    // in process: the errors the helper raises carry fixed sentences only
    const get = roomFetch(room.base, { env: { WPI_MEMBER_KEY: planted } })
    await assert.rejects(() => get(room.base + '/api/log'), (err) => err instanceof RoomReadError && !err.message.includes(planted) && !err.stack.includes(planted))
    // the room's database holds neither the key nor the cookie in the clear
    assert.ok(!JSON.stringify(room.ctx.log.entries).includes(A.id.seedHex))
  })

  test('the helper: an open reader is plain fetch; a session the room ended is signed in again once', async () => {
    assert.equal(memberIdentity({}), null)
    const get = roomFetch(room.base, { env: { WPI_MEMBER_KEY: A.id.seedHex } })
    assert.equal((await readWholeLog(room.base, get)).length, room.ctx.log.entries.length)
    await room.ctx.sessions.deleteFor(A.id.did) // every session of the member ends
    assert.equal((await readWholeLog(room.base, get)).length, room.ctx.log.entries.length, 'it signed in again')
  })
})
