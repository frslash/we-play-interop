// P2, sealed notebooks: the host side. It keeps CIPHERTEXT ONLY, and no roster in the clear.
// Every door fails closed. Logs are content-blind: counts, sizes and refusal reasons only.
// TEST MEMBERS ONLY (see src/shared/sealed.js). In memory for now; a live host is still needed.
import { randomBytes, sha256, toHex, utf8 } from '../shared/crypto.js'
import { AGENT_MAX_TTL_MS, AGENT_SCOPES, MAX_NOTE_BYTES, MEMBER_MAX_TTL_MS, argsHash, verifyWith } from '../shared/sealed.js'

const HOST_NOTE_CAP = 64 * 1024
export const LOG_MAX_AGE_MS = 3600e3 // stale log: deny
export const STATUS_MAX_AGE_MS = 24 * 3600e3 // stale status list: deny
const NONCE_TTL_MS = 60e3
const NONCE_CAP = 10000 // refuse new challenges beyond this; expired ones are swept on every call
const OPS = { write: 'notes:write', list: 'notes:read', read: 'notes:read', add_member: 'members:admin', remove_member: 'members:admin' }

export class SealedHost {
  constructor ({ host = 'host.test', now = () => Date.now(), writesPerMinute = 30 } = {}) {
    this.host = host; this.now = now; this.writesPerMinute = writesPerMinute
    this.rooms = new Map() // roomDid -> { epoch, records: Map, revoked: Set(credential id hashes) }
    this.nonces = new Map()
    this.statusAt = now(); this.logAt = now() // when the status list and the room log were last fetched
    this.events = [] // content-blind
    this.hits = new Map()
  }

  createRoom (roomDid) { if (!this.rooms.has(roomDid)) this.rooms.set(roomDid, { epoch: 0, records: new Map(), revoked: new Set(), removed: new Set() }); return roomDid }
  refreshStatus () { this.statusAt = this.now(); this.logAt = this.now() }
  /** The member's own tap, or the room's: the next call with this credential fails. */
  revoke (roomDid, credentialId) { this.rooms.get(roomDid)?.revoked.add(this.#h(credentialId)) }
  /** Removing a member ends their credential AND every agent delegation they gave, in the same step, and moves the room to a new epoch (Security should-fix 5). */
  removeMember (roomDid, memberDid) { const room = this.rooms.get(roomDid); room.removed.add(this.#h(memberDid)); return this.nextEpoch(roomDid) }
  /** After a removal the room moves to a new epoch; clients seal new notes with the new key. */
  nextEpoch (roomDid) { return ++this.rooms.get(roomDid).epoch }

  challenge () {
    const t = this.now(); for (const [n, e] of this.nonces) if (e < t) this.nonces.delete(n)
    if (this.nonces.size >= NONCE_CAP) throw new Refused('too many open challenges')
    const nonce = toHex(randomBytes(16)); this.nonces.set(nonce, t + NONCE_TTL_MS); return nonce
  }

  /** { presentation, args } -> result. Throws Refused with a reason that never contains note content. */
  call (presentation, args = {}) {
    const op = presentation?.op
    try {
      const { room, who, credential } = this.#authorize(presentation, args)
      if (op === 'write') return this.#write(room, who, credential, args)
      if (op === 'list') return this.#list(room, who)
      if (op === 'read') return this.#read(room, who, args)
      // members and rules are the person's, never an agent's; the host has no member list, so these only bump the epoch
      if (op === 'remove_member') {
        this.#log(op, 'ok')
        return { epoch: typeof args.member === 'string' ? this.removeMember(presentation.room, args.member) : this.nextEpoch(presentation.room) }
      }
      throw new Refused('unknown operation')
    } catch (e) {
      if (e instanceof Refused) { this.#log(op ?? 'unknown', 'refused', e.message); throw e }
      throw e
    }
  }

  #authorize (p, args = {}) {
    const fail = (m) => { throw new Refused(m) }
    if (!p || typeof p !== 'object' || JSON.stringify(p).length > 8192) fail('malformed or oversize')
    if (p.host !== this.host) fail('wrong host')
    const room = this.rooms.get(p.room); if (!room) fail('no such room')
    // the checker's own clock; stale log or status = deny
    if (this.now() - this.logAt > LOG_MAX_AGE_MS) fail('room log is stale')
    if (this.now() - this.statusAt > STATUS_MAX_AGE_MS) fail('status list is stale')
    const exp = this.nonces.get(p.nonce); this.nonces.delete(p.nonce) // single use
    if (!exp || exp < this.now()) fail('nonce unknown, used or expired')
    const c = p.credential
    if (c?.issuer !== p.room || c?.credentialSubject?.room !== p.room) fail('credential is for another room')
    let ok = false; try { ok = verifyWith(c, p.room, 'assertionMethod') } catch {} // the room's did:key signs credentials
    if (!ok) fail('credential not signed by the room')
    let holderOk = false; try { holderOk = verifyWith(p, p.holder, 'authentication') } catch {}
    if (!holderOk || p.holder !== c.credentialSubject.id) fail('holder does not own the credential')
    let bound = false; try { bound = p.args === argsHash(args) } catch {}
    if (!bound) fail('arguments are not the ones signed')
    const t = this.now(), from = Date.parse(c.validFrom), until = Date.parse(c.validUntil)
    if (!(from <= t) || !(t < until)) fail('credential expired or not yet valid')
    const role = c.credentialSubject.role, max = role === 'agent' ? AGENT_MAX_TTL_MS : MEMBER_MAX_TTL_MS
    if (role !== 'agent' && role !== 'member') fail('unknown role')
    if (until - from > max) fail('credential lives too long')
    if (room.revoked.has(this.#h(c.id))) fail('credential revoked')
    const owner = role === 'agent' ? c.credentialSubject.delegatedBy : p.holder
    if (typeof owner !== 'string' || room.removed.has(this.#h(owner))) fail('credential revoked') // a removed member's agent stops too; same answer as a revoked one
    const scopes = c.credentialSubject.scopes ?? []
    if (role === 'agent' && scopes.some((s) => !AGENT_SCOPES.includes(s))) fail('agent scope too wide')
    if (!OPS[p.op] || !scopes.includes(OPS[p.op])) fail('not permitted')
    return { room, who: this.#h(p.room + '|' + owner), credential: c }
  }

  // an agent's notes live in its person's own room records (one notebook per person)
  #write (room, who, c, { recordId, epoch, sealed }) {
    if (typeof sealed !== 'string' || !/^[0-9a-f]+$/.test(sealed) || typeof recordId !== 'string' || !/^[\w-]{1,64}$/.test(recordId)) throw new Refused('malformed record')
    if (sealed.length / 2 > HOST_NOTE_CAP || sealed.length / 2 - 28 > MAX_NOTE_BYTES) throw new Refused('note too large')
    const prior = room.records.get(recordId)
    if (prior && prior.owner !== who) throw new Refused('not yours') // same answer as "missing"; checked before the epoch so existence doesn't leak
    if (epoch !== room.epoch) throw new Refused('stale epoch')
    const k = this.#h(c.id), now = this.now(), hits = (this.hits.get(k) ?? []).filter((x) => now - x < 60e3)
    if (hits.length >= this.writesPerMinute) { throw new Refused('too many writes') }
    hits.push(now); this.hits.set(k, hits)
    room.records.set(recordId, { owner: who, epoch, sealed, at: now })
    this.#log('write', 'ok', undefined, sealed.length / 2)
    return { ok: true }
  }
  #list (room, who) { const ids = [...room.records].filter(([, r]) => r.owner === who).map(([id, r]) => ({ recordId: id, epoch: r.epoch })); this.#log('list', 'ok', undefined, ids.length); return ids }
  #read (room, who, { recordId }) {
    const r = room.records.get(recordId)
    if (!r || r.owner !== who) throw new Refused('not yours') // same answer as "missing"
    this.#log('read', 'ok', undefined, r.sealed.length / 2)
    return { epoch: r.epoch, sealed: r.sealed }
  }

  #h (s) { return toHex(sha256(utf8(s))).slice(0, 32) }
  // Content-blind: op, outcome, reason, size or count. Nothing the person wrote, no ids, no keys.
  #log (op, outcome, reason, size) { this.events.push({ at: this.now(), op, outcome, ...(reason ? { reason } : {}), ...(size != null ? { size } : {}) }); if (this.events.length > 1000) this.events.shift() }

  /** Everything the host holds, as a string, for the "marker absent" tests. */
  dumpAll () { return JSON.stringify({ rooms: [...this.rooms].map(([d, r]) => [d, r.epoch, [...r.records], [...r.revoked]]), events: this.events, hits: [...this.hits] }) }
}
export class Refused extends Error {}
