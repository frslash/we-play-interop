// Rebuild the room's whole record from other members' copies, with no server.
// Each copy (a mirror, an export, a file someone kept) may hold only part of the log, may be behind,
// and may be wrong. The rebuild walks the chain from the genesis, one seq at a time, and takes an
// entry only if it links to the entry before, its hash matches, and both its signatures check (the
// room's witness and the author's own proof). Copies that disagree at a seq are named, never trusted.
// Then the whole result goes through verifyChain, so every permission is checked as well.
// It passes only if the chain verifies, no signature went unchecked, no copy holds an entry past the
// rebuilt head (else part of the record is missing), and no two copies hold two different, validly
// signed entries at the same place (a fork: that needs people, not code).
// Runs anywhere: no Node-only or browser-only APIs.
import { didKeyOnly, entryCore, hashCore, verifyChain } from './chain.js'
import { canonicalize } from './crypto.js'
import { verifySignature } from './proof.js'

async function signatureProblem (signed, did, keyFor) {
  try {
    const key = await keyFor(did, signed?.proof?.verificationMethod, signed?.proof?.proofPurpose)
    if (!key) return 'its key could not be resolved here'
    const r = verifySignature(signed, key)
    return r.ok ? null : r.reason
  } catch (err) { return err.message }
}

/** Why this entry cannot be the one at `seq` after `parent`, or null when it can. */
async function entryProblem (e, seq, parent, room, keyFor) {
  if (!e || typeof e !== 'object') return 'not an entry'
  if (e.seq !== seq) return `expected seq ${seq}`
  if (e.parent !== parent) return 'parent does not point at the entry before'
  if (seq === 0 && room && e.author !== room) return 'the genesis is not by this room'
  const core = entryCore(e)
  if (hashCore(core) !== e.hash) return 'hash does not match the entry'
  const witness = await signatureProblem({ ...core, proof: e.witness }, room ?? e.author, keyFor)
  if (witness) return `witness: ${witness}`
  const proof = await signatureProblem(e.document, e.document?.issuer, keyFor)
  if (proof) return `document proof: ${proof}`
  return null
}

/**
 * copies: [{ name, entries }] where entries are log entries in any order (duplicates and gaps are fine).
 * room: the room's DID, if you know it; otherwise the genesis the copies agree on decides it.
 * Returns { ok, entries, head, room, report, fork, missing, copies: [{ name, held, used, agreesUpTo, disagreesAt, problem }] }.
 */
export async function rebuildFromCopies (copies, { keyFor = didKeyOnly, room = null } = {}) {
  const sources = copies.map((c, i) => {
    const bySeq = new Map()
    for (const e of Array.isArray(c?.entries) ? c.entries : []) if (Number.isInteger(e?.seq) && !bySeq.has(e.seq)) bySeq.set(e.seq, e)
    return { name: c?.name ?? `copy ${i + 1}`, bySeq, held: bySeq.size, used: 0, agreesUpTo: -1, disagreesAt: null, problem: null }
  })
  const out = []
  let parent = null, fork = null, workspace = room
  for (let seq = 0; ; seq++) {
    const valid = new Map() // canonical entry -> entry
    const holders = new Map() // canonical entry -> sources
    for (const s of sources) {
      const e = s.bySeq.get(seq)
      if (!e || s.disagreesAt !== null) continue
      const problem = await entryProblem(e, seq, parent, workspace, keyFor)
      if (problem) { s.disagreesAt = seq; s.problem = problem; continue }
      const k = canonicalize(e)
      valid.set(k, e); holders.set(k, [...(holders.get(k) ?? []), s])
    }
    if (!valid.size) break
    if (valid.size > 1) {
      fork = { seq, versions: [...holders.values()].map((hs) => hs.map((s) => s.name)) }
      for (const hs of holders.values()) for (const s of hs) { s.disagreesAt = seq; s.problem = 'two copies hold different, validly signed entries here (a fork)' }
      break
    }
    const [[k, e]] = valid
    for (const s of holders.get(k)) { s.used++; s.agreesUpTo = seq }
    if (seq === 0) workspace = workspace ?? e.author
    out.push(e); parent = e.hash
  }
  const report = await verifyChain(out, { keyFor })
  // Whole means: no copy holds an entry past the rebuilt head. A copy that is further along but could not be
  // followed (a gap nobody fills, or entries that do not check) means part of the record is missing.
  const furthest = Math.max(-1, ...sources.flatMap((s) => [...s.bySeq.keys()]))
  const missing = furthest > out.length - 1 ? { from: out.length, to: furthest } : null
  const ok = out.length > 0 && report.ok && report.signaturesNotChecked === 0 && !fork && !missing
  return {
    ok,
    entries: out,
    head: report.head,
    room: workspace,
    report,
    fork,
    missing,
    copies: sources.map(({ bySeq, ...s }) => s),
  }
}
