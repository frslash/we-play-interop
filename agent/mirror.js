#!/usr/bin/env node
// A second copy of a room's record, kept anywhere by anyone, and checked: every hash link, every
// signature, every agent's permission. It follows the room every few seconds, and if the room's record
// ever stops matching this copy (an entry changed or removed), it keeps its copy, says so loudly, and
// serves both what it holds and what it found. Anyone can read it the way they read the room:
//   node agent/mirror.js https://the-room [--dir ./mirror] [--port 3100] [--every 15] [--host 127.0.0.1]
// A members-only room needs a member: set WPI_MEMBER_KEY_FILE (a file holding your 64-hex key) or WPI_MEMBER_KEY. A member reads
// people-only lines too, so this copy then holds them: it listens on this computer only (127.0.0.1) unless you give --host, and
// its files are for you alone. Share the copy only with people who may read those lines.
//   GET /           what this copy holds and whether it checks out
//   GET /api/log    the same entries the room serves (?after=&limit=)
//   GET /api/verify the last full check
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { verifyChain } from '../src/shared/chain.js'
import { createResolver } from '../src/server/resolver.js'
import { memberIdentity, roomFetch, RoomReadError } from './member-session.js'

const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d }
const room = (args.find((a) => /^https?:\/\//.test(a)) || process.env.WPI_URL || '').replace(/\/$/, '')
if (!room) { console.error('usage: node agent/mirror.js <room url> [--dir ./mirror] [--port 3100] [--every 15] [--host 127.0.0.1]\n  members-only room: set WPI_MEMBER_KEY_FILE to a file holding your key'); process.exit(2) }
const dir = opt('dir', './mirror'), port = Number(opt('port', 3100)), every = Number(opt('every', 15)) * 1000
let keyed = false
try { keyed = memberIdentity() !== null } catch (err) { if (err instanceof RoomReadError) { console.error(err.message); process.exit(2) } throw err }
const host = opt('host', keyed ? '127.0.0.1' : undefined) // a copy that holds people-only lines is not offered to the network by default
const get = roomFetch(room)
mkdirSync(dir, { recursive: true, mode: 0o700 })
const FILE = join(dir, 'entries.jsonl'), STATUS = join(dir, 'status.json')
const entries = existsSync(FILE) ? readFileSync(FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
const resolver = createResolver()
const status = { room, since: new Date().toISOString(), entries: entries.length, head: entries.at(-1)?.hash ?? null, lastPull: null, report: null, mismatch: null, error: null }
const save = () => writeFileSync(STATUS, JSON.stringify(status, null, 2))
const say = (s) => console.log(`${new Date().toISOString()} ${s}`)

async function check () {
  status.report = await verifyChain(entries, { keyFor: (did, vm, purpose) => resolver.keyFor(did, vm, purpose) })
  status.report.at = new Date().toISOString()
}

async function pull () {
  try {
    let got = 0
    // the room's entry at our head must still be ours, or the room changed its record
    if (entries.length) {
      const last = entries.at(-1)
      const r = await get(`${room}/api/log?after=${last.seq - 1}&limit=1`, { signal: AbortSignal.timeout(20_000) })
      const there = r.ok ? (await r.json()).entries[0] : null
      if (!there || there.hash !== last.hash) {
        if (!status.mismatch) say(`THE ROOM'S RECORD NO LONGER MATCHES THIS COPY at #${last.seq}: this copy keeps what it holds`)
        status.mismatch = { at: new Date().toISOString(), seq: last.seq, ours: last.hash, theirs: there?.hash ?? null }
        return save()
      }
    }
    for (;;) {
      const after = entries.at(-1)?.seq ?? -1
      const r = await get(`${room}/api/log?after=${after}&limit=500`, { signal: AbortSignal.timeout(20_000) })
      if (!r.ok) throw new Error(`the room answered ${r.status}`)
      const page = (await r.json()).entries
      for (const e of page) { entries.push(e); appendFileSync(FILE, JSON.stringify(e) + '\n', { mode: 0o600 }); got++ }
      if (page.length < 500) break
    }
    status.lastPull = new Date().toISOString(); status.entries = entries.length; status.head = entries.at(-1)?.hash ?? null; status.error = null
    if (got || !status.report) { await check(); say(`${got} new · ${entries.length} entries · ${status.report.ok ? 'all checks out' : `${status.report.problems.length} problems`}`) }
  } catch (err) {
    status.error = { at: new Date().toISOString(), message: String(err.message).slice(0, 200) }
    if (!status.lastPull && err instanceof RoomReadError) { console.error(err.message); process.exit(2) } // the first look failed for a reason only the person can fix: say it and stop
  }
  save()
}

const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(body, null, 2)) }
createServer((req, res) => {
  const u = new URL(req.url, 'http://local')
  if (u.pathname === '/api/log') {
    const after = Number(u.searchParams.get('after') ?? -1), limit = Math.min(500, Number(u.searchParams.get('limit') ?? 100))
    return send(res, 200, { entries: entries.filter((e) => e.seq > after).slice(0, limit), mirrorOf: room })
  }
  if (u.pathname === '/api/verify') return send(res, 200, status.report ?? { ok: null, note: 'not checked yet' })
  return send(res, 200, { mirrorOf: room, entries: status.entries, head: status.head, checksOut: status.report?.ok ?? null, lastPull: status.lastPull, mismatch: status.mismatch, error: status.error })
}).listen(port, host, () => say(`a copy of ${room} on ${host ?? ''}:${port}, in ${dir}`))

await pull()
setInterval(pull, every)
