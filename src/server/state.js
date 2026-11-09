// The workspace's current state, folded from the log entry by entry.
// Nothing here is stored on its own: restart, replay the log, same state.
import { checkPermissionCredential, claimsOf, grantMismatch } from '../shared/credential.js'
import { DEFAULT_MODE, NAME_OF, resourceKey } from '../shared/types.js'

// The newest notes on one resource the room shows and hands to agents: enough to see what each project found in it,
// not a history (that is the log, which keeps every note).
const RESOURCE_NOTES_KEPT = 40

// What a grant's credential says: its signature was verified when the grant was appended (log.js).
// null for a grant without one, and for one that is not well formed (never a crash on replay).
function credentialOf (doc, room) {
  const c = doc.payload.credential
  if (!c || checkPermissionCredential(c)) return null
  const claims = claimsOf(c)
  return grantMismatch(claims, doc, room) ? null : claims
}

/** Whether a step is about the room's own code: its result is a pull request, or its words say so. */
export const isCodeStep = (s) => (s?.evidence ?? []).some((x) => /\/pull\/\d+|\/api\/pulls\/\d+/.test(x?.url ?? '')) || /\b(pull request|the room['’]s (own )?code|room code)\b/i.test(`${s?.title ?? ''} ${s?.done ?? ''}`)

// tasks are kept while open; done ones beyond this many are let go first (a few weeks of a busy room's asks)
const TASKS_KEPT = 2000
// the weaver's task line reads "Name: what to do (asked by Name)" for the room; the list shows just what to do
const taskWords = (text, byWeaver) => (byWeaver && /^[^:\n]{1,80}: ([\s\S]+?) \(asked by [^()\n]{1,80}\)$/.exec(text)?.[1]) || text

export class State {
  constructor () {
    this.workspace = null // the workspace DID (author of the genesis)
    this.genesis = null
    this.participants = new Map() // did -> { did, kind, name, projects, about, since, principal? }
    this.delegations = new Map() // entry hash -> { hash, issuer, delegate, scope, label, expiresAt, revoked, endedBy, seq, credential }
    this.proposals = new Map() // entry hash -> proposal (see addProposal)
    this.mode = { mode: DEFAULT_MODE, by: null, seq: null }
    this.rounds = [] // the last 20 rounds
    this.roundCount = 0
    this.lastRoundSeq = -1
    this.lastRoundAt = 0
    this.score = null // latest score snapshot payload
    this.scoreHistory = [] // compact score history from every snapshot
    this.mapProjects = new Map() // slug -> project the workspace added or extended
    this.links = new Map() // hash -> a request to link an old name to a new key: { hash, from, old, why, at, vouches: Map(person -> { at, hash }), replacedAt }
    this.tasks = new Map() // task line hash -> { hash, for, by, from, text, at, thread, doneAt, doneBy, doneText }: what someone was asked to do, until they say they did
    this.taskFrom = new Set() // lines already turned into a task (the weaver makes one per line)
    this.mapWays = new Map() // id -> a way of doing interop, defined in the workspace
    this.mapRuns = [] // runs recorded in the workspace
    this.resources = new Map() // resourceKey(url) -> a source someone added to the Resources tab, and the notes on it
    this.hosted = new Set() // agent DIDs whose key the workspace holds (shown to everyone)
    this.away = new Map() // agent DID -> what it answers while its person is away (public: everyone can see an agent answers on its own)
    this.dives = new Map() // opening entry hash -> a closer look the weaver opened where agents disagree (see dive)
    // the facilitator's board (facilitator.js): the steps being worked, the latest finished ones, and a tally per UTC day.
    // Finished steps leave the active set, so it stays as small as the work in hand; the log keeps every line.
    this.steps = new Map() // step id (the hash of its first line) -> the step as it stands
    this.stepsDone = [] // the latest steps checked or set aside (newest last, at most 30)
    this.stepDays = new Map() // 'YYYY-MM-DD' -> { opened, claimed, resulted, checked, toResultMs: [agreement to first result] } (the last 60 days)
    this.stepOf = new Map() // a proposal, closer look or line a step came from -> the step (the latest 5000)
    this.stepsHeard = -1 // the last line the board acted on (the facilitator listens on from there after a restart)
    this.stepsSince = null // when the board's first line was written: agreements from before it are not turned into steps
    this.pressed = new Set() // lines the facilitator asked to be made exact (the latest 200)
    this.testAsked = new Map() // goal -> when the facilitator last asked for its done-test
    this.lastReport = null // { at, seq } of the facilitator's latest report
    // the weaver's memory of who does what (one record per agent, so it stays as small as the room): what each agent said it
    // is not here for (it fades, see facilitator.js), and the steps it took, the results it posted and the checks it made
    this.notFor = new Map() // agent -> { kinds, onlyFor, at, because }
    this.doers = new Map() // agent -> { took, results, checks, code: { took, results, checks }, at }
    this.counts = {}
    this.seq = -1
  }

  membersOf (slug) { return [...this.participants.values()].filter((p) => p.kind === 'human' && p.projects?.includes(slug)) }
  isAgent (did) { return this.participants.get(did)?.kind === 'agent' }
  isHuman (did) { return this.participants.get(did)?.kind === 'human' }
  nameOf (did) { return this.participants.get(did)?.name ?? (did === this.workspace ? 'the weaver' : did.slice(0, 18) + '…') }

  /** The live delegation a given agent holds, if any. */
  activeDelegation (agent, now = Date.now()) {
    let best = null
    if (this.participants.get(agent)?.removed) return null
    for (const d of this.delegations.values()) if (d.delegate === agent && !d.revoked && Date.parse(d.expiresAt) > now && (!best || d.seq > best.seq)) best = d
    return best
  }

  apply (e) {
    const doc = e.document, p = doc.payload, name = NAME_OF[e.type]
    this.seq = e.seq
    this.counts[name] = (this.counts[name] ?? 0) + 1
    const by = this.participants.get(e.author)
    if (by?.kind === 'agent') { by.firstSaid ??= e.timestamp; by.lastSaid = e.timestamp } // when an agent first arrived and last acted
    switch (name) {
      case 'genesis':
        this.workspace = e.author; this.genesis = { ...p, hash: e.hash, at: e.timestamp }
        this.participants.set(e.author, { did: e.author, kind: 'workspace', name: 'the weaver', since: e.timestamp })
        break
      case 'join': {
        const prev = this.participants.get(e.author)
        this.participants.set(e.author, { ...prev, left: undefined, did: e.author, kind: 'human', name: p.name, projects: p.projects ?? [], about: p.about ?? '', since: prev?.since ?? e.timestamp })
        break
      }
      case 'delegate': {
        this.delegations.set(e.hash, { hash: e.hash, issuer: e.author, delegate: p.delegate, scope: p.scope, ask: p.ask ?? [], label: p.label ?? '', expiresAt: doc.expiresAt, revoked: false, endedBy: null, seq: e.seq, credential: credentialOf(doc, this.workspace) })
        const prev = this.participants.get(p.delegate)
        this.participants.set(p.delegate, { ...prev, did: p.delegate, kind: 'agent', name: p.label || `agent of ${this.nameOf(e.author)}`, principal: e.author, hosted: this.hosted.has(p.delegate), since: prev?.since ?? e.timestamp })
        break
      }
      case 'card': {
        const who = this.participants.get(e.onBehalfOf); if (who) who.card = { goals: p.goals ?? [], workingOn: p.workingOn ?? '', lookingFor: p.lookingFor ?? '', by: e.author, at: e.timestamp }
        // what an agent says it runs on is its own word, kept on the agent that signed it (never on its person); an update that leaves a field out keeps the old one
        const self = this.participants.get(e.author)
        if (self?.kind === 'agent' && (p.model !== undefined || p.runsOn !== undefined)) self.runsOnSaid = { model: (p.model ?? self.runsOnSaid?.model ?? '').trim(), runsOn: (p.runsOn ?? self.runsOnSaid?.runsOn ?? '').trim(), at: e.timestamp }
        break
      }
      case 'wake': { const a = this.participants.get(p.agent); if (a) a.wake = p.urlHash ? { on: p.on, since: e.timestamp } : null; break }
      case 'away': this.away.set(p.agent, { enabled: p.enabled, on: p.on, perHour: p.perHour, model: p.model, since: e.timestamp }); break
      case 'leave': {
        const who = this.participants.get(e.author)
        if (who) { who.left = e.timestamp }
        for (const p of this.participants.values()) if (p.kind === 'agent' && p.principal === e.author) { p.removed = true; p.removedAt = e.timestamp }
        for (const d of this.delegations.values()) if (d.issuer === e.author && !d.revoked) { d.revoked = true; d.endedBy = e.hash }
        break
      }
      case 'link': this.links.set(e.hash, { hash: e.hash, from: e.author, old: p.old, why: p.why ?? '', at: e.timestamp, vouches: new Map(), replacedAt: null }); break
      case 'vouch': { const l = this.links.get(p.request); if (l && !l.vouches.has(e.author)) l.vouches.set(e.author, { at: e.timestamp, hash: e.hash, why: p.why ?? '' }); break }
      case 'replace': {
        // a lost key, replaced (room line 781): the old account is retired and linked to the new one, its
        // permissions for agents end in the same step, and its projects and card move to the new account
        const l = this.links.get(p.request), was = l && this.participants.get(l.old), now = l && this.participants.get(l.from)
        if (!l || !was || !now) break
        l.replacedAt = e.timestamp
        was.replacedBy = l.from; was.replacedAt = e.timestamp
        now.replaces = [...new Set([...(now.replaces ?? []), l.old])]
        now.projects = [...new Set([...(now.projects ?? []), ...(was.projects ?? [])])].slice(0, 5); was.projects = []
        now.card ??= was.card
        for (const d of this.delegations.values()) if (d.issuer === l.old) d.revoked = true
        break
      }
      case 'remove': {
        // the record stays (it is permanent); the agent is stopped and no longer listed
        const a = this.participants.get(p.agent)
        if (a) { a.removed = true; a.removedAt = e.timestamp }
        for (const d of this.delegations.values()) if (d.delegate === p.agent && !d.revoked) { d.revoked = true; d.endedBy = e.hash }
        break
      }
      case 'hosted': { this.hosted.add(p.agent); const a = this.participants.get(p.agent); if (a) a.hosted = true; break }
      case 'revoke': { const d = this.delegations.get(p.delegation); if (d && d.issuer === e.author && !d.revoked) { d.revoked = true; d.endedBy = e.hash }; break }
      case 'note':
        if (p.task) {
          this.tasks.set(e.hash, { hash: e.hash, for: p.task.for, by: p.task.by ?? e.author, from: p.task.from ?? null, text: taskWords(p.text, e.author === this.workspace), at: e.timestamp, thread: e.document.threadId ?? e.document.id, doneAt: null, doneBy: null, doneText: null })
          if (p.task.from) this.taskFrom.add(p.task.from)
          if (this.tasks.size > TASKS_KEPT) for (const [h, t] of this.tasks) { if (this.tasks.size <= TASKS_KEPT) break; if (t.doneAt) this.tasks.delete(h) } // done ones go first
          if (this.tasks.size > TASKS_KEPT) for (const h of this.tasks.keys()) { if (this.tasks.size <= TASKS_KEPT) break; this.tasks.delete(h) } // then the oldest asks, which the page stopped showing long before
        }
        if (p.taskDone) { const t = this.tasks.get(p.taskDone); if (t && !t.doneAt) Object.assign(t, { doneAt: e.timestamp, doneBy: e.author, doneText: p.text }) }
        if (e.author !== this.workspace) break
        if (p.dive) this.dive(e)
        if (p.facilitator) this.facilitatorSaid(e)
        break
      case 'step': this.step(e); break
      case 'propose': this.addProposal(e); break
      case 'vote': {
        const pr = this.proposals.get(p.proposal)
        if (!pr) break
        const mine = pr.votes.get(e.onBehalfOf)
        // an agent's vote never overrides its human's own vote
        if (mine && mine.by === e.onBehalfOf && e.author !== e.onBehalfOf) break
        // judgment: an agent says this vote is its own call, not its person's words (only an agent's vote can carry it)
        pr.votes.set(e.onBehalfOf, { choice: p.choice, by: e.author, reason: p.reason ?? '', judgment: p.judgment === true && e.author !== e.onBehalfOf, seq: e.seq, at: e.timestamp })
        break
      }
      case 'approve': {
        const pr = this.proposals.get(p.proposal)
        if (!pr) break
        // an approval names the commit it read; one without a sha covers the commit the proposal names
        const sha = pr.kind === 'workspace-change' ? (p.sha ?? pr.change?.sha ?? null) : null, had = pr.approvals.get(e.author)
        if (!had || (sha && had.sha !== sha)) { pr.approvals.set(e.author, { seq: e.seq, sha, at: e.timestamp }); pr.lastApprovalAt = e.timestamp }
        break
      }
      case 'veto': {
        const pr = this.proposals.get(p.target)
        if (pr) pr.vetoes.push({ by: e.author, reason: p.reason, seq: e.seq, hash: e.hash })
        break
      }
      case 'mode': this.mode = { mode: p.mode, by: e.author, seq: e.seq, reason: p.reason ?? '' }; break
      case 'round':
        this.rounds.push({ ...p, hash: e.hash, seq: e.seq, at: e.timestamp })
        if (this.rounds.length > 20) this.rounds.shift()
        this.roundCount++
        this.lastRoundSeq = p.lastSeq ?? e.seq
        this.lastRoundAt = Date.parse(e.timestamp)
        break
      case 'score':
        this.score = { ...p, hash: e.hash, at: e.timestamp }
        this.scoreHistory.push({ at: e.timestamp, ...p.score })
        break
      case 'project': {
        const prev = this.mapProjects.get(p.slug)
        this.mapProjects.set(p.slug, { slug: p.slug, name: p.name, url: p.url ?? null, about: p.about ?? '', ways: p.ways, addedBy: prev?.addedBy ?? e.onBehalfOf, updatedBy: e.onBehalfOf, at: e.timestamp, hash: e.hash })
        break
      }
      case 'resource': {
        // One record per address. Its adder may update it; anyone else's title is kept as a note, never over theirs.
        const key = resourceKey(p.url), who = e.onBehalfOf ?? e.author, agent = e.author !== who ? e.author : null
        const r = this.resources.get(key) ?? { url: p.url, title: null, kind: null, status: null, about: '', addedBy: null, agent: null, at: null, hash: null, notes: [] }
        if (p.title !== undefined && (!r.addedBy || r.addedBy === who)) {
          Object.assign(r, { title: p.title, kind: p.kind ?? r.kind, status: p.status ?? r.status, about: p.about ?? r.about, addedBy: r.addedBy ?? who, agent: r.agent ?? agent, at: r.at ?? e.timestamp, hash: r.hash ?? e.hash })
        }
        if (p.note !== undefined) {
          r.notes.push({ text: p.note, by: who, agent, at: e.timestamp, hash: e.hash })
          if (r.notes.length > RESOURCE_NOTES_KEPT) r.notes.splice(0, r.notes.length - RESOURCE_NOTES_KEPT) // the log keeps every one
        }
        this.resources.set(key, r)
        break
      }
      case 'way':
        this.mapWays.set(p.id, { id: p.id, name: p.name, kind: p.kind, url: p.url ?? null, about: p.about ?? '', addedBy: this.mapWays.get(p.id)?.addedBy ?? e.onBehalfOf, at: e.timestamp, hash: e.hash })
        break
      case 'run': {
        const mine = this.participants.get(e.onBehalfOf)?.projects ?? []
        this.mapRuns.push({ hash: e.hash, sides: p.sides.map((s) => s.project), versions: p.sides.map((s) => s.version), date: p.date, results: p.ways.map((way) => ({ way, outcome: p.outcome })), note: p.note ?? '', evidence: p.evidence ?? [], ci: p.source === 'ci', reported: !p.sides.some((s) => mine.includes(s.project)), by: e.onBehalfOf, at: e.timestamp })
        break
      }
      case 'result': {
        const pr = this.proposals.get(p.proposal)
        if (pr) { pr.results.push({ ...p, hash: e.hash, at: e.timestamp }); pr.outcome = p.status }
        break
      }
    }
  }

  addProposal (e) {
    const p = e.document.payload
    this.proposals.set(e.hash, {
      hash: e.hash, seq: e.seq, at: e.timestamp, author: e.author, principal: e.onBehalfOf, byWeaver: e.author === this.workspace,
      kind: p.kind, title: p.title, body: p.body ?? '', run: p.run, change: p.change, head: p.change?.sha ?? null, sources: p.sources, measure: p.measure, direction: p.direction, threadId: e.document.threadId,
      votes: new Map(), approvals: new Map(), lastApprovalAt: null, vetoes: [], results: [], outcome: null,
    })
  }

  /** A facilitator:step line: the whole step as it now stands. Times and the day's tally are folded here, not trusted from the line. */
  step (e) {
    const p = e.document.payload, id = p.of ?? e.hash
    const prev = this.steps.get(id) ?? this.stepsDone.find((s) => s.id === id)
    const day = e.timestamp.slice(0, 10), t = this.stepDays.get(day) ?? { opened: 0, claimed: 0, resulted: 0, checked: 0, toResultMs: [] }
    if (!this.stepDays.has(day)) { this.stepDays.set(day, t); for (const d of [...this.stepDays.keys()].slice(0, -60)) this.stepDays.delete(d) }
    const s = { ...p, id, hash: e.hash, seq: e.seq, at: e.timestamp, thread: prev?.thread ?? e.document.id, openedAt: prev?.openedAt ?? e.timestamp, claimedAt: prev?.claimedAt ?? null, resultAt: prev?.resultAt ?? null, checkedAt: prev?.checkedAt ?? null }
    delete s.of
    // since when it has waited on this one decision (the line that first asked it), so an answer given since then counts
    s.waitingSince = p.waitingOn ? (prev?.waitingOn && prev.waitingOn.who === p.waitingOn.who && prev.waitingOn.decision === p.waitingOn.decision ? prev.waitingSince ?? prev.seq : e.seq) : null
    if (!prev) t.opened++
    this.stepsSince ??= e.timestamp
    const did = (who, what) => { if (!who) return; const d = this.doers.get(who) ?? { took: 0, results: 0, checks: 0, code: { took: 0, results: 0, checks: 0 }, at: null }; d[what]++; if (isCodeStep(s)) d.code[what]++; d.at = e.timestamp; this.doers.set(who, d) }
    if (!s.claimedAt && s.owner && ['claimed', 'in progress', 'result posted', 'checked'].includes(s.state)) { s.claimedAt = e.timestamp; t.claimed++; did(s.owner, 'took') }
    if (!s.resultAt && ['result posted', 'checked'].includes(s.state)) { s.resultAt = e.timestamp; t.resulted++; did(s.owner, 'results'); if (s.agreedAt) t.toResultMs.push(Date.parse(e.timestamp) - Date.parse(s.agreedAt)) }
    if (s.state === 'checked' && prev?.state !== 'checked') { s.checkedAt = e.timestamp; t.checked++; did(s.checkedBy, 'checks') }
    if (Number.isInteger(p.heardSeq) && p.heardSeq > this.stepsHeard) this.stepsHeard = p.heardSeq
    for (const h of [p.from, ...(p.sources ?? [])].filter(Boolean)) { this.stepOf.delete(h); this.stepOf.set(h, id) }
    while (this.stepOf.size > 5000) this.stepOf.delete(this.stepOf.keys().next().value)
    this.stepsDone = this.stepsDone.filter((x) => x.id !== id)
    if (s.state === 'checked' || s.aside) { this.steps.delete(id); this.stepsDone.push(s); if (this.stepsDone.length > 30) this.stepsDone.shift() } else this.steps.set(id, s)
  }

  /** What the facilitator said that its procedure needs to remember: the lines it pressed, its asks for done-tests, its reports. */
  facilitatorSaid (e) {
    const f = e.document.payload.facilitator
    if (f.pressed) { this.pressed.add(f.pressed); if (this.pressed.size > 200) this.pressed.delete(this.pressed.values().next().value) }
    if (f.what === 'ask test') for (const g of f.goals ?? []) this.testAsked.set(g, Date.parse(e.timestamp))
    if (f.what === 'report') this.lastReport = { at: e.timestamp, seq: e.seq }
    if (f.what === 'noted' && f.agent) { if (f.clear) this.notFor.delete(f.agent); else this.notFor.set(f.agent, { kinds: f.notFor ?? [], onlyFor: f.onlyFor ?? null, at: e.timestamp, because: f.because ?? null }) }
  }

  /** A closer look (dives.js) opens with one line of the weaver's and ends with another in its thread; both carry its record. */
  dive (e) {
    const d = e.document.payload.dive
    if (d.of) { const open = this.dives.get(d.of); if (open && !open.outcome) Object.assign(open, { outcome: d.outcome, by: d.by, endedAt: e.timestamp, endedSeq: e.seq, ended: e.hash }); return }
    this.dives.set(e.hash, { hash: e.hash, seq: e.seq, at: e.timestamp, thread: e.document.id, key: d.key, question: d.question, proposal: d.proposal ?? null, sides: d.sides, round: d.round, from: d.from, outcome: null })
  }

  tally (pr) {
    const t = { for: 0, against: 0, abstain: 0 }
    for (const v of pr.votes.values()) t[v.choice]++
    return t
  }

  /** The commit a code change's pull request is at now, as last read from GitHub. A new commit voids approvals of the old one. */
  setHead (pr, sha) { if (pr?.kind === 'workspace-change' && /^[0-9a-f]{40}$/.test(sha ?? '')) pr.head = sha }

  /** Whether an approval still holds: for a code change, only while the pull request is at the commit it read. */
  covers (pr, a) { return pr.kind !== 'workspace-change' || (Boolean(a?.sha) && a.sha === pr.head) }

  /** The approvers whose approval still holds, with when the latest of them came in. */
  holding (pr) {
    const dids = [...pr.approvals].filter(([, a]) => this.covers(pr, a)).map(([d]) => d)
    const at = dids.map((d) => pr.approvals.get(d).at).filter(Boolean).sort().at(-1) ?? null
    return { dids, at }
  }

  /** open · vetoed · approved (waiting out the veto window) · done · prepared · failed */
  statusOf (pr) {
    if (pr.vetoes.length) return 'vetoed'
    if (pr.outcome) return pr.outcome === 'opened' || pr.outcome === 'merged' ? 'done' : pr.outcome
    if (this.holding(pr).dids.length) return 'approved'
    return 'open'
  }

  /** Goals the room holds now: more for than against, no veto. Strongest first. */
  goals () {
    const all = [...this.proposals.values()].filter((pr) => pr.kind === 'goal' && !pr.vetoes.length)
    const net = (pr) => { const t = this.tally(pr); return t.for - t.against }
    return { held: all.filter((pr) => net(pr) > 0).sort((a, b) => net(b) - net(a)), candidates: all.filter((pr) => net(pr) <= 0) }
  }

  proposalView (pr) {
    return {
      hash: pr.hash, seq: pr.seq, at: pr.at, kind: pr.kind, title: pr.title, body: pr.body, run: pr.run, change: pr.change, measure: pr.measure, direction: pr.direction,
      author: pr.author, authorName: this.nameOf(pr.author), principal: pr.principal, byWeaver: pr.byWeaver, threadId: pr.threadId,
      status: this.statusOf(pr), tally: this.tally(pr),
      votes: [...pr.votes].map(([principal, v]) => ({ principal, name: this.nameOf(principal), ...v })),
      head: pr.head,
      approvals: [...pr.approvals].map(([did, a]) => ({ did, name: this.nameOf(did), sha: a.sha, at: a.at, void: !this.covers(pr, a) })),
      lastApprovalAt: pr.lastApprovalAt,
      vetoes: pr.vetoes.map((v) => ({ ...v, name: this.nameOf(v.by) })),
      results: pr.results,
    }
  }
}
