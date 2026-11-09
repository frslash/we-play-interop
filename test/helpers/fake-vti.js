// A stand-in for two services the room does not run: a person's trust agent (OpenVTC "VTA") and a room host, each on
// 127.0.0.1. It follows the wire of OpenVTC at the commit the room builds from (c6964c4). It proves the room's side is
// self-consistent; it does not prove interop (test/live/vti-notebook-live.test.js is the check against the real thing).
//
// Each shape below was read from:
//   the door, both services      one route, POST /trust-tasks, one Trust Task document in, one out
//                                (room-host/src/lib.rs router/dispatch; vta-service/src/trust_tasks/mod.rs)
//   refusals                     trust-task-error documents with the shared codes (room-host/src/lib.rs reject,
//                                from_app_error: not found and a lost version are taskFailed, a bad proof or chain
//                                is permissionDenied, a bad payload is malformedRequest)
//   a duplicate id at the host   the first answer again for a write, 204 and no body for a read, idConflict for a
//                                different document (room-host/src/lib.rs dispatch_received, is_consequential)
//   sign-in                      vti-specs-core/trust-tasks/auth/{challenge/0.1,authenticate/0.3,refresh/0.2}.bundle.json;
//                                one session per DID, a refused token is HTTP 401 (vti-common/src/auth/extractor.rs)
//   which versions are served    vta-service/src/trust_tasks/mod.rs (the dispatch table), room-host/src/lib.rs route()
//   payload members              vti-specs-rooms/trust-tasks/rooms/**/<version>.bundle.json (each is closed: an
//                                unknown member is malformedRequest)
//   rooms/keys/act               vta-service/src/trust_tasks/room_act.rs handle_act and operations/room_act.rs (the
//                                closed table per version, the five-minute window, no presentation brought along,
//                                who is acted as, a delegate refused)
//   rooms/keys/seal              room_act.rs handle_seal, unsigned_body (the body's members, signed as its author for
//                                assertionMethod, the place it names must be the place it is sealed for)
//   rooms/keys/open, commit      room_group.rs handle_open_v0_2 / open_refused, operations/room_groups.rs apply_commit
//   rooms/keys/list              room_label.rs handle_list_v0_2 (a delegate is answered with no rooms)
//   a sealed record              vti-rooms/src/sealed.rs: ChaCha20-Poly1305, a 12-byte random nonce, the tag after the
//                                ciphertext, associated data "{roomId}|{key}|{version}|{epoch}", base64url without padding
//   an epoch link                vti-rooms/src/retention.rs seal_link: the epoch before, sealed under this one, with
//                                associated data "{roomId}|epoch-link|{epoch}|{epoch-1}"
//   records at the host          vti-rooms/src/storage.rs put_record (one version counter for the room, the three
//                                expectedVersion cases and their words, the epoch a sealed record must name, the
//                                version a body was stored at kept as sealed.version) and list_records_page (by
//                                version, a cursor "v<version>" only when more remain)
//   who may do what              vti-rooms/src/authz.rs as reported in _reads/vti-rooms.md: the presenter is the
//                                document's signer; { membership, authority: [leaf first … issued by the room] }
// Where it is NOT the real thing, on purpose:
//   - No MLS. The real storage key is the group's exporter secret ("openvtc/room/storage/v1"); here each epoch's key
//     is 32 random bytes, and a "commit" is the next epoch's key sealed under the one before. What a member can and
//     cannot open, epoch by epoch, is the same; the bytes of a commit are not.
//   - The credentials inside a presentation are small look-alikes of the DTG ones (issuer, subject, actions, dates,
//     an eddsa-jcs-2022 proof). The room's client never reads inside a presentation, so nothing depends on them.
//   - The host leaves out the optional dataCommitment and trace (the Merkle proof over the room's records).
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import http from 'node:http'
import { canonicalize, multibase } from '../../src/shared/crypto.js'
import { newIdentity, resolveDidKey } from '../../src/shared/did.js'
import { keyFromDidDocument } from '../../src/shared/chain.js'
import { sign, verifySignature } from '../../src/shared/proof.js'
import { SPEC, checkTask, instant, parseType, refusalTo, responseTo, signTask, statusFor, verifyTask } from '../../src/shared/trusttask.js'

const b64u = (b) => Buffer.from(b).toString('base64url')
const unb64u = (s) => Buffer.from(String(s), 'base64url')
const digest = (v) => createHash('sha256').update(canonicalize(v)).digest('hex')
export const recordAad = (roomId, key, version, epoch) => `${roomId}|${key}|${version}|${epoch}`
export const linkAad = (roomId, epoch) => `${roomId}|epoch-link|${epoch}|${epoch - 1}`
export function seal (key, aad, plain) {
  const nonce = randomBytes(12), c = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 })
  c.setAAD(Buffer.from(aad), { plaintextLength: plain.length })
  return { ciphertext: b64u(Buffer.concat([c.update(plain), c.final(), c.getAuthTag()])), nonce: b64u(nonce) }
}
export function open (key, aad, { ciphertext, nonce }) {
  const raw = unb64u(ciphertext), d = createDecipheriv('chacha20-poly1305', key, unb64u(nonce), { authTagLength: 16 })
  d.setAAD(Buffer.from(aad), { plaintextLength: raw.length - 16 }); d.setAuthTag(raw.subarray(raw.length - 16))
  return Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()])
}

class Refuse extends Error { constructor (code, message, details, status) { super(message); this.code = code; this.details = details; this.status = status } }
const no = (code, message, details, status) => { throw new Refuse(code, message, details, status) }
const only = (obj, members, what) => { for (const k of Object.keys(obj ?? {})) if (k !== 'ext' && !members.includes(k)) no('malformedRequest', `${what}: unknown member \`${k}\``) }
const need = (obj, members, what) => { for (const k of members) if (obj?.[k] === undefined) no('malformedRequest', `${what}: missing \`${k}\``) }
const credential = (issuer, subject, extra, days = 90) => sign({ '@context': ['https://www.w3.org/ns/credentials/v2'], type: ['VerifiableCredential', 'DTGCredential'], id: `urn:uuid:${randomUUID()}`, issuer: issuer.did, validFrom: instant(Date.now() - 60_000), validUntil: instant(Date.now() + days * 86400_000), credentialSubject: { id: subject, ...extra } }, { seed: issuer.seed, verificationMethod: issuer.verificationMethod, created: instant(), proofPurpose: 'assertionMethod' })
const credentialHolds = (c, issuerDid) => { try { return c?.issuer === issuerDid && c.proof?.proofPurpose === 'assertionMethod' && Date.parse(c.validFrom) <= Date.now() && Date.parse(c.validUntil) > Date.now() && verifySignature(c, keyFromDidDocument(resolveDidKey(issuerDid), issuerDid, c.proof.verificationMethod, 'assertionMethod')).ok } catch { return false } }

// rooms/keys/act: the closed table of each version (vta-service/src/operations/room_act.rs ACT_TABLE_0_8 and the rows 0.9, 0.11 and 0.12 add).
const T = (family, v) => `${SPEC}rooms/${family}/${v}`
const ACT_0_8 = { [T('records/put', '0.1')]: 'write', [T('records/put', '0.2')]: 'write', [T('records/put', '0.3')]: 'write', [T('records/get', '0.1')]: 'read', [T('records/get', '0.2')]: 'read', [T('records/list', '0.1')]: 'read', [T('records/list', '0.2')]: 'read', [T('records/list', '0.3')]: 'read', [T('records/list', '0.4')]: 'read', [T('records/list', '0.5')]: 'read', [T('records/curate', '0.1')]: 'curate', [T('info', '0.1')]: 'read', [T('info', '0.2')]: 'read', [T('info', '0.3')]: 'read', [T('epoch/chain', '0.2')]: 'read', [T('epoch/commits', '0.1')]: 'read' }
const ACT_0_11 = { ...ACT_0_8, [T('records/put', '0.4')]: 'write', [T('records/put', '0.5')]: 'write', [T('records/list', '0.6')]: 'read', [T('records/get', '0.3')]: 'read' }
const ACT_TABLES = { 0.8: ACT_0_8, 0.9: { ...ACT_0_8, [T('records/put', '0.4')]: 'write' }, '0.10': { ...ACT_0_8, [T('records/put', '0.4')]: 'write' }, 0.11: ACT_0_11, 0.12: { ...ACT_0_11, [T('watch', '0.1')]: 'read' } }
const BODY_MEMBERS = ['roomId', 'key', 'version', 'author', 'title', 'description', 'body', 'tags', 'basis', 'confidence', 'evidence', 'validFor', 'validUntil', 'file', 'kind', 'inReplyTo', 'writtenAt', 'editedAt']
const GOVERNED = ['kind', 'inReplyTo', 'writtenAt', 'editedAt'] // accepted from rooms/keys/seal 0.3 only
const VTA_SERVES = { 'auth/challenge': ['0.1'], 'auth/authenticate': ['0.3'], 'auth/refresh': ['0.2'], 'rooms/keys/list': ['0.2'], 'rooms/keys/present': ['0.2'], 'rooms/keys/act': ['0.8', '0.9', '0.10', '0.11', '0.12'], 'rooms/keys/seal': ['0.2', '0.3'], 'rooms/keys/open': ['0.2'], 'rooms/keys/commit': ['0.1'], 'rooms/keys/backfill': ['0.2'] }
const HOST_SERVES = { 'rooms/info': ['0.3'], 'rooms/records/put': ['0.3', '0.4', '0.5'], 'rooms/records/get': ['0.2', '0.3'], 'rooms/records/list': ['0.5', '0.6'], 'rooms/epoch/commits': ['0.1'] }
const READS = ['rooms/info', 'rooms/records/get', 'rooms/records/list', 'rooms/epoch/commits']

/**
 * Start both services. Options: `vtaServes` / `hostServes` replace which versions of a family are served (an older
 * trust agent or host); `tokenMs` how long a sign-in lasts.
 */
export async function startFakeVti ({ vtaServes = {}, hostServes = {}, tokenMs = 15 * 60_000 } = {}) {
  const vtaId = newIdentity(), hostId = newIdentity()
  const serves = { vta: { ...VTA_SERVES, ...vtaServes }, host: { ...HOST_SERVES, ...hostServes } }
  const personas = new Map() // did -> identity: the DIDs the trust agent holds keys for
  const clients = new Map() // did -> { personas: Set, delegate }: who may sign in, and whom they may act as
  const sessions = new Map() // access token -> { did, until }
  const refresh = new Map() // refresh token -> did
  const challenges = new Map() // sessionId -> { challenge, subject }
  const vault = new Map() // `${room}|${persona}` -> { vmc, vac, actions }: the room's credentials for that member
  const groups = new Map() // `${room}|${persona}` -> { epoch, earliest, keys: Map(epoch -> key) }: what stands in for MLS state
  const rooms = new Map() // roomId -> what the HOST stores: { roomId, ownerDid, visibility, retentionPolicy, epoch, nextVersion, records, commits, links }
  const secrets = new Map() // roomId -> { id (the room's own key), keys: Map(epoch -> key) }: what the room's OWNER holds, never the host
  const accepted = new Map() // document id -> { digest, answer }: the host's duplicate record
  const received = { vta: [], host: [] } // every body each service was sent, as it arrived
  const seen = { vta: {}, host: {} } // counts by type
  const slow = { vta: [], host: [] } // retry-after values to answer the next requests with (HTTP 429)
  const hostDoc = (url) => ({ '@context': ['https://www.w3.org/ns/did/v1'], id: hostId.did, verificationMethod: [{ id: hostId.verificationMethod, type: 'Multikey', controller: hostId.did, publicKeyMultibase: hostId.did.slice('did:key:'.length) }], authentication: [hostId.verificationMethod], assertionMethod: [hostId.verificationMethod], service: [{ id: `${hostId.did}#rest`, type: 'TrustTaskHTTPS', serviceEndpoint: url }] })
  const fake = { vta: { did: vtaId.did }, host: { did: hostId.did, signs: false }, received, seen }
  const resolve = async (did) => (did === hostId.did ? hostDoc(fake.host.url) : resolveDidKey(did))
  fake.resolver = { resolve, keyFor: async (did, vm, purpose) => keyFromDidDocument(await resolve(did), did, vm, purpose) }
  const keyFor = fake.resolver.keyFor

  // ----- the trust agent -----
  const actsAs = (auth, roomId) => [...clients.get(auth.did).personas].filter((p) => vault.has(`${roomId}|${p}`))
  const memberFor = (auth, roomId, named) => {
    const held = [...clients.get(auth.did).personas].filter((p) => groups.has(`${roomId}|${p}`))
    if (named) return held.includes(named) ? named : no('taskFailed', `no group state for room \`${roomId}\` is held for a member you act as`, { reason: 'notFound' })
    if (held.length !== 1) no(held.length ? 'malformedRequest' : 'taskFailed', held.length ? 'you act as several members of that room: act from the context of the one you mean' : `this VTA holds no group state for room \`${roomId}\``, held.length ? undefined : { reason: 'notFound' })
    return held[0]
  }
  /** A presentation of `persona`'s authority for one action, its leaf granted to `to` for four hours (operations/room_oracle). */
  const present = (roomId, persona, to, action) => {
    const v = vault.get(`${roomId}|${persona}`)
    if (!v.actions.includes(action)) return null
    const leaf = credential(personas.get(persona), to, { authority: { scope: roomId, actions: [action] } }, 4 / 24)
    return { presentation: { membership: JSON.stringify(v.vmc), authority: [JSON.stringify(leaf), JSON.stringify(v.vac)] }, expiresAt: leaf.validUntil }
  }
  const notDelegate = (auth) => { if (clients.get(auth.did).delegate) no('permissionDenied', 'a delegate presents under its own identifier: use rooms/keys/present, and sign your own record bodies') }
  const vtaTasks = {
    'rooms/keys/list': (auth, p) => {
      only(p, ['includePersonal'], 'rooms/keys/list')
      const c = clients.get(auth.did), out = []
      if (!c.delegate) for (const [k, g] of groups) { const [roomId, member] = k.split('|'); if (c.personas.has(member)) out.push({ roomId, member, epoch: g.epoch, earliestReadableEpoch: g.earliest }) }
      return { rooms: out.sort((a, b) => a.roomId.localeCompare(b.roomId) || a.member.localeCompare(b.member)) }
    },
    'rooms/keys/present': (auth, p) => {
      only(p, ['roomId', 'action'], 'rooms/keys/present'); need(p, ['roomId', 'action'], 'rooms/keys/present')
      const who = actsAs(auth, p.roomId)
      if (who.length !== 1) no('permissionDenied', 'no credential issued by that room to a member you may act as')
      return present(p.roomId, who[0], auth.did, p.action) ?? no('rooms/keys/present:actionNotHeld', `the member's credentials do not confer \`${p.action}\``)
    },
    'rooms/keys/act': (auth, p, version) => {
      notDelegate(auth)
      only(p, ['document'], 'rooms/keys/act'); need(p, ['document'], 'rooms/keys/act')
      const d = p.document
      only(d, ['id', 'type', 'issuer', 'recipient', 'issuedAt', 'expiresAt', 'threadId', 'payload'], 'document'); need(d, ['id', 'type', 'recipient', 'issuedAt', 'payload'], 'document')
      if (!/^https:\/\/trusttasks\.org\/spec\/(rooms|vtc\/rooms\/(offers|memberships))\//.test(d.type) || !/^did:/.test(d.recipient)) no('malformedRequest', 'document: not a room request')
      const action = ACT_TABLES[version][d.type]
      if (!action) no('rooms/keys/act:typeNotActable', `\`${d.type}\` is not a room request this VTA completes as a member`, { type: d.type })
      const at = Date.parse(d.issuedAt)
      if (!(at >= Date.now() - 5 * 60_000 && at <= Date.now() + 2 * 60_000)) no('malformedRequest', `the document was issued at ${d.issuedAt}; a document is completed to be sent now`)
      if ('presentation' in d.payload) no('malformedRequest', 'the document already carries a presentation; the member\'s own is inserted here')
      const roomId = d.payload.roomId, who = actsAs(auth, roomId)
      const member = d.issuer ? (who.includes(d.issuer) ? d.issuer : no('rooms/keys/act:issuerNotPrincipal', `\`${d.issuer}\` is not a member of room \`${roomId}\` you may act as`, { issuer: d.issuer })) : who.length === 1 ? who[0] : no(who.length ? 'rooms/keys/act:principalAmbiguous' : 'rooms/keys/act:notAMember', who.length ? `you may act as ${who.length} members of room \`${roomId}\`; name the one you mean in the document's \`issuer\`` : `this VTA holds no credential issued by room \`${roomId}\` to a member you may act as`)
      const minted = present(roomId, member, member, action) ?? no('rooms/keys/act:actionNotHeld', `the member's credentials for room \`${roomId}\` do not confer \`${action}\``, { action })
      const id = personas.get(member)
      const document = sign({ ...d, issuer: member, payload: { ...d.payload, presentation: minted.presentation } }, { seed: id.seed, verificationMethod: id.verificationMethod, created: instant(), proofPurpose: 'authentication' })
      return { principal: member, document, expiresAt: minted.expiresAt }
    },
    'rooms/keys/seal': (auth, p, version) => {
      only(p, ['roomId', 'key', 'version', 'plaintext', 'signAsPrincipal'], 'rooms/keys/seal'); need(p, ['roomId', 'key', 'version', 'plaintext'], 'rooms/keys/seal')
      if (!/^[A-Za-z0-9_-]+$/.test(p.plaintext)) no('malformedRequest', 'plaintext is not base64url')
      let plain = unb64u(p.plaintext), member
      if (p.signAsPrincipal) {
        notDelegate(auth)
        let body
        try { body = JSON.parse(plain.toString('utf8')) } catch { no('rooms/keys/seal:bodyInvalid', 'the body is not JSON') }
        if (!body || typeof body !== 'object' || Array.isArray(body)) no('rooms/keys/seal:bodyInvalid', 'the body is not a JSON object')
        if ('proof' in body) no('rooms/keys/seal:bodyInvalid', 'the body already carries a proof; it is signed here')
        const unknown = Object.keys(body).find((k) => !BODY_MEMBERS.includes(k)) ?? (version === '0.2' ? GOVERNED.find((k) => k in body) : undefined)
        if (unknown) no('rooms/keys/seal:bodyInvalid', version === '0.2' && GOVERNED.includes(unknown) ? `the body carries \`${unknown}\`, which rooms/keys/seal/0.2 does not accept; send rooms/keys/seal/0.3` : `the body carries an unknown member \`${unknown}\``)
        for (const k of ['roomId', 'key', 'version', 'author']) if (!(k in body)) no('rooms/keys/seal:bodyInvalid', `the body lacks \`${k}\``)
        if (!Number.isInteger(body.version) || body.version < 1 || !String(body.author).startsWith('did:')) no('rooms/keys/seal:bodyInvalid', '`version` is an integer from 1 and `author` is a DID')
        if (body.basis !== undefined && !['declared', 'observed', 'verified', 'inferred'].includes(body.basis)) no('rooms/keys/seal:bodyInvalid', '`basis` is declared, observed, verified or inferred')
        if (body.tags !== undefined && (!Array.isArray(body.tags) || body.tags.length > 32 || body.tags.some((t) => typeof t !== 'string' || t.length > 64))) no('rooms/keys/seal:bodyInvalid', 'at most 32 tags of 64 characters each')
        if ((body.title ?? '').length > 512 || (body.body ?? '').length > 1_048_576) no('rooms/keys/seal:bodyInvalid', 'title or body is too long')
        member = body.author
        if (!clients.get(auth.did).personas.has(member)) no('rooms/keys/seal:authorNotPrincipal', `the body's author is not a member of room \`${p.roomId}\` you may act as`, { author: member })
        if (!groups.has(`${p.roomId}|${member}`)) no('rooms/keys/seal:notAMember', `this VTA holds no group state for room \`${p.roomId}\` for the body's author`)
        if (body.roomId !== p.roomId || body.key !== p.key || body.version !== p.version) no('rooms/keys/seal:locationMismatch', 'the body\'s roomId, key or version differs from the payload\'s; a body signed for one location and sealed for another opens nowhere')
        const id = personas.get(member)
        plain = Buffer.from(JSON.stringify(sign(body, { seed: id.seed, verificationMethod: id.verificationMethod, created: instant(), proofPurpose: 'assertionMethod' })))
      } else member = memberFor(auth, p.roomId, p.ext?.['org.openvtc.rooms']?.member)
      const g = groups.get(`${p.roomId}|${member}`)
      return { sealed: { ...seal(g.keys.get(g.epoch), recordAad(p.roomId, p.key, p.version, g.epoch), plain), epoch: g.epoch } }
    },
    'rooms/keys/open': (auth, p) => {
      only(p, ['roomId', 'key', 'version', 'sealed'], 'rooms/keys/open'); need(p, ['roomId', 'key', 'version', 'sealed'], 'rooms/keys/open'); only(p.sealed, ['ciphertext', 'nonce', 'epoch'], 'sealed')
      const g = groups.get(`${p.roomId}|${memberFor(auth, p.roomId, p.ext?.['org.openvtc.rooms']?.member)}`), e = p.sealed.epoch
      if (e > g.epoch) no('rooms/keys/open:unknownEpoch', `the record is sealed under epoch ${e}; this VTA holds epoch ${g.epoch}`, { reason: 'notDelivered', heldEpoch: g.epoch })
      if (!g.keys.has(e)) no('rooms/keys/open:unknownEpoch', `the record is sealed under epoch ${e}; the earliest this VTA can read is ${g.earliest}`, { reason: 'beyondChain', earliestEpoch: g.earliest })
      try { return { plaintext: b64u(open(g.keys.get(e), recordAad(p.roomId, p.key, p.version, e), p.sealed)) } } catch { no('rooms/keys/open:didNotOpen', 'the record did not open') }
    },
    'rooms/keys/commit': (auth, p) => {
      only(p, ['roomId', 'commit', 'epoch'], 'rooms/keys/commit'); need(p, ['roomId', 'commit', 'epoch'], 'rooms/keys/commit')
      const g = groups.get(`${p.roomId}|${memberFor(auth, p.roomId, p.ext?.['org.openvtc.rooms']?.member)}`), current = g.epoch - 1 // MLS counts from 0, a room from 1
      if (p.epoch === current) return { epoch: current } // already applied: a retry is not an error
      if (p.epoch !== current + 1) no('taskFailed', `commit produces epoch ${p.epoch} but room \`${p.roomId}\` is at ${current}; resume from ${current + 1}`, { reason: 'conflict' })
      let next
      try { next = open(g.keys.get(g.epoch), `fake-commit|${p.roomId}|${g.epoch + 1}`, JSON.parse(unb64u(p.commit).toString('utf8'))) } catch { no('malformedRequest', 'the commit did not process') }
      g.epoch += 1; g.keys.set(g.epoch, next)
      return { epoch: g.epoch - 1 }
    },
    'rooms/keys/backfill': (auth, p) => {
      only(p, ['roomId', 'host', 'fromEpoch', 'limit'], 'rooms/keys/backfill'); need(p, ['roomId', 'host'], 'rooms/keys/backfill')
      const who = actsAs(auth, p.roomId).filter((m) => groups.has(`${p.roomId}|${m}`))
      if (who.length !== 1) no('rooms/keys/backfill:notAMember', 'no group state for that room is held for a member you act as')
      const g = groups.get(`${p.roomId}|${who[0]}`), room = rooms.get(p.roomId)
      if (p.host !== hostId.did || !room) no('rooms/keys/backfill:hostUnreachable', 'the host could not be reached')
      let fetched = 0 // the real trust agent asks the host for these as the member (rooms/epoch/chain/0.2); here it reads them where the host keeps them
      for (let e = g.earliest; e >= 2 && room.links.has(e); e--) { g.keys.set(e - 1, open(g.keys.get(e), linkAad(p.roomId, e), room.links.get(e))); g.earliest = e - 1; fetched++ }
      return { roomId: p.roomId, earliestReadableEpoch: g.earliest, fetched, stored: fetched }
    },
  }
  const tokens = (did) => {
    for (const [t, s] of sessions) if (s.did === did) sessions.delete(t) // one session per DID: a new sign-in supersedes the last
    for (const [t, d] of refresh) if (d === did) refresh.delete(t)
    const accessToken = b64u(randomBytes(24)), refreshToken = b64u(randomBytes(24)), now = Date.now()
    sessions.set(accessToken, { did, until: now + tokenMs }); refresh.set(refreshToken, did)
    return { tokens: { accessToken, refreshToken }, session: { id: did, subject: did, acr: 'aal1', amr: ['did'], issuedAt: instant(now), expiresAt: instant(now + tokenMs) } }
  }
  async function vtaAnswer (doc, bearer, bytes) {
    const basic = checkTask(doc, { me: vtaId.did, bytes, maxBytes: 1_000_000 })
    if (!basic.ok) no(basic.code, basic.message)
    const t = parseType(doc.type)
    if (!t || t.response || !serves.vta[t.family]) no('unsupportedType', `\`${doc.type}\` is not served here`, { requestedType: doc.type })
    if (!serves.vta[t.family].includes(t.version)) no('unsupportedVersion', `\`${t.family}\` is served at ${serves.vta[t.family].join(', ')}`, { servedVersions: serves.vta[t.family] })
    const p = doc.payload
    if (t.family === 'auth/challenge') {
      only(p, ['subject', 'purpose'], 'auth/challenge')
      if (!clients.has(p.subject)) no('auth/challenge:subjectNotRecognized', 'that DID has no standing here')
      const sessionId = randomUUID(), challenge = b64u(randomBytes(32))
      challenges.set(sessionId, { challenge, subject: p.subject })
      return { challenge, sessionId, expiresAt: instant(Date.now() + 300_000) }
    }
    if (t.family === 'auth/refresh') { // unsigned by design: the token is the credential
      only(p, ['refreshToken', 'scope'], 'auth/refresh'); need(p, ['refreshToken'], 'auth/refresh')
      const did = refresh.get(p.refreshToken)
      return did ? tokens(did) : no('permissionDenied', 'that refresh token is not known', undefined, 403)
    }
    if (t.family !== 'auth/authenticate') {
      const s = sessions.get(bearer)
      if (!s || s.until <= Date.now()) no('unauthorized', s ? 'token expired' : bearer ? 'token superseded' : 'this task needs a session: authenticate, or send a public task', undefined, 401)
      if (s.did !== doc.issuer) no('identityMismatch', 'the document\'s issuer is not the session\'s')
    }
    const v = await verifyTask(doc, { keyFor, me: vtaId.did, bytes, maxBytes: 1_000_000, purposes: ['authentication'] })
    if (!v.ok) no(v.code, v.message)
    if (t.family === 'auth/authenticate') {
      only(p, ['challenge', 'sessionId', 'scope', 'principal', 'delegationEvidence', 'sessionKey'], 'auth/authenticate'); need(p, ['challenge', 'sessionId'], 'auth/authenticate')
      const c = challenges.get(p.sessionId); challenges.delete(p.sessionId) // single use
      if (!c) no('auth/authenticate:challengeNotFound', 'no such challenge')
      if (c.challenge !== p.challenge) no('auth/authenticate:challengeMismatch', 'that is not the challenge this session was given')
      if (c.subject !== doc.issuer) no('auth/authenticate:subjectMismatch', 'the challenge was given to another DID')
      return tokens(doc.issuer)
    }
    return vtaTasks[t.family]({ did: doc.issuer }, p, t.version)
  }

  // ----- the room host -----
  /** The presenter is the document's signer; the chain must be the room's, reach the signer, and confer the action. One refusal for every way it can fail. */
  const authorize = (room, presentation, action, presenter) => {
    const denied = () => no('permissionDenied', 'the presented credentials do not authorise this')
    try {
      only(presentation, ['membership', 'authority', 'subjectBinding'], 'presentation')
      const chain = presentation.authority.map((c) => JSON.parse(c)), vmc = JSON.parse(presentation.membership)
      if (!chain.length || chain.length > 8) denied()
      const root = chain.at(-1)
      if (!credentialHolds(root, room.roomId) || !credentialHolds(vmc, room.roomId) || vmc.credentialSubject.id !== root.credentialSubject.id) denied()
      let subject = root.credentialSubject.id, actions = root.credentialSubject.authority.actions
      for (const link of chain.slice(0, -1).reverse()) { // each link is issued by the one above it and never widens it
        if (!credentialHolds(link, subject) || link.credentialSubject.authority.actions.some((a) => !actions.includes(a))) denied()
        subject = link.credentialSubject.id; actions = link.credentialSubject.authority.actions
      }
      if (subject !== presenter || !actions.includes(action)) denied()
      return { subject, member: root.credentialSubject.id }
    } catch (e) { if (e instanceof Refuse) throw e; denied() }
  }
  const meta = (r, v3) => ({ key: r.key, version: r.version, status: r.status, updatedAt: r.updatedAt, epoch: r.epoch, author: r.author, ...(v3 ? { createdAt: r.createdAt, createdBy: r.createdBy, bodyStoredAt: r.bodyStoredAt } : {}) })
  const head = (room) => ({ headVersion: Math.max(0, ...[...room.records.values()].map((r) => r.version)), recordCount: room.records.size })
  const hostTasks = {
    'rooms/info': (room) => ({ roomId: room.roomId, visibility: room.visibility, epoch: room.epoch, retentionPolicy: room.retentionPolicy, limits: { filesEnabled: false }, usage: { room: { bytes: 0, files: 0, reservedBytes: 0 } } }),
    'rooms/records/put': (room, p, who) => {
      if (room.visibility === 'open' ? !p.cleartext : !p.sealed || p.cleartext) no('malformedRequest', room.visibility === 'open' ? 'an open room requires `cleartext`' : 'a sealed room requires `sealed` content')
      if (p.sealed) { only(p.sealed, ['ciphertext', 'nonce', 'epoch', 'version'], 'sealed'); if (p.sealed.epoch !== room.epoch) no('rooms/records/put:epochMismatch', `record is sealed under epoch ${p.sealed.epoch}, room \`${room.roomId}\` is at ${room.epoch}`) }
      const current = room.records.get(p.key), n = p.expectedVersion
      if (n !== undefined) {
        if (current && n === 0) no('taskFailed', `record \`${p.key}\` already exists (create-only requested)`)
        if (current && current.version !== n) no('taskFailed', `record \`${p.key}\` is at version ${current.version}, not ${n}`)
        if (!current && n !== 0) no('taskFailed', `record \`${p.key}\` does not exist, so it cannot be at version ${n}`)
      }
      const now = instant(), version = room.nextVersion++
      room.records.set(p.key, { key: p.key, version, epoch: p.sealed?.epoch, status: 'active', sealed: p.sealed ? { ciphertext: p.sealed.ciphertext, nonce: p.sealed.nonce } : undefined, cleartext: p.cleartext, sealedVersion: p.sealed ? version : undefined, author: who.subject, updatedAt: now, createdAt: current?.createdAt ?? now, createdBy: current?.createdBy ?? who.subject, bodyStoredAt: now })
      return { key: p.key, version, ...(p.sealed ? { epoch: p.sealed.epoch } : {}) }
    },
    'rooms/records/get': (room, p, who, version) => {
      const r = room.records.get(p.key) ?? no('taskFailed', `record \`${p.key}\` not found in room \`${room.roomId}\``)
      return { ...meta(r, version === '0.3'), ...(r.sealed ? { sealed: { ...r.sealed, epoch: r.epoch, version: r.sealedVersion } } : { cleartext: r.cleartext }), ...head(room) }
    },
    'rooms/records/list': (room, p, who, version) => {
      const floor = Math.max(p.sinceVersion ?? 0, p.cursor === undefined ? 0 : (/^v(\d+)$/.test(p.cursor) ? Number(p.cursor.slice(1)) : no('malformedRequest', `\`${p.cursor}\` is not a cursor this host issued`)))
      const all = [...room.records.values()].filter((r) => r.version > floor && (!p.prefix || r.key.startsWith(p.prefix))).sort((a, b) => a.version - b.version)
      const page = all.slice(0, Math.min(Math.max(p.limit ?? 500, 1), 500))
      return { records: page.map((r) => meta(r, version === '0.6')), ...(all.length > page.length ? { nextCursor: `v${page.at(-1).version}` } : {}), ...head(room) }
    },
    'rooms/epoch/commits': (room, p) => ({ roomId: room.roomId, commits: [...room.commits].filter(([e]) => e > p.sinceEpoch).sort((a, b) => a[0] - b[0]).slice(0, Math.min(p.limit ?? 100, 100)).map(([epoch, commit]) => ({ epoch, commit })), roomEpoch: room.epoch }),
  }
  const HOST_MEMBERS = { 'rooms/info': [[], ['roomId', 'presentation']], 'rooms/records/put': [['key', 'expectedVersion', 'sealed', 'cleartext', 'blobs'], ['roomId', 'key', 'presentation']], 'rooms/records/get': [['key'], ['roomId', 'key', 'presentation']], 'rooms/records/list': [['prefix', 'sinceVersion', 'cursor', 'limit'], ['roomId', 'presentation']], 'rooms/epoch/commits': [['sinceEpoch', 'limit'], ['roomId', 'presentation', 'sinceEpoch']] }
  async function hostAnswer (doc, bytes) {
    const basic = checkTask(doc, { me: hostId.did, bytes })
    if (!basic.ok) no(basic.code, basic.message)
    const t = parseType(doc.type)
    if (!t || t.response || !serves.host[t.family]?.includes(t.version)) no('unsupportedType', `\`${doc.type}\` is not served here`, { requestedType: doc.type })
    const p = doc.payload, [may, must] = HOST_MEMBERS[t.family]
    only(p, ['roomId', 'presentation', ...may], t.family); need(p, must, t.family)
    const room = rooms.get(p.roomId) ?? no('taskFailed', `room \`${p.roomId}\` not found`)
    const v = await verifyTask(doc, { keyFor: async (did, vm, purpose) => keyFromDidDocument(resolveDidKey(did), did, vm, purpose), me: hostId.did, bytes }) // did:key only, as a host started without --resolve-dids
    if (!v.ok) no('permissionDenied', `request proof: ${v.message}`)
    const who = authorize(room, p.presentation, READS.includes(t.family) ? 'read' : 'write', v.signer)
    return hostTasks[t.family](room, p, who, t.version)
  }

  // ----- the two doors -----
  const door = (which, issuer, answer) => http.createServer(async (req, res) => {
    const send = (status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(body === null ? '' : JSON.stringify(body)) }
    if (req.method === 'GET' && req.url === '/health') return send(200, which === 'host' ? 'ok' : { status: 'ok' })
    if (req.method !== 'POST' || req.url !== '/trust-tasks') return send(404, { error: 'not found' })
    const chunks = []; for await (const c of req) chunks.push(c)
    const raw = Buffer.concat(chunks).toString('utf8'); received[which].push(raw)
    if (slow[which].length) return send(429, null, { 'retry-after': String(slow[which].shift()) })
    let doc
    try { doc = JSON.parse(raw); if (!doc || typeof doc !== 'object' || typeof doc.type !== 'string') throw new Error('no type') } catch (e) { return send(400, { error: `body is not a Trust Task document: ${e.message}` }) }
    seen[which][doc.type] = (seen[which][doc.type] ?? 0) + 1
    const family = parseType(doc.type)?.family, dup = which === 'host' ? accepted.get(doc.id) : null
    if (dup) return dup.digest !== digest(doc) ? send(409, refusalTo(doc, { code: 'idConflict', message: 'another document already used that id' }, issuer.did)) : dup.answer ? send(200, dup.answer) : send(204, null)
    try {
      const payload = await answer(doc, (req.headers.authorization ?? '').replace(/^Bearer /, ''), Buffer.byteLength(raw))
      let reply = responseTo(doc, payload, issuer.did)
      if (which === 'vta' || fake.host.signs) reply = signTask(reply, issuer) // a host with a DID of its own signs what it answers; one reached only by address does not
      if (which === 'host') accepted.set(doc.id, { digest: digest(doc), answer: READS.includes(family) ? null : reply })
      send(200, reply)
    } catch (e) {
      if (!(e instanceof Refuse)) return send(500, refusalTo(doc, { code: 'internalError', message: e.message }, issuer.did))
      send(e.status ?? statusFor(e.code), e.code === 'unauthorized' ? { error: e.message } : refusalTo(doc, { code: e.code, message: e.message, details: e.details }, issuer.did)) // the 401 body's exact shape was not read; a client goes by the status
    }
  })
  const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)))
  const servers = [door('vta', vtaId, vtaAnswer), door('host', hostId, hostAnswer)]
  fake.vta.url = await listen(servers[0]); fake.host.url = await listen(servers[1])
  fake.close = () => Promise.all(servers.map((s) => new Promise((resolve) => { s.closeAllConnections?.(); s.close(resolve) })))

  // ----- what the room's owner does, outside this wire (pnm rooms owner register / issue-membership / issue-authority --store / group-create / group-add / group-renew) -----
  /** A DID the trust agent holds keys for: the person's member of a room. */
  fake.persona = () => { const id = newIdentity(); personas.set(id.did, id); return id.did }
  /** A credential for an app (the starter kit's VTA_CREDENTIAL), allowed to act as these personas; `delegate`: registered as an AI agent, not the person's own client. */
  fake.credential = (acts, { delegate = false, withUrl = true } = {}) => {
    const id = newIdentity(); clients.set(id.did, { personas: new Set(acts), delegate })
    return b64u(JSON.stringify({ did: id.did, privateKeyMultibase: multibase(new Uint8Array([0x80, 0x26, ...id.seed])), vtaDid: vtaId.did, ...(withUrl ? { vtaUrl: fake.vta.url } : {}) }))
  }
  const grant = (roomId, persona, actions) => { const room = secrets.get(roomId).id; vault.set(`${roomId}|${persona}`, { actions, vmc: credential(room, persona, {}), vac: credential(room, persona, { authority: { scope: roomId, actions } }) }) }
  /** Register a sealed room at the host, owned by `owner`, at epoch 1. */
  fake.room = (owner, { visibility = 'attributed', retentionPolicy = 'chained' } = {}) => {
    const id = newIdentity(), key = randomBytes(32)
    secrets.set(id.did, { id, keys: new Map([[1, key]]) })
    rooms.set(id.did, { roomId: id.did, ownerDid: owner, visibility, retentionPolicy, epoch: 1, nextVersion: 1, records: new Map(), commits: new Map(), links: new Map() })
    groups.set(`${id.did}|${owner}`, { epoch: 1, earliest: 1, keys: new Map([[1, key]]) }); grant(id.did, owner, ['read', 'write', 'curate', 'admin'])
    return id.did
  }
  /** The owner moves the room to its next epoch (a renewal, or adding a member): the host gets the commit and, in a room that keeps its chain, the link. Other members are now one commit behind. */
  fake.advance = (roomId) => {
    const room = rooms.get(roomId), s = secrets.get(roomId), next = randomBytes(32), before = s.keys.get(room.epoch), epoch = room.epoch + 1
    room.commits.set(epoch, b64u(JSON.stringify(seal(before, `fake-commit|${roomId}|${epoch}`, next))))
    if (room.retentionPolicy === 'chained') room.links.set(epoch, { epoch, ...seal(next, linkAad(roomId, epoch), before) })
    s.keys.set(epoch, next); room.epoch = epoch
    const mine = groups.get(`${roomId}|${room.ownerDid}`); mine.epoch = epoch; mine.keys.set(epoch, next)
    return epoch
  }
  /** Add a member: the room moves on one epoch and the new member holds keys from there (as a Welcome gives), with the room's credentials in the trust agent's vault. */
  fake.admit = (roomId, persona, actions = ['read', 'write']) => {
    const epoch = fake.advance(roomId)
    groups.set(`${roomId}|${persona}`, { epoch, earliest: epoch, keys: new Map([[epoch, secrets.get(roomId).keys.get(epoch)]]) }); grant(roomId, persona, actions)
    return epoch
  }
  /** Answer the next requests at one door with "slow down" and these retry-after values (seconds). */
  fake.slowDown = (which, ...seconds) => slow[which].push(...seconds)
  /** Every session ends now (a token that ran out). */
  fake.expireSessions = () => { for (const s of sessions.values()) s.until = 0 }
  /** Everything the host holds or was ever sent, as one string: what a person who runs the host could read. */
  fake.hostDump = () => JSON.stringify({ rooms: [...rooms.values()].map((r) => ({ ...r, records: [...r.records.values()], commits: [...r.commits], links: [...r.links] })), accepted: [...accepted], received: received.host })
  /** One record as the host stores it (for a test that tampers with what the host serves). */
  fake.stored = (roomId, key) => rooms.get(roomId)?.records.get(key)
  fake.epochOf = (roomId, persona) => groups.get(`${roomId}|${persona}`)?.epoch
  return fake
}
