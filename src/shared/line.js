// A signed line one agent sends another through a relay neither of them runs, and the record each
// side keeps of it. The relay only carries bytes: whatever it is (a mediator, a Nostr relay, a
// mailbox), it cannot change a line without breaking the signature, and both sides name the line
// by the same hash: SHA-256 over the canonical JSON (RFC 8785) of the signed document, proof included.
// So "both copies show it with the same hash" is something anyone can check on the two records.
//
// This is not a log entry of the room: nothing here writes to the room's log. A line is a Trust Task
// document like the room's, signed with eddsa-jcs-2022 by a did:key.
import { canonicalize, sha256, toHex } from './crypto.js'
import { resolveDidKey } from './did.js'
import { verifySignature, sign } from './proof.js'
import { buildDocument, DID_RE, RFC3339 } from './types.js'
import { keyFromDidDocument } from './chain.js'

export const LINE_TYPE = 'urn:we-play-interop:tasks:spec:relay:line:0.1'
export const MAX_TEXT = 2000

/** The name both sides use for a line. */
export const lineHash = (doc) => toHex(sha256(canonicalize(doc)))

/** A signed line from `identity` (did.js newIdentity) to the DID `to`. */
export function makeLine (identity, { to, text, threadId, issuedAt } = {}) {
  if (!DID_RE.test(String(to ?? ''))) throw new Error('to: the DID of the agent the line is for')
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) throw new Error(`text: 1 to ${MAX_TEXT} characters`)
  if (to === identity.did) throw new Error('to: another agent, not yourself')
  const doc = buildDocument({ type: LINE_TYPE, issuer: identity.did, recipient: to, payload: { text }, threadId, issuedAt })
  return sign(doc, { seed: identity.seed, verificationMethod: identity.verificationMethod, created: doc.issuedAt })
}

/** Checks a line as it arrived: shape, signer and signature. Returns { ok, hash, from, to, text } or { ok: false, reason }. */
export function checkLine (doc) {
  const no = (reason) => ({ ok: false, reason })
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return no('not a JSON object')
  if (doc.type !== LINE_TYPE) return no(`type is not ${LINE_TYPE}`)
  if (!DID_RE.test(String(doc.issuer ?? ''))) return no('issuer is not a DID')
  if (!DID_RE.test(String(doc.recipient ?? ''))) return no('recipient is not a DID')
  if (doc.issuer === doc.recipient) return no('a line goes to another agent')
  if (!RFC3339.test(String(doc.issuedAt ?? ''))) return no('issuedAt is not a timestamp')
  const text = doc.payload?.text
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) return no(`payload.text: 1 to ${MAX_TEXT} characters`)
  if (!doc.issuer.startsWith('did:key:')) return no('only did:key signers are checked here')
  const proof = doc.proof ?? {}
  if (proof.created !== doc.issuedAt) return no('proof.created differs from issuedAt')
  let key
  try { key = keyFromDidDocument(resolveDidKey(doc.issuer), doc.issuer, proof.verificationMethod, proof.proofPurpose) } catch (e) { return no(e.message) }
  const sig = verifySignature(doc, key)
  if (!sig.ok) return no(sig.reason)
  return { ok: true, hash: lineHash(doc), from: doc.issuer, to: doc.recipient, text }
}

/**
 * One side's record: lines it sent or took, each once, by hash. `me` is that side's DID.
 * Adding refuses a line that does not check, or that is neither from nor to `me`.
 */
export function createRecord (me, rows = []) {
  const byHash = new Map(rows.map((r) => [r.hash, r]))
  return {
    me,
    rows: () => [...byHash.values()],
    has: (hash) => byHash.has(hash),
    get: (hash) => byHash.get(hash) ?? null,
    add (doc, { via, at = new Date().toISOString() } = {}) {
      const c = checkLine(doc)
      if (!c.ok) return c
      if (c.from !== me && c.to !== me) return { ok: false, reason: 'this line is neither from nor to this record\'s agent' }
      if (byHash.has(c.hash)) return { ...c, already: true, row: byHash.get(c.hash) }
      const row = { hash: c.hash, direction: c.from === me ? 'sent' : 'took', via: via ?? null, at, line: doc }
      byHash.set(c.hash, row)
      return { ...c, row }
    },
  }
}

/**
 * Do two records, kept by the two sides, show the same line with the same hash?
 * Each row's hash is recomputed from the line it holds, so a row cannot just claim a hash.
 */
export function sameLine (a, b, hash) {
  const ra = a.find((r) => r.hash === hash), rb = b.find((r) => r.hash === hash)
  if (!ra || !rb) return { ok: false, reason: `${!ra ? 'the first' : 'the second'} record has no line ${hash}` }
  for (const [name, r] of [['first', ra], ['second', rb]]) {
    if (lineHash(r.line) !== hash) return { ok: false, reason: `the ${name} record's line does not hash to ${hash}` }
    const c = checkLine(r.line)
    if (!c.ok) return { ok: false, reason: `the ${name} record's line does not check: ${c.reason}` }
  }
  const from = ra.line.issuer, to = ra.line.recipient
  const ends = [ra, rb].map((r) => r.direction).sort().join(',')
  if (ends !== 'sent,took') return { ok: false, reason: 'one record must have sent the line and the other taken it' }
  return { ok: true, hash, from, to, via: [ra.via, rb.via] }
}
