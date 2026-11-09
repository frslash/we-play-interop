// The room's own did:webvh log, served at /.well-known/did.jsonl on the room's host (so the DID resolves from there).
// The log is public by design (a hash-chained list of signed entries); it holds no key. It is read from the room's data
// folder (DID_LOG_FILE, default <DATA_DIR>/did.jsonl) on every request, so a new entry (a key rotation, a host move)
// is live as soon as the file changes, without a restart. The signing keys never come near this server.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { mintRoomDid } from '../../agent/mint-room-did.js'

const MAX_LOG_BYTES = 256 * 1024 // a rehearsal log is a few KB; this tripwire stands for "this is a DID log, not a data dump"

/** The log's text, or null when the room has none (or it isn't a did:webvh log). */
export function readRoomDidLog ({ dataDir, file = '' }) {
  const path = file || join(dataDir, 'did.jsonl')
  try {
    if (!existsSync(path) || statSync(path).size > MAX_LOG_BYTES) return null
    const text = readFileSync(path, 'utf8')
    const lines = text.split('\n').filter((l) => l.trim())
    if (!lines.length) return null
    for (const l of lines) { const e = JSON.parse(l); if (typeof e.versionId !== 'string' || !e.parameters || !e.state || !Array.isArray(e.proof)) return null }
    return text.endsWith('\n') ? text : text + '\n'
  } catch { return null }
}

/** Handle a GET/HEAD for the room's DID log. Returns false when the path isn't this module's. */
export function handleRoomDid (req, res, path, opts) {
  if (path !== '/.well-known/did.jsonl') return false
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { allow: 'GET, HEAD' }); res.end(); return true }
  const text = readRoomDidLog(opts)
  if (text === null) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('this room has no did:webvh log'); return true }
  res.writeHead(200, { 'content-type': 'text/jsonl; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=60', 'x-content-type-options': 'nosniff' })
  res.end(req.method === 'HEAD' ? undefined : text)
  return true
}

/** The host a did:webvh is minted for: the host of PUBLIC_URL (from config, never hard-coded). '' when there is none. */
export function didHostOf (publicUrl) {
  try { return publicUrl ? new URL(publicUrl).host.replace(':', '%3A') : '' } catch { return '' }
}

/**
 * On start: if the room has no DID log yet, mint one for its public host. The update key is written next to the log
 * (mode 0600) and is never logged; a sibling did-test.json marks it as a rehearsal DID, not the one handed to Project Weave.
 * Returns { minted, did?, reason? }. Never throws: a room without a DID still runs, and says why.
 */
export async function ensureRoomDid ({ dataDir, file = '', publicUrl, log = console.log, now = () => new Date() }) {
  const path = file || join(dataDir, 'did.jsonl')
  if (existsSync(path)) return { minted: false, reason: 'has a log' }
  const host = didHostOf(publicUrl)
  if (!host) return { minted: false, reason: 'no PUBLIC_URL' }
  try {
    const m = await mintRoomDid(host)
    const dir = dirname(path)
    mkdirSync(dir, { recursive: true })
    const at = now().toISOString()
    writeFileSync(join(dir, 'update-key.txt'), m.seedHex + '\n', { mode: 0o600 })
    writeFileSync(join(dir, 'did-test.json'), JSON.stringify({ test: true, did: m.did, mintedAt: at, note: 'A rehearsal DID on a test key. Not the DID handed to Project Weave; their people make the first real keys.' }) + '\n', { mode: 0o600 })
    writeFileSync(path, m.log, { mode: 0o600 }) // last, so a half-finished mint leaves no log and is retried
    log(`room DID minted (test): ${m.did} at ${at}`)
    return { minted: true, did: m.did }
  } catch (e) {
    log(`room DID not minted: ${e?.code || e?.name || 'error'}`)
    return { minted: false, reason: 'error' }
  }
}
