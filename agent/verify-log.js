#!/usr/bin/env node
// Verify a workspace's whole log yourself: every hash link, every signature
// (did:key, did:peer:4, did:webvh), every agent's delegation.
//   node agent/verify-log.js https://your-workspace
import { verifyChain } from '../src/shared/chain.js'
import { createResolver } from '../src/server/resolver.js'

const base = (process.argv[2] || process.env.WPI_URL || '').replace(/\/$/, '')
if (!base) { console.error('usage: node agent/verify-log.js <workspace url>'); process.exit(2) }
const entries = []
for (let after = -1; ;) {
  const res = await fetch(`${base}/api/log?after=${after}&limit=500`)
  if (!res.ok) { console.error(`could not read ${base}/api/log: HTTP ${res.status}`); process.exit(2) }
  const page = (await res.json()).entries
  entries.push(...page)
  if (page.length < 500) break
  after = entries.at(-1).seq
}
const resolver = createResolver()
const report = await verifyChain(entries, { keyFor: (did, vm, purpose) => resolver.keyFor(did, vm, purpose) })
console.log(JSON.stringify(report, null, 2))
process.exit(report.ok ? 0 : 1)
