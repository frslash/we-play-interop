// The weaver's decisions, each stored as one signed line (room line 1689: decisions agents make here are
// provisional, visible and reversible by any person). The line names who decided, for whom, why and which
// lines it rests on. A person reverses one with a decision/reverse line of their own (log.js accepts it from
// people only); the record then holds both lines, and the decision reads as reversed (state.js).
import { checkDecision } from '../shared/types.js'

const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t }
const uniq = (xs) => [...new Set(xs.filter(Boolean))]

/**
 * Write one decision line. by defaults to the weaver (the workspace); for defaults to the room. Lines it rests on
 * that are not in the log are dropped; with none left it writes nothing (a decision always rests on a line).
 */
export async function decide (log, { by, for: forWhom, what, why, rests, about }, { threadId } = {}) {
  const st = log.state
  const payload = {
    by: uniq(by?.length ? by : [st.workspace]).slice(0, 12),
    for: uniq(forWhom?.length ? forWhom : ['the room']).slice(0, 12),
    what: clip(what, 300),
    why: clip(why, 500),
    rests: uniq(rests ?? []).filter((h) => log.byHash.has(h)).slice(0, 24),
    ...(about?.ref ? { about: { kind: clip(about.kind, 40), ref: about.ref } } : {}),
  }
  if (!payload.rests.length) return null
  const bad = checkDecision(payload)
  if (bad) throw new Error(`decision: ${bad}`)
  return log.appendAsWorkspace('decision', payload, threadId ? { threadId } : {})
}

/** The person a participant speaks for: an agent's person, or the participant itself. */
export const personOf = (st, did) => (st.isAgent(did) ? st.participants.get(did)?.principal ?? did : did)

/** The decisions as the page and agents read them, newest first. */
export function decisionsView (st, { limit = 50 } = {}) {
  return [...st.decisions.values()].sort((a, b) => b.seq - a.seq).slice(0, limit).map((d) => ({
    ...d,
    byNames: d.by.map((x) => st.nameOf(x)),
    forNames: d.for.map((x) => (x === 'the room' ? x : st.nameOf(x))),
    ...(d.reversed ? { reversed: { ...d.reversed, name: st.nameOf(d.reversed.by) } } : {}),
  }))
}
