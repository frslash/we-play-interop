// The scoreboard: dtg-interop's published data.json, read the way its AGENTS.md
// defines it. Pairs come from runs and nothing else; a mark fades after 30 days;
// a scenario with a missing piece cannot be played by any pair.
import { canonicalize, sha256, toHex } from '../shared/crypto.js'
import { computeMap } from './map.js'

const DAY = 86_400_000
const key = (a, b) => [a, b].sort().join('|')

export function computeBoard (data, { today = new Date(), freshDays = 30 } = {}) {
  const ageDays = (date) => Math.floor((today - Date.parse(date + 'T00:00:00Z')) / DAY)
  const fresh = (date) => ageDays(date) <= freshDays
  const projects = (data.projects ?? []).map((p) => ({ slug: p.slug, name: p.shortName || p.name }))
  const runs = data.runs ?? []

  // per pair, per subject: the latest run and the latest pass
  const pairs = new Map()
  for (const r of runs) {
    if (r.sides?.length !== 2) continue
    const k = key(r.sides[0].project, r.sides[1].project)
    const pair = pairs.get(k) ?? { pair: k.split('|'), subjects: new Map() }
    for (const s of r.subjects ?? []) {
      const sk = `${s.kind}:${s.id}`, outcome = s.outcome ?? r.outcome
      const cur = pair.subjects.get(sk) ?? { subject: sk, kind: s.kind, id: s.id, title: s.title ?? s.id, latest: null, latestPass: null }
      if (!cur.latest || r.date >= cur.latest.date) cur.latest = { date: r.date, outcome, reported: !!r.reportedBy }
      if (outcome === 'pass' && (!cur.latestPass || r.date >= cur.latestPass)) cur.latestPass = r.date
      pair.subjects.set(sk, cur)
    }
    pairs.set(k, pair)
  }
  const passOf = (pair, sk) => pair?.subjects.get(sk)?.latestPass ?? null

  // a scenario is played by a pair when its passes cover one journey (one item per need)
  const plays = [], opportunities = []
  let missing = 0
  for (const s of data.scenarios ?? []) {
    missing += s.missing?.length ?? 0
    const needs = (s.needs ?? []).map((n) => n.oneOf ?? [n])
    if (s.missing?.length) continue
    for (const pair of pairs.values()) {
      const dates = needs.map((alts) => alts.map((it) => passOf(pair, `${it.kind}:${it.id}`)).filter(Boolean).sort().at(-1))
      if (dates.every(Boolean)) plays.push({ scenario: s.id, title: s.title, pair: pair.pair, fresh: dates.every(fresh), oldest: dates.sort()[0] })
    }
    // who could play it next: pairs where both sides bring an item for every need, in running code
    const bring = (it) => new Set((it.bringers ?? []).filter((b) => b.status === 'runs').map((b) => b.project))
    const slugs = projects.map((p) => p.slug)
    for (let i = 0; i < slugs.length; i++) for (let j = i + 1; j < slugs.length; j++) {
      const a = slugs[i], b = slugs[j]
      if (plays.some((pl) => pl.scenario === s.id && key(...pl.pair) === key(a, b))) continue
      const journey = needs.map((alts) => alts.find((it) => { const set = bring(it); return set.has(a) && set.has(b) }))
      if (!journey.every(Boolean)) continue
      const pair = pairs.get(key(a, b))
      const done = journey.filter((it) => passOf(pair, `${it.kind}:${it.id}`)).length
      opportunities.push({ scenario: s.id, title: s.title, pair: [a, b], subjects: journey.map((it) => ({ kind: it.kind, id: it.id, title: it.title ?? it.id })), alreadyPassing: done, toRun: journey.length - done })
    }
  }
  opportunities.sort((x, y) => x.toRun - y.toRun || x.scenario.localeCompare(y.scenario))

  const faded = []
  for (const pair of pairs.values()) for (const s of pair.subjects.values()) if (s.latestPass && !fresh(s.latestPass)) faded.push({ pair: pair.pair, subject: s.subject, title: s.title, lastPass: s.latestPass, ageDays: ageDays(s.latestPass) })
  faded.sort((x, y) => y.ageDays - x.ageDays)
  // still fresh, but within a week of fading: the cheapest points on the board
  const fadingSoon = []
  for (const pair of pairs.values()) for (const s of pair.subjects.values()) if (s.latestPass && fresh(s.latestPass) && ageDays(s.latestPass) > freshDays - 7) fadingSoon.push({ pair: pair.pair, subject: s.subject, title: s.title, lastPass: s.latestPass, daysLeft: freshDays - ageDays(s.latestPass) })
  fadingSoon.sort((x, y) => x.daysLeft - y.daysLeft)

  const passingPairs = [...pairs.values()].filter((p) => [...p.subjects.values()].some((s) => s.latestPass))
  const score = {
    runs: runs.length,
    freshRuns: runs.filter((r) => fresh(r.date)).length,
    passingPairs: passingPairs.length,
    freshPairs: passingPairs.filter((p) => [...p.subjects.values()].some((s) => s.latestPass && fresh(s.latestPass))).length,
    plays: plays.length,
    freshPlays: plays.filter((p) => p.fresh).length,
    missing,
    faded: faded.length,
  }
  return {
    score,
    generated: data.generated ?? null,
    today: today.toISOString().slice(0, 10),
    projects,
    pairs: [...pairs.values()].map((p) => ({ pair: p.pair, subjects: [...p.subjects.values()].map((s) => ({ ...s, fresh: s.latestPass ? fresh(s.latestPass) : false })) })),
    plays,
    opportunities: opportunities.slice(0, 30),
    faded: faded.slice(0, 30),
    fadingSoon: fadingSoon.slice(0, 30),
    missing: (data.scenarios ?? []).flatMap((s) => (s.missing ?? []).map((m) => ({ scenario: s.id, title: s.title, label: m.label, thread: m.thread }))),
    scenarios: (data.scenarios ?? []).map((s) => ({ id: s.id, title: s.title, done: s.done, missing: s.missing?.length ?? 0 })),
    catalog: {
      credentials: Object.keys(data.credentialProfiles?.profiles ?? {}),
      ceremonies: (data.ceremonies ?? []).map((c) => c.id),
      basics: (data.basics ?? []).map((b) => b.id),
    },
  }
}

/** Keeps the DTG board in memory, computes the whole map, and snapshots its score into the log. */
export class Board {
  constructor ({ config, log }) { this.config = config; this.log = log; this.data = null; this.view = null; this.error = null; this.fetchedAt = null; this.dataHash = null; this.cache = null }

  async refresh () {
    try {
      const res = await fetch(this.config.boardDataUrl, { signal: AbortSignal.timeout(30_000), headers: { accept: 'application/json' } })
      if (!res.ok) throw new Error(`board data: HTTP ${res.status}`)
      const data = await res.json()
      this.dataHash = toHex(sha256(canonicalize({ runs: data.runs, scenarios: data.scenarios, projects: (data.projects ?? []).map((p) => p.slug) })))
      this.data = data
      this.view = computeBoard(data, { freshDays: this.config.freshDays })
      this.fetchedAt = new Date().toISOString(); this.error = null; this.cache = null
    } catch (err) {
      this.error = { message: err.message, at: new Date().toISOString() } // keep the last good board
      console.warn('board refresh failed:', err.message)
    }
    await this.snapshotIfChanged()
    return this.view
  }

  projectSlugs () { return new Set((this.data?.projects ?? []).map((p) => p.slug)) }

  /** The whole map, recomputed when the log, the board or the day changes. */
  map () {
    const k = `${this.log.state.seq}|${this.dataHash}|${new Date().toISOString().slice(0, 10)}`
    if (this.cache?.k !== k) this.cache = { k, map: computeMap({ board: this.data, state: this.log.state, freshDays: this.config.freshDays }) }
    return this.cache.map
  }

  score () {
    const m = this.map(), d = this.view?.score
    return { ...m.score, ...(d ? { dtgPlays: d.plays, dtgFreshPlays: d.freshPlays, missing: d.missing } : {}) }
  }

  /** The measurement path: every change in the score is a signed entry in the log. */
  async snapshotIfChanged () {
    if (!this.data && !this.log.state.mapProjects.size) return null
    const score = this.score(), last = this.log.state.score
    if (last && canonicalize(last.score) === canonicalize(score) && last.sources?.dtg?.dataHash === this.dataHash) return null
    const m = this.map()
    return this.log.appendAsWorkspace('score', {
      score,
      sources: { dtg: { url: this.config.boardDataUrl, dataHash: this.dataHash, generated: this.view?.generated ?? null }, workspace: { projects: this.log.state.mapProjects.size, ways: this.log.state.mapWays.size, runs: this.log.state.mapRuns.length } },
      fadingSoon: m.fadingSoon.slice(0, 5).map((f) => ({ pair: f.pair, way: f.way, daysLeft: f.daysLeft })),
      sharedWays: m.sharedWays.slice(0, 5).map((o) => ({ pair: o.pair, ways: o.ways.slice(0, 3) })),
    })
  }
}
