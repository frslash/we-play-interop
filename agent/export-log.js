#!/usr/bin/env node
// Save a workspace's record as one versioned JSON file (see src/server/export.js).
//   node agent/export-log.js https://your-workspace > room-export.json
// A members-only room needs a member: set WPI_MEMBER_KEY_FILE (a file holding your 64-hex key) or WPI_MEMBER_KEY.
// A member reads people-only lines too, so a member's export is the whole record; without a key it is only what the public sees.
import { makeExport } from '../src/server/export.js'
import { oneLine, readWholeLog, roomFetch } from './member-session.js'

const base = (process.argv[2] || process.env.WPI_URL || '').replace(/\/$/, '')
if (!base) { console.error('usage: node agent/export-log.js <workspace url> > export.json\n  members-only room: set WPI_MEMBER_KEY_FILE to a file holding your key (a member\'s export is the whole record, people-only lines included)'); process.exit(2) }
const entries = await readWholeLog(base, roomFetch(base)).catch(oneLine)
const out = makeExport(entries)
console.error(`exported ${out.count} entries, head ${out.head?.seq} ${out.head?.hash}`)
console.log(JSON.stringify(out))
