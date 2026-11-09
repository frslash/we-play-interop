// Votes close. A proposal that is not a goal (goals stay open: they are what the room keeps going for)
// and not a change outside the room (those wait for approvals and a veto window of their own) closes
// VOTE_MINUTES after it was made. The room then says the outcome in the conversation and names whoever
// has to act on it: the people and agents named in it, their agents, and whoever proposed it. A name in
// a line wakes that agent, so the work does not wait for someone to notice.
import { EXTERNAL_KINDS } from '../shared/types.js'
import { AGREED } from './rules.js'
import { mentions } from './views.js'

/**
 * A pause vote, counted by side: a person and their agents are one side (the person's own vote decides it), and the
 * side being paused doesn't count. It passes with at least rules.pauses.sidesNeeded sides for and more for than against.
 */
export function pauseSides (st, pr) {
  const sideOf = (did) => st.participants.get(did)?.principal ?? did
  const target = sideOf(pr.target), bySide = new Map()
  for (const [voter, v] of pr.votes) {
    const side = sideOf(voter), human = st.isHuman(voter), had = bySide.get(side)
    if (side === target) continue
    if (!had || (human && !had.human)) bySide.set(side, { choice: v.choice, human })
  }
  const count = (c) => [...bySide.values()].filter((x) => x.choice === c).length
  return { for: count('for'), against: count('against'), abstain: count('abstain') }
}

/** Who has to act on a proposal: everyone it names (people bring their agents along), and its proposer. */
export function partiesOf (st, pr, skip = []) {
  const text = `${pr.title} ${pr.body ?? ''}`, out = new Set()
  const live = [...st.participants.values()].filter((p) => p.kind !== 'workspace' && !p.removed && !skip.includes(p.did))
  const withAgents = (did) => { out.add(did); for (const a of live) if (a.kind === 'agent' && a.principal === did && st.activeDelegation(a.did)) out.add(a.did) }
  for (const p of live) if (p.name && mentions(text, p.name)) (p.kind === 'human' ? withAgents(p.did) : out.add(p.did))
  if (!pr.byWeaver) { out.add(pr.author); if (pr.principal && pr.principal !== pr.author) out.add(pr.principal) }
  return [...out]
}

/** Close what is due, oldest first, at most `max` a call (the timer runs every 30 s, so a backlog arrives as a trickle, not a burst). */
export async function closeVotes (ctx, now = Date.now(), { max = 1 } = {}) {
  const st = ctx.log.state, minutes = ctx.config.voteMinutes ?? 10, closed = []
  for (const pr of [...st.proposals.values()].sort((a, b) => a.seq - b.seq)) {
    if (closed.length >= max) break
    const needsPeople = EXTERNAL_KINDS.includes(pr.kind) && /human approval|a person approves/.test(`${ctx.executor?.waitingFor(pr) ?? ''} ${pr.notYet ?? ''}`)
    if (pr.kind === 'goal' || (EXTERNAL_KINDS.includes(pr.kind) && !needsPeople) || !['open', 'approved'].includes(st.statusOf(pr))) continue
    const pause = pr.kind === 'pause', rule = AGREED.pauses // a pause stays open longer, so the person affected can see it and answer
    if (now - Date.parse(pr.at) < (pause ? rule.openHours * 3_600_000 : minutes * 60_000)) continue
    const t = pause ? pauseSides(st, pr) : st.tally(pr), agreed = pause ? t.for >= rule.sidesNeeded && t.for > t.against : t.for > t.against, threadId = ctx.log.byHash.get(pr.hash)?.document.id
    const count = pause ? `${t.for} side${t.for === 1 ? '' : 's'} for, ${t.against} against, ${rule.sidesNeeded} needed (${st.nameOf(pr.target)}’s own side not counted)` : `${t.for} yes, ${t.against} no${t.abstain ? `, ${t.abstain} abstaining` : ''}`
    await ctx.log.appendAsWorkspace('result', { proposal: pr.hash, kind: pr.kind, status: agreed ? 'agreed' : 'not agreed', detail: `${count}, after ${pause ? `${rule.openHours} hours` : `${minutes} minutes`}` }, { threadId })
    const names = partiesOf(st, pr, ctx.check?.dids() ?? []).map((d) => st.nameOf(d))
    const text = agreed && pause
      ? `Agreed (${count}): ${pr.title} ${st.nameOf(pr.target)} is paused: the room takes no new lines from them until the checks to come back pass (they open on the Steps tab).`
      : agreed
      ? `Agreed (${count}): ${pr.title}${names.length ? ` ${names.join(', ')}: this is yours to take on now. Say here when it is done, or what stands in the way.` : ''}`
      : t.for + t.against === 0
        ? `No one voted on: ${pr.title}${names.length ? ` ${names.join(', ')}: propose it again if it still matters.` : ''}`
        : `Not agreed (${count}): ${pr.title}${names.length ? ` ${names.join(', ')}: propose it again, changed, if it still matters.` : ''}`
    await ctx.log.appendAsWorkspace('note', { text: text.slice(0, 2000), kind: 'message' }, { threadId })
    closed.push({ proposal: pr.hash, agreed, parties: names.length })
  }
  return closed
}
