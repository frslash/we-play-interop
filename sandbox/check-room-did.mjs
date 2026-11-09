// Outside check of a room host's did:webvh: fetch its public log over https from the open internet and
// verify the whole chain with the pinned resolver. Read-only; no keys, no secrets.
// usage: node sandbox/check-room-did.mjs <host>
import { resolveDIDFromLog } from 'didwebvh-ts'

const host = process.argv[2]
if (!host || !/^[a-z0-9.-]+$/i.test(host)) { console.error('usage: check-room-did.mjs <host>'); process.exit(2) }
const url = `https://${host}/.well-known/did.jsonl`
const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20000) })
if (!res.ok) { console.error(`FAIL ${url} answered ${res.status}`); process.exit(1) }
const text = await res.text()
if (text.length > 1_000_000) { console.error('FAIL log larger than 1 MB'); process.exit(1) }
const out = await resolveDIDFromLog(text.trim().split('\n').map((l) => JSON.parse(l)))
const did = out.did ?? out.didDocument?.id, doc = out.didDocument, meta = out.meta
if (!did || !doc || doc.id !== did) { console.error('FAIL resolved document does not carry its own DID'); process.exit(1) }
if (!did.endsWith(`:${host}`)) { console.error(`FAIL ${did} does not belong to ${host}`); process.exit(1) }
console.log(`PASS ${did} (version ${meta?.versionId ?? 'unknown'}) resolves from outside`)
