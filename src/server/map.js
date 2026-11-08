// The interop map: every project, every way of doing interop, every run between
// two projects, from all sources. The DTG board (dtg-interop) is one source; the
// workspace's own entries (map:project, map:way, map:run) are another.
// The board's rules carry over to the whole map: pairs come from runs and from
// nothing else, a run is entered by one of its sides (or marked reported), and a
// mark fades after 30 days.
const DAY = 86_400_000
const key = (a, b) => [a, b].sort().join('|')
export const BOARD_WAY_PREFIXES = ['credential:', 'task:', 'ceremony:', 'basic:']
const BOARD_KIND = { credential: 'credentials', task: 'trust tasks', ceremony: 'ceremonies', basic: 'basics' }

const runsOnly = (status) => status === 'runs'
const facetValues = (list) => (list ?? []).filter((v) => typeof v === 'string' || runsOnly(v?.status)).map((v) => (typeof v === 'string' ? v : v.value))

/** What a board project brings, in running code, as way ids. */
export function boardWaysOf (p) {
  const ways = new Set()
  for (const c of p.credentials ?? []) if (runsOnly(c.status)) { for (const id of c.profiles ?? []) ways.add(`credential:${id}`); for (const proof of c.proof ?? []) ways.add(proof) }
  for (const c of p.ceremonies ?? []) if (runsOnly(c.status)) ways.add(`ceremony:${c.ceremony}`)
  for (const t of p.trustTaskUse?.types ?? []) { const type = typeof t === 'string' ? t : t.type; const st = typeof t === 'string' ? p.trustTaskUse.status : t.status; if (runsOnly(st) && !type.endsWith('/*')) ways.add(`task:${type}`) }
  for (const [id, b] of Object.entries(p.basics ?? {})) if (runsOnly(b?.status)) ways.add(`basic:${id}`)
  for (const m of facetValues(p.facets?.didMethods)) ways.add(m)
  return [...ways]
}

export function boardSources (data) {
  const projects = (data?.projects ?? []).map((p) => ({ slug: p.slug, name: p.shortName || p.name, url: p.website || p.repositories?.[0] || null, about: p.purpose || '', ways: boardWaysOf(p), source: 'dtg' }))
  const runs = (data?.runs ?? []).filter((r) => r.sides?.length === 2).map((r, i) => ({
    sides: r.sides.map((s) => s.project), versions: r.sides.map((s) => s.version), date: r.date, reported: !!r.reportedBy, source: 'dtg', ref: r.index ?? i, note: r.note ?? '',
    results: (r.subjects ?? []).map((s) => ({ way: `${s.kind}:${s.id}`, outcome: s.outcome ?? r.outcome })),
  }))
  return { projects, runs }
}

export function computeMap ({ board, state, today = new Date(), freshDays = 30 }) {
  const ageDays = (date) => Math.floor((today - Date.parse(date + 'T00:00:00Z')) / DAY)
  const fresh = (date) => ageDays(date) <= freshDays
  const src = boardSources(board)

  // projects: the board's rows, then the workspace's own entries; members are people who joined for it
  const projects = new Map()
  for (const p of src.projects) projects.set(p.slug, { ...p, ways: new Set(p.ways), sources: ['dtg'], members: [] })
  for (const p of state.mapProjects.values()) {
    const cur = projects.get(p.slug)
    if (cur) { p.ways.forEach((w) => cur.ways.add(w)); cur.sources.push('workspace'); cur.url ??= p.url; cur.about ||= p.about }
    else projects.set(p.slug, { slug: p.slug, name: p.name, url: p.url, about: p.about, ways: new Set(p.ways), sources: ['workspace'], members: [], addedBy: p.addedBy })
  }
  for (const person of state.participants.values()) if (person.kind === 'human') for (const slug of person.projects ?? []) projects.get(slug)?.members.push(person.name)

  // ways: defined in the workspace, or named by a project or a run
  const ways = new Map()
  const way = (id) => {
    if (!ways.has(id)) {
      const prefix = BOARD_WAY_PREFIXES.find((x) => id.startsWith(x))
      ways.set(id, { id, name: prefix ? id.slice(prefix.length) : id, kind: prefix ? BOARD_KIND[prefix.slice(0, -1)] : id.startsWith('did:') ? 'identity' : 'other', about: '', url: null, defined: false, projects: new Set(), passingPairs: 0 })
    }
    return ways.get(id)
  }
  for (const w of state.mapWays.values()) Object.assign(way(w.id), { name: w.name, kind: w.kind, about: w.about, url: w.url, defined: true })
  for (const p of projects.values()) for (const w of p.ways) way(w).projects.add(p.slug)

  // runs: the board's and the workspace's, per pair and way: the latest run and the latest pass
  const runs = [...src.runs, ...state.mapRuns.map((r) => ({ ...r, source: 'workspace' }))]
  const pairs = new Map()
  for (const r of runs) {
    const k = key(...r.sides)
    const pair = pairs.get(k) ?? { pair: k.split('|'), ways: new Map() }
    for (const { way: w, outcome } of r.results) {
      way(w)
      const cur = pair.ways.get(w) ?? { way: w, latest: null, latestPass: null }
      if (!cur.latest || r.date >= cur.latest.date) cur.latest = { date: r.date, outcome, reported: r.reported, source: r.source }
      if (outcome === 'pass' && (!cur.latestPass || r.date >= cur.latestPass)) cur.latestPass = r.date
      pair.ways.set(w, cur)
    }
    pairs.set(k, pair)
  }
  const passing = [...pairs.values()].filter((p) => [...p.ways.values()].some((w) => w.latestPass))
  for (const p of passing) for (const w of p.ways.values()) if (w.latestPass) way(w.way).passingPairs++
  const connected = new Set(passing.flatMap((p) => p.pair))

  const faded = [], fadingSoon = []
  for (const p of pairs.values()) for (const w of p.ways.values()) {
    if (!w.latestPass) continue
    const age = ageDays(w.latestPass)
    const item = { pair: p.pair, way: w.way, title: way(w.way).name, lastPass: w.latestPass }
    if (!fresh(w.latestPass)) faded.push({ ...item, ageDays: age })
    else if (age > freshDays - 7) fadingSoon.push({ ...item, daysLeft: freshDays - age })
  }
  faded.sort((a, b) => b.ageDays - a.ageDays); fadingSoon.sort((a, b) => a.daysLeft - b.daysLeft)

  // speak the same way, never tried together: the widest invitation on the map
  const sharedWays = []
  const list = [...projects.values()]
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i], b = list[j], tried = pairs.get(key(a.slug, b.slug))?.ways
    const shared = [...a.ways].filter((w) => b.ways.has(w) && !tried?.get(w)?.latestPass)
    if (shared.length) sharedWays.push({ pair: [a.slug, b.slug], ways: shared.slice(0, 8), count: shared.length, alreadyPassing: [...(tried?.values() ?? [])].filter((w) => w.latestPass).length, crossesSources: a.sources.join() !== b.sources.join() })
  }
  // pairs that cross from the board to the rest of the field first, then the most in common
  sharedWays.sort((x, y) => Number(y.crossesSources) - Number(x.crossesSources) || y.count - x.count)

  const score = {
    projects: projects.size, connected: connected.size,
    ways: ways.size, waysTried: [...ways.values()].filter((w) => w.passingPairs).length,
    runs: runs.length, freshRuns: runs.filter((r) => fresh(r.date)).length,
    passingPairs: passing.length, freshPairs: passing.filter((p) => [...p.ways.values()].some((w) => w.latestPass && fresh(w.latestPass))).length,
    faded: faded.length, fadingSoon: fadingSoon.length,
  }
  return {
    score,
    projects: [...projects.values()].map((p) => ({ ...p, ways: [...p.ways] })).sort((a, b) => a.name.localeCompare(b.name)),
    ways: [...ways.values()].map((w) => ({ ...w, projects: [...w.projects] })).sort((a, b) => b.projects.length - a.projects.length || a.id.localeCompare(b.id)),
    pairs: [...pairs.values()].map((p) => ({ pair: p.pair, ways: [...p.ways.values()].map((w) => ({ ...w, name: way(w.way).name, fresh: w.latestPass ? fresh(w.latestPass) : false })) })),
    sharedWays: sharedWays.slice(0, 30),
    faded: faded.slice(0, 30), fadingSoon: fadingSoon.slice(0, 30),
  }
}
