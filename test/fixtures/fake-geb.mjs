#!/usr/bin/env node
// A stand-in for Geb's CLI, for test/geb-cli.test.js only. It keeps nothing of Geb's: it writes each call to
// <home>/calls.jsonl, prints <home>/listen.txt for `listen --json` (exactly as given, one line each), and answers the
// room and member lists with fixed JSON. `group remove` fails when <home>/no-remove exists, as a CLI without it would.
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const at = argv.indexOf('--home'), home = at >= 0 ? argv[at + 1] : null
const args = at >= 0 ? [...argv.slice(0, at), ...argv.slice(at + 2)] : argv
if (!home) { process.stderr.write('no --home\n'); process.exit(2) }
appendFileSync(join(home, 'calls.jsonl'), JSON.stringify(args) + '\n')
const [cmd, sub] = args

if (cmd === 'listen') {
  const file = join(home, 'listen.txt')
  if (existsSync(file)) process.stdout.write(readFileSync(file, 'utf8'))
  if (existsSync(join(home, 'exit-after'))) process.exit(3)
  setInterval(() => {}, 1 << 30)
} else if (cmd === 'groups') {
  process.stdout.write(JSON.stringify([{ id: 'old-room', name: 'Other', members: 2 }, { id: '0b11f5fc-df80-4cfa-a30f-761be88dc08f', name: 'InWove', members: 2, founder: 'me', epoch: 1 }]) + '\n')
} else if (cmd === 'gmembers') {
  process.stdout.write(JSON.stringify([{ did: 'did:peer:2.Aroom', label: 'me', leaf: 'bound' }, { did: 'did:peer:2.Ahost', label: 'host', leaf: 'bound' }]) + '\n')
} else if (cmd === 'group' && sub === 'remove' && existsSync(join(home, 'no-remove'))) {
  process.stderr.write('unknown command: group remove\n'); process.exit(2)
} else {
  process.stdout.write('ok\n')
}
