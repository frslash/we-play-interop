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
// The room epoch is the MLS epoch plus one; the trust agent takes MLS epochs, the host numbers rooms (agent/vta.js commit()).
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { keyFromDidDocument } from '../src/shared/chain.js'
import { verifySignature } from '../src/shared/proof.js'
import { signerOf, taskDocument, typeUri } from '../src/shared/trusttask.js'
import { createResolver } from '../src/server/resolver.js'
import { VtiError, sendTask, unwrap } from './vta.js'
import { RoomHost } from './room-host.js'
import { inWords } from './vti-notebook.js'

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
  constructor ({ vta, communityDid, member, resolver = createResolver(), fetch: f, url, statePath, host, now = () => Date.now(), sleep = pause } = {}) {
    if (!vta || !/^did:/.test(String(communityDid ?? '')) || !/^did:/.test(String(member ?? ''))) throw new Error('entering a community\'s room needs the person\'s trust agent, the community\'s DID and the member\'s DID')
    Object.assign(this, { vta, communityDid, member, resolver, now, sleep })
    this.host = host ?? new RoomHost({ vta, hostDid: communityDid, member, resolver, ...(url ? { url } : {}), ...(f ? { fetch: f } : {}), sleep })
    this.statePath = statePath ?? join(homedir(), '.config/we-play-interop/community-room.json')
    this.renewals = [] // renewals of admissions already held, as the last offers() read them (no credential strings): reported, never acted on
    this.counts = { offersRead: 0, renewalsSeen: 0, ignored: 0, accepted: 0, welcomes: 0, commitsApplied: 0, refusedBy: {} } // counts and codes only, never a credential
    this.last = null // { ok, task, code?, at }
  }

  // ----- what a person reads: the rooms the community offers, and where each stands -----
  #file () { try { const j = JSON.parse(readFileSync(this.statePath, 'utf8')); return isObj(j?.rooms) ? j : { rooms: {} } } catch { return { rooms: {} } } }
  /** The kept stage of one room, or null. Never holds a credential, a KeyPackage or a Welcome. */
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
