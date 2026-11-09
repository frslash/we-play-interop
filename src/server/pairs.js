// Pair cards for the front page: one card per pair folder in the interopathon repository
// (https://github.com/Project-Weave-Tech/interopathon). Each card is read from that folder alone, so the folder's own
// people keep it right: change the folder, and the card follows at the next refresh.
//
// A folder is a pair when it has a `pair.json`, or when its README says the run's date and outcome
// ("Date: 9 November 2026. Outcome: pass ..."). `pair.json` says what the README cannot say plainly:
//
//   { "sides": [{ "project": "RLTP", "person": "<a name>" }, { "project": "Consensual (Geb)", "person": "<a name>" }],
//     "command": "node conformance/dtg-vrc.mjs geb-vrcs.json",
//     "expected": "All credentials pass the plain DTG RelationshipCredential check (informative).",
//     "lastRun": { "date": "2026-11-09", "by": "<a name>", "outcome": "pass" } }
//
// Every field is optional. What the folder does not say, the card says is missing; nothing is guessed.
// Only reads: one listing of the repository's files and the raw files of pair folders, all from that one repository.

const MINUTE = 60_000
const MAX_FILE_BYTES = 256 * 1024 // a README or an output file; anything bigger is not read
const TIMEOUT_MS = 30_000
const MAX_CARDS = 12 // a short list
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const cut = (s, n) => { const t = String(s ?? '').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t }
const text = (v, n) => (typeof v === 'string' && v.trim() ? cut(v, n) : null)

/** "9 November 2026", "2026-11-09" or "Nov 9, 2026" as 2026-11-09; null if it is not a date. */
export function isoDate (s) {
  const t = String(s ?? '').trim()
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  const month = (w) => MONTHS.findIndex((x) => x.startsWith(w.toLowerCase().slice(0, 3))) + 1
  const out = (y, mo, d) => (mo > 0 && d >= 1 && d <= 31 ? `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null)
  if ((m = t.match(/^(\d{1,2})\s+([A-Za-z]+)\.?\s+(\d{4})/))) return out(m[3], month(m[2]), Number(m[1]))
  if ((m = t.match(/^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})/))) return out(m[3], month(m[1]), Number(m[2]))
  return null
}

/** pass, fail, or null when the words say neither. */
export function outcomeOf (s) {
  const t = String(s ?? '').trim().toLowerCase()
  if (/^(pass|passed|ok)\b/.test(t)) return 'pass'
  if (/^(fail|failed)\b/.test(t)) return 'fail'
  return null
}

/** What the README says: the two projects (from its title), the date and outcome, the first shell command, the output file. */
export function readReadme (md) {
  const src = String(md ?? '')
  const title = src.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? null
  const named = title?.split(':')[0] ?? ''
  const parts = named.split(/\s+(?:and|x|×|&)\s+/i).map((s) => s.trim()).filter(Boolean)
  const run = src.match(/^Date:\s*([^.\n]+)\.\s*Outcome:\s*([^\n]*)$/mi)
  const command = src.match(/```(?:sh|bash|shell|console)?[ \t]*\n([\s\S]*?)```/)?.[1]?.trim() ?? null
  const output = src.match(/Full output:\s*\[`?([^\]`]+)`?\]\(([^)\s]+)\)/i)
  return {
    title,
    projects: parts.length === 2 ? parts : null,
    date: run ? isoDate(run[1]) : null,
    outcomeText: run ? run[2].trim() : null,
    outcome: run ? outcomeOf(run[2]) : null,
    command,
    outputFile: output && !/^[a-z]+:/i.test(output[2]) ? output[2].replace(/^\.\//, '') : null,
  }
}

const lastLine = (t) => String(t ?? '').split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? null

/**
 * One card from one folder. `files` maps a file name in the folder to its text (README.md, pair.json and the output
 * file, when they are there). Returns null when the folder is not a pair.
 */
export function cardOf ({ repo, branch, folder, files }) {
  let pair = null
  if (files['pair.json'] != null) { try { const j = JSON.parse(files['pair.json']); if (j && typeof j === 'object' && !Array.isArray(j)) pair = j } catch { pair = null } }
  const readme = readReadme(files['README.md'])
  if (!pair && !(readme.date || readme.outcomeText)) return null
  const tree = `https://github.com/${repo}/tree/${branch}/${folder.split('/').map(encodeURIComponent).join('/')}`
  const blob = (name) => `https://github.com/${repo}/blob/${branch}/${[...folder.split('/'), ...name.split('/')].map(encodeURIComponent).join('/')}`
  const sidesIn = Array.isArray(pair?.sides) ? pair.sides.slice(0, 2) : []
  const sides = [0, 1].map((i) => ({
    project: text(sidesIn[i]?.project, 80) ?? readme.projects?.[i] ?? null,
    person: text(sidesIn[i]?.person, 80),
  }))
  const run = pair?.lastRun && typeof pair.lastRun === 'object' ? pair.lastRun : {}
  const outputFile = readme.outputFile && files[readme.outputFile] != null ? readme.outputFile : null
  const expected = text(pair?.expected, 600) ?? (outputFile ? cut(lastLine(files[outputFile]), 600) : null)
  const missing = []
  if (sides.some((s) => !s.project)) missing.push('the two projects')
  if (sides.some((s) => !s.person)) missing.push('a person for each side')
  const card = {
    folder,
    title: text(readme.title, 160) ?? folder,
    link: tree,
    sides,
    command: text(pair?.command, 1000) ?? (readme.command ? cut(readme.command, 1000) : null),
    expected,
    expectedFile: outputFile ? { name: outputFile, link: blob(outputFile) } : null,
    lastRun: {
      date: isoDate(run.date) ?? readme.date,
      by: text(run.by, 80),
      outcome: outcomeOf(run.outcome) ?? readme.outcome,
      said: text(run.outcome, 200) ?? (readme.outcomeText ? cut(readme.outcomeText, 200) : null),
    },
    from: pair ? 'pair.json' : 'README.md',
    missing,
  }
  if (!card.command) missing.push('the command')
  if (!card.expected) missing.push('the expected output')
  if (!card.lastRun.date) missing.push('the date of the last run')
  if (!card.lastRun.by) missing.push('who ran it last')
  if (!card.lastRun.outcome) missing.push('pass or fail')
  return card
}

/** The cards, newest run first; folders named in `order` come first, in that order. */
export function sortCards (cards, order = []) {
  const rank = (c) => { const i = order.indexOf(c.folder); return i < 0 ? order.length : i }
  return [...cards].sort((a, b) => rank(a) - rank(b) || String(b.lastRun.date ?? '').localeCompare(String(a.lastRun.date ?? '')) || a.folder.localeCompare(b.folder)).slice(0, MAX_CARDS)
}

/** Reads the interopathon repository on a schedule and keeps the last good set of cards. */
export class Pairs {
  /** `fetch`, `api` and `raw` exist so tests can play GitHub locally; the app passes only `repo`, `order` and `token`. */
  constructor ({ repo, order = [], token = '', everyMinutes = 30, startDelayMs = 5000, fetch: f = globalThis.fetch, api = 'https://api.github.com', raw = 'https://raw.githubusercontent.com' } = {}) {
    this.repo = repo; this.order = order; this.token = token; this.everyMs = everyMinutes * MINUTE; this.startDelayMs = startDelayMs
    this.fetch = f; this.api = api; this.raw = raw
    this.cards = []; this.fetchedAt = null; this.commit = null; this.error = null; this.timer = null
  }

  async get (url, headers = {}) {
    const res = await this.fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers })
    if (!res.ok) throw new Error(`${url.replace(/\?.*$/, '')}: HTTP ${res.status}`)
    const body = await res.text()
    if (body.length > MAX_FILE_BYTES * 8) throw new Error('too big')
    return body
  }

  async refresh () {
    try {
      const auth = this.token ? { authorization: `Bearer ${this.token}` } : {}
      const branch = 'HEAD' // the repository's default branch, whatever it is called; GitHub's links take it too
      const listing = JSON.parse(await this.get(`${this.api}/repos/${this.repo}/git/trees/HEAD?recursive=1`, { accept: 'application/vnd.github+json', ...auth }))
      const sha = String(listing.sha ?? '')
      if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('no commit in the listing')
      const blobs = new Map((listing.tree ?? []).filter((t) => t.type === 'blob' && typeof t.path === 'string').map((t) => [t.path, t.size ?? 0]))
      // a folder at the top whose README says a run, or that has a pair.json
      const folders = [...new Set([...blobs.keys()].filter((p) => /^[^/]+\/(README\.md|pair\.json)$/.test(p)).map((p) => p.split('/')[0]))]
      const read = async (path) => (blobs.has(path) && blobs.get(path) <= MAX_FILE_BYTES ? this.get(`${this.raw}/${this.repo}/${sha}/${path.split('/').map(encodeURIComponent).join('/')}`) : null)
      const cards = []
      for (const folder of folders) {
        const files = {}
        for (const name of ['README.md', 'pair.json']) { const t = await read(`${folder}/${name}`); if (t != null) files[name] = t }
        const out = readReadme(files['README.md']).outputFile
        if (out && !out.includes('..')) { const t = await read(`${folder}/${out}`); if (t != null) files[out] = t }
        const card = cardOf({ repo: this.repo, branch, folder, files })
        if (card) cards.push(card)
      }
      this.cards = sortCards(cards, this.order); this.commit = sha; this.fetchedAt = new Date().toISOString(); this.error = null
    } catch (err) {
      this.error = { message: err.message, at: new Date().toISOString() } // keep the last good cards
      console.warn('pairs refresh failed:', err.message)
    }
    return this.view()
  }

  view () {
    return { source: `https://github.com/${this.repo}`, commit: this.commit, fetchedAt: this.fetchedAt, error: this.error, pairs: this.cards }
  }

  start () {
    if (this.timer || this.first) return
    this.first = setTimeout(() => { this.first = null; this.refresh(); this.timer = setInterval(() => this.refresh(), this.everyMs) }, this.startDelayMs)
  }
  stop () { clearTimeout(this.first); clearInterval(this.timer); this.first = null; this.timer = null }
}
