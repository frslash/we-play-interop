// The workspace's current state, folded from the log entry by entry.
// Nothing here is stored on its own: restart, replay the log, same state.
import { NAME_OF } from '../shared/types.js'

export class State {
  constructor () {
    this.workspace = null // the workspace DID (author of the genesis)
    this.genesis = null
    this.participants = new Map() // did -> { did, kind, name, projects, about, since, principal? }
    this.delegations = new Map() // entry hash -> { hash, issuer, delegate, scope, label, expiresAt, revoked, seq }
    this.proposals = new Map() // entry hash -> proposal (see addProposal)
    this.mode = { mode: 'weave', by: null, seq: null }
    this.rounds = [] // the last 20 rounds
    this.roundCount = 0
    this.lastRoundSeq = -1
    this.lastRoundAt = 0
    this.score = null // latest score snapshot payload
    this.scoreHistory = [] // compact score history from every snapshot
    this.mapProjects = new Map() // slug -> project the workspace added or extended
    this.mapWays = new Map() // id -> a way of doing interop, defined in the workspace
    this.mapRuns = [] // runs recorded in the workspace
    this.hosted = new Set() // agent DIDs whose key the workspace holds (shown to everyone)
    this.away = new Map() // agent DID -> what it answers while its person is away (public: everyone can see an agent answers on its own)
    this.dives = new Map() // opening entry hash -> a closer look the weaver opened where agents disagree (see dive)
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
        this.delegations.set(e.hash, { hash: e.hash, issuer: e.author, delegate: p.delegate, scope: p.scope, ask: p.ask ?? [], label: p.label ?? '', expiresAt: doc.expiresAt, revoked: false, seq: e.seq })
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
        for (const d of this.delegations.values()) if (d.issuer === e.author) d.revoked = true
        break
      }
      case 'remove': {
        // the record stays (it is permanent); the agent is stopped and no longer listed
        const a = this.participants.get(p.agent)
        if (a) { a.removed = true; a.removedAt = e.timestamp }
        for (const d of this.delegations.values()) if (d.delegate === p.agent) d.revoked = true
        break
      }
      case 'hosted': { this.hosted.add(p.agent); const a = this.participants.get(p.agent); if (a) a.hosted = true; break }
      case 'revoke': { const d = this.delegations.get(p.delegation); if (d && d.issuer === e.author) d.revoked = true; break }
      case 'note': if (e.author === this.workspace && p.dive) this.dive(e); break
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
        if (pr && !pr.approvals.has(e.author)) { pr.approvals.set(e.author, e.seq); pr.lastApprovalAt = e.timestamp }
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
      kind: p.kind, title: p.title, body: p.body ?? '', run: p.run, change: p.change, sources: p.sources, measure: p.measure, direction: p.direction, threadId: e.document.threadId,
      votes: new Map(), approvals: new Map(), lastApprovalAt: null, vetoes: [], results: [], outcome: null,
    })
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

  /** open · vetoed · approved (waiting out the veto window) · done · prepared · failed */
  statusOf (pr) {
    if (pr.vetoes.length) return 'vetoed'
    if (pr.outcome) return pr.outcome === 'opened' || pr.outcome === 'merged' ? 'done' : pr.outcome
    if (pr.approvals.size) return 'approved'
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
      approvals: [...pr.approvals.keys()].map((did) => ({ did, name: this.nameOf(did) })),
      lastApprovalAt: pr.lastApprovalAt,
      vetoes: pr.vetoes.map((v) => ({ ...v, name: this.nameOf(v.by) })),
      results: pr.results,
    }
  }
}
