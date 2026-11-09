// For you: what waits on one person, counted for them alone (room line 2629). It is computed on each signed
// request from what the room already holds, answered to that person only, and never written anywhere: not to
// the log, not to /api/state, not to the database. Four counts:
//   ok       lines their agents hold for their OK (drafts, from all their agents)
//   vote     open proposals they have not voted on (a vote their agent cast for them counts as theirs)
//   waiting  steps whose choice waits on them (held for them, or put to them)
//   replies  lines for them (to them, naming them, or answering them) after the last one they say they've seen
import { NAME_OF } from '../shared/types.js'
import { lineIsFor } from '../shared/presence.js'

const SCAN = 2000 // how far back unread replies are looked for: the page's own feed is shorter than this
const OPEN = ['open', 'approved']

export function forYou (ctx, did, { seenUpTo = -1 } = {}) {
  const st = ctx.log.state, me = st.participants.get(did), skip = new Set(ctx.check?.dids?.() ?? [])
  const fromCheck = (e) => skip.has(e.author) || skip.has(e.onBehalfOf)

  const agents = [...st.participants.values()].filter((p) => p.kind === 'agent' && p.principal === did && !p.removed)
  const ok = agents.map((a) => ({ agent: a.did, name: a.name ?? null, count: ctx.drafts?.list(a.did).length ?? 0 })).filter((a) => a.count)

  const vote = [...st.proposals.values()]
    .filter((pr) => OPEN.includes(st.statusOf(pr)) && !pr.votes.has(did) && !skip.has(pr.author) && !skip.has(pr.principal))
    .map((pr) => pr.hash)

  const waiting = [...st.steps.values()].filter((s) => s.waitingOn?.who === did && !s.aside).map((s) => s.id)

  const parentOf = (e) => { const t = e.document.threadId; return t ? ctx.log.byDocId.get(t)?.author ?? null : null }
  const who = { did, name: me?.name }
  const replies = ctx.log.entries.slice(-SCAN).filter((e) => e.seq > seenUpTo && !fromCheck(e) && ['note', 'propose'].includes(NAME_OF[e.type]) && lineIsFor(e, who, parentOf(e)))

  const counts = { ok: ok.reduce((n, a) => n + a.count, 0), vote: vote.length, waiting: waiting.length, replies: replies.length }
  return {
    for: did,
    counts,
    total: counts.ok + counts.vote + counts.waiting + counts.replies,
    ok, // per agent, so a tap opens the right one
    vote, // proposal hashes
    waiting, // step ids
    replies: replies.map((e) => e.seq).slice(-50),
    at: new Date().toISOString(),
  }
}
