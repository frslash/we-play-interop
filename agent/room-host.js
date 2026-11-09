// A sealed room's host (OpenVTC's room-host, or a community's VTC serving the same tasks), as the agent bridge
// reaches it. The host keeps ciphertext only. Every request is one Trust Task document, written here unsigned, completed
// and signed as the person's own member of that room by their trust agent (rooms/keys/act), then posted to the
// host's door. The host learns who the member is from that proof and what they may do from the credentials the
// trust agent put in; it has no accounts, no sessions and no keys.
//
// Read from OpenVTC at the commit the room builds from (c6964c4):
//   the door        room-host/src/lib.rs (one route, POST /trust-tasks; a duplicate id answers 200, 202 or 204)
//   what is served  room-host/src/lib.rs route(): info 0.3, records/put 0.3 0.4 0.5, records/get 0.2 0.3,
//                   records/list 0.5 0.6, epoch/commits 0.1
//   the members     vti-specs-rooms/trust-tasks/rooms/{info,records/put,records/list,records/get,epoch/commits}/*.bundle.json
//   a lost write    vti-rooms/src/storage.rs put_record: a version that does not match is answered taskFailed, in words
//   the reference   vta-cli-common/src/commands/rooms.rs (pnm rooms: what it sends for each step)
// Versions sent: info 0.3, put 0.5, list 0.6, get 0.3, commits 0.1. A trust agent or host that predates those gets
// put 0.3, list 0.5, get 0.2 (what the openvti starter kit sends); for a sealed record the two carry the same members.
import { keyFromDidDocument } from '../src/shared/chain.js'
import { verifySignature } from '../src/shared/proof.js'
import { serviceEndpoint, signerOf, taskDocument, typeUri } from '../src/shared/trusttask.js'
import { createResolver, publicFetch } from '../src/server/resolver.js'
import { VtiError, sendTask, unwrap } from './vta.js'

const NEWER = { info: '0.3', put: '0.5', list: '0.6', get: '0.3', commits: '0.1' }
const OLDER = { ...NEWER, put: '0.3', list: '0.5', get: '0.2' }
const FAMILY = { info: 'rooms/info', put: 'rooms/records/put', list: 'rooms/records/list', get: 'rooms/records/get', commits: 'rooms/epoch/commits' }
export const LIST_PAGE = 500 // the most one page of a listing holds (rooms/records/list: limit 1..500)
// What this protects: a listing that never ends (a host that keeps handing out cursors) must not hold an agent forever.
const MAX_PAGES = 64

/** True when a write lost to another: the declared code, or the words the pinned host answers with (it sends taskFailed). */
export const isVersionConflict = (e) => e instanceof VtiError && (/(^|:)versionConflict$/.test(e.code) || (e.code === 'taskFailed' && (e.details?.reason === 'conflict' || /already exists|is at version \d+, not \d+|cannot be at version/.test(e.message))))
export const isEpochMismatch = (e) => e instanceof VtiError && /(^|:)epochMismatch$/.test(e.code)
export const isNotFound = (e) => e instanceof VtiError && (/(^|:)notFound$/.test(e.code) || (e.code === 'taskFailed' && /not found|does not exist|no record/i.test(e.message)))

export class RoomHost {
  /**
   * `vta`: the person's trust agent (agent/vta.js). `hostDid`: the host's DID, which every document is addressed to.
   * `url`: the host's door when the person names it themselves; without it the door is read from the host DID's
   * document (its TrustTaskHTTPS service, or VTCRest for a community's VTC) and reached only over public https.
   * `member`: the member to act as, when the credential may act as several in one room.
   */
  constructor ({ vta, hostDid, url, member, resolver = createResolver(), fetch: f, sleep } = {}) {
    if (!vta || !/^did:/.test(String(hostDid ?? ''))) throw new Error('a room host needs the trust agent and the host\'s DID')
    this.vta = vta; this.hostDid = hostDid; this.member = member; this.resolver = resolver; this.sleep = sleep
    this.url = url ? String(url).replace(/\/+$/, '') : null
    this.fetch = f ?? (this.url ? globalThis.fetch : publicFetch) // an address from someone else's DID document is only ever reached as a public https host
    this.gen = NEWER
    this.counts = { calls: 0, refused: 0, slowDowns: 0, signedAnswers: 0, uncheckedAnswers: 0 }
    this.last = null
  }

  /** The address documents are posted under: `<door>/trust-tasks`. */
  async door () {
    if (this.url) return this.url
    let doc
    try { doc = await this.resolver.resolve(this.hostDid) } catch (e) { throw new VtiError('unavailable', `the host's DID could not be read (${e.message}); name its address with NOTEBOOK_HOST_URL`, { from: 'the room host' }) }
    const at = serviceEndpoint(doc, 'TrustTaskHTTPS') ?? serviceEndpoint(doc, 'VTCRest')
    if (!at) throw new VtiError('unavailable', 'the host\'s DID lists no https door (a TrustTaskHTTPS service); name its address with NOTEBOOK_HOST_URL', { from: 'the room host' })
    return (this.url = at.replace(/\/+$/, ''))
  }

  async #once (name, payload) {
    const type = typeUri(FAMILY[name], this.gen[name])
    const unsigned = taskDocument({ type, recipient: this.hostDid, payload, ...(this.member ? { issuer: this.member } : {}) })
    const { document: doc, principal } = await this.vta.act(unsigned)
    // What comes back is what was asked for, completed: never forward a different request than the one written here.
    if (doc.id !== unsigned.id || doc.type !== type || doc.recipient !== this.hostDid || doc.payload?.roomId !== payload.roomId || !doc.proof) throw new VtiError('indeterminate', 'the trust agent handed back a different request than the one it was given', { from: 'the trust agent' })
    this.counts.calls++
    const r = await sendTask(await this.door(), doc, { fetch: this.fetch, counts: this.counts, ...(this.sleep ? { sleep: this.sleep } : {}) })
    // A host with a DID of its own signs what it answers; one reached only by address answers unsigned. A signature that is there must hold.
    if (r.reply?.proof) {
      const bad = () => { throw new VtiError('proofInvalid', 'the answer is signed, but not by the host it was sent to', { from: 'the room host' }) }
      if (signerOf(r.reply) !== this.hostDid) bad()
      let hostDoc = null
      try { hostDoc = await this.resolver.resolve(this.hostDid) } catch {} // a host DID this machine cannot read (did:peer:2): its signature goes unchecked, and that is counted
      if (!hostDoc) this.counts.uncheckedAnswers++
      else {
        let key = null
        try { key = keyFromDidDocument(hostDoc, this.hostDid, r.reply.proof.verificationMethod, r.reply.proof.proofPurpose) } catch {}
        if (!key || !verifySignature(r.reply, key).ok) bad()
        this.counts.signedAnswers++
      }
    }
    if (r.kind === 'done-no-body') throw new VtiError('indeterminate', 'the host had already answered this request and keeps no copy of a read; ask again', { from: 'the room host', status: r.status })
    this.member ??= principal
    return unwrap(r, 'the room host')
  }

  /** One request to the host, as the member. An older trust agent or host is asked again in the versions it serves. */
  async send (name, payload) {
    try {
      let out
      try { out = await this.#once(name, payload) } catch (e) {
        if (this.gen !== NEWER || !['rooms/keys/act:typeNotActable', 'unsupportedType', 'unsupportedVersion'].includes(e.code)) throw e
        this.gen = OLDER; out = await this.#once(name, payload)
      }
      this.last = { ok: true, task: name, at: Date.now() }
      return out
    } catch (e) { this.counts.refused++; this.last = { ok: false, task: name, code: e.code ?? 'network', at: Date.now() }; throw e }
  }

  /** { roomId, visibility: open | attributed | private, epoch, … } */
  info (roomId) { return this.send('info', { roomId }) }

  /** Write one sealed record. expectedVersion 0: only if the key is new; n: only over version n. Answers { key, version, epoch? }. */
  put (roomId, { key, sealed, expectedVersion }) {
    return this.send('put', { roomId, key, sealed: { ciphertext: sealed.ciphertext, nonce: sealed.nonce, epoch: sealed.epoch }, ...(expectedVersion !== undefined ? { expectedVersion } : {}) })
  }

  /** One page of the room's records, oldest version first: what there is, never what it says. */
  async listPage (roomId, { prefix, sinceVersion, cursor, limit = LIST_PAGE } = {}) {
    const r = await this.send('list', { roomId, ...(prefix ? { prefix } : {}), ...(sinceVersion ? { sinceVersion } : {}), ...(cursor ? { cursor } : {}), limit: Math.min(Math.max(1, limit), LIST_PAGE) })
    const next = r.nextCursor ?? r.cursor
    return { records: Array.isArray(r.records) ? r.records.filter((x) => typeof x?.key === 'string' && Number.isInteger(x?.version)) : [], ...(typeof next === 'string' && next ? { nextCursor: next } : {}), ...(Number.isInteger(r.headVersion) ? { headVersion: r.headVersion } : {}), ...(Number.isInteger(r.recordCount) ? { recordCount: r.recordCount } : {}) }
  }

  /** Every record above `sinceVersion` whose key starts with `prefix`, following the cursor to its end (its absence is the only end). */
  async list (roomId, opts = {}) {
    const records = []; let cursor, headVersion
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await this.listPage(roomId, { ...opts, cursor })
      records.push(...r.records)
      if (r.headVersion !== undefined) headVersion = Math.max(headVersion ?? 0, r.headVersion)
      if (!r.nextCursor || r.nextCursor === cursor) return { records, headVersion, complete: true }
      cursor = r.nextCursor
    }
    return { records, headVersion, complete: false }
  }

  /** One record with its sealed body: { key, version, status?, author?, updatedAt?, sealed: { ciphertext, nonce, epoch, version? } }. */
  async get (roomId, key) { const r = await this.send('get', { roomId, key }); return r.record ?? r }

  /** The commits that moved the room past `sinceEpoch`, in order, and the epoch the room is at. */
  async commits (roomId, sinceEpoch) {
    const r = await this.send('commits', { roomId, sinceEpoch })
    return { commits: (Array.isArray(r.commits) ? r.commits : []).filter((c) => typeof c?.commit === 'string' && Number.isInteger(c?.epoch)), ...(Number.isInteger(r.roomEpoch) ? { roomEpoch: r.roomEpoch } : {}) }
  }
}
