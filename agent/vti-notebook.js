// An agent's private notebook, kept in a sealed data room its person holds (an OpenVTC room on the `attributed`
// tier), not on the room's server. The room's host keeps ciphertext only; the keys and the MLS group state are in
// the person's own trust agent; this file runs on the person's machine and is the only place a note is in the clear.
//
// The choices made here, and why:
//  - One note is one sealed record. Its body is OpenVTC's own record body (`SealedRecordBody` in rooms/_shared/0.1,
//    vtc-client/src/rooms/body.rs at c6964c4): { roomId, key, version, author, title, body, tags, basis }, signed as
//    the member by their trust agent (rooms/keys/seal with signAsPrincipal) and then sealed. That is the only body
//    the reference readers show: `pnm rooms get` and a wallet reading through its trust agent refuse a body that is
//    not signed by its author for the place it was read from. The openvti starter kit's `openvti.collab/1` note
//    ({ profile, kind: "note", id, clientTs, title, body } as the bare plaintext) carries no author's proof, so
//    those readers refuse it; it was not used. What the notebook needs beyond a body rides in `tags`, which every
//    reader keeps: "wpi-notebook", "from:agent" or "from:person", "agent:<a short hash of the agent's DID>",
//    "at:<when it was written>". Only members every trust agent seals are used (none that a room's `recordMembers`
//    must list), so it works on rooms/keys/seal 0.2 and 0.3 alike.
//  - Keys say nothing. On a sealed tier a record's key is in the clear to the host, so each is 16 random bytes
//    (vti-rooms/src/sealed.rs: "Keys must therefore be opaque"), after an optional prefix the person picks when the
//    room also holds other things. The one fixed key, where the agent keeps "read up to here", is derived from the
//    agent's own key, so it too is noise to anyone else.
//  - The index is the host's own listing (rooms/records/list by prefix, above the last version seen): which records
//    exist, never what they say. There is no search on any server. Bodies are fetched and opened newest first, only
//    as far as an agent can take in at once; older ones stay sealed in the room until asked for.
//  - The room is the notebook: anything in it (under the prefix) that the agent did not write is a note from its
//    person, written with their own wallet. That is how a person tells their agent something privately here.
//  - Epochs. The room's keys move on when its owner adds or removes a member. A write the host refuses as sealed under
//    an old epoch, and a record that will not open because a commit was not delivered, are both repaired the way
//    `pnm rooms keys commit` does: fetch the commits from the host, hand each to the trust agent, try again.
//  - A member added again (after a removal, or for the first time into a room with history) holds keys from the
//    epoch it joined at. In a room that keeps its key chain (`chained`, the default) the trust agent can fetch the
//    older keys from the host (rooms/keys/backfill) and everything opens. In a room that does not (`fromJoin`), and
//    for anything written after a removal, the older notes stay sealed: they are counted and said, never guessed at.
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { verifySignature } from '../src/shared/proof.js'
import { createResolver } from '../src/server/resolver.js'
import { VtiError, Vta, readCredential } from './vta.js'
import { RoomHost, isEpochMismatch, isVersionConflict } from './room-host.js'

export const NOTE_TAG = 'wpi-notebook'
export const MAX_NOTE_CHARS = 2000 // the room's own rule for a note (src/server/notebook.js): one thing remembered, not a document
// About what an agent can take in at once (the same bound the room's server keeps). Older notes stay in the room, sealed.
export const READ_CHARS = 60_000
// A sealed body names the version it will take, and the host assigns versions from one counter for the whole room:
// each try loses only to a write that landed between this one's seal and its put (pnm's SEALED_WRITE_ATTEMPTS).
const WRITE_ATTEMPTS = 4
// What this protects: the person's trust agent and the host from one call on every check of an agent that loops on its inbox.
const PEEK_MS = 30_000
const MAX_COMMIT_PAGES = 32 // a host that keeps answering with commits that move nothing must not hold the agent

const b64u = (bytes) => Buffer.from(bytes).toString('base64url')
const sha = (s) => createHash('sha256').update(s).digest()
const tagOf = (tags, p) => tags.find((t) => typeof t === 'string' && t.startsWith(p))?.slice(p.length)
const firstLine = (text) => { const l = String(text).split('\n').find((x) => x.trim()) ?? ''; return l.trim().slice(0, 80) }
/** The name a moved note carries, so moving twice writes it once: a hash of when, who and what. */
export const movedId = (n) => b64u(sha(JSON.stringify([n.at ?? '', n.from ?? '', n.text ?? '']))).slice(0, 22)
class Unreadable extends Error { constructor (why) { super(why); this.why = why } }

export class VtiNotebook {
  /**
   * `vta`, `host`: agent/vta.js and agent/room-host.js. `roomId`: the sealed room's DID. `agent`: the agent's DID;
   * `secret`: bytes only this agent holds (its key's seed), from which its one fixed record key is derived.
   * `keyFor(did, verificationMethod, purpose)`: finds a note author's key (default: the room's resolver).
   */
  constructor ({ vta, host, roomId, agent, secret, prefix = '', keyFor = createResolver().keyFor, now = () => Date.now() } = {}) {
    if (!vta || !host || !/^did:/.test(String(roomId ?? '')) || !agent || !secret?.length) throw new Error('a sealed notebook needs the trust agent, the host, the room\'s DID, and the agent\'s DID and key')
    if (!/^[A-Za-z0-9_-]{0,32}$/.test(prefix)) throw new Error('NOTEBOOK_PREFIX is a few letters or digits that say nothing (the host can read it)')
    Object.assign(this, { vta, host, roomId, agent, prefix, keyFor, now })
    this.agentTag = b64u(sha(agent)).slice(0, 22)
    this.markerKey = prefix + b64u(createHmac('sha256', secret).update(`wpi.notebook/1 read-up-to|${roomId}`).digest()).slice(0, 22)
    this.records = new Map() // key -> what the host lists for it (no body)
    this.opened = new Map() // key -> { version, body, at } or { version, why }
    this.watermark = 0; this.head = 0; this.member = null; this.tier = null; this.floor = 0; this.mark = null; this.peeked = { at: 0, unread: 0 }
    this.counts = { added: 0, opened: 0, resealed: 0, catchUps: 0, backfills: 0, unreadable: 0 } // counts only: a notebook's numbers never hold a note
  }

  /** The room has to be a sealed one, and the trust agent has to act in it for this credential: found out once, on first use. */
  async ready () {
    if (this.member) return
    const info = await this.host.info(this.roomId)
    if (info.visibility === 'open') throw new VtiError('permissionDenied', 'that room is open: its host can read everything in it. A notebook goes in a sealed room.', { from: 'the notebook' })
    this.tier = info.visibility; this.member = this.host.member
  }

  /** What the host lists that is new since last time: metadata only. */
  async sync () {
    await this.ready()
    const { records, headVersion } = await this.host.list(this.roomId, { prefix: this.prefix, sinceVersion: this.watermark })
    for (const r of records) {
      if (r.status === 'retracted') { this.records.delete(r.key); this.opened.delete(r.key) } else this.records.set(r.key, r)
      this.watermark = Math.max(this.watermark, r.version)
    }
    this.head = Math.max(this.head, headVersion ?? 0, this.watermark)
  }

  /** Bring the trust agent's group up to the room's epoch, as `pnm rooms keys commit --host` does. */
  async catchUp () {
    const held = (await this.vta.list()).find((r) => r.roomId === this.roomId && (!this.member || r.member === this.member))
    if (!held) throw new VtiError('rooms/keys/commit:notAMember', 'the trust agent holds no keys for that room: its owner has to add this member (a fresh invitation) first', { from: 'the trust agent' })
    let at = held.epoch, applied = 0
    for (let page = 0; page < MAX_COMMIT_PAGES; page++) {
      const { commits, roomEpoch } = await this.host.commits(this.roomId, at)
      if (!commits.length) break
      const before = at
      // The host numbers a commit by the room epoch it produces; the trust agent takes the MLS epoch, which counts from 0: one less.
      for (const c of commits) { at = ((await this.vta.commit(this.roomId, c.commit, c.epoch - 1)).epoch ?? at - 1) + 1; applied++ }
      if (at === before || (roomEpoch && at >= roomEpoch)) break
    }
    this.counts.catchUps++
    return { applied, epoch: at }
  }

  /** Seal `fields` as one record at `key` and put it, sealing again for the version the host really gave it when that differs. */
  async #write (key, fields, expected) {
    let intended = this.head + 1, caughtUp = false
    for (let turn = 0; turn < WRITE_ATTEMPTS; turn++) {
      const body = { roomId: this.roomId, key, version: intended, author: this.member, ...fields }
      let put, sealed
      try {
        sealed = await this.vta.seal(this.roomId, key, intended, Buffer.from(JSON.stringify(body)), { signAsPrincipal: true })
        put = await this.host.put(this.roomId, { key, sealed, expectedVersion: expected })
      } catch (e) {
        if (!isEpochMismatch(e) || caughtUp) throw e
        caughtUp = true; await this.catchUp(); continue // the room moved to a new epoch: catch up once and seal again
      }
      this.head = Math.max(this.head, put.version)
      if (put.version === intended) {
        this.records.set(key, { key, version: put.version, status: 'active', author: this.member, epoch: sealed.epoch })
        this.opened.set(key, { version: put.version, body, at: new Date(this.now()).toISOString() })
        return put.version
      }
      this.counts.resealed++ // another write took that version: this one is stored but will not open until it is sealed for where it landed
      expected = put.version; intended = put.version + 1
    }
    throw new VtiError('unavailable', `the note is stored but could not be sealed for the place it landed: the room kept moving under ${WRITE_ATTEMPTS} tries. Write it again.`, { from: 'the notebook' })
  }

  /** Add one note. `from`: 'agent' (what it learned or tells its person) or 'person' (their words, moved here). */
  async add (text, from = 'agent', { at = new Date(this.now()).toISOString(), moved } = {}) {
    const body = String(text ?? '').slice(0, MAX_NOTE_CHARS)
    if (!body.trim()) throw new Error('a note needs words')
    await this.sync()
    const key = this.prefix + b64u(randomBytes(16))
    await this.#write(key, {
      title: firstLine(body), body,
      tags: [NOTE_TAG, `from:${from === 'person' ? 'person' : 'agent'}`, `agent:${this.agentTag}`, `at:${String(at).slice(0, 40)}`, ...(moved ? [`moved:${moved}`] : [])],
      basis: from === 'person' ? 'declared' : 'inferred', // an agent writing on its own account says so: the record is signed as the person's member
    }, 0)
    this.counts.added++
    return { key }
  }

  /** An opened body is believed only if its author signed it for the very place it was read from, and the host recorded that author. */
  async #checked (bytes, at) {
    let b
    try { b = JSON.parse(Buffer.from(bytes).toString('utf8')) } catch { throw new Unreadable('not-a-record') }
    const p = b?.proof
    if (!b || typeof b !== 'object' || typeof b.author !== 'string' || !p || typeof p !== 'object') throw new Unreadable('not-signed-by-its-author')
    if (b.roomId !== this.roomId || b.key !== at.key || b.version !== at.version) throw new Unreadable('signed-for-another-place')
    if (at.author && at.author !== b.author) throw new Unreadable('not-signed-by-its-author')
    if (p.proofPurpose !== 'assertionMethod' || String(p.verificationMethod).split('#')[0] !== b.author) throw new Unreadable('not-signed-by-its-author')
    let key = null
    try { key = await this.keyFor(b.author, p.verificationMethod, 'assertionMethod') } catch { throw new Unreadable('author-not-found') }
    if (!key || !verifySignature(b, key).ok) throw new Unreadable('not-signed-by-its-author')
    return b
  }

  async #open (meta) {
    const hit = this.opened.get(meta.key)
    if (hit?.version === meta.version) return hit
    if (meta.epoch && meta.epoch < this.floor) return { version: meta.version, why: 'from-before-this-membership' } // already known to be out of reach: not fetched again
    let out
    try {
      const rec = await this.host.get(this.roomId, meta.key)
      if (!rec?.sealed) throw new Unreadable('not-a-record')
      const sealedFor = rec.sealed.version ?? rec.version
      const open = () => this.vta.open(this.roomId, meta.key, sealedFor, rec.sealed, { member: this.member })
      let got
      try { got = await open() } catch (e) {
        if (e.code !== 'rooms/keys/open:unknownEpoch') throw e
        const why = e.details?.reason
        if (why === 'notDelivered') { await this.catchUp(); got = await open() } else if (why === 'beyondChain') { // sealed before this membership began: ask for the older keys once
          this.counts.backfills++
          try { await this.vta.backfill(this.roomId, this.host.hostDid); got = await open() } catch (e2) {
            if (e2.code !== 'rooms/keys/open:unknownEpoch' && e2.code !== 'rooms/keys/backfill:hostRefused') throw e2 // a host that is down is an error now, not a verdict
            this.floor = Math.max(this.floor, e2.details?.earliestEpoch ?? e.details?.earliestEpoch ?? 0)
            throw new Unreadable('from-before-this-membership')
          }
        } else throw new Unreadable(why === 'removed' ? 'written-after-this-member-was-removed' : 'no-key-for-its-epoch')
      }
      const body = await this.#checked(got.bytes, { key: meta.key, version: got.sealedAt ?? sealedFor, author: rec.author })
      out = { version: meta.version, body, at: rec.createdAt ?? rec.updatedAt ?? null }
      this.counts.opened++
    } catch (e) {
      if (!(e instanceof Unreadable) && e.code !== 'rooms/keys/open:didNotOpen') throw e // anything that may pass (a door that is down) is an error now, never a note quietly dropped
      out = { version: meta.version, why: e.why ?? 'did-not-open' }; this.counts.unreadable++
    }
    this.opened.set(meta.key, out)
    return out
  }

  #note (key, o) {
    const tags = Array.isArray(o.body.tags) ? o.body.tags : [], mine = tags.includes(NOTE_TAG)
    const from = !mine || tagOf(tags, 'from:') === 'person' ? 'person' : tagOf(tags, 'agent:') === this.agentTag ? 'agent' : 'another-agent'
    const moved = tagOf(tags, 'moved:')
    return { v: o.version, key, at: (mine && tagOf(tags, 'at:')) || o.at, from, text: mine ? String(o.body.body ?? '') : [o.body.title, o.body.body].filter(Boolean).join('\n'), ...(moved ? { moved } : {}) }
  }

  /**
   * The notebook: { notes: [{ at, from, text, v }] oldest first, older, unreadable }. `older` counts notes left
   * sealed because the newest ones already fill what an agent can take in; `unreadable` counts, by reason, records
   * that would not open or were not signed by their author.
   */
  async get ({ chars = READ_CHARS } = {}) {
    await this.sync()
    const metas = [...this.records.values()].filter((r) => r.key !== this.markerKey).sort((a, b) => b.version - a.version)
    const notes = [], unreadable = {}; let size = 0, older = 0
    for (const m of metas) {
      if (size >= chars) { older++; continue }
      const o = await this.#open(m)
      if (o.why) { unreadable[o.why] = (unreadable[o.why] ?? 0) + 1; continue }
      const n = this.#note(m.key, o); notes.push(n); size += n.text.length
    }
    return { notes: notes.reverse(), older, unreadable }
  }

  /** The room version the agent has read up to (0: never), from its marker record. */
  async #readUpTo () {
    const meta = this.records.get(this.markerKey)
    if (!meta) return 0
    if (this.mark?.version !== meta.version) { const o = await this.#open(meta); this.mark = { version: meta.version, upTo: o.why ? 0 : Number(tagOf(o.body.tags ?? [], 'read:')) || 0 } }
    return this.mark.upTo
  }

  /** Notes from the person the agent has not read yet. */
  async unread () {
    const { notes } = await this.get()
    const upTo = await this.#readUpTo()
    return notes.filter((n) => n.from === 'person' && n.v > upTo)
  }

  /** The agent opened its notebook: everything in it so far is read. One small record, rewritten in place, says up to where. */
  async markRead () {
    if (!(await this.unread()).length) return { upTo: await this.#readUpTo() }
    const upTo = this.head
    for (let turn = 0; ; turn++) {
      try {
        const version = await this.#write(this.markerKey, { title: 'Read up to here', body: `The agent has read the notes in this room up to version ${upTo}.`, tags: [NOTE_TAG, 'read-marker', `agent:${this.agentTag}`, `read:${upTo}`] }, this.records.get(this.markerKey)?.version ?? 0)
        this.mark = { version, upTo }; this.peeked = { at: this.now(), unread: 0 }
        return { upTo }
      } catch (e) { if (!isVersionConflict(e) || turn) throw e; await this.sync() } // another device of this agent moved the marker: look again, once
    }
  }

  /**
   * Copy notes that were kept elsewhere (the room's server) into the sealed room, each as its own note, then read
   * every one back and compare. Safe to run twice: a note already moved is not written again. Changes nothing where
   * the notes came from. Answers counts only.
   */
  async importNotes (notes) {
    const list = (Array.isArray(notes) ? notes : []).filter((n) => typeof n?.text === 'string' && n.text.trim()).map((n) => ({ at: n.at, from: n.from === 'person' ? 'person' : 'agent', text: n.text.slice(0, MAX_NOTE_CHARS) }))
    const have = new Set((await this.get({ chars: Infinity })).notes.map((n) => n.moved).filter(Boolean))
    let moved = 0, alreadyThere = 0
    for (const n of list) {
      const id = movedId(n)
      if (have.has(id)) { alreadyThere++; continue }
      await this.add(n.text, n.from, { at: n.at, moved: id }); have.add(id); moved++
    }
    this.opened.clear() // read back from the room itself, not from what was just written
    const back = new Map((await this.get({ chars: Infinity })).notes.filter((n) => n.moved).map((n) => [n.moved, n]))
    const verified = list.every((n) => { const b = back.get(movedId(n)); return b && b.text === n.text && b.from === n.from })
    return { notes: list.length, moved, alreadyThere, verified }
  }

  /** Where the notebook lives and how it is doing: places, counts and outcomes, never a note. */
  status () {
    return {
      lives: 'sealed-room', room: this.roomId, host: this.host.hostDid, member: this.member, tier: this.tier,
      records: Math.max(0, this.records.size - (this.records.has(this.markerKey) ? 1 : 0)), ...this.counts,
      trustAgent: { ...this.vta.counts, last: this.vta.last }, roomHost: { ...this.host.counts, last: this.host.last },
    }
  }

  /** `adapter.notebook(op, text)` for the agent's tools (src/agent-tools.js): peek, add, read. `card`: reads the person's public card. */
  adapter ({ card } = {}) {
    const run = this.#adapter({ card })
    // A failure is said in words the agent can pass on to its person, with the code. It never falls back to the room's server.
    return async (op, text) => { try { return await run(op, text) } catch (e) { throw Object.assign(new Error(`The notebook in the sealed room did not answer: ${inWords(e)}`), { code: e.code, cause: e }) } }
  }

  #adapter ({ card }) {
    return async (op, text) => {
      if (op === 'peek') {
        if (this.now() - this.peeked.at >= PEEK_MS) this.peeked = { at: this.now(), unread: (await this.unread()).length }
        return { unread: this.peeked.unread }
      }
      if (op === 'add') await this.add(text, 'agent')
      const r = await this.get()
      if (op === 'read') await this.markRead()
      const left = Object.values(r.unreadable).reduce((a, b) => a + b, 0)
      return { notes: r.notes.map(({ at, from, text: t }) => ({ at, from, text: t })), ...(r.older ? { older: r.older } : {}), ...(left ? { unreadable: r.unreadable } : {}), ...(op === 'read' && card ? { card: await card().catch(() => null) } : {}) }
    }
  }
}

/** A refusal, in words a person can act on. The code follows, for whoever looks it up. */
export function inWords (e) {
  const code = e?.code, tail = code ? ` (${code})` : ''
  if (!(e instanceof VtiError)) return `${e?.cause?.code === 'ECONNREFUSED' || /fetch failed|timeout|aborted/i.test(e?.message ?? '') ? 'the person\'s trust agent or the room\'s host could not be reached' : e?.message ?? 'it failed'}${tail}`
  if (code === 'permissionDenied' && e.from === 'the trust agent' && /delegate/.test(e.message)) return `the person's trust agent has this bridge's credential down as an AI agent (a delegate) and will not act as them for it. They register it as their own client instead (the README says how)${tail}`
  if (code === 'rooms/keys/act:notAMember' || code === 'rooms/keys/seal:notAMember' || code === 'rooms/keys/commit:notAMember') return `the person's trust agent holds no place in that room for this credential. They check NOTEBOOK_ROOM, and that the room's owner has added their persona${tail}`
  if (code === 'rooms/keys/act:actionNotHeld') return `the person's membership of that room does not allow this (${e.details?.action ?? 'that action'}). The room's owner grants read and write${tail}`
  if (code === 'auth/challenge:subjectNotRecognized') return `the person's trust agent does not know this credential. They check VTA_CREDENTIAL${tail}`
  if (code === 'permissionDenied' && e.from === 'the room host') return `the room's host did not accept the person's credentials for that room (expired, withdrawn, or for another room)${tail}`
  return `${e.message}${tail}`
}

const NEEDED = ['VTA_CREDENTIAL', 'NOTEBOOK_ROOM', 'NOTEBOOK_HOST_DID']
/**
 * The sealed notebook the bridge's settings ask for, or null when none of the three is set (the notebook then stays
 * where it is today). Some but not all is refused out loud: falling back to the room's server would put private
 * notes exactly where the person asked them not to be.
 */
export function notebookFromEnv (env, { agent, fetch: f, keyFor } = {}) {
  const have = { VTA_CREDENTIAL: Boolean(env.VTA_CREDENTIAL || env.VTA_CREDENTIAL_FILE), NOTEBOOK_ROOM: Boolean(env.NOTEBOOK_ROOM), NOTEBOOK_HOST_DID: Boolean(env.NOTEBOOK_HOST_DID) }
  const missing = NEEDED.filter((n) => !have[n])
  if (missing.length === NEEDED.length) return null
  if (missing.length) throw new Error(`A notebook in a sealed room needs VTA_CREDENTIAL, NOTEBOOK_ROOM and NOTEBOOK_HOST_DID together; ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not set. Set all three, or none to keep the notebook on the room's server.`)
  const credential = readCredential(env)
  const vta = new Vta({ credential, url: env.VTA_URL || credential.vtaUrl, ...(f ? { fetch: f } : {}) })
  const host = new RoomHost({ vta, hostDid: env.NOTEBOOK_HOST_DID, url: env.NOTEBOOK_HOST_URL, ...(f ? { fetch: f } : {}) })
  return new VtiNotebook({ vta, host, roomId: env.NOTEBOOK_ROOM, agent: agent.did, secret: agent.seed, prefix: env.NOTEBOOK_PREFIX ?? '', ...(keyFor ? { keyFor } : {}) })
}
