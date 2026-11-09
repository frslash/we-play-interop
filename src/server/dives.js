// Closer looks (deep dives) when agents disagree. When agents of different people vote both ways on the same
// open proposal, or the weaver's model names a conflict between two participants, the weaver opens one: it names
// the exact point as one checkable question, names both sides (a name in a line wakes that agent) and asks each
// for its evidence (a spec, a test or a run, not an opinion) and the one check that would settle it. Each later
// round it reads the dive's thread and ends it as one of three: agreed; different premises, with both claims
// recorded; or handed to the people involved, with what is known and what is still a choice.
// It is an add-on to rounds: nothing waits for it, and proposals keep closing on their own schedule.
// Its state is its own two lines in the log (state.js folds them), so a restart brings it back as it was.
import { NAME_OF } from '../shared/types.js'

const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s }
// A few rounds at most. Three of the weaver's rounds (about half an hour at its default pace) leave time for each
// side to bring its evidence and for the other to check it. Past that, a dive costs the room's attention and holds a
// decision in the air, so it goes to the people involved instead of running on.
export const DIVE_ROUNDS = 3
const NEW_PER_ROUND = 1 // a room looks closely at one thing at a time; another split waits for the next round (it is still there)
const THREAD_LINES = 20 // what the model reads of a dive's thread: enough for a short exchange of evidence, not a whole debate
const OUTCOMES = ['agreed', 'different premises', 'handed to people']

export const DIVE_PROMPT = `Closer looks ("deepDives"): when two participants of different people disagree on a point, put "between":["<did from inRoom>","<did from inRoom>"] and "question":"<the exact point as one question a check could answer>" in that conflict; a closer look opens for it. Do not report a conflict that is already in deepDives. For each one in deepDives.open, read its thread and judge it in one more field, "dives":[{"id":"<its id>","outcome":"open|agreed|different premises|handed to people","known":"<what the evidence shows, one or two sentences>","choice":"<what is still a choice, if anything>","claims":[{"who":"<did>","claim":"<that side's claim and what would show it>"}]}]. agreed: the evidence or the votes now agree. different premises: each side holds from where it starts; give both claims. handed to people: no check settles it; say what is known and what is still a choice. open: still going (it ends on its own after its last round). Judge on evidence (a spec, a test, a run), never on who says more.`

const person = (st, did) => st.participants.get(did)?.principal ?? did
const isOpen = (st, pr) => ['open', 'approved'].includes(st.statusOf(pr))
const named = (st, did) => { const n = st.nameOf(did), p = st.participants.get(did)?.principal; return p && !n.includes(st.nameOf(p)) ? `${n} (for ${st.nameOf(p)})` : n }

/** Open proposals where agents of different people vote both for and against, the freshest split first. */
export function splits (st, skip = []) {
  const out = []
  for (const pr of st.proposals.values()) {
    if (!isOpen(st, pr)) continue
    const side = (choice) => [...pr.votes.values()].filter((v) => v.choice === choice && st.isAgent(v.by) && !st.participants.get(v.by).removed && !skip.includes(v.by)).map((v) => v.by)
    const yes = side('for'), no = side('against') // votes count once per person, so the two sides are always different people
    if (yes.length && no.length) out.push({ pr, sides: [{ stance: 'for', who: yes }, { stance: 'against', who: no }], last: Math.max(...[...pr.votes.values()].map((v) => v.seq)) })
  }
  return out.sort((a, b) => b.last - a.last)
}

/** What was said about a dive since it opened: replies in its thread, and for a proposal, in the proposal's thread too. */
function threadOf (log, d) {
  const st = log.state, other = d.proposal ? log.byHash.get(d.proposal)?.document.id : null
  return log.entries.slice(d.seq + 1).filter((e) => NAME_OF[e.type] === 'note' && e.author !== st.workspace && (e.document.threadId === d.thread || (other && e.document.threadId === other)))
}

/** For the model: the open dives (the point, the sides and their votes, how far along, the thread) and the last few that ended. */
export function diveContext (log) {
  const st = log.state, round = st.roundCount + 1, all = [...st.dives.values()]
  const open = all.filter((d) => !d.outcome).map((d) => {
    const pr = d.proposal ? st.proposals.get(d.proposal) : null
    const who = (did) => { const v = pr?.votes.get(person(st, did)); return { did, name: st.nameOf(did), ...(v ? { vote: v.choice, ...(v.reason ? { reason: clip(v.reason, 300) } : {}) } : {}) } }
    return {
      id: d.hash, question: d.question, round: round - d.round, of: DIVE_ROUNDS,
      ...(pr ? { proposal: { hash: pr.hash, title: pr.title, status: st.statusOf(pr) } } : {}),
      sides: d.sides.map((s) => ({ ...(s.stance ? { stance: s.stance } : {}), who: s.who.map(who) })),
      thread: threadOf(log, d).slice(-THREAD_LINES).map((e) => ({ entry: e.hash, who: st.nameOf(e.author), text: clip(e.document.payload.text, 500), ...(e.document.payload.tech ? { technical: clip(e.document.payload.tech, 500) } : {}) })),
    }
  })
  return { open, ended: all.filter((d) => d.outcome).slice(-3).map((d) => ({ question: d.question, outcome: d.outcome })) }
}

/** A conflict's two named sides (participants of different people the weaver hears) and its point as a question, when the model gave them. */
export function conflictSides (st, c, skip = []) {
  const ok = (d) => typeof d === 'string' && st.participants.has(d) && d !== st.workspace && !skip.includes(d)
  const between = Array.isArray(c?.between) && c.between.length === 2 && c.between.every(ok) && person(st, c.between[0]) !== person(st, c.between[1])
  return { ...(between ? { between: c.between } : {}), ...(typeof c?.question === 'string' && c.question.trim() ? { question: clip(c.question, 300) } : {}) }
}

/** The model's judgments, kept only for an open dive with a known outcome; different premises needs both sides' claims. */
export function sanitizeDives (st, judged) {
  if (!Array.isArray(judged)) return []
  return judged.slice(0, 12).map((j) => {
    const d = typeof j?.id === 'string' ? st.dives.get(j.id) : null
    if (!d || d.outcome || ![...OUTCOMES, 'open'].includes(j.outcome)) return null
    const claims = (Array.isArray(j.claims) ? j.claims : []).slice(0, 6).filter((c) => typeof c?.who === 'string' && st.participants.has(c.who) && c.who !== st.workspace && typeof c.claim === 'string' && c.claim.trim()).map((c) => ({ who: c.who, claim: clip(c.claim, 300) }))
    if (j.outcome === 'different premises' && new Set(claims.map((c) => person(st, c.who))).size < 2) return null // both claims, or it is not that
    return { id: d.hash, outcome: j.outcome, known: clip(j.known, 500), choice: clip(j.choice, 300), claims }
  }).filter(Boolean)
}

/** The plain rule, model or not: the two sides no longer vote against each other → agreed; otherwise, at its last round → to the people. */
function byRule (st, d, over) {
  const pr = d.proposal ? st.proposals.get(d.proposal) : null
  if (pr) {
    const choices = new Set(d.sides.flatMap((s) => s.who).map((a) => pr.votes.get(person(st, a))?.choice))
    if (!(choices.has('for') && choices.has('against'))) return { outcome: 'agreed', by: 'rule' }
  }
  return over ? { outcome: 'handed to people', by: 'rule' } : null
}

function openText (st, c, pr) {
  const who = (s) => s.who.map((a) => { const r = pr?.votes.get(person(st, a))?.reason; return named(st, a) + (r ? `, who says "${clip(r, 160)}"` : '') }).join('; ')
  const stance = Boolean(c.sides[0].stance)
  return [
    `${stance ? 'A closer look, since agents disagree.' : `A closer look, since ${who(c.sides[0])} and ${who(c.sides[1])} differ.`} The point: ${c.question}`,
    stance ? `For: ${who(c.sides[0])}. Against: ${who(c.sides[1])}.` : '',
    `Each side: answer in this thread with your evidence (a spec, a test or a run, not an opinion) and the one check that would settle it. If no check can, it goes to the people involved. This lasts at most ${DIVE_ROUNDS} of the weaver's rounds and holds nothing up${pr ? ': the vote closes on its own time' : ''}.`,
  ].filter(Boolean).join('\n').slice(0, 2000)
}

function endText (log, d, end) {
  const st = log.state, pr = d.proposal ? st.proposals.get(d.proposal) : null
  if (end.outcome === 'agreed') {
    const now = new Set(d.sides.flatMap((s) => s.who).map((a) => pr?.votes.get(person(st, a))?.choice).filter((c) => c === 'for' || c === 'against'))
    const votes = now.size === 1 ? `Both sides now vote ${now.has('for') ? 'yes' : 'no'}.` : 'The two sides no longer vote against each other.'
    return `Agreed: ${d.question} ${end.known || votes}`.slice(0, 2000)
  }
  if (end.outcome === 'different premises') return [`Different premises, both recorded: ${d.question}`, ...end.claims.map((c) => `${named(st, c.who)}: ${c.claim}`), end.known].filter(Boolean).join('\n').slice(0, 2000)
  const said = threadOf(log, d).length, t = pr ? st.tally(pr) : null
  const known = end.known || `${t ? `The vote stands at ${t.for} yes, ${t.against} no. ` : ''}${said ? `${said} ${said === 1 ? 'line was' : 'lines were'} said here` : 'Nobody answered here'}, and no check settled it within ${DIVE_ROUNDS} rounds.`
  const choice = end.choice || (pr ? (isOpen(st, pr) ? `whether "${pr.title}" goes ahead.` : `whether to take "${pr.title}" up again (its vote closed: ${st.statusOf(pr)}).`) : 'which way to go.')
  const people = [...new Set(d.sides.flatMap((s) => s.who).map((a) => person(st, a)))].map((p) => st.nameOf(p))
  return [`For the people involved: ${d.question}`, `What is known: ${known}`, `What is still a choice: ${choice}`, `${people.join(', ')}: this is yours to decide.`].join('\n').slice(0, 2000)
}

/**
 * One round's work: judge the open dives (the model's view when it gave one, the plain rule otherwise) and end the
 * settled ones, then open new ones. Returns what each dive did this round, for the round's own record.
 */
export async function runDives (weaver, { round, judged = [], conflicts = [] }) {
  const log = weaver.log, st = log.state, skip = weaver.skip(), out = []
  const note = (d, did, by) => ({ dive: d, did, by, question: clip(st.dives.get(d)?.question, 200) })
  for (const d of [...st.dives.values()].filter((x) => !x.outcome && x.round < round)) {
    const k = round - d.round, over = k >= DIVE_ROUNDS, j = judged.find((x) => x.id === d.hash)
    const end = j ? (j.outcome !== 'open' ? { ...j, by: 'model' } : over ? { ...j, outcome: 'handed to people', by: 'model' } : null) : byRule(st, d, over)
    if (!end) { out.push({ ...note(d.hash, 'open', j ? 'model' : 'rule'), round: k, of: DIVE_ROUNDS }); continue }
    const record = { of: d.hash, outcome: end.outcome, by: end.by, ...(end.known ? { known: end.known } : {}), ...(end.choice ? { choice: end.choice } : {}), ...(end.claims?.length ? { claims: end.claims } : {}) }
    await log.appendAsWorkspace('note', { text: endText(log, d, end), kind: 'message', dive: record }, { threadId: d.thread })
    out.push({ ...note(d.hash, end.outcome, end.by), round: k, of: DIVE_ROUNDS })
  }
  // new ones: vote splits first (they need no model), then the conflicts the model named between two people
  const candidates = splits(st, skip).map((s) => ({ key: `proposal:${s.pr.hash}`, proposal: s.pr.hash, sides: s.sides, from: 'votes', question: conflicts.find((c) => c.question && c.entries?.includes(s.pr.hash))?.question ?? `Should "${s.pr.title}" go ahead?` }))
  for (const c of conflicts) {
    if (!c.between) continue
    const pr = (c.entries ?? []).map((h) => st.proposals.get(h)).find((p) => p && isOpen(st, p))
    const key = pr ? `proposal:${pr.hash}` : `people:${c.between.map((x) => person(st, x)).sort().join('|')}`
    candidates.push({ key, proposal: pr?.hash ?? null, sides: [{ who: [c.between[0]] }, { who: [c.between[1]] }], from: 'model', question: c.question ?? clip(c.point, 300), entries: c.entries ?? [] })
  }
  for (const c of candidates) {
    if (out.filter((x) => x.did === 'opened').length >= NEW_PER_ROUND) break
    const before = [...st.dives.values()].filter((d) => d.key === c.key)
    if (before.some((d) => !d.outcome)) continue // never two on one question at a time
    // a proposal gets one closer look; the same two people get another only over something said since their last one ended
    if (before.length && (c.proposal || !c.entries.some((h) => log.byHash.get(h)?.seq > Math.max(...before.map((d) => d.endedSeq))))) continue
    const pr = c.proposal ? st.proposals.get(c.proposal) : null
    const e = await log.appendAsWorkspace('note', { text: openText(st, c, pr), kind: 'question', dive: { key: c.key, question: c.question, proposal: c.proposal, sides: c.sides, round, from: c.from } })
    out.push({ ...note(e.hash, 'opened', c.from), round: 0, of: DIVE_ROUNDS })
  }
  return out
}
