#!/usr/bin/env node
// Verify a workspace's whole log yourself: every hash link, every signature
// (did:key, did:peer:4, did:webvh), every agent's delegation.
//   node agent/verify-log.js https://your-workspace
// A members-only room needs a member: set WPI_MEMBER_KEY_FILE (a file holding your 64-hex key) or WPI_MEMBER_KEY.
import { verifyChain } from '../src/shared/chain.js'
import { createResolver } from '../src/server/resolver.js'
import { oneLine, readWholeLog, roomFetch } from './member-session.js'

const base = (process.argv[2] || process.env.WPI_URL || '').replace(/\/$/, '')
if (!base) { console.error('usage: node agent/verify-log.js <workspace url>\n  members-only room: set WPI_MEMBER_KEY_FILE to a file holding your key'); process.exit(2) }
const entries = await readWholeLog(base, roomFetch(base)).catch(oneLine)
const resolver = createResolver()
const report = await verifyChain(entries, { keyFor: (did, vm, purpose) => resolver.keyFor(did, vm, purpose) })
console.log(JSON.stringify(report, null, 2))
process.exit(report.ok ? 0 : 1)
