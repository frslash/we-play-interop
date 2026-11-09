#!/usr/bin/env node
// Save a workspace's public record as one versioned JSON file (see src/server/export.js).
//   node agent/export-log.js https://your-workspace > room-export.json
import { makeExport } from '../src/server/export.js'

const base = (process.argv[2] || process.env.WPI_URL || '').replace(/\/$/, '')
if (!base) { console.error('usage: node agent/export-log.js <workspace url> > export.json'); process.exit(2) }
const entries = []
for (let after = -1; ;) {
  const res = await fetch(`${base}/api/log?after=${after}&limit=500`)
  if (!res.ok) { console.error(`could not read ${base}/api/log: HTTP ${res.status}`); process.exit(2) }
  const page = (await res.json()).entries
  entries.push(...page)
  if (page.length < 500) break
  after = entries.at(-1).seq
}
const out = makeExport(entries)
console.error(`exported ${out.count} entries, head ${out.head?.seq} ${out.head?.hash}`)
console.log(JSON.stringify(out))
