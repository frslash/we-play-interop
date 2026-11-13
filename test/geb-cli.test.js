// Geb's CLI as the bridge's node (src/server/geb-cli.js): what `geb listen --json` prints in 0.5.18 (lines recorded on
// throwaway identities), and the commands the adapter runs, against a stand-in program that records each call.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { GebCli, parseListenLine } from '../src/server/geb-cli.js'

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
const calls = () => readFileSync(join(home, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))

test('the adapter needs the room\'s Geb home and identity, both', () => {
  assert.throws(() => new GebCli({ bin, did: 'did:peer:2.Aroom' }), /GEB_HOME/)
  assert.throws(() => new GebCli({ bin, home }), /GEB_ROOM_DID/)
})

test('commands go to the room\'s own Geb home, as separate arguments, and their answers are read', async () => {
  const cli = new GebCli({ bin, home, did: 'did:peer:2.Aroom' })
  assert.equal(await cli.groupNew('InWove', ['did:peer:2.Ahost']), '0b11f5fc-df80-4cfa-a30f-761be88dc08f', 'the newest room of that name')
  await cli.gsend('0b11f5fc-df80-4cfa-a30f-761be88dc08f', 'Ann: hello; rm -rf / && echo "--home elsewhere"')
  await cli.accept('did:peer:2.Ahost')
  assert.deepEqual(await cli.members('0b11f5fc-df80-4cfa-a30f-761be88dc08f'), ['did:peer:2.Aroom', 'did:peer:2.Ahost'])
  assert.deepEqual(calls().slice(-5), [
    ['group', 'new', '--mls', 'InWove', 'did:peer:2.Ahost'],
    ['groups', '--json'],
    ['gsend', '0b11f5fc-df80-4cfa-a30f-761be88dc08f', 'Ann: hello; rm -rf / && echo "--home elsewhere"'],
    ['accept', 'did:peer:2.Ahost', '--agree'],
    ['gmembers', '0b11f5fc-df80-4cfa-a30f-761be88dc08f', '--json'],
  ], 'a line goes as one argument, never through a shell, and the home flag stays the room\'s')
  writeFileSync(join(home, 'no-remove'), '')
  await assert.rejects(cli.groupRemove('0b11f5fc-df80-4cfa-a30f-761be88dc08f', ['did:peer:2.Ahost']), /unknown command: group remove/, 'a CLI that cannot remove says so, and the bridge pauses on it')
  rmSync(join(home, 'no-remove'))
})

test('the listener turns each printed line into an event, and comes back when it stops', async () => {
  writeFileSync(join(home, 'listen.txt'), [DIRECT, 'room.presumed {}', GROUP_LINE, ''].join('\n'))
  writeFileSync(join(home, 'exit-after'), '')
  const cli = new GebCli({ bin, home, did: 'did:peer:2.Aroom', restartMs: [50] })
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
