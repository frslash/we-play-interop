// The executor: the only code that acts outside the workspace. A proposal acts
// when it has APPROVALS_REQUIRED human approvals, no veto, a quiet veto window
// since the last approval, and (in democracy) more votes for than against.
// What it may do is narrow, by the board's own rules:
//   record-run        a pull request that appends one run to dtg-interop runs.json, nothing else
//   issue             an issue on dtg-interop
//   workspace-change  merge one pull request of this workspace's repo, pinned to the approved commit
//                     (an approval names the commit it read; a later push voids it until someone approves the new one);
//                     once merged, it closes the pull requests the proposal names in change.replaces, each with
//                     the comment "Replaced by #n". It only closes them: it never deletes a branch.
// It never edits another project's files. Without GITHUB_TOKEN it prepares the
// step (a link a person can open) and says so in the log.
import { EXTERNAL_KINDS, MAX_REPLACES, checkBoardRun } from '../shared/types.js'
import { inEffect, laneOf, needAPerson, onlyOwnYes, waitingFor } from '../shared/rules.js'
import { AGREED } from './rules.js'

const API = 'https://api.github.com'
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')
const unb64 = (s) => Buffer.from(s, 'base64').toString('utf8')

export function github (token) {
  return async function gh (method, path, body) {
    const res = await fetch(API + path, {
      method,
      headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'we-play-interop', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    })
    const text = await res.text()
    const json = text ? JSON.parse(text) : null
    if (!res.ok) throw Object.assign(new Error(`GitHub ${method} ${path}: ${res.status} ${json?.message ?? ''}`), { status: res.status })
    return json
  }
}

export class Executor {
  constructor ({ config, log, board, gh = github(config.githubToken) }) { this.config = config; this.log = log; this.board = board; this.gh = gh; this.busy = false }

  /** The rules in effect in this room: the agreed data (rules.json), with what its host set. */
  rules () { return inEffect(AGREED, this.config) }

  /** The facts the rules' checker reads about a proposal. */
  facts (pr, now = Date.now()) {
    const st = this.log.state
    const held = st.holding(pr)
    const people = [...new Set([...held.dids, ...this.yesVoters(pr)])].filter((d) => st.isHuman(d)) // a person's yes in the open vote is their approval
    const owner = pr.byWeaver && pr.sources?.length ? this.log.byHash.get(pr.sources[0])?.onBehalfOf ?? pr.principal : pr.principal // a change an agent handed the room is its person's
    const backers = new Set(held.dids.map((d) => st.participants.get(d)?.principal ?? d).filter((p) => p !== owner)) // different people, never the proposer's own
    const yesTimes = [held.at, ...[...pr.votes].filter(([d, v]) => v.choice === 'for' && this.yesVoters(pr).includes(d)).map(([, v]) => v.at)].filter(Boolean).map((t) => Date.parse(t)).filter(Number.isFinite)
    return { kind: pr.kind, external: EXTERNAL_KINDS.includes(pr.kind), vetoed: pr.vetoes.length > 0, acted: Boolean(pr.outcome), lane: pr.lane ?? null, proposedAt: Date.parse(pr.at), yesTimes, people, owner, otherPeoplesAgents: backers.size, democracy: st.mode.mode === 'democracy' ? st.tally(pr) : null, now }
  }

  /** Who said yes in the vote, counted as approval. A vote names no commit, so for a code change it holds only while the pull request is still at the commit the proposal names. */
  yesVoters (pr) {
    if (pr.kind === 'workspace-change' && pr.head !== pr.change?.sha) return []
    return [...pr.votes].filter(([, v]) => v.choice === 'for').map(([d]) => d)
  }

  /** Why a proposal is (not yet) ready to act; null means ready. The rules' checker decides, from rules.json. */
  waitingFor (pr, now = Date.now()) { return waitingFor(this.rules(), this.facts(pr, now)) }

  async tick () {
    if (this.busy) return
    this.busy = true
    try {
      for (const pr of [...this.log.state.proposals.values()]) {
        if (pr.kind === 'workspace-change' && this.config.githubToken && ['open', 'approved'].includes(this.log.state.statusOf(pr))) { const why = await this.changeReady(pr).catch((e) => `could not check it: ${e.message}`); pr.notYet = why; if (why && !/^(failed|merged):/.test(why)) continue; if (/^merged:/.test(why)) { await this.log.appendAsWorkspace('result', { proposal: pr.hash, kind: pr.kind, status: 'merged', detail: why.slice(8, 500) }, { threadId: this.log.byHash.get(pr.hash).document.id }); continue } if (why) { await this.log.appendAsWorkspace('result', { proposal: pr.hash, kind: pr.kind, status: 'failed', detail: why.slice(8, 500) }, { threadId: this.log.byHash.get(pr.hash).document.id }); continue } }
        if (this.waitingFor(pr)) continue
        let result
        try { result = await this.act(pr) } catch (err) { result = { status: 'failed', detail: err.message.slice(0, 500) } }
        if (result.status !== 'failed' && onlyOwnYes(this.rules(), this.facts(pr))) result = { ...result, ownYesOnly: true, detail: `${result.detail ?? ''} (on its own person's yes alone, which the rules allow for now: an open question)`.trim() } // said openly, room lines 309-315
        await this.log.appendAsWorkspace('result', { proposal: pr.hash, kind: pr.kind, ...result }, { threadId: this.log.byHash.get(pr.hash).document.id })
      }
    } finally { this.busy = false }
  }

  provenance (pr) {
    const st = this.log.state, base = this.config.publicUrl || '(this workspace)'
    return [
      `Proposed in the We Play Interop workspace ${base} and approved there.`,
      `- proposal: log entry \`${pr.hash}\` by ${st.nameOf(pr.principal)} (${pr.principal})`,
      `- approved by: ${st.holding(pr).dids.map((d) => `${st.nameOf(d)} (${d})${pr.approvals.get(d).sha ? ` for commit ${pr.approvals.get(d).sha}` : ''}`).join(', ')}`,
      `- votes: ${JSON.stringify(st.tally(pr))}; mode ${st.mode.mode}`,
      `- verify: ${base}/api/log/${pr.hash}`,
    ].join('\n')
  }

  async act (pr) {
    if (pr.kind === 'issue') return this.issue(pr)
    if (pr.kind === 'record-run') return this.recordRun(pr)
    if (pr.kind === 'workspace-change') return this.mergeChange(pr)
    throw new Error(`nothing to do for ${pr.kind}`)
  }

  async issue (pr) {
    const repo = this.config.boardRepo, title = pr.title, body = `${pr.body}\n\n---\n${this.provenance(pr)}`
    if (!this.config.githubToken) {
      const url = `https://github.com/${repo}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body.slice(0, 6000))}`
      return { status: 'prepared', url, detail: 'No GITHUB_TOKEN is set, so nothing was opened. Anyone can open this prefilled issue.' }
    }
    const issue = await this.gh('POST', `/repos/${repo}/issues`, { title, body })
    return { status: 'opened', url: issue.html_url, detail: `issue #${issue.number}` }
  }

  /** The run as it will stand in runs.json, with reportedBy when no side proposed it. */
  boardRun (pr) {
    const run = structuredClone(pr.run)
    const err = checkBoardRun(run)
    if (err) throw new Error(err)
    const view = this.board.view
    if (!view) throw new Error('the board is not loaded yet; try again after it refreshes')
    const projects = new Set(view.projects.map((p) => p.slug))
    for (const s of run.sides) if (!projects.has(s.project)) throw new Error(`${s.project} is not a project on the board`)
    const known = { credential: view.catalog.credentials, ceremony: view.catalog.ceremonies, basic: view.catalog.basics }
    for (const s of run.subjects) if (known[s.kind] && !known[s.kind].includes(s.id)) throw new Error(`${s.kind} ${s.id} is not in the board's catalogue`)
    const mine = this.log.state.participants.get(pr.principal)?.projects ?? []
    if (!run.sides.some((s) => mine.includes(s.project))) run.reportedBy = { project: mine[0], sources: pr.sources ?? [] }
    return run
  }

  async recordRun (pr) {
    const repo = this.config.boardRepo, run = this.boardRun(pr)
    const sides = run.sides.map((s) => s.project).join(' and ')
    const title = `Run: ${sides}, ${run.subjects.map((s) => s.id).join(', ')} (${run.outcome})`
    const body = `Appends one run to \`runs.json\`, entered ${run.reportedBy ? `as reported by ${run.reportedBy.project}` : 'for one of its two sides'}.\n\n\`\`\`json\n${JSON.stringify(run, null, 2)}\n\`\`\`\n\n---\n${this.provenance(pr)}`
    if (!this.config.githubToken) {
      return { status: 'prepared', url: `https://github.com/${repo}/edit/main/runs.json`, run, detail: 'No GITHUB_TOKEN is set, so no pull request was opened. Append the run above to runs.json there (GitHub forks it for you).' }
    }
    const gh = this.gh
    const [owner, name] = repo.split('/')
    const me = (await gh('GET', '/user')).login
    // work in a fork, so the same path works with or without write access
    await gh('POST', `/repos/${repo}/forks`, { default_branch_only: true })
    for (let i = 0; i < 15; i++) { try { await gh('GET', `/repos/${me}/${name}`); break } catch { await new Promise((r) => setTimeout(r, 2000)) } }
    await gh('POST', `/repos/${me}/${name}/merge-upstream`, { branch: 'main' }).catch(() => {})
    const file = await gh('GET', `/repos/${owner}/${name}/contents/runs.json?ref=main`)
    const before = unb64(file.content)
    const parsed = JSON.parse(before)
    if (JSON.stringify(parsed, null, 2) + '\n' !== before) throw new Error('runs.json is not in the layout this workspace appends to; record this run by hand')
    const afterObj = { ...parsed, runs: [...parsed.runs, run] }
    const after = JSON.stringify(afterObj, null, 2) + '\n'
    // the guard: exactly the old runs, then this one
    if (JSON.stringify(afterObj.runs.slice(0, -1)) !== JSON.stringify(parsed.runs) || afterObj.runs.length !== parsed.runs.length + 1) throw new Error('refusing a change that is not one appended run')
    const branch = `wpi-run-${pr.hash.slice(0, 12)}`
    const forkMain = await gh('GET', `/repos/${me}/${name}/git/ref/heads/main`)
    await gh('POST', `/repos/${me}/${name}/git/refs`, { ref: `refs/heads/${branch}`, sha: forkMain.object.sha }).catch((e) => { if (e.status !== 422) throw e })
    const forkFile = await gh('GET', `/repos/${me}/${name}/contents/runs.json?ref=${branch}`)
    if (unb64(forkFile.content) !== before) throw new Error('the fork is behind the board; try again later')
    await gh('PUT', `/repos/${me}/${name}/contents/runs.json`, { message: `${run.sides[0].project}: run with ${run.sides[1].project} (${run.outcome})`, content: b64(after), sha: forkFile.sha, branch })
    const pull = await gh('POST', `/repos/${repo}/pulls`, { title, head: `${me}:${branch}`, base: 'main', body, maintainer_can_modify: true })
    return { status: 'opened', url: pull.html_url, run, detail: `pull request #${pull.number}` }
  }

  /** null when a code change may merge now; a reason it waits; or "failed: …" when it never will as it is. */
  async changeReady (pr) {
    const repo = this.config.workspaceRepo, { pr: number } = pr.change, st = this.log.state
    const pull = await this.gh('GET', `/repos/${repo}/pulls/${number}`)
    if (pull.merged_at || pull.merged) return `merged: pull request #${number} was already merged (${pull.merge_commit_sha ? `as ${pull.merge_commit_sha}` : 'outside this loop'})` // a merged pull request is GitHub-state "closed": that is done, never a failure
    if (pull.state !== 'open') return `failed: pull request #${number} is ${pull.state}`
    st.setHead(pr, pull.head.sha)
    const sha = pr.head
    if (sha !== pr.change.sha && !st.holding(pr).dids.length) return `pull request #${number} has a new commit (${sha.slice(0, 10)}): approvals of earlier commits are void until someone reads it and approves it again`
    const files = await this.gh('GET', `/repos/${repo}/pulls/${number}/files?per_page=100`)
    const names = files.map((f) => f.filename)
    const rules = this.rules()
    pr.lane = laneOf(rules, names) // the small lane, by rules.json: the page and the docs only (public/setup.js is never small)
    const touched = needAPerson(rules, names)
    if (touched.length && ![...st.holding(pr).dids, ...this.yesVoters(pr)].some((d) => st.isHuman(d))) return `it changes the room's safety (${touched.slice(0, 3).join(', ')}), so a person approves it too`
    const runs = (await this.gh('GET', `/repos/${repo}/actions/runs?head_sha=${sha}&per_page=20`)).workflow_runs ?? []
    const tests = runs.filter((r) => (r.name ?? '').toLowerCase().includes(rules.codeChanges.testsMustPass.toLowerCase()))
    if (!tests.length) return 'its tests have not run yet'
    if (tests.some((r) => r.status !== 'completed')) return 'its tests are still running'
    if (tests.some((r) => r.conclusion !== 'success')) return `failed: its tests did not pass (${tests.find((r) => r.conclusion !== 'success').html_url})`
    return null
  }

  async mergeChange (pr) {
    const repo = this.config.workspaceRepo, { pr: number } = pr.change, sha = pr.head ?? pr.change.sha // the commit the holding approvals read
    const url = `https://github.com/${repo}/pull/${number}`
    if (!this.config.githubToken) return { status: 'prepared', url, detail: `Approved in the workspace for commit ${sha}. No GITHUB_TOKEN is set; a maintainer merges it, checking the head is still ${sha}.` }
    const pull = await this.gh('GET', `/repos/${repo}/pulls/${number}`)
    if (pull.state !== 'open') throw new Error(`pull request #${number} is ${pull.state}`)
    if (pull.base?.ref && pull.base.ref !== (this.config.workspaceBranch || 'main')) throw new Error(`pull request #${number} is into ${pull.base.ref}; this room merges into ${this.config.workspaceBranch || 'main'}`)
    if (pull.head.sha !== sha) throw new Error(`pull request #${number} changed after it was approved (now ${pull.head.sha}); the approvals of ${sha.slice(0, 10)} are void, so approve the new commit or propose it`)
    // the commit status branch protection can require, so code merges only through this loop
    try { await this.gh('POST', `/repos/${repo}/statuses/${sha}`, { state: 'success', context: 'we-play-interop/approval', description: 'Approved in the workspace log', target_url: this.config.publicUrl ? `${this.config.publicUrl}/api/log/${pr.hash}` : undefined }) } catch (err) { console.warn('approval mark not set:', err.message) } // a token without commit-status rights still merges, unless the branch rules require the mark
    const merged = await this.gh('PUT', `/repos/${repo}/pulls/${number}/merge`, { sha, merge_method: 'squash', commit_title: `${pull.title} (#${number})`, commit_message: this.provenance(pr) })
    const replaced = await this.closeReplaced(pr)
    const said = [replaced.closed.length ? `closed as replaced: ${replaced.closed.map((n) => `#${n}`).join(', ')}` : null, ...replaced.skipped.map((s) => `left #${s.pr} open: ${s.why}`)].filter(Boolean)
    return { status: 'merged', url, detail: `merged as ${merged.sha}${said.length ? `; ${said.join('; ')}` : ''}`.slice(0, 500), sha: merged.sha, ...(replaced.closed.length || replaced.skipped.length ? { replaced } : {}) }
  }

  /**
   * The merge hook: after the room merged a workspace-change, close each pull request the proposal names in
   * change.replaces with the comment "Replaced by #n". The list is part of the signed proposal the room approved,
   * so nothing closes on one agent's say-so: only what a merged, approved proposal names. It only sets the pull
   * request's state to closed (anyone can reopen it); it never deletes a branch. A pull request already closed or
   * merged is left as it is. One close that fails never undoes the merge; it is reported.
   */
  async closeReplaced (pr) {
    const repo = this.config.workspaceRepo, number = pr.change?.pr, out = { closed: [], skipped: [] }
    const named = Array.isArray(pr.change?.replaces) ? [...new Set(pr.change.replaces)].filter((n) => Number.isInteger(n) && n >= 1 && n !== number) : []
    for (const n of named.slice(MAX_REPLACES)) out.skipped.push({ pr: n, why: `one merge closes at most ${MAX_REPLACES}` })
    for (const n of named.slice(0, MAX_REPLACES)) {
      try {
        const pull = await this.gh('GET', `/repos/${repo}/pulls/${n}`)
        if (pull.merged_at || pull.merged) { out.skipped.push({ pr: n, why: 'it was already merged' }); continue }
        if (pull.state !== 'open') { out.skipped.push({ pr: n, why: `it is already ${pull.state}` }); continue }
        await this.gh('POST', `/repos/${repo}/issues/${n}/comments`, { body: `Replaced by #${number}` })
        await this.gh('PATCH', `/repos/${repo}/pulls/${n}`, { state: 'closed' }) // closes only; the branch stays
        out.closed.push(n)
      } catch (err) { out.skipped.push({ pr: n, why: `could not close it (${String(err.message).slice(0, 120)})` }) }
    }
    return out
  }
}
