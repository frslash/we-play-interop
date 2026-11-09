#!/usr/bin/env node
// The export round trip: import an export into a clean, empty data folder (only if the chain verifies and
// the head comes out the same), export again from what was written, and compare the two entry by entry.
// Prints one JSON result; exits 1 unless every entry came back the same and no signature went unchecked.
//   node agent/roundtrip-log.js room-export.json <empty-data-dir> [re-export.json]
import { readFileSync, writeFileSync } from 'node:fs'
import { makeExport, roundTrip } from '../src/server/export.js'
import { loadEntries, openDb } from '../src/server/db.js'
import { createResolver } from '../src/server/resolver.js'

const [file, dataDir, againFile] = process.argv.slice(2)
if (!file || !dataDir) { console.error('usage: node agent/roundtrip-log.js <export.json> <empty-data-dir> [re-export.json]'); process.exit(2) }
// Always a local data folder: the round trip never writes into a database named by the environment.
const db = await openDb({ databaseUrl: '', dataDir })
try {
  const resolver = createResolver()
  const r = await roundTrip(db, JSON.parse(readFileSync(file, 'utf8')), { keyFor: (d, vm, p) => resolver.keyFor(d, vm, p) })
  if (againFile) writeFileSync(againFile, JSON.stringify(makeExport(await loadEntries(db))))
  console.log(JSON.stringify(r, null, 2))
  if (!r.ok || r.signaturesNotChecked !== 0) process.exitCode = 1
} catch (err) {
  console.error(err.message)
  for (const p of err.report?.problems?.slice(0, 50) ?? []) console.error(`  seq ${p.seq}: ${p.problem}`)
  console.log(JSON.stringify({ ok: false, reason: err.message }, null, 2))
  process.exitCode = 1
} finally { await db.close() }
