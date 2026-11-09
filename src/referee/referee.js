// The referee: merges the room's code from the room's own signed record, with no host and no admin deciding.
// It runs on GitHub's runner, from main only (.github/workflows/room-referee.yml), every ten minutes:
//  1. it reads the room's whole record from a copy (ROOM_URL) and checks every hash link and signature itself. A
//     copy that doesn't verify is refused, so whoever serves the copy can hold a line back but can never fake one;
//  2. for each code change proposed in the room, it applies the agreed rules (rules.json on main, never a host's own
//     settings) with the same checker the room uses: agents of three different people, no veto through the window, a
//     person for the protected files, tests passed, and the pull request still at the commit they approved;
//  3. a change that passes gets the approval mark main requires from this app, and is merged. One that doesn't shows
//     why, as a pending mark on its commit, so anyone looking at the pull request sees what the room waits for.
import { verifyChain } from '../shared/chain.js'
import { State } from '../server/state.js'
import { APPROVAL_CONTEXT, Executor } from '../server/actions.js'
import { AGREED } from '../server/rules.js'

/** The record checked as the agreed rules read it: agents may approve code changes where rules.json says so. */
export const verifyRecord = (entries, opts = {}) => verifyChain(entries, { ...opts, agentsMayApprove: Boolean(AGREED.codeChanges.agentsMayApprove) })

const PAGE = 500
const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s }

/** The room's whole record, page by page, from any copy that serves /api/log. */
export async function readRecord (roomUrl, fetchImpl = fetch) {
  const base = String(roomUrl).replace(/\/+$/, ''), entries = []
  for (let after = -1; ;) {
    let page, last
    for (let attempt = 1; attempt <= 3 && !page; attempt++) { // a slow page is tried again (twice), so one hiccup doesn't cost a round
      try {
        const res = await fetchImpl(`${base}/api/log?after=${after}&limit=${PAGE}`, { signal: AbortSignal.timeout(60_000) })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        page = (await res.json()).entries ?? []
      } catch (err) { last = err; if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 2000)) }
    }
    if (!page) throw new Error(`could not read ${base}/api/log after ${after}: ${last?.message ?? 'no answer'}`)
    entries.push(...page)
    if (page.length < PAGE) return entries
    after = entries.at(-1).seq
  }
}

/** Set the approval mark on a commit, unless it already says the same. */
async function mark (gh, repo, sha, state, description, target) {
  const now = await gh('GET', `/repos/${repo}/commits/${sha}/status`).catch(() => null)
  const had = (now?.statuses ?? []).find((s) => s.context === APPROVAL_CONTEXT)
  const text = clip(description, 140)
  if (had && had.state === state && had.description === text) return false
  await gh('POST', `/repos/${repo}/statuses/${sha}`, { state, context: APPROVAL_CONTEXT, description: text, ...(target ? { target_url: target } : {}) })
  return true
}

/**
 * One round: verify the record, then decide every open code change. `gh` is GitHub, as the referee's app.
 * Returns what it decided and why, for the run's summary.
 */
export async function round ({ entries, gh, repo, branch = 'main', publicUrl = '', verify = (es) => verifyRecord(es), now = Date.now() }) {
  const report = await verify(entries)
  if (!report.ok) return { ok: false, why: `the record did not verify, so nothing was merged: ${clip(JSON.stringify(report.errors ?? report.problems ?? report).slice(0, 400), 400)}`, entries: entries.length, decisions: [] }
  const state = new State(), byHash = new Map()
  for (const e of entries) { byHash.set(e.hash, e); state.apply(e) }
  const room = String(publicUrl).replace(/\/+$/, '')
  const ex = new Executor({ config: { workspaceRepo: repo, workspaceBranch: branch, githubToken: 'the referee app', publicUrl: room, mergeHere: true }, log: { state, byHash }, board: null, gh })
  const latest = new Map() // the newest open proposal for each pull request
  for (const pr of state.proposals.values()) {
    if (pr.kind !== 'workspace-change' || !pr.change?.pr || !['open', 'approved'].includes(state.statusOf(pr))) continue
    if (!latest.has(pr.change.pr) || latest.get(pr.change.pr).seq < pr.seq) latest.set(pr.change.pr, pr)
  }
  const decisions = []
  for (const pr of [...latest.values()].sort((a, b) => a.seq - b.seq)) {
    const n = pr.change.pr, at = { pr: n, proposal: pr.hash, title: clip(pr.title, 120) }
    let why
    try { why = await ex.changeReady(pr) } catch (err) { decisions.push({ ...at, outcome: 'could not read it', why: clip(err.message, 300) }); continue }
    if (why && /^merged:/.test(why)) { decisions.push({ ...at, outcome: 'already merged' }); continue }
    if (!why) why = ex.waitingFor(pr, now)
    if (!why) {
      try { const r = await ex.mergeChange(pr); decisions.push({ ...at, outcome: 'merged', sha: r.sha, approvals: state.holding(pr).dids.length }) } catch (err) { decisions.push({ ...at, outcome: 'refused by GitHub', why: clip(err.message, 300) }) }
      continue
    }
    const never = /^failed:/.test(why), text = why.replace(/^failed:\s*/, '')
    const sha = pr.head ?? pr.change.sha
    await mark(gh, repo, sha, never ? 'failure' : 'pending', `${never ? 'Won’t merge' : 'Waiting'}: ${text}`, room ? `${room}/api/log/${pr.hash}` : null).catch(() => {})
    decisions.push({ ...at, outcome: never ? 'will not merge as it is' : 'waiting', why: clip(text, 300) })
  }
  return { ok: true, entries: entries.length, head: entries.at(-1)?.hash ?? null, decisions }
}

/** The run's summary, in plain words, for the Actions page (and anyone reading the run). */
export function summary (out, roomUrl) {
  const lines = ['## The room’s referee', '']
  if (!out.ok) return [...lines, `**Nothing merged.** ${out.why}`].join('\n')
  lines.push(`Read ${out.entries} lines of the record from ${roomUrl}; every hash link and signature checked out.`, '')
  if (!out.decisions.length) lines.push('No code change is waiting in the room.')
  for (const d of out.decisions) lines.push(`- #${d.pr} ${d.title}: **${d.outcome}**${d.sha ? ` (as ${d.sha.slice(0, 7)}, ${d.approvals} approvals)` : ''}${d.why ? `. ${d.why}` : ''}`)
  return lines.join('\n')
}
