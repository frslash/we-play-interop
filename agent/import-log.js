#!/usr/bin/env node
// Import an export into a clean, empty instance's data folder, but only if the chain verifies and
// the head comes out the same. Never overwrites an existing log.
//   node agent/import-log.js room-export.json <data-dir>      (or DATABASE_URL for Postgres)
import { readFileSync } from 'node:fs'
import { importExport } from '../src/server/export.js'
import { openDb } from '../src/server/db.js'
import { createResolver } from '../src/server/resolver.js'

const [file, dataDir] = process.argv.slice(2)
if (!file || (!dataDir && !process.env.DATABASE_URL)) { console.error('usage: node agent/import-log.js <export.json> <data-dir>'); process.exit(2) }
const db = await openDb({ databaseUrl: process.env.DATABASE_URL || '', dataDir })
try {
  const resolver = createResolver()
  const r = await importExport(db, JSON.parse(readFileSync(file, 'utf8')), { keyFor: (d, vm, p) => resolver.keyFor(d, vm, p) })
  console.log(JSON.stringify({ ok: true, ...r }, null, 2))
} catch (err) {
  console.error(err.message)
  // Say where it failed: the verifier's own report (seq and reason of each problem, the first 50).
  const rep = err.report
  if (rep) {
    console.error(`checked ${rep.checked} of ${rep.entries} entries, ${rep.problems.length} problem(s), ${rep.signaturesNotChecked} signature(s) not checked`)
    for (const p of rep.problems.slice(0, 50)) console.error(`  seq ${p.seq}: ${p.problem}`)
  }
  process.exitCode = 1
} finally { await db.close() }
