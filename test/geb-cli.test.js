// Geb's CLI as the bridge's node (src/server/geb-cli.js): what `geb listen --json` prints in 0.5.18 (lines recorded on
// throwaway identities), and the commands the adapter runs, against a stand-in program that records each call.
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { GebCli, GebCliError, checkHomeModes, failureCode, parseListenLine, safeReason } from '../src/server/geb-cli.js'

// Geb identities in their real shape (the stand-in CLI prints the same two)
const ROOM = 'did:peer:2.Az6Mkroom' + 'x'.repeat(39) + '.Vz6Mkroom' + 'x'.repeat(39)
const HOST = 'did:peer:2.Az6Mkhost' + 'x'.repeat(39) + '.Vz6Mkhost' + 'x'.repeat(39)
const GROUP = '0b11f5fc-df80-4cfa-a30f-761be88dc08f'

// as Geb CLI 0.5.18 printed them (DIDs replaced by placeholders)
const DIRECT = '{"at":1794590322290,"event":"gmessage","group":"1f9ddf…bafc9","name":"direct","from":"<A-DID>","person":["<A-DID>"],"text":"hello one-to-one","id":"6b034d38c53830c4636de081d3a22cf8","mentioned_me":true,"re_me":false,"direct":true,"sig":"signed","rx":1794590323163,"via":"replay"}'
const GROUP_LINE = '{"at":1794590404204,"event":"gmessage","group":"0b11f5fc-df80-4cfa-a30f-761be88dc08f","name":"testroom2","from":"<A-DID>","person":["<A-DID>"],"text":"hello mls group","id":"2b623daddac3a4f0b1f23bc83b2736cf","mentioned_me":false,"re_me":false,"sig":"signed","rx":1794590405070,"via":"replay"}'
const SEATED = '{"at":"2026-11-13T17:19:19.910Z","event":"group","id":"0b11f5fc-df80-4cfa-a30f-761be88dc08f","name":"testroom2","from":"<A-DID>","members":2,"epoch":1}'

test('each kind of line `geb listen --json` prints reads as the bridge needs it', () => {
  assert.deepEqual(parseListenLine(DIRECT), { type: 'message', id: '6b034d38c53830c4636de081d3a22cf8', group: '1f9ddf…bafc9', groupName: 'direct', direct: true, from: '<A-DID>', text: 'hello one-to-one', at: 1794590322290, replay: true, signed: true })
  const g = parseListenLine(GROUP_LINE)
  assert.equal(g.direct, false); assert.equal(g.group, '0b11f5fc-df80-4cfa-a30f-761be88dc08f'); assert.equal(g.text, 'hello mls group')
  assert.deepEqual(parseListenLine(SEATED), { type: 'group', id: '0b11f5fc-df80-4cfa-a30f-761be88dc08f', name: 'testroom2', members: 2, epoch: 1 })
  assert.equal(parseListenLine('room.presumed {"x":1}'), null, 'some lines under --json are not JSON')
  assert.equal(parseListenLine('{"event":"gmessage","text":"no id or sender"}'), null)
  assert.deepEqual(parseListenLine('{"event":"kp-low"}'), { type: 'other', event: 'kp-low' })
  assert.equal(parseListenLine(GROUP_LINE.replace('"sig":"signed"', '"sig":"unsigned"')).signed, false)
})

const home = mkdtempSync(join(tmpdir(), 'geb-home-'))
after(() => rmSync(home, { recursive: true, force: true }))
const bin = fileURLToPath(new URL('./fixtures/fake-geb.mjs', import.meta.url))
const put = (name, text = '') => writeFileSync(join(home, name), text, { mode: 0o600 })
const calls = () => readFileSync(join(home, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))

test('the adapter needs the room\'s Geb home and identity, both', () => {
  assert.throws(() => new GebCli({ bin, did: ROOM }), /GEB_HOME/)
  assert.throws(() => new GebCli({ bin, home }), /GEB_ROOM_DID/)
  assert.throws(() => new GebCli({ bin, home, did: '--home=/elsewhere' }), /not a did:peer:2/, 'the room\'s own identity is checked too')
})

test('commands go to the room\'s own Geb home, as separate arguments, and their answers are read', async () => {
  const cli = new GebCli({ bin, home, did: ROOM })
  assert.equal(await cli.groupNew('InWove', [HOST]), GROUP, 'the newest room of that name')
  await cli.gsend(GROUP, 'Ann: hello; rm -rf / && echo "--home elsewhere"')
  await cli.accept(HOST)
  assert.deepEqual(await cli.members(GROUP), [ROOM, HOST])
  assert.deepEqual(calls().slice(-5), [
    ['group', 'new', '--mls', 'InWove', HOST],
    ['groups', '--json'],
    ['gsend', GROUP, 'Ann: hello; rm -rf / && echo "--home elsewhere"'],
    ['accept', HOST, '--agree'],
    ['gmembers', GROUP, '--json'],
  ], 'a line goes as one argument, never through a shell, and the home flag stays the room\'s')
  put('no-remove')
  await assert.rejects(cli.groupRemove(GROUP, [HOST]), (err) => err instanceof GebCliError && err.code === 'unknown-command' && err.message === 'geb group remove: unknown-command', 'a CLI that cannot remove says so, as a code, and the bridge pauses on it')
  rmSync(join(home, 'no-remove'))
})

test('every DID and room id is checked before it becomes an argument: nothing from Geb can be read as a flag', async () => {
  const cli = new GebCli({ bin, home, did: ROOM })
  const before = calls().length
  const refused = (code) => (err) => err instanceof GebCliError && err.code === code
  await assert.rejects(cli.accept('--home=/elsewhere'), refused('bad-did'))
  await assert.rejects(cli.accept('did:peer:2.not-a-key'), refused('bad-did'))
  await assert.rejects(cli.send('-x', 'hi'), refused('bad-did'))
  await assert.rejects(cli.groupNew('InWove', [HOST, '--mls']), refused('bad-did'))
  await assert.rejects(cli.groupNew('InWove', []), refused('bad-did'))
  await assert.rejects(cli.groupAdd(GROUP, ['--home', '/elsewhere']), refused('bad-did'))
  await assert.rejects(cli.groupRemove(GROUP, [42]), refused('bad-did'))
  await assert.rejects(cli.groupAdd('--home', [HOST]), refused('bad-room'))
  await assert.rejects(cli.gsend('-g', 'hi'), refused('bad-room'))
  await assert.rejects(cli.members('--json'), refused('bad-room'))
  assert.equal(calls().length, before, 'none of these ran the CLI at all')
})

test('a failed command says only a fixed code and the subcommand: never its stderr, its arguments or the Geb home', async () => {
  const secret = 'secret words only for the room'
  const lines = []
  const was = console.error
  console.error = (...a) => lines.push(a.join(' '))
  try {
    put('hang')
    const slow = new GebCli({ bin, home, did: ROOM, timeoutMs: 300 })
    const err = await slow.gsend(GROUP, secret).then(() => null, (e) => e)
    assert.ok(err instanceof GebCliError); assert.equal(err.code, 'timeout'); assert.equal(err.message, 'geb gsend: timeout')
    rmSync(join(home, 'hang'))
    put('echo')
    const loud = await new GebCli({ bin, home, did: ROOM }).gsend(GROUP, secret).then(() => null, (e) => e)
    assert.equal(loud.message, 'geb gsend: exit-1', 'the CLI printed every argument to stderr; none of it is kept')
    rmSync(join(home, 'echo'))
    for (const e of [err, loud]) {
      const all = JSON.stringify({ message: e.message, stack: e.stack, ...e })
      assert.ok(!all.includes('secret words') && !all.includes(home), 'no words and no home path anywhere on the error')
      assert.equal(safeReason(e), e.code)
    }
  } finally { console.error = was }
  assert.ok(!lines.join('\n').includes('secret words') && !lines.join('\n').includes(home))
  assert.equal(failureCode({ code: 'ENOENT' }), 'not-found')
  assert.equal(failureCode({ code: 2 }, 'Error: unknown command "group remove"'), 'unknown-command')
  assert.equal(safeReason(new Error('Command failed: geb gsend room secret --home /x')), 'error', 'any other error is only "error"')
})

test("the bridge's listener does not start unless the Geb home is the room's alone (folders 700, files 600)", async () => {
  const h = mkdtempSync(join(tmpdir(), 'geb-modes-'))
  try {
    chmodSync(h, 0o700)
    mkdirSync(join(h, 'keys'), { mode: 0o700 })
    writeFileSync(join(h, 'keys', 'id.json'), '{}', { mode: 0o600 })
    checkHomeModes(h)
    chmodSync(join(h, 'keys', 'id.json'), 0o644)
    assert.throws(() => checkHomeModes(h), (e) => /folders 700, files 600/.test(e.message) && !e.message.includes(h), 'a file others can read: refused, and the path is not said')
    chmodSync(join(h, 'keys', 'id.json'), 0o600); chmodSync(join(h, 'keys'), 0o750)
    assert.throws(() => checkHomeModes(h), /folders 700/)
    chmodSync(join(h, 'keys'), 0o700); chmodSync(h, 0o755)
    assert.throws(() => checkHomeModes(h), /folders 700/)
    await assert.rejects(new GebCli({ bin, home: h, did: ROOM }).start(() => {}), /folders 700/, 'start refuses')
    assert.throws(() => checkHomeModes(join(h, 'missing')), (e) => /cannot be read/.test(e.message) && !e.message.includes(h))
  } finally { rmSync(h, { recursive: true, force: true }) }
})

test('the listener turns each printed line into an event, and comes back when it stops', async () => {
  put('listen.txt', [DIRECT, 'room.presumed {}', GROUP_LINE, ''].join('\n'))
  put('exit-after')
  const cli = new GebCli({ bin, home, did: ROOM, restartMs: [50] })
  const events = []
  await cli.start((ev) => events.push(ev))
  const deadline = Date.now() + 5000
  while (events.filter((e) => e.type === 'stopped').length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25))
  await cli.stop()
  const messages = events.filter((e) => e.type === 'message')
  assert.ok(messages.length >= 4, 'the same two lines, printed by the first listener and again by the one that came back')
  assert.deepEqual(messages.slice(0, 2).map((m) => m.text), ['hello one-to-one', 'hello mls group'])
  assert.ok(events.filter((e) => e.type === 'stopped').length >= 2, 'each stop is told to the bridge')
  assert.ok(calls().some((c) => c[0] === 'listen' && c[1] === '--json'))
})
