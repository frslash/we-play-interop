// The room's own did:webvh log, served at /.well-known/did.jsonl on the room's host (so the DID resolves from there).
// The log is public by design (a hash-chained list of signed entries); it holds no key. It is read from the room's data
// folder (DID_LOG_FILE, default <DATA_DIR>/did.jsonl) on every request, so a new entry (a key rotation, a host move)
// is live as soon as the file changes, without a restart. The update key may sit next to the log on the host (0600),
// never in the repository, the room's log or its output; growRoomDid uses it to add entries.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { deriveNextKeyHash, prepareDataForSigning, resolveDIDFromLog, updateDID } from 'didwebvh-ts'
import { mintRoomDid } from '../../agent/mint-room-did.js'
import { ed25519Multikey, identityFromSeedHex, multikeyToEd25519, newIdentity } from '../shared/did.js'
import { ed25519, multibase } from '../shared/crypto.js'
import { HTTPS_SERVICE, serviceEndpoint } from '../shared/trusttask.js'

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

/** Where the room takes DIDComm messages (the join desk's route), for PUBLIC_URL. '' when there is none. */
export function didcommEndpoint (publicUrl) {
  try { return publicUrl ? new URL(publicUrl).origin + '/didcomm' : '' } catch { return '' }
}

/**
 * Where the room takes standard Trust Task documents, for PUBLIC_URL: the base its DID names. The door is this +
 * "/trust-tasks" (src/server/door.js): the https binding makes the service's endpoint the base and has every sender
 * add the path (OpenVTC writes and checks it so: vtc-service/src/member_portal/oob.rs, vti-common trust_task_push).
 * '' when there is no PUBLIC_URL.
 */
export function trustTaskBase (publicUrl) {
  try { return publicUrl ? new URL(publicUrl).origin : '' } catch { return '' }
}

/**
 * The page a wallet sign-in is started from, for PUBLIC_URL: the room's own page. A wallet refuses a sign-in code
 * unless the DID that sent it lists a SignInPortal service on the same origin as the page the code was shown on
 * (OpenVTC vta-sdk/src/did_templates/sign_in_portal.rs). Only for an https address: a wallet will not sign in to a
 * plain-http page, and an entry it would refuse hides the real gap. '' when there is none.
 */
export function signInPortalEndpoint (publicUrl) {
  try { const u = new URL(publicUrl); return u.protocol === 'https:' ? u.origin + '/' : '' } catch { return '' }
}

/** The document the room's DID should have: the room's signing key, a service pointing at the room's site, its DIDComm inbox, its Trust Task door, and the page people sign in on. */
export function roomDidDocument ({ did, roomPublicKey, publicUrl }) {
  const vm = `${did}#room`, portal = signInPortalEndpoint(publicUrl)
  return {
    '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'],
    id: did,
    verificationMethod: [{ id: vm, type: 'Multikey', controller: did, publicKeyMultibase: ed25519Multikey(roomPublicKey) }],
    authentication: [vm],
    assertionMethod: [vm],
    service: [
      { id: `${did}#room-site`, type: 'LinkedDomains', serviceEndpoint: new URL(publicUrl).origin + '/' },
      { id: `${did}#didcomm`, type: 'DIDCommMessaging', serviceEndpoint: { uri: didcommEndpoint(publicUrl), accept: ['didcomm/v2'] } },
      { id: `${did}#trust-tasks`, type: HTTPS_SERVICE, serviceEndpoint: trustTaskBase(publicUrl) }, // found by its type, never by this #id
      ...(portal ? [{ id: `${did}#sign-in-portal`, type: 'SignInPortal', serviceEndpoint: portal }] : []),
    ],
  }
}

/**
 * What the room's DID says right now, read from the same log /.well-known/did.jsonl serves (so it is what a wallet
 * resolves): its id, its DIDComm endpoint, the base of its Trust Task door, the key it lists as #room for
 * authentication (the room can answer as this DID only when that is its own key), and the whole document. Nulls
 * when there is no log or it does not verify. Never throws.
 */
export async function roomDidStatus ({ dataDir, file = '' }) {
  const none = { did: null, didcomm: null, trustTasks: null, roomKey: null }
  try {
    const text = readRoomDidLog({ dataDir, file })
    if (text === null) return none
    const doc = (await resolveDIDFromLog(text.trim().split('\n').map((l) => JSON.parse(l)))).didDocument
    const room = `${doc.id}#room`
    const key = (doc.authentication ?? []).includes(room) ? (doc.verificationMethod ?? []).find((m) => m.id === room)?.publicKeyMultibase : null
    return { did: doc.id ?? null, didcomm: serviceEndpoint(doc, 'DIDCommMessaging'), trustTasks: serviceEndpoint(doc, HTTPS_SERVICE), roomKey: key ?? null, document: doc }
  } catch { return none }
}

/** did:webvh times are whole seconds and must rise: now, or one second after the last entry if that is later. */
const nextVersionTime = (prev, at) => new Date(Math.max(Math.floor(at.getTime() / 1000) * 1000, Date.parse(prev) + 1000)).toISOString().replace(/\.\d+Z$/, 'Z')
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const readSeed = (p) => { try { return identityFromSeedHex(readFileSync(p, 'utf8')) } catch { return null } }

/**
 * Bring the room's DID up to date with a new signed log entry (never rewriting old ones): its document carries the
 * room's signing key and its services for PUBLIC_URL (the site, the DIDComm inbox, the Trust Task door), and its update
 * key is no longer the rehearsal key. A service the document lacks (one this code learned to name since the last entry)
 * is reason enough for a new entry.
 * The new update key is ROOM_DID_UPDATE_KEY (a public Ed25519 multikey held by the room's people) when set; otherwise
 * the host makes a fresh one and keeps it next to the log (0600), so a later entry can hand it to them.
 * Pre-rotation: `nextKey` (ROOM_DID_NEXT_KEY, a public Ed25519 multikey made by the room's people, kept apart from every update key)
 * is committed to the log as a hash (`nextKeyHashes`), so only that key can take the DID over next. Once a commitment is
 * in the log the host can change only to a committed key; it never holds the recovery key, and the key never leaves them.
 * Signs only with an update key the host holds; when it holds none of the current ones it changes nothing and says so.
 * Returns { grown, versionId?, reason? }. Never throws, never logs a key.
 */
export async function growRoomDid ({ dataDir, file = '', publicUrl, roomPublicKey, updateKey = '', nextKey = '', log = console.log, now = () => new Date() }) {
  const path = file || join(dataDir, 'did.jsonl')
  const dir = dirname(path)
  try {
    const text = readRoomDidLog({ dataDir, file })
    if (text === null) return { grown: false, reason: 'no log' }
    if (!publicUrl || !roomPublicKey) return { grown: false, reason: 'no PUBLIC_URL or room key' }
    if (updateKey) multikeyToEd25519(updateKey) // refuse anything but an Ed25519 multikey
    let nextHash = ''
    if (nextKey) {
      multikeyToEd25519(nextKey)
      if (nextKey === updateKey) return { grown: false, reason: 'next key must differ from the update key' }
      nextHash = await deriveNextKeyHash(nextKey)
    }
    const entries = text.trim().split('\n').map((l) => JSON.parse(l))
    const current = await resolveDIDFromLog(entries)
    const did = current.didDocument.id
    const keys = current.didDocumentMetadata.updateKeys ?? []
    const testMark = (() => { try { return JSON.parse(readFileSync(join(dir, 'did-test.json'), 'utf8')) } catch { return null } })()
    const rehearsalKey = testMark?.test ? (testMark.rehearsalUpdateKey ?? entries[0].parameters.updateKeys?.[0]) : null

    const wantDoc = roomDidDocument({ did, roomPublicKey, publicUrl })
    const have = current.didDocument // as resolved: did:webvh adds its own #files and #whois services, so look for ours
    const docOk = ['verificationMethod', 'authentication', 'assertionMethod'].every((k) => sameJson(have[k], wantDoc[k])) &&
      wantDoc.service.every((s) => (have.service ?? []).some((h) => sameJson(h, s)))
    const committed = current.didDocumentMetadata.nextKeyHashes ?? []
    const nextOk = !nextHash || sameJson(committed, [nextHash])
    const keyOk = updateKey ? sameJson(keys, [updateKey]) : !keys.includes(rehearsalKey)
    if (docOk && keyOk && nextOk) return { grown: false, reason: 'up to date' }

    const held = [join(dir, 'update-key.txt'), join(dir, 'update-key.next.txt')].map(readSeed).find((id) => id && keys.includes(ed25519Multikey(id.publicKey)))
    if (!held) { log('room DID not grown: the host holds none of its update keys'); return { grown: false, reason: 'no update key here' } }
    const heldMk = ed25519Multikey(held.publicKey)

    let fresh = null
    let nextKeys = keys
    if (!keyOk) {
      if (updateKey) nextKeys = [updateKey]
      else { fresh = newIdentity(); nextKeys = [ed25519Multikey(fresh.publicKey)] }
    }
    if (nextHash && nextKeys.includes(nextKey)) return { grown: false, reason: 'next key must differ from the update key' }
    if (committed.length) { // once a commitment is in the log, only a committed key may be the update key
      for (const k of nextKeys) if (!committed.includes(await deriveNextKeyHash(k))) { log('room DID not grown: pre-rotation is on and the update key is not a committed one'); return { grown: false, reason: 'pre-rotation: not a committed key' } }
    }
    const signer = {
      getVerificationMethodId: () => `did:key:${heldMk}#${heldMk}`,
      async sign ({ document, proof }) { return { proofValue: multibase(ed25519.sign(await prepareDataForSigning(document, proof), held.seed)) } },
    }
    const verifier = { verify: async (sig, msg, pub) => ed25519.verify(sig, msg, pub) }
    const r = await updateDID({ log: entries, signer, verifier, didDocument: wantDoc, updateKeys: nextKeys, ...(nextHash && !sameJson(committed, [nextHash]) ? { nextKeyHashes: [nextHash] } : {}), updated: nextVersionTime(entries.at(-1).versionTime, now()) })
    const newText = r.log.map((e) => JSON.stringify(e)).join('\n') + '\n'
    // Re-resolve what we are about to write BEFORE anything touches disk (and so before any key is deleted): the whole chain must
    // verify, the update keys must be exactly what was asked, and the document must be the one wanted. Else change nothing.
    const after = await resolveDIDFromLog(r.log)
    const afterDoc = after.didDocument
    const afterOk = sameJson(after.didDocumentMetadata.updateKeys ?? [], nextKeys) && (!nextHash || sameJson(after.didDocumentMetadata.nextKeyHashes ?? [], [nextHash])) && ['verificationMethod', 'authentication', 'assertionMethod'].every((k) => sameJson(afterDoc[k], wantDoc[k])) && wantDoc.service.every((s) => (afterDoc.service ?? []).some((h) => sameJson(h, s)))
    if (!afterOk) { log('room DID not grown: the new log did not resolve to what was asked'); return { grown: false, reason: 'new log did not verify' } }
    // the new key first (so a crash leaves a key that can still sign), then the log, then the key takes its usual name
    if (fresh) writeFileSync(join(dir, 'update-key.next.txt'), fresh.seedHex + '\n', { mode: 0o600 })
    writeFileSync(path + '.tmp', newText, { mode: 0o600 }); renameSync(path + '.tmp', path)
    if (fresh) renameSync(join(dir, 'update-key.next.txt'), join(dir, 'update-key.txt'))
    else if (updateKey && !nextKeys.includes(heldMk)) rmSync(join(dir, 'update-key.txt'), { force: true }) // handed over: the host keeps no power over the DID
    if (testMark && !keyOk) writeFileSync(join(dir, 'did-test.json'), JSON.stringify({ ...testMark, test: false, rehearsalUpdateKey: rehearsalKey, rehearsalKeyRetiredAt: now().toISOString(), updateKeyHeldBy: updateKey ? 'ROOM_DID_UPDATE_KEY' : 'this host' }) + '\n', { mode: 0o600 })
    const versionId = r.log.at(-1).versionId
    log(`room DID grown: ${did} now at ${versionId}`)
    return { grown: true, versionId }
  } catch (e) {
    log(`room DID not grown: ${e?.code || e?.name || 'error'}`)
    return { grown: false, reason: 'error' }
  }
}
