// P4, a wallet joins a sealed room (Keyring first, through a DIDComm out-of-band invitation).
// TEST MEMBERS AND TEST VALUES ONLY until Security's gate opens (Railroad step 3, a second implementation,
// Security's code read, Faolan's call on lost keys). Not wired into the server routes yet: this is the
// desk the routes will call. It builds on #23's out-of-band shape and P2's credentials.
//
// The QR is never membership. A scan and a good handshake make a PENDING request at the lowest role; the
// joiner reads nothing until an existing member's own tap issues the credential.
import { randomBytes, sha256, toHex, utf8 } from '../shared/crypto.js'
import { sign, verifySignature } from '../shared/proof.js'
import { issueCredential, verifyWith } from '../shared/sealed.js'

export const INVITE_MAX_MS = 3600e3 // Security P4.2: an invite lives an hour at most
export const MAX_OPEN_INVITES_PER_ROOM = 20 // P4.5
export const MAX_REDEMPTIONS_PER_MINUTE = 10 // P4.5, per room
export const MAX_MESSAGE_BYTES = 8192 // P4.6
export const JOINER_CREDENTIAL_MS = 24 * 3600e3 // short, and well under Railroad's 7-day ceiling
const MESSAGE_TYPES = ['wpi/join-request/1'] // anything else is refused; a credential offered back is never accepted
const OOB_TYPE = 'https://didcomm.org/out-of-band/2.0/invitation'
const NONCE_MS = 60e3

export class Refused extends Error {}
const hash = (s) => toHex(sha256(utf8(s)))

export class JoinDesk {
  /** room: the room's identity (did + seed). resolver: has keyFor(did, vmRef, purpose) (use the pinned, https-only, size-capped one). */
  constructor ({ room, host, resolver, now = Date.now, inviteMs = INVITE_MAX_MS } = {}) {
    if (inviteMs > INVITE_MAX_MS) throw new Error('an invite lives an hour at most')
    Object.assign(this, { room, host, resolver, now, inviteMs })
    this.invites = new Map() // sha256(token) -> { room, inviter, expiresAt, usedAt, revoked }
    this.nonces = new Map() // nonce -> expiresAt
    this.pending = new Map() // requestId -> { did, at }  (lowest role: no credential, no key)
    this.members = new Set() // DIDs a member's tap has admitted
    this.seenPersonas = new Set() // hashed DIDs ever joined here; the same DID is never admitted twice
    this.redemptions = [] // timestamps
    this.events = [] // content-blind: kind, outcome, reason. Never a token, DID or key.
  }

  /** The joiner asks for a fresh nonce to sign (P4.4). */
  challenge () { const n = toHex(randomBytes(16)); this.nonces.set(n, this.now() + NONCE_MS); return n }

  /** A member makes an invite. The token is returned ONCE and stored only as a hash. */
  invite (inviterDid) {
    const t = this.now()
    this.#sweep(t)
    if (!this.members.has(inviterDid) && !this.#seed.has(inviterDid)) throw this.#refuse('invite', 'only a member can invite')
    const open = [...this.invites.values()].filter((v) => !v.usedAt && !v.revoked && v.expiresAt > t).length
    if (open >= MAX_OPEN_INVITES_PER_ROOM) throw this.#refuse('invite', 'too many open invites')
    const token = toHex(randomBytes(16))
    this.invites.set(hash(token), { room: this.room.did, inviter: inviterDid, expiresAt: t + this.inviteMs, usedAt: null, revoked: false })
    return { token, expiresAt: new Date(t + this.inviteMs).toISOString(), invitation: oobInvitation({ roomDid: this.room.did, token, roomName: this.roomName ?? 'the room' }) }
  }
  /** The first members (test setup only; a real room's first member comes from the room's own creation). */
  #seed = new Set()
  seed (did) { this.#seed.add(did); this.members.add(did) }
  revokeInvite (token) { const v = this.invites.get(hash(token)); if (v) v.revoked = true }

  /**
   * A wallet message: { type, room, host, token, nonce, holder, proof }. Data, not a command: size cap, schema
   * check, unknown types refused, nothing auto-accepted. Returns a pending request, never a credential.
   */
  async receive (msg) {
    const t = this.now()
    this.#sweep(t)
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) throw this.#refuse('message', 'malformed')
    let size = Infinity; try { size = JSON.stringify(msg).length } catch {}
    if (size > MAX_MESSAGE_BYTES) throw this.#refuse('message', 'oversize')
    if (typeof msg.type !== 'string' || !MESSAGE_TYPES.includes(msg.type)) throw this.#refuse('message', 'unknown type')
    for (const k of ['room', 'host', 'token', 'nonce', 'holder']) if (typeof msg[k] !== 'string' || !msg[k] || msg[k].length > 2048) throw this.#refuse('message', 'malformed')
    if (!msg.proof || typeof msg.proof !== 'object') throw this.#refuse('message', 'malformed')

    this.redemptions = this.redemptions.filter((x) => t - x < 60e3)
    if (this.redemptions.length >= MAX_REDEMPTIONS_PER_MINUTE) throw this.#refuse('join', 'too many redemptions')
    this.redemptions.push(t)

    if (msg.room !== this.room.did) throw this.#refuse('join', 'invite is for another room')
    if (msg.host !== this.host) throw this.#refuse('join', 'wrong host')
    const inv = this.invites.get(hash(msg.token))
    // one answer for unknown, expired, used and revoked, so a probe learns nothing about which
    if (!inv || inv.room !== this.room.did || inv.revoked || inv.usedAt || inv.expiresAt <= t) throw this.#refuse('join', 'invite not valid')
    if (!this.members.has(inv.inviter)) throw this.#refuse('join', 'invite not valid')

    // the joiner proves it owns the DID: a fresh nonce, signed with that DID's key (never a claim)
    const exp = this.nonces.get(msg.nonce); this.nonces.delete(msg.nonce)
    if (!exp || exp < t) throw this.#refuse('join', 'nonce unknown, used or expired')
    let ok = false
    try {
      const key = await this.resolver.keyFor(msg.holder, msg.proof.verificationMethod, 'authentication')
      ok = verifySignature(msg, key).ok
    } catch { ok = false } // an unresolvable DID, a private address, a wrong key: all just "not proven"
    if (!ok) throw this.#refuse('join', 'holder does not own that DID')

    // P4.8: a fresh persona for this room, never one that was used here or is the inviter's
    const ph = hash(msg.holder)
    if (this.seenPersonas.has(ph) || msg.holder === inv.inviter) throw this.#refuse('join', 'use a fresh identity for this room')
    this.seenPersonas.add(ph); inv.usedAt = t // single use, spent on a good handshake
    const requestId = toHex(randomBytes(8))
    this.pending.set(requestId, { did: msg.holder, at: t })
    this.#log('join', 'pending')
    return { requestId, status: 'pending', role: 'none yet' }
  }

  /** An existing member's own tap. Only now is a credential issued. A joiner can't approve itself; an agent can't approve. */
  approve (requestId, approverPresentation) {
    const t = this.now()
    const p = this.pending.get(requestId)
    if (!p) throw this.#refuse('approve', 'no such request')
    const a = approverPresentation
    const exp = this.nonces.get(a?.nonce); this.nonces.delete(a?.nonce)
    if (!exp || exp < t) throw this.#refuse('approve', 'nonce unknown, used or expired')
    if (!a || a.room !== this.room.did || a.op !== 'approve_member' || a.request !== requestId) throw this.#refuse('approve', 'not an approval of this request')
    let ok = false; try { ok = verifyWith(a, a.holder) } catch {}
    if (!ok || !this.members.has(a.holder)) throw this.#refuse('approve', 'only a member can approve')
    if (a.holder === p.did) throw this.#refuse('approve', 'you cannot approve yourself')
    this.pending.delete(requestId); this.members.add(p.did)
    this.#log('approve', 'ok')
    return issueCredential(this.room, { subject: p.did, role: 'member', scopes: ['notes:read', 'notes:write'], notBefore: new Date(t), ttlMs: JOINER_CREDENTIAL_MS })
  }

  #sweep (t) {
    for (const [h, v] of this.invites) if (v.expiresAt <= t - 60e3) this.invites.delete(h)
    for (const [n, e] of this.nonces) if (e < t) this.nonces.delete(n)
    for (const [id, p] of this.pending) if (t - p.at > 24 * 3600e3) this.pending.delete(id)
    if (this.events.length > 1000) this.events.splice(0, this.events.length - 1000)
  }
  #refuse (kind, reason) { this.#log(kind, 'refused', reason); return new Refused(reason) }
  #log (kind, outcome, reason) { this.events.push({ at: this.now(), kind, outcome, ...(reason ? { reason } : {}) }) }

  /** Everything the desk holds, for the "planted string" tests. */
  dumpAll () { return JSON.stringify({ invites: [...this.invites], pending: [...this.pending], members: [...this.members], events: this.events }) }
}

/**
 * The DIDComm v2 out-of-band invitation for one invite. It carries the room's public DID and the one-time token,
 * and nothing else: no key, no member id, no email. Make the QR from it locally (no third-party QR service).
 */
export function oobInvitation ({ roomDid, token, roomName }) {
  return { type: OOB_TYPE, id: token, from: roomDid, body: { goal_code: 'join', goal: `Join ${roomName}`, accept: ['didcomm/v2'] } }
}

/** The joiner's side: a signed join request over the host's fresh nonce. */
export function joinRequest (holder, { room, host, token, nonce }) {
  const doc = { type: 'wpi/join-request/1', room, host, token, nonce, holder: holder.did }
  return sign(doc, { seed: holder.seed, verificationMethod: holder.verificationMethod, proofPurpose: 'authentication' })
}

/** A member's tap on a pending request. */
export function approval (member, { room, nonce, request }) {
  const doc = { type: 'WpiApproval', room, nonce, op: 'approve_member', request, holder: member.did }
  return sign(doc, { seed: member.seed, verificationMethod: member.verificationMethod, proofPurpose: 'authentication' })
}

/** P4.9: the join screen, in plain words, naming the room and the host's domain so a lookalike invite is spottable. */
export function joinScreenWords ({ roomName, hostDomain }) {
  return `You are asking to join "${roomName}", kept at ${hostDomain}. Check that this is the room and the address you expected. Scanning this code does not let you in: a member of the room has to say yes first, and until they do you can read nothing. The room will know you by a new name made just for it.`
}

/**
 * P4.7: a Keyring (ts-mls) leaf with no DID-signed binding stays unverified and is handed no key. Geb's
 * binding is extension 0xf002; here the binding is a signature by the member's DID over the leaf's key.
 */
export class LeafGate {
  constructor ({ desk, epochKey }) { this.desk = desk; this.epochKey = epochKey; this.verified = new Set() }
  async register ({ did, leafKey, binding }) {
    try {
      const key = await this.desk.resolver.keyFor(did, binding?.proof?.verificationMethod, 'authentication')
      const ok = verifySignature(binding, key).ok && binding.did === did && binding.leaf === leafKey && binding.room === this.desk.room.did
      if (ok && this.desk.members.has(did)) { this.verified.add(leafKey); return 'verified' }
    } catch {}
    return 'unverified' // joins the group, never promoted by default
  }
  /** The epoch key is released to a verified leaf only. */
  keyFor (leafKey) { return this.verified.has(leafKey) ? this.epochKey : null }
}
export const bindLeaf = (member, { room, leaf }) => sign({ type: 'WpiLeafBinding', room, did: member.did, leaf }, { seed: member.seed, verificationMethod: member.verificationMethod, proofPurpose: 'authentication' })
