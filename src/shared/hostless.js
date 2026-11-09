// No host: lines that members' own agents add and pass to each other directly, with no server
// in the middle, and an order every copy agrees on.
//
// Each line is a signed document (eddsa-jcs-2022, a did:key issuer). It names the lines its
// author had already seen when writing it (`after`, the heads of their copy), so the lines form
// a graph that only grows. Its id is the hash of the whole signed line.
//
// The order is a function of the set of lines alone, never of when or in what order a copy
// received them: a line comes after every line it names; among lines that are free to go next,
// the one with the lowest depth goes first (depth = 1 + the deepest line it names), then the
// lowest id. So two members who add a line at the same moment, each without seeing the other's,
// end up in the same order in every copy once their copies have each other's lines.
//
// The carrier is not here: anything that moves JSON between two agents will do (a project's own
// messaging, a file, a relay). `missing` and `wanted` say what to send. Who may write is a list of
// member DIDs the copy is given; how members agree on that list is outside this file.
//
// The order can be gamed by any member. It is agreed, not fair. A member chooses what their line
// names: by naming fewer or older lines than they have seen, they lower its depth and can put it
// before lines they already saw. Among lines of the same depth the lowest id goes first, and a
// member can re-sign a line (another `created`, a space in the text) until its id is low, to go
// ahead of others' lines written at the same moment. Nothing here can tell a line written in
// good faith from one placed on purpose. So nothing that matters (who was first, who wins a
// tie, a vote's outcome) should rest on this order alone.
//
// A copy holds at most `maxWaiting` lines that wait for earlier lines it does not have, so a
// member cannot fill another's memory with lines that name lines never sent. Past the cap,
// such lines are refused; send the earlier ones first. Lines whose earlier lines are all here
// are always taken.
import { canonicalize, sha256, toHex } from './crypto.js'
import { multikeyToEd25519 } from './did.js'
import { sign, verifySignature } from './proof.js'

export const LINE_TYPE = 'wpi/hostless-line/v1'
export const MAX_LINE_CHARS = 4000
export const MAX_AFTER = 64
export const MAX_WAITING = 1000

export const lineId = (line) => toHex(sha256(canonicalize(line)))

const didKeyPublic = (did) => {
  const m = /^did:key:(z[1-9A-HJ-NP-Za-km-z]+)$/.exec(did)
  if (!m) throw new Error('the issuer is not a did:key')
  return { publicKey: multikeyToEd25519(m[1]), vm: did + '#' + m[1] }
}

/** Why a line cannot be taken as it is, or null. Checks shape and signature only (not membership or parents). */
export function lineProblem (line) {
  if (!line || typeof line !== 'object' || Array.isArray(line)) return 'not an object'
  if (line.type !== LINE_TYPE) return 'not a hostless line'
  if (typeof line.room !== 'string' || !line.room) return 'no room'
  if (typeof line.text !== 'string' || !line.text.trim()) return 'no text'
  if (line.text.length > MAX_LINE_CHARS) return `text longer than ${MAX_LINE_CHARS} characters`
  if (!Array.isArray(line.after) || line.after.length > MAX_AFTER || line.after.some((h) => !/^[0-9a-f]{64}$/.test(h))) return 'after is not a list of line ids'
  if (new Set(line.after).size !== line.after.length || line.after.some((h, i) => i && line.after[i - 1] >= h)) return 'after is not sorted and unique'
  let key
  try { key = didKeyPublic(line.issuer) } catch (e) { return e.message }
  if (line.proof?.verificationMethod !== key.vm) return 'signed with a key that is not the issuer’s'
  const r = verifySignature(line, key.publicKey)
  return r.ok ? null : r.reason
}

/** One member's copy of a room's lines. */
export class Copy {
  constructor ({ room, members, me = null, now = () => new Date().toISOString(), maxWaiting = MAX_WAITING }) {
    this.room = room
    this.maxWaiting = maxWaiting
    this.members = new Set(members)
    this.me = me // { seed, did, verificationMethod } when this copy can write
    this.now = now
    this.lines = new Map() // id -> line, every line taken
    this.waiting = new Map() // id -> line, signed and from a member, but naming lines not here yet
    this.depth = new Map() // id -> depth
  }

  /** Lines no other line here names: what a new line will name. */
  heads () {
    const named = new Set()
    for (const l of this.lines.values()) for (const h of l.after) named.add(h)
    return [...this.lines.keys()].filter((id) => !named.has(id)).sort()
  }

  /** What a new line names: every head, or, past MAX_AFTER, the MAX_AFTER lowest ids. The rest stay heads and the next line names them. */
  nextAfter () {
    return this.heads().slice(0, MAX_AFTER)
  }

  /** Add a line of my own. Returns the signed line, to hand to the others. */
  add (text) {
    if (!this.me) throw new Error('this copy has no key to write with')
    const unsigned = { type: LINE_TYPE, room: this.room, issuer: this.me.did, text: String(text), after: this.nextAfter(), created: this.now() }
    const line = sign(unsigned, { seed: this.me.seed, verificationMethod: this.me.verificationMethod, created: unsigned.created })
    const r = this.receive(line)
    if (!r.ok) throw new Error(r.reason)
    return line
  }

  /** Take a line from anyone. Lines naming lines not here yet wait until those arrive. */
  receive (line) {
    const problem = lineProblem(line)
    if (problem) return { ok: false, reason: problem }
    if (line.room !== this.room) return { ok: false, reason: 'a line of another room' }
    if (!this.members.has(line.issuer)) return { ok: false, reason: 'the issuer is not a member' }
    const id = lineId(line)
    if (this.lines.has(id)) return { ok: true, id, already: true }
    if (this.waiting.has(id)) return { ok: true, id, already: true, waiting: true }
    const ready = line.after.every((h) => this.lines.has(h))
    if (!ready && this.waiting.size >= this.maxWaiting) {
      return { ok: false, reason: `too many lines waiting for earlier lines (${this.maxWaiting}); send the earlier lines first` }
    }
    this.waiting.set(id, line)
    this.#settle()
    return { ok: true, id, waiting: this.waiting.has(id) }
  }

  #settle () {
    let moved = true
    while (moved) {
      moved = false
      for (const [id, line] of this.waiting) {
        if (!line.after.every((h) => this.lines.has(h))) continue
        this.waiting.delete(id)
        this.lines.set(id, line)
        this.depth.set(id, 1 + Math.max(0, ...line.after.map((h) => this.depth.get(h))))
        moved = true
      }
    }
  }

  /** Line ids still wanted: named by a waiting line but not here. */
  wanted () {
    const want = new Set()
    for (const l of this.waiting.values()) for (const h of l.after) if (!this.lines.has(h) && !this.waiting.has(h)) want.add(h)
    return [...want].sort()
  }

  /** The lines I have that a copy holding `theirIds` lacks. */
  missing (theirIds) {
    const have = new Set(theirIds)
    return this.order().filter((l) => !have.has(lineId(l)))
  }

  /** Every line, in the order every copy with the same lines agrees on. */
  order () {
    const ready = [], out = [], left = new Map()
    const children = new Map()
    for (const [id, l] of this.lines) {
      left.set(id, l.after.length)
      for (const h of l.after) { if (!children.has(h)) children.set(h, []); children.get(h).push(id) }
      if (!l.after.length) ready.push(id)
    }
    const before = (a, b) => (this.depth.get(a) - this.depth.get(b)) || (a < b ? -1 : a > b ? 1 : 0)
    while (ready.length) {
      ready.sort(before)
      const id = ready.shift()
      out.push(this.lines.get(id))
      for (const c of children.get(id) ?? []) { left.set(c, left.get(c) - 1); if (left.get(c) === 0) ready.push(c) }
    }
    return out
  }

  ids () { return [...this.lines.keys()].sort() }
}

/** Two copies meet (over any carrier) and each takes what the other has. Returns how many lines moved each way. */
export function exchange (a, b) {
  const toB = a.missing(b.ids()), toA = b.missing(a.ids())
  for (const l of toB) b.receive(structuredClone(l))
  for (const l of toA) a.receive(structuredClone(l))
  return { toA: toA.length, toB: toB.length }
}
