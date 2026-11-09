#!/usr/bin/env node
// Send one signed line to another agent through any relay, and keep your own record of it.
// The relay is not part of this tool: you (or your agent) hand the line's JSON to whatever carrier
// the two of you chose, one neither of you runs, and the other side takes it from there.
//
//   node agent/line.js say --to <their DID> --text "hello" [--via <relay>]   prints the signed line (JSON) to send
//   node agent/line.js take <file | -> [--via <relay>]                     checks a line you received and records it
//   node agent/line.js show                                                each line in your record, with its hash
//   node agent/line.js same <their record.jsonl> <hash>                    does their copy show the line with the same hash?
//   node agent/line.js me                                                  your DID (give it to the other side)
//
// Env: WPI_AGENT_KEY (64 hex) or WPI_AGENT_KEY_FILE (default ~/.config/we-play-interop/agent-key, the bridge's key);
// WPI_LINES (default ./lines/record.jsonl). The key never leaves this machine; only signed lines do.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { identityFromSeedHex, newIdentity } from '../src/shared/did.js'
import { createRecord, makeLine, sameLine } from '../src/shared/line.js'

const [cmd, ...rest] = process.argv.slice(2)
const opt = (k) => { const i = rest.indexOf('--' + k); return i >= 0 ? rest[i + 1] : undefined }
const positional = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--')))
const die = (s) => { console.error(s); process.exit(1) }

function loadKey () {
  if (process.env.WPI_AGENT_KEY) return identityFromSeedHex(process.env.WPI_AGENT_KEY)
  const file = process.env.WPI_AGENT_KEY_FILE || join(homedir(), '.config/we-play-interop/agent-key')
  if (existsSync(file)) return identityFromSeedHex(readFileSync(file, 'utf8'))
  const id = newIdentity()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, id.seedHex, { mode: 0o600 })
  console.error(`Made a key for this agent in ${file} (keep it private).`)
  return id
}

const readRows = (file) => existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
const FILE = process.env.WPI_LINES || './lines/record.jsonl'
const me = loadKey()
const record = createRecord(me.did, readRows(FILE))
const keep = (row) => { mkdirSync(dirname(FILE), { recursive: true }); appendFileSync(FILE, JSON.stringify(row) + '\n') }

if (cmd === 'me') console.log(me.did)
else if (cmd === 'say') {
  const line = makeLine(me, { to: opt('to'), text: opt('text') })
  const r = record.add(line, { via: opt('via') })
  if (!r.ok) die(r.reason)
  keep(r.row)
  console.error(`line ${r.hash}: send the JSON below through the relay`)
  console.log(JSON.stringify(line))
} else if (cmd === 'take') {
  const src = positional[0] ?? '-'
  let doc
  try { doc = JSON.parse(readFileSync(src === '-' ? 0 : src, 'utf8')) } catch (e) { die(`not a line: ${e.message}`) }
  const r = record.add(doc, { via: opt('via') })
  if (!r.ok) die(`refused: ${r.reason}`)
  if (!r.already) keep(r.row)
  console.log(`${r.already ? 'already had' : 'took'} line ${r.hash} from ${r.from}: ${JSON.stringify(r.text)}`)
} else if (cmd === 'show') {
  for (const r of record.rows()) console.log(`${r.hash} ${r.direction} ${r.direction === 'sent' ? 'to ' + r.line.recipient : 'from ' + r.line.issuer} via ${r.via ?? '(not said)'}: ${JSON.stringify(r.line.payload.text)}`)
} else if (cmd === 'same') {
  const [theirs, hash] = positional
  if (!theirs || !hash) die('usage: node agent/line.js same <their record.jsonl> <hash>')
  const r = sameLine(record.rows(), readRows(theirs), hash)
  if (!r.ok) die(`no: ${r.reason}`)
  console.log(`yes: both copies show line ${r.hash}, from ${r.from} to ${r.to}, via ${r.via.map((v) => v ?? '(not said)').join(' / ')}`)
} else die('usage: node agent/line.js me | say --to <did> --text <text> [--via <relay>] | take <file|-> [--via <relay>] | show | same <their record.jsonl> <hash>')
