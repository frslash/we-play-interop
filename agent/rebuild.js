#!/usr/bin/env node
// Rebuild the room's whole record with the room's server switched off, from other members' copies.
// Each source is a copy someone keeps: a mirror's address (it serves /api/log, see agent/mirror.js),
// a mirror's entries.jsonl, or an export (.json). No source is trusted: every entry must link, hash and
// carry two good signatures, and the result must pass the whole-log check with no signature unchecked.
// A source that is a members-only room's address needs a member: set WPI_MEMBER_KEY_FILE (a file holding your key).
//   node agent/rebuild.js <copy> [<copy> ...] --room did:key:... [--out rebuilt-export.json]
// --room is required: the room's DID, from somewhere other than the copies (the room's page, your own
// notes). Without it, a full copy of some other room would rebuild and pass as this one.
// Prints one JSON result (no entries in it); exits 0 only when the rebuild checks out.
// --out writes the rebuilt record as an export, which agent/import-log.js or agent/roundtrip-log.js take.
import { readFileSync, writeFileSync } from 'node:fs'
import { rebuildFromCopies } from '../src/shared/rebuild.js'
import { makeExport } from '../src/server/export.js'
import { createResolver } from '../src/server/resolver.js'
import { RoomReadError, roomFetch } from './member-session.js'

const args = process.argv.slice(2)
const opt = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? args.splice(i, 2)[1] : null }
const out = opt('out'), room = opt('room')
const usage = 'usage: node agent/rebuild.js <mirror url | entries.jsonl | export.json> [...] --room did [--out file]'
if (!room || !/^did:[a-z0-9]+:\S+$/.test(room)) {
  console.error(room ? `--room must be a DID (did:method:...), got: ${String(room).slice(0, 80)}` : 'refusing to rebuild without --room: name the room\'s DID, so another room\'s record cannot pass as this one')
  console.error(usage); process.exit(2)
}
if (!args.length) { console.error(usage); process.exit(2) }

async function readCopy (src) {
  if (/^https?:\/\//.test(src)) {
    const base = src.replace(/\/$/, ''), entries = [], get = roomFetch(base)
    for (let after = -1; ;) {
      const r = await get(`${base}/api/log?after=${after}&limit=500`, { signal: AbortSignal.timeout(20_000) })
      if (!r.ok) throw new Error(`answered ${r.status}`)
      const page = (await r.json()).entries ?? []
      entries.push(...page)
      if (page.length < 500) break
      after = entries.at(-1).seq
    }
    return entries
  }
  const text = readFileSync(src, 'utf8')
  if (src.endsWith('.jsonl')) return text.split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const doc = JSON.parse(text)
  return Array.isArray(doc) ? doc : (doc.entries ?? [])
}

const copies = [], unreadable = []
for (const src of args) {
  try { copies.push({ name: src, entries: await readCopy(src) }) } catch (err) { unreadable.push({ name: src, problem: String(err.message).slice(0, 200) }); if (err instanceof RoomReadError) console.error(err.message) }
}
const resolver = createResolver()
const r = await rebuildFromCopies(copies, { room, keyFor: (d, vm, p) => resolver.keyFor(d, vm, p) })
if (out && r.ok) writeFileSync(out, JSON.stringify(makeExport(r.entries)))
console.log(JSON.stringify({
  ok: r.ok,
  room: r.room,
  entries: r.entries.length,
  head: r.head,
  entriesChecked: r.report.checked,
  signaturesNotChecked: r.report.signaturesNotChecked,
  problems: r.report.problems,
  fork: r.fork,
  missing: r.missing,
  copies: r.copies,
  unreadable,
  written: out && r.ok ? out : null,
}, null, 2))
process.exit(r.ok ? 0 : 1)
