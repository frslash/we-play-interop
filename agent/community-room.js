// Entering a community's encrypted room through the person's own trust agent. The community owns and hosts the room;
// its own trust agent holds the owner's keys. The person's trust agent holds the member's half. This file only CARRIES
// three things between the two: the offer (with its credentials), a KeyPackage (minted by the person's trust agent,
// its private half never leaves it) and a Welcome (built by the community's trust agent, opened only by the person's).
// There is no MLS here and no key: every step that touches a key is a task the person's trust agent runs.
//
// Read from OpenVTC at the commit the room builds from (c6964c4):
//   offers        vti-specs-vtc/trust-tasks/vtc/rooms/offers/list/0.4.bundle.json (the one version served:
//                 vtc-service/src/trust_tasks/mod.rs, OFFERS_LIST_TYPE), offers/accept/0.1.bundle.json (its errors)
//   the strings   a credential inside an offer is what rooms/owner/{invite,issue-membership,issue-authority} return:
//                 serde_json::to_string of the signed credential, so JSON text (vta-service/src/operations/room_issuance.rs
//                 sign_as_room, `serialised`; vtc-service/src/trust_tasks/community_room_tasks.rs issue_offer). The
//                 trust agent also reads a base64url invitation (operations/room_invitation.rs decode), so a string
//                 that is not JSON is decoded here before it is stored, and the invitation is always handed back to the
//                 trust agent exactly as the community sent it.
//   the steps     vta-service/src/trust_tasks/room_group.rs: handle_key_package_v0_2 (the same KeyPackage again while
//                 it is outstanding, which is how an acceptance begun elsewhere is finished), handle_welcome
//   as the member offers/list and offers/accept are completed by the trust agent with rooms/keys/act, issuer set to
//                 the member (agent/vta.js actAsMember); the community's own door serves rooms/* too
//                 (vtc-service/src/trust_tasks/mod.rs `crate::rooms::handlers::serves`), so agent/room-host.js reaches
//                 it through the community's VTCRest service
// Talking (read, say, drafts), read from OpenVTC at c6964c4 as well:
//   the body     vtc-client/src/rooms/body.rs SealedRecordBody (roomId, key, version, author; title, body, tags, basis, kind, inReplyTo,
//                writtenAt; "Untrusted text from another member: render it inert"), signed by its author and sealed by the trust agent
//                (rooms/keys/seal with signAsPrincipal, as agent/vti-notebook.js #write does)
//   the profile  vti-specs-rooms/trust-tasks/rooms/keys/profile/read/0.1.bundle.json (request { roomId, host }; answer { roomId, status:
//                found|absent|cleared, profile?: { name, recordMembers? }, author?, version?, epoch? }; served by the trust agent,
//                vta-service/src/trust_tasks/mod.rs TASK_ROOMS_KEYS_PROFILE_READ_0_1). A writer uses `kind`, `inReplyTo` and `writtenAt`
//                only when the profile's `recordMembers` lists them (rooms/records/put/0.5 RoomProfile.recordMembers)
//   the refusal  rooms/keys/act:actionNotHeld, `details.action` (rooms/keys/act/0.12 errorCodes); a member's actions are read, write, curate
//                (vtc/rooms/offers/list/0.4 MemberAction)
// The room epoch is the MLS epoch plus one; the trust agent takes MLS epochs, the host numbers rooms (agent/vta.js commit()).
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { keyFromDidDocument } from '../src/shared/chain.js'
import { verifySignature } from '../src/shared/proof.js'
import { signerOf, taskDocument, typeUri } from '../src/shared/trusttask.js'
import { createResolver } from '../src/server/resolver.js'
import { VtiError, Vta, readCredential, sendTask, unwrap } from './vta.js'
import { RoomHost, isEpochMismatch, isVersionConflict } from './room-host.js'
import { MAX_NOTE_CHARS, NOTE_TAG, READ_CHARS, inWords } from './vti-notebook.js'

export const OFFERS_LIST = '0.4' // the only version a community serves (vtc-service/src/trust_tasks/mod.rs)
const PAGE = 100 // offers/list limit: 1..100
// What these limits protect. MAX_PAGES: a community that keeps handing out cursors must not hold the agent for ever (100
// offers a page: far more rooms than one person is offered). ADMISSION_TRIES: "admissionPending" means the community's trust
// agent has not answered yet and the identical request is to be retried; the agent is waiting on a person, so it asks a few
// times, a few seconds apart, then says so. MAX_COMMIT_PAGES: a host that keeps answering with commits that move nothing.
const MAX_PAGES = 64
const ADMISSION_TRIES = 4
const ADMISSION_WAIT_MS = 3000
const MAX_COMMIT_PAGES = 32
const VISIBILITIES = ['open', 'attributed', 'private']
const STAGES = ['stored', 'accepted', 'joined'] // in order; a stage is a step finished, so a retry skips what is done
const is = (re, code) => typeof code === 'string' && re.test(code)
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const b64u = (bytes) => Buffer.from(bytes).toString('base64url')
const tagOf = (tags, p) => tags.find((t) => typeof t === 'string' && t.startsWith(p))?.slice(p.length)
export const TALK_TAG = 'inwove-talk' // marks a message of this bridge's, so a room whose profile lists no `kind` can still tell talk from notes
export const MAX_TALK_CHARS = MAX_NOTE_CHARS // the room's own rule for a note (agent/vti-notebook.js): one thing said, not a document
// What these limits protect. MAX_SHOWN_CHARS: the agent's context, from one huge message (a body may be a megabyte); READ_CHARS (the
// notebook's own bound, 60 000) caps all of one read for the same reason. MAX_DRAFTS: the person's own review: an agent that loops must not
// bury what it wants to say under hundreds of drafts, nor grow the state file without end. WRITE_ATTEMPTS: as the notebook's (pnm's
// SEALED_WRITE_ATTEMPTS): each try loses only to a write that landed between the seal and the put.
const MAX_SHOWN_CHARS = 4000
const MAX_DRAFTS = 20
const WRITE_ATTEMPTS = 4
const BAD_SIGNATURE = ['not-signed-by-its-author', 'signed-for-another-place'] // counted as badSignatures: a body that claims what it cannot show
class Unreadable extends Error { constructor (why) { super(why); this.why = why } }

/** A credential string as the trust agent's vault takes it: JSON text as is; base64url of JSON decoded; anything else (a compact SD-JWT) untouched. */
export function asCredential (s) {
  const t = String(s).trim()
  if (t.startsWith('{')) return t
  if (/^[A-Za-z0-9_-]+$/.test(t)) { const d = Buffer.from(t, 'base64url').toString('utf8'); if (d.trimStart().startsWith('{')) return d }
  return String(s)
}

/** A refusal in words a person can act on: the community's own codes first, then the trust agent's (inWords). */
export function communityWords (e) {
  const code = e?.code, tail = code ? ` (${code})` : ''
  if (e instanceof VtiError && is(/^vtc\/rooms\/offers\/(list|accept):/, code)) {
    const w = {
      notAMember: 'the community does not list this person as a member, so it has no room to offer them. A community administrator admits them first',
      notFound: 'the community has no open offer of that room for this person',
      offerExpired: 'the offer has run out. A community administrator offers the room again',
      keyPackageRequired: 'the room is sealed and the community wanted a KeyPackage with the acceptance',
      keyPackageNotExpected: 'the room is open, which has no group, so a KeyPackage was not wanted',
      keyPackageInvalid: 'the community did not accept the KeyPackage the person\'s trust agent made',
      alreadyAccepted: 'the community already admitted this person with a different KeyPackage, or too long ago to keep the Welcome. A community administrator removes and admits them again',
      admissionPending: 'the community\'s own trust agent had not finished admitting the person. Try again in a minute',
      keyHolderRefused: 'the community\'s own trust agent refused to admit the person'
    }[code.split(':')[1]]
    if (w) return `${w}${tail}`
  }
  return inWords(e)
}

export class CommunityRoom {
  /**
   * `vta`: the person's trust agent (agent/vta.js). `communityDid`: the community's DID (every document is addressed to
   * it; it is the host of its rooms). `member`: the DID the community addressed its offers to (the person's member).
   * `resolver`/`fetch`/`url`: as for agent/room-host.js (the community's door is read from its DID's VTCRest service).
   * `statePath`: where the stage of each room is kept (default ~/.config/we-play-interop/community-room.json, mode 0600).
   */
  constructor ({ vta, communityDid, member, resolver = createResolver(), fetch: f, url, statePath, host, keyFor, agentMaySay = false, now = () => Date.now(), sleep = pause } = {}) {
    if (!vta || !/^did:/.test(String(communityDid ?? '')) || !/^did:/.test(String(member ?? ''))) throw new Error('entering a community\'s room needs the person\'s trust agent, the community\'s DID and the member\'s DID')
    Object.assign(this, { vta, communityDid, member, resolver, now, sleep, agentMaySay: Boolean(agentMaySay) })
    this.keyFor = keyFor ?? ((did, vm, purpose) => resolver.keyFor(did, vm, purpose)) // finds an author's key to check a body's signature
    this.profiles = new Map() // roomId -> { epoch, listed: [member names] }: a profile resolved within the room's current epoch may be relied on
    this.host = host ?? new RoomHost({ vta, hostDid: communityDid, member, resolver, ...(url ? { url } : {}), ...(f ? { fetch: f } : {}), sleep })
    this.statePath = statePath ?? join(homedir(), '.config/we-play-interop/community-room.json')
    this.renewals = [] // renewals of admissions already held, as the last offers() read them (no credential strings): reported, never acted on
    this.counts = { offersRead: 0, renewalsSeen: 0, ignored: 0, accepted: 0, welcomes: 0, commitsApplied: 0, refusedBy: {}, read: 0, said: 0, drafted: 0, badSignatures: 0, unreadable: {}, profileUnread: 0 } // counts and codes only, never a credential or a word said
    this.last = null // { ok, task, code?, at }
  }

  // ----- what a person reads: the rooms the community offers, and where each stands -----
  #file () { try { const j = JSON.parse(readFileSync(this.statePath, 'utf8')); return isObj(j?.rooms) ? j : { rooms: {} } } catch { return { rooms: {} } } }
  /** The kept stage of one room, or null. Never holds a credential, a KeyPackage or a Welcome; talk keeps counts, the place read up to, and the drafts not yet sent. */
  stage (roomId) { const r = this.#file().rooms[roomId]; return r && r.communityDid === this.communityDid ? r : null }
  #keep (roomId, patch) {
    const file = this.#file(), now = file.rooms[roomId]
    file.rooms[roomId] = { ...(now?.communityDid === this.communityDid ? now : {}), communityDid: this.communityDid, ...patch }
    mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 })
    const tmp = `${this.statePath}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(file), { mode: 0o600 }); try { chmodSync(tmp, 0o600) } catch {}
    renameSync(tmp, this.statePath) // a half-written file is never the one read
    return file.rooms[roomId]
  }
  #reached (roomId, stage) { return STAGES.indexOf(this.stage(roomId)?.stage) >= STAGES.indexOf(stage) }

  // ----- one request to the community, as the member -----
  /** One task to the community's door, completed as the member by their trust agent. Throws a VtiError for a refusal. */
  async request (family, version, payload) {
    const unsigned = taskDocument({ type: typeUri(family, version), issuer: this.member, recipient: this.communityDid, payload })
    const doc = await this.vta.actAsMember(unsigned, this.member)
    const r = await sendTask(await this.host.door(), doc, { fetch: this.host.fetch, counts: this.host.counts, ...(this.sleep ? { sleep: this.sleep } : {}) })
    if (r.reply?.proof) { // a community with a DID of its own signs its answers; one reached only by address does not. A signature that is there must hold.
      const bad = () => { throw new VtiError('proofInvalid', 'the answer is signed, but not by the community it was sent to', { from: 'the community' }) }
      if (signerOf(r.reply) !== this.communityDid) bad()
      let d = null; try { d = await this.resolver.resolve(this.communityDid) } catch {}
      if (d) { let key = null; try { key = keyFromDidDocument(d, this.communityDid, r.reply.proof.verificationMethod, r.reply.proof.proofPurpose) } catch {} if (!key || !verifySignature(r.reply, key).ok) bad() }
    }
    return unwrap(r, 'the community')
  }

  /** Run one step: its outcome is kept (counts and the code), and a failure is thrown in words with the code on it. */
  async #step (task, fn) {
    try { const out = await fn(); this.last = { ok: true, task, at: this.now() }; return out } catch (e) {
      const code = e?.code ?? 'unreachable'
      this.counts.refusedBy[code] = (this.counts.refusedBy[code] ?? 0) + 1; this.last = { ok: false, task, code, at: this.now() }
      throw Object.assign(new Error(`Entering the community's room did not work: ${communityWords(e)}`), { code, cause: e })
    }
  }

  /** Every offer addressed to this member, all pages, with the credential strings (a private reading: accept() uses it). */
  async #read () {
    const items = []; const seen = new Set(); let cursor, renewals = []
    for (let page = 0; page < MAX_PAGES; page++) {
      const out = await this.request('vtc/rooms/offers/list', OFFERS_LIST, { limit: PAGE, ...(cursor ? { cursor } : {}) })
      if (!Array.isArray(out.items)) throw new VtiError('indeterminate', 'the community answered an offer list with no list', { from: 'the community' })
      for (const o of out.items) { if (offerShape(o, this.communityDid)) items.push(o); else this.counts.ignored++ } // an offer that does not read, or names another host, is not acted on
      if (!cursor && Array.isArray(out.renewals)) renewals = out.renewals.filter((r) => isObj(r) && typeof r.roomId === 'string')
      cursor = out.nextCursor
      if (typeof cursor !== 'string' || !cursor || seen.has(cursor)) break // the cursor's absence is the end; one repeated is a host going round in circles
      seen.add(cursor)
    }
    this.counts.offersRead += items.length; this.counts.renewalsSeen += renewals.length
    this.renewals = renewals.map(({ credentials, ...r }) => r)
    return items
  }

  /** The offers addressed to this member, without their credential strings: [{ roomId, host, label, description?, visibility, actions, validUntil, offeredAt, state }]. */
  offers () { return this.#step('offers', async () => (await this.#read()).map(({ credentials, ...o }) => o)) }

  // ----- entering -----
  /**
   * Accept the offer of `roomId` and join its group, every key step in the person's trust agent. Safe to call again: it
   * picks up where the last call stopped. Answers state() once the trust agent is at the room's epoch.
   */
  accept (roomId) {
    return this.#step('accept', async () => {
      if (!(await this.#held(roomId))) {
        const offer = (await this.#read()).find((o) => o.roomId === roomId)
        if (!offer) throw new VtiError('vtc/rooms/offers/accept:notFound', 'no offer of that room is addressed to this member', { from: 'this bridge' })
        if (Date.parse(offer.validUntil) <= this.now()) throw new VtiError('vtc/rooms/offers/accept:offerExpired', `the offer ran out at ${offer.validUntil}`, { from: 'this bridge' }) // before anything is stored or sent
        if (!this.#reached(roomId, 'stored')) {
          for (const c of ['invitation', 'membership', 'authority']) await this.vta.receiveCredential(asCredential(offer.credentials[c])) // the person's own vault; the invitation is also handed back below, as sent
          this.#keep(roomId, { stage: 'stored', visibility: offer.visibility })
        }
        if (offer.visibility === 'open') { // no group: the room is read and written in the clear, and the acceptance carries no KeyPackage
          const got = await this.request('vtc/rooms/offers/accept', '0.1', { roomId })
          this.counts.accepted++; this.#keep(roomId, { stage: 'joined', visibility: 'open', roomEpoch: got.epoch, mlsEpoch: null, joinedAt: new Date(this.now()).toISOString() })
          return this.state(roomId)
        }
        await this.#join(roomId, offer)
      }
      await this.#catchUp(roomId)
      return this.state(roomId)
    })
  }

  /** The trust agent already holds this member's place in the room: the join is done (the person's other device, or an earlier run). */
  async #held (roomId) {
    const held = (await this.vta.list()).find((r) => r.roomId === roomId && r.member === this.member)
    if (held && !this.#reached(roomId, 'joined')) this.#keep(roomId, { stage: 'joined', joinedAt: new Date(this.now()).toISOString() })
    return Boolean(held)
  }

  /** KeyPackage, acceptance, Welcome: in that order. An acceptance begun and not finished is finished the way the trust agent describes. */
  async #join (roomId, offer) {
    const invitation = offer.credentials.invitation
    const { keyPackage } = await this.vta.keyPackage(roomId, invitation)
    let got
    for (let turn = 0; ; turn++) {
      try { got = await this.request('vtc/rooms/offers/accept', '0.1', { roomId, keyPackage }); break } catch (e) {
        if (is(/(^|:)admissionPending$/, e.code) && turn < ADMISSION_TRIES) { await this.sleep(ADMISSION_WAIT_MS); continue } // the identical request, as the community asks
        if (is(/(^|:)alreadyAccepted$/, e.code) && turn === 0) { // the same KeyPackage again is what the community kept the Welcome for; a different one is a new acceptance it will not take
          const again = await this.vta.keyPackage(roomId, invitation)
          if (again.keyPackage === keyPackage) continue
        }
        throw e
      }
    }
    if (got.state !== 'admitted' || typeof got.welcome !== 'string' || !got.welcome) throw new VtiError('indeterminate', 'the community admitted the member on a sealed room without a Welcome', { from: 'the community' })
    this.counts.accepted++; this.#keep(roomId, { stage: 'accepted', visibility: offer.visibility, roomEpoch: got.epoch })
    const joined = await this.vta.welcome(roomId, { welcome: got.welcome, invitation, ...(got.ratchetTree ? { ratchetTree: got.ratchetTree } : {}) }) // Welcome and ratchet tree unchanged
    this.counts.welcomes++
    this.#keep(roomId, { stage: 'joined', mlsEpoch: joined.epoch ?? this.stage(roomId)?.mlsEpoch ?? null, joinedAt: new Date(this.now()).toISOString() })
  }

  /** Bring the trust agent's group up to the room's epoch: fetch the host's commits since the epoch held and apply each (as `pnm rooms keys commit --host` does). */
  catchUp (roomId) { return this.#step('catchUp', () => this.#catchUp(roomId)) }

  async #catchUp (roomId) {
    const held = (await this.vta.list()).find((r) => r.roomId === roomId && r.member === this.member)
    if (!held) throw new VtiError('rooms/keys/commit:notAMember', 'the trust agent holds no place in that room for this member yet: accept the offer first', { from: 'the trust agent' })
    let at = held.epoch, applied = 0
    for (let page = 0; page < MAX_COMMIT_PAGES; page++) {
      const { commits, roomEpoch } = await this.host.commits(roomId, at)
      if (!commits.length) break
      const before = at
      // The host numbers a commit by the room epoch it produces; the trust agent takes the MLS epoch, which counts from 0: one less.
      for (const c of commits) { at = ((await this.vta.commit(roomId, c.commit, c.epoch - 1)).epoch ?? at - 1) + 1; applied++ }
      if (at === before || (roomEpoch && at >= roomEpoch)) break
    }
    this.counts.commitsApplied += applied
    return { applied, epoch: at }
  }

  // ----- talking: reading what members wrote, and saying something, in the room's sealed records -----
  // What is kept per room beside the stage (counts, a version, and the drafts): read, said, drafted, badSignatures, unreadable{reason:n},
  // refusedBy{code:n}, readUpTo (the last room version read), drafts[{ n, text, inReplyTo?, at }], nextDraft. Counts only, except the drafts.
  #talk (roomId) { return { read: 0, said: 0, drafted: 0, badSignatures: 0, unreadable: {}, refusedBy: {}, readUpTo: 0, drafts: [], nextDraft: 1, ...(this.stage(roomId)?.talk ?? {}) } }
  #bump (roomId, change) { const t = this.#talk(roomId); change(t); this.#keep(roomId, { talk: t }); return t }
  /** One talking step: its outcome is kept (counts and the code, in memory and in the file), and a failure is thrown in words with the code on it. */
  async #talked (roomId, task, fn) {
    try { const out = await fn(); this.last = { ok: true, task, at: this.now() }; return out } catch (e) {
      const code = e?.code ?? 'unreachable'
      this.counts.refusedBy[code] = (this.counts.refusedBy[code] ?? 0) + 1; this.last = { ok: false, task, code, at: this.now() }
      try { this.#bump(roomId, (t) => { t.refusedBy[code] = (t.refusedBy[code] ?? 0) + 1 }) } catch {} // a state file that cannot be written must not hide the refusal
      throw Object.assign(new Error(`Talking in the community's room did not work: ${talkWords(e)}`), { code, cause: e })
    }
  }
  /** Talk happens in sealed records. An open room keeps its records in the clear and has no group: this bridge does not write or read talk there. */
  async #sealedInfo (roomId) {
    const open = () => new VtiError('permissionDenied', 'that room is open: its records are in the clear and this bridge keeps talk only in sealed rooms', { from: 'this bridge' })
    if (this.stage(roomId)?.visibility === 'open') throw open() // known from the acceptance: the trust agent holds no group for it to ask as
    const info = await this.host.info(roomId)
    if (info.visibility === 'open') throw open()
    return info
  }

  /** What the room's profile lets a writer use (cached for the room's current epoch). */
  async #listed (roomId, epoch) {
    const hit = this.profiles.get(roomId)
    if (hit && hit.epoch === epoch) return hit.listed
    let listed = []
    try { listed = (await profileOf(this.vta, roomId, this.communityDid)).recordMembers } catch (e) {
      if (!(e instanceof VtiError) || /notAMember$/.test(e.code ?? '')) throw e
      this.counts.profileUnread++ // the profile could not be read: nothing it governs is written, and the message is marked with a tag instead
    }
    this.profiles.set(roomId, { epoch, listed })
    return listed
  }

  /** The room version the host is at, so a write can say which version it expects to land at (a wrong guess is repaired by sealing again). */
  async #head (roomId) { const from = this.#talk(roomId).readUpTo; const r = await this.host.listPage(roomId, { ...(from ? { sinceVersion: from } : {}), limit: 1 }); return r.headVersion ?? from }

  /** Open one listed record and believe it only if its author signed it for the very place it was read from (as VtiNotebook does). */
  async #opened (roomId, meta) {
    const rec = await this.host.get(roomId, meta.key)
    if (!rec?.sealed) throw new Unreadable('not-a-record')
    const sealedFor = rec.sealed.version ?? rec.version
    const open = () => this.vta.open(roomId, meta.key, sealedFor, rec.sealed, { member: this.member })
    let got
    try { got = await open() } catch (e) {
      if (e.code !== 'rooms/keys/open:unknownEpoch') throw e
      const why = e.details?.reason
      if (why === 'notDelivered') { await this.#catchUp(roomId); got = await open() } else if (why === 'beyondChain') { // sealed before this membership began: ask for the older keys once
        try { await this.vta.backfill(roomId, this.communityDid); got = await open() } catch (e2) {
          if (e2.code !== 'rooms/keys/open:unknownEpoch' && e2.code !== 'rooms/keys/backfill:hostRefused') throw e2 // a host that is down is an error now, not a verdict
          throw new Unreadable('from-before-this-membership')
        }
      } else throw new Unreadable(why === 'removed' ? 'written-after-this-member-was-removed' : 'no-key-for-its-epoch')
    }
    return { body: await checkedBody(got.bytes, { roomId, key: meta.key, version: got.sealedAt ?? sealedFor, author: rec.author }, this.keyFor), createdAt: rec.createdAt ?? null }
  }

  /**
   * What members wrote since `since` (default: since the last read, kept in the file): { messages, more, unreadable, upTo }.
   * Oldest first, so a long gap is read in order across calls and nothing is skipped: `more` counts what the caps left for the next
   * read. Each message is { key, version, author, writtenAt, kind, inReplyTo, basis, text, mine, truncated? }. `author` is who signed it,
   * checked against the place it was read from; a body that fails the check is counted (badSignatures) and never shown.
   */
  read (roomId, { since, limit = 100, chars = READ_CHARS } = {}) {
    return this.#talked(roomId, 'read', async () => {
      await this.#sealedInfo(roomId)
      const t = this.#talk(roomId), floor = since ?? t.readUpTo
      const { records } = await this.host.list(roomId, { sinceVersion: floor })
      const metas = records.filter((r) => floor === undefined || r.version > floor).sort((a, b) => a.version - b.version)
      const messages = [], unreadable = {}; let size = 0, more = 0, upTo = floor, bad = 0
      for (const m of metas) {
        if (messages.length >= limit || size >= chars) { more++; continue } // the rest waits for the next read: it stays sealed in the room until then
        upTo = m.version
        if (m.status === 'retracted') continue
        let o
        try { o = await this.#opened(roomId, m) } catch (e) {
          if (!(e instanceof Unreadable) && e.code !== 'rooms/keys/open:didNotOpen') throw e // a door that is down is an error now, never a message quietly dropped
          const why = e.why ?? 'did-not-open'; unreadable[why] = (unreadable[why] ?? 0) + 1
          if (BAD_SIGNATURE.includes(why)) bad++
          continue
        }
        const b = o.body, tags = Array.isArray(b.tags) ? b.tags : []
        if (tags.includes(NOTE_TAG)) continue // a private note kept in the same room is not talk
        if (b.validUntil && Date.parse(b.validUntil) <= this.now()) { unreadable.expired = (unreadable.expired ?? 0) + 1; continue } // a reader hides what its author no longer stands behind
        const re = typeof b.inReplyTo?.key === 'string' && b.inReplyTo.key ? { key: b.inReplyTo.key, ...(Number.isInteger(b.inReplyTo.version) ? { version: b.inReplyTo.version } : {}) } : tagOf(tags, 're:') ? { key: tagOf(tags, 're:') } : null
        const text = [b.title, b.body].filter((x) => typeof x === 'string' && x).join('\n')
        messages.push({ key: m.key, version: m.version, author: b.author, writtenAt: typeof b.writtenAt === 'string' ? b.writtenAt : o.createdAt, kind: typeof b.kind === 'string' ? b.kind : 'message', inReplyTo: re, basis: typeof b.basis === 'string' ? b.basis : 'unstated', text: text.slice(0, MAX_SHOWN_CHARS), mine: b.author === this.member, ...(text.length > MAX_SHOWN_CHARS ? { truncated: true } : {}) })
        size += Math.min(text.length, MAX_SHOWN_CHARS)
      }
      const total = Object.values(unreadable).reduce((a, n) => a + n, 0)
      this.counts.read += messages.length; this.counts.badSignatures += bad
      for (const [k, n] of Object.entries(unreadable)) this.counts.unreadable[k] = (this.counts.unreadable[k] ?? 0) + n
      this.#bump(roomId, (s) => { // nothing but counts and the place read up to
        s.read += messages.length; s.badSignatures += bad
        for (const [k, n] of Object.entries(unreadable)) s.unreadable[k] = (s.unreadable[k] ?? 0) + n
        if (since === undefined && upTo !== undefined) s.readUpTo = Math.max(s.readUpTo, upTo)
      })
      return { messages, more, ...(total ? { unreadable } : {}), upTo: upTo ?? 0 }
    })
  }

  /**
   * Say something to the room as this member. `from`: 'person' (they typed it: basis `declared`) or 'agent' (an agent wrote it on its own
   * account: `inferred`). Sealed and signed by the person's trust agent; answers { key, version }. A message over MAX_TALK_CHARS is refused,
   * not cut: a person speaking to a whole community is not to be cut off mid-sentence.
   */
  say (roomId, text, { inReplyTo, from = 'person' } = {}) {
    return this.#talked(roomId, 'say', async () => {
      const words = String(text ?? '').trim()
      if (!words) throw new Error('a message needs words')
      if (words.length > MAX_TALK_CHARS) throw new Error(`that message is ${words.length} characters; the most one message holds is ${MAX_TALK_CHARS}. Say it in parts`)
      if (inReplyTo !== undefined && (typeof inReplyTo !== 'string' || !inReplyTo || inReplyTo.length > 512)) throw new Error('inReplyTo is the key of the message answered')
      const info = await this.#sealedInfo(roomId), listed = await this.#listed(roomId, info.epoch)
      const key = b64u(randomBytes(16)) // on a sealed tier a record's key is in the clear to the host: it says nothing
      const base = { body: words, tags: [TALK_TAG, ...(inReplyTo && inReplyTo.length <= 61 ? [`re:${inReplyTo}`] : [])], basis: from === 'person' ? 'declared' : 'inferred' }
      const governed = { ...(listed.includes('kind') ? { kind: 'message' } : {}), ...(inReplyTo && listed.includes('inReplyTo') ? { inReplyTo: { key: inReplyTo } } : {}), ...(listed.includes('writtenAt') ? { writtenAt: new Date(this.now()).toISOString() } : {}) }
      const version = await this.#put(roomId, key, base, governed)
      this.counts.said++; this.#bump(roomId, (t) => { t.said++ })
      return { key, version }
    })
  }

  /** Seal `base` (and `governed`, the members the profile lists) as one record at `key` and put it, sealing again for the version the host really gave it. */
  async #put (roomId, key, base, governed) {
    let intended = (await this.#head(roomId)) + 1, expected = 0, caughtUp = false, plain = !Object.keys(governed).length
    for (let turn = 0; turn < WRITE_ATTEMPTS; turn++) {
      const body = { roomId, key, version: intended, author: this.member, ...base, ...(plain ? {} : governed) }
      let put, sealed
      try {
        sealed = await this.vta.seal(roomId, key, intended, Buffer.from(JSON.stringify(body)), { signAsPrincipal: true })
        put = await this.host.put(roomId, { key, sealed, expectedVersion: expected })
      } catch (e) {
        if (!plain && e?.code === 'rooms/keys/seal:bodyInvalid') { plain = true; continue } // a trust agent that predates the profile's members: say it without them, marked by its tag
        if (!isEpochMismatch(e) || caughtUp) throw e
        caughtUp = true; await this.#catchUp(roomId); continue // the room moved to a new epoch: catch up once and seal again
      }
      if (put.version === intended) return put.version
      expected = put.version; intended = put.version + 1 // another write took that version: seal again for where this one landed
    }
    throw new VtiError('unavailable', `the message is stored but could not be sealed for the place it landed: the room kept moving under ${WRITE_ATTEMPTS} tries. Say it again`, { from: 'this bridge' })
  }

  // ----- what an agent may say: by default it only writes a draft its person sends -----
  /** An agent's words: said at once when this bridge was told the agent may (COMMUNITY_TALK_AGENT_MAY_SAY=yes); otherwise kept as a numbered draft. */
  async agentSay (roomId, text, { inReplyTo } = {}) {
    if (this.agentMaySay) return { sent: true, ...(await this.say(roomId, text, { inReplyTo, from: 'agent' })) }
    return { sent: false, ...(await this.draft(roomId, text, { inReplyTo })) }
  }
  /** Keep words as a draft: { draft: n }. At most MAX_DRAFTS wait at once. */
  draft (roomId, text, { inReplyTo } = {}) {
    return this.#talked(roomId, 'draft', async () => {
      const words = String(text ?? '').trim()
      if (!words) throw new Error('a draft needs words')
      if (words.length > MAX_TALK_CHARS) throw new Error(`that draft is ${words.length} characters; the most one message holds is ${MAX_TALK_CHARS}`)
      if (inReplyTo !== undefined && (typeof inReplyTo !== 'string' || !inReplyTo || inReplyTo.length > 512)) throw new Error('inReplyTo is the key of the message answered')
      const t = this.#talk(roomId)
      if (t.drafts.length >= MAX_DRAFTS) throw Object.assign(new Error(`${t.drafts.length} drafts are waiting for the person already; they send or discard some first`), { code: 'draftsFull' })
      const n = t.nextDraft
      this.#bump(roomId, (s) => { s.drafts.push({ n, text: words, ...(inReplyTo ? { inReplyTo } : {}), at: new Date(this.now()).toISOString() }); s.nextDraft = n + 1; s.drafted++ })
      this.counts.drafted++
      return { draft: n }
    })
  }
  /** The drafts waiting: [{ n, text, inReplyTo?, at }]. For the person; no tool hands them back to an agent. */
  drafts (roomId) { return this.#talk(roomId).drafts }
  /** Send draft `n` as the agent's words (basis `inferred`) and delete it. A draft that fails to send stays. */
  async send (roomId, n) {
    const d = this.#talk(roomId).drafts.find((x) => x.n === Number(n))
    if (!d) throw Object.assign(new Error(`there is no draft ${n}`), { code: 'noSuchDraft' })
    const out = await this.say(roomId, d.text, { inReplyTo: d.inReplyTo, from: 'agent' })
    this.#bump(roomId, (t) => { t.drafts = t.drafts.filter((x) => x.n !== d.n) })
    return out
  }
  /** Delete draft `n` without sending it. */
  discard (roomId, n) {
    if (!this.#talk(roomId).drafts.some((x) => x.n === Number(n))) throw Object.assign(new Error(`there is no draft ${n}`), { code: 'noSuchDraft' })
    this.#bump(roomId, (t) => { t.drafts = t.drafts.filter((x) => x.n !== Number(n)) })
  }

  /** How talking is doing for one room: counts, codes and places, never a word said. Reaches the host for the epochs when it can. */
  async status (roomId) {
    const t = this.#talk(roomId)
    let where = { visibility: this.stage(roomId)?.visibility ?? null, roomEpoch: this.stage(roomId)?.roomEpoch ?? null, mlsEpoch: this.stage(roomId)?.mlsEpoch ?? null }
    try { const s = await this.state(roomId); where = { visibility: s.visibility, roomEpoch: s.roomEpoch, mlsEpoch: s.mlsEpoch } } catch { where.unreached = true }
    return { room: roomId, ...where, read: t.read, said: t.said, drafted: t.drafted, draftsWaiting: t.drafts.length, refusedBy: t.refusedBy, badSignatures: t.badSignatures, unreadable: t.unreadable, lastVersionRead: t.readUpTo, agentMaySay: this.agentMaySay, last: this.last }
  }

  /** Where the room stands for this member: { roomId, visibility, roomEpoch (the host's), mlsEpoch (the trust agent's group), joinedAt }. */
  async state (roomId) {
    const kept = this.stage(roomId)
    let info = {}
    try { info = await this.host.info(roomId) } catch (e) { if (kept?.visibility !== 'open') throw e } // an open room has no group, so the trust agent has no place in it to ask as: the host's answer is not had, the kept one stands
    const held = (await this.vta.list()).find((r) => r.roomId === roomId && r.member === this.member)
    return { roomId, visibility: info.visibility ?? kept?.visibility ?? null, roomEpoch: Number.isInteger(info.epoch) ? info.epoch : kept?.roomEpoch ?? null, mlsEpoch: held ? held.epoch - 1 : kept?.mlsEpoch ?? null, joinedAt: kept?.joinedAt ?? null }
  }
}

/** True when `o` is an OfferV2 this bridge can act on: every required member, the community as host, strings it can store. */
function offerShape (o, communityDid) {
  const c = o?.credentials
  return isObj(o) && typeof o.roomId === 'string' && o.roomId && o.host === communityDid && VISIBILITIES.includes(o.visibility) && Array.isArray(o.actions) && Number.isFinite(Date.parse(o.validUntil)) && ['open', 'accepted'].includes(o.state) && isObj(c) && ['invitation', 'membership', 'authority'].every((k) => typeof c[k] === 'string' && c[k])
}

/**
 * The room's profile as its member's own trust agent reads it: { status: found|absent|cleared, name?, recordMembers: [...], version?, author? }.
 * `recordMembers` lists what a writer may use beyond the base body (`kind`, `inReplyTo`, `writtenAt`, ...); it is empty unless a profile was found
 * and lists some. Called through `vta.call`, so a trust agent that does not serve it throws unsupportedType/unsupportedVersion.
 */
export async function profileOf (vta, roomId, host) {
  const out = await vta.call('rooms/keys/profile/read', '0.1', { roomId, host })
  const found = out?.status === 'found' && isObj(out.profile)
  const members = found && Array.isArray(out.profile.recordMembers) ? out.profile.recordMembers.filter((m) => typeof m === 'string' && /^[a-z][A-Za-z0-9]*$/.test(m)) : []
  return { status: ['found', 'absent', 'cleared'].includes(out?.status) ? out.status : 'absent', ...(found && typeof out.profile.name === 'string' ? { name: out.profile.name } : {}), recordMembers: members, ...(Number.isInteger(out?.version) ? { version: out.version } : {}), ...(typeof out?.author === 'string' ? { author: out.author } : {}) }
}

/** An opened body is believed only if its author signed it for the very place it was read from, and the host recorded that author (as VtiNotebook does). */
async function checkedBody (bytes, at, keyFor) {
  let b
  try { b = JSON.parse(Buffer.from(bytes).toString('utf8')) } catch { throw new Unreadable('not-a-record') }
  const p = b?.proof
  if (!isObj(b) || typeof b.author !== 'string' || !isObj(p)) throw new Unreadable('not-signed-by-its-author')
  if (b.roomId !== at.roomId || b.key !== at.key || b.version !== at.version) throw new Unreadable('signed-for-another-place')
  if (at.author && at.author !== b.author) throw new Unreadable('not-signed-by-its-author')
  if (p.proofPurpose !== 'assertionMethod' || String(p.verificationMethod).split('#')[0] !== b.author) throw new Unreadable('not-signed-by-its-author')
  let key = null
  try { key = await keyFor(b.author, p.verificationMethod, 'assertionMethod') } catch { throw new Unreadable('author-not-found') }
  if (!key || !verifySignature(b, key).ok) throw new Unreadable('not-signed-by-its-author')
  return b
}

/** A refusal while talking, in words a person can act on: the member's own rights first, then the trust agent's and the host's (inWords). */
export function talkWords (e) {
  const code = e?.code, tail = code ? ` (${code})` : ''
  if (code === 'rooms/keys/act:actionNotHeld') return `this person's membership of the community's room does not let them ${e.details?.action ?? 'do that'} there. A community administrator grants it${tail}`
  if (e instanceof VtiError && /^rooms\/keys\/(act|seal|commit):notAMember$/.test(code ?? '')) return `the person's trust agent holds no place in that room: they accept the community's offer first (wpi-agent community-room accept)${tail}`
  return inWords(e)
}

// ----- the command line and the bridge's settings -----
const STATE_NAME = 'community-room.json'
/** The joined rooms the state file holds for `communityDid`: [roomId]. */
export function joinedRooms (statePath, communityDid) {
  try { return Object.entries(JSON.parse(readFileSync(statePath, 'utf8')).rooms ?? {}).filter(([, r]) => r?.communityDid === communityDid && r.stage === 'joined' && r.visibility !== 'open').map(([id]) => id) } catch { return [] }
}
/**
 * The community room the bridge's settings ask for, or null when there is none to talk in: COMMUNITY_DID and COMMUNITY_PERSONA, the
 * person's trust agent (VTA_CREDENTIAL), and a room joined with `wpi-agent community-room accept` (COMMUNITY_ROOM names it when several are).
 * Answers { cr, roomId }. COMMUNITY_TALK_AGENT_MAY_SAY=yes lets the agent speak without asking (the default asks: it is a whole community).
 */
export function communityRoomFromEnv (env, { stateDir, statePath, fetch: f, resolver, vtaFetch, vtaSleep, sleep, needRoom = true } = {}) {
  if (!/^did:/.test(String(env.COMMUNITY_DID ?? '')) || !env.COMMUNITY_PERSONA || !(env.VTA_CREDENTIAL || env.VTA_CREDENTIAL_FILE)) return null
  const file = statePath ?? join(stateDir, STATE_NAME)
  const joined = joinedRooms(file, env.COMMUNITY_DID)
  const roomId = env.COMMUNITY_ROOM || (joined.length === 1 ? joined[0] : null)
  if (needRoom && (!roomId || !joined.includes(roomId))) return null
  const credential = readCredential(env)
  const vta = new Vta({ credential, url: env.VTA_URL || credential.vtaUrl, ...(vtaFetch ? { fetch: vtaFetch } : {}), ...(vtaSleep ? { sleep: vtaSleep } : {}), ...(resolver ? { resolver } : {}) })
  const cr = new CommunityRoom({ vta, communityDid: env.COMMUNITY_DID, member: env.COMMUNITY_PERSONA, url: env.COMMUNITY_URL, statePath: file, agentMaySay: env.COMMUNITY_TALK_AGENT_MAY_SAY === 'yes', ...(f ? { fetch: f } : {}), ...(resolver ? { resolver } : {}), ...(sleep ? { sleep } : {}) })
  return { cr, roomId }
}

const HELP = 'wpi-agent community-room offers | accept <roomId> | status | say "<text>" | drafts | send <n> | discard <n>'
/** `wpi-agent community-room ...`: enter the community's room and talk in it, through the person's own trust agent. Answers an exit code. */
export async function communityRoomCommand (args, env, { say = console.error, out = console.log, ...opts } = {}) {
  const [cmd, ...rest] = args
  if (!['offers', 'accept', 'status', 'say', 'drafts', 'send', 'discard'].includes(cmd)) { say(`Usage: ${HELP}`); return 2 }
  if (!/^did:/.test(String(env.COMMUNITY_DID ?? ''))) { say('Set COMMUNITY_DID to the DID of the community.'); return 1 }
  if (!env.COMMUNITY_PERSONA) { say('Set COMMUNITY_PERSONA to the DID of the persona the community addressed its offers to.'); return 1 }
  if (!env.VTA_CREDENTIAL && !env.VTA_CREDENTIAL_FILE) { say('Set VTA_CREDENTIAL (or VTA_CREDENTIAL_FILE): entering and talking in the room is done by your own trust agent, which signs as your persona.'); return 1 }
  let made
  try { made = communityRoomFromEnv(env, { ...opts, needRoom: false }) } catch (e) { say(e.message); return 1 }
  const { cr } = made
  const room = () => { const r = rest[0] && cmd === 'accept' ? rest[0] : env.COMMUNITY_ROOM || (joinedRooms(cr.statePath, cr.communityDid).length === 1 ? joinedRooms(cr.statePath, cr.communityDid)[0] : null); if (!r) throw new Error('No joined room to use: accept an offer first (wpi-agent community-room accept <roomId>), or set COMMUNITY_ROOM when several are joined.'); return r }
  try {
    if (cmd === 'offers') {
      const list = await cr.offers()
      if (!list.length) say('The community has no room on offer to this person.')
      for (const o of list) out(`${o.roomId}  ${o.visibility}  ${o.state}  actions: ${o.actions.join(', ')}  until ${o.validUntil}  ${o.label ?? ''}`.trimEnd())
      return 0
    }
    if (cmd === 'accept') {
      if (!rest[0]) { say('Say which room: wpi-agent community-room accept <roomId> (the ids are listed by offers)'); return 2 }
      const st = await cr.accept(rest[0]); out(JSON.stringify(st)); say(`Joined ${st.visibility} room ${st.roomId} at room epoch ${st.roomEpoch}.`); return 0
    }
    const roomId = room()
    if (cmd === 'status') { out(JSON.stringify(await cr.status(roomId))); return 0 }
    if (cmd === 'say') {
      if (!rest.length) { say('Say what: wpi-agent community-room say "<text>"'); return 2 }
      const r = await cr.say(roomId, rest.join(' '), { from: 'person' }); say(`Said (record ${r.key}, version ${r.version}).`); return 0
    }
    if (cmd === 'drafts') {
      const d = cr.drafts(roomId)
      if (!d.length) say('No drafts are waiting.')
      for (const x of d) out(`${x.n}${x.inReplyTo ? ` (replying to ${x.inReplyTo})` : ''}: ${x.text}`)
      return 0
    }
    if (cmd === 'send') { const r = await cr.send(roomId, rest[0]); say(`Sent draft ${rest[0]} (record ${r.key}, version ${r.version}) and deleted it.`); return 0 }
    cr.discard(roomId, rest[0]); say(`Deleted draft ${rest[0]}.`); return 0
  } catch (e) { say(e.message); return 1 }
}
