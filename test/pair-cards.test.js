// The front page's pair cards (src/server/pairs.js): one card per pair folder in the interopathon repository,
// read from that folder alone. A local server plays GitHub, so the tests run offline.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { config as baseConfig } from '../src/server/config.js'
import { createApp } from '../src/server/index.js'
import { Pairs, cardOf, isoDate, outcomeOf, readReadme, sortCards } from '../src/server/pairs.js'

const REPO = 'Project-Weave-Tech/interopathon'
const SHA = 'a'.repeat(40)
// shaped like the rltp-geb folder's README on 9 Nov 2026, trimmed
const GEB_README = `# RLTP and Consensual (Geb): VRCs and DID resolution

Date: 9 November 2026. Outcome: pass in both directions, with the limits named below. All keys are throwaway test keys.

## Direction 1: RLTP reads Geb's credentials

\`\`\`sh
git clone https://github.com/real-life-org/trust-protocol
cd trust-protocol && git checkout 36af651
node conformance/dtg-vrc.mjs geb-vrcs.json
\`\`\`

Full output: [\`reader-output.txt\`](reader-output.txt). Node 22, no install, no network.

\`\`\`sh
node tamper-check.mjs /path/to/trust-protocol geb-vrcs.json
\`\`\`
`
const GEB_OUTPUT = `  ok    geb-vrcs.json[0] (did:peer:2.Az6Mk…): plain DTG RelationshipCredential, eddsa-jcs-2022 proof verifies

All credentials pass the plain DTG RelationshipCredential check (informative).
`
const NAOMS_README = '# RLTP and NAOMS: did:key and eddsa-jcs-2022\n\nDate: 9 November 2026. Outcome: pass in both directions.\n'
const RLTP_README = '# Real Life Trust Protocol\n\nWhere its specifications, code and demos are.\n'
const KEYRING_PAIR = JSON.stringify({ sides: [{ project: 'Keyring', person: 'Side A person' }, { project: 'OpenVTC', person: 'Side B person' }], command: 'npm run interop', expected: 'joined: ok', lastRun: { date: '2026-10-15', by: 'Side A person', outcome: 'fail' } })

let files, hits
const fake = createServer((req, res) => {
  hits.push(req.url)
  if (req.url === `/repos/${REPO}/git/trees/HEAD?recursive=1`) {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ sha: SHA, tree: [{ path: 'README.md', type: 'blob', size: 10 }, ...Object.keys(files).map((path) => ({ path, type: 'blob', size: files[path].length })), { path: 'rltp-geb', type: 'tree' }] }))
  }
  const prefix = `/raw/${REPO}/${SHA}/`
  const path = req.url.startsWith(prefix) ? decodeURIComponent(req.url.slice(prefix.length)) : null
  if (path != null && files[path] != null) { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(files[path]) }
  res.writeHead(404); res.end('not found')
})

describe('pair cards from the interopathon folders', () => {
  let base
  before(async () => { await new Promise((r) => fake.listen(0, r)); base = `http://localhost:${fake.address().port}` })
  after(() => fake.close())
  const pairsAt = (opts = {}) => new Pairs({ repo: REPO, order: ['rltp-geb'], api: base, raw: `${base}/raw`, ...opts })

  test('dates and outcomes in the words people write them', () => {
    assert.equal(isoDate('9 November 2026'), '2026-11-09')
    assert.equal(isoDate('2026-10-11'), '2026-10-11')
    assert.equal(isoDate('Oct 15, 2026'), '2026-10-15')
    assert.equal(isoDate('soon'), null)
    assert.equal(outcomeOf('pass in both directions'), 'pass')
    assert.equal(outcomeOf('Failed at proof-key'), 'fail')
    assert.equal(outcomeOf('partly'), null)
  })

  test('the README gives the two projects, the run, the first command and the output file', () => {
    const r = readReadme(GEB_README)
    assert.deepEqual(r.projects, ['RLTP', 'Consensual (Geb)'])
    assert.equal(r.date, '2026-11-09'); assert.equal(r.outcome, 'pass')
    assert.ok(r.command.startsWith('git clone https://github.com/real-life-org/trust-protocol'))
    assert.ok(r.command.endsWith('node conformance/dtg-vrc.mjs geb-vrcs.json'))
    assert.equal(r.outputFile, 'reader-output.txt')
  })

  test('a folder that says no run is not a pair', () => {
    assert.equal(cardOf({ repo: REPO, branch: 'HEAD', folder: 'rltp', files: { 'README.md': RLTP_README } }), null)
  })

  test('an rltp-geb card: the two projects, its folder, the command, the expected output and the last run; what the folder does not say is named as missing', async () => {
    files = { 'rltp/README.md': RLTP_README, 'rltp-geb/README.md': GEB_README, 'rltp-geb/reader-output.txt': GEB_OUTPUT, 'rltp-geb/geb-vrcs.json': '[]', 'rltp-naoms/README.md': NAOMS_README }
    hits = []
    const v = await pairsAt().refresh()
    assert.equal(v.error, null); assert.equal(v.commit, SHA)
    assert.deepEqual(v.pairs.map((c) => c.folder), ['rltp-geb', 'rltp-naoms'], 'rltp-geb first; the folder without a run is not a card')
    const c = v.pairs[0]
    assert.deepEqual(c.sides.map((s) => s.project), ['RLTP', 'Consensual (Geb)'])
    assert.equal(c.link, `https://github.com/${REPO}/tree/HEAD/rltp-geb`)
    assert.ok(c.command.includes('node conformance/dtg-vrc.mjs geb-vrcs.json'))
    assert.equal(c.expected, 'All credentials pass the plain DTG RelationshipCredential check (informative).')
    assert.equal(c.expectedFile.link, `https://github.com/${REPO}/blob/HEAD/rltp-geb/reader-output.txt`)
    assert.deepEqual({ date: c.lastRun.date, outcome: c.lastRun.outcome, by: c.lastRun.by }, { date: '2026-11-09', outcome: 'pass', by: null })
    assert.equal(c.from, 'README.md')
    assert.deepEqual(c.missing, ['a person for each side', 'who ran it last'], 'nothing guessed: no names unless the folder gives them')
    assert.ok(!hits.some((u) => u.includes('geb-vrcs.json')), 'only the README, pair.json and the output file are read')
  })

  test('a pair.json in the folder names a person per side and who ran it last', async () => {
    files = { 'rltp-geb/README.md': GEB_README, 'rltp-geb/reader-output.txt': GEB_OUTPUT, 'rltp-geb/pair.json': JSON.stringify({ sides: [{ person: 'RLTP person' }, { person: 'Geb person' }], lastRun: { date: '2026-11-09', by: 'Geb person', outcome: 'pass' } }), 'keyring-openvtc/pair.json': KEYRING_PAIR }
    hits = []
    const v = await pairsAt().refresh()
    assert.deepEqual(v.pairs.map((c) => c.folder), ['rltp-geb', 'keyring-openvtc'])
    const [geb, key] = v.pairs
    assert.deepEqual(geb.sides, [{ project: 'RLTP', person: 'RLTP person' }, { project: 'Consensual (Geb)', person: 'Geb person' }], 'projects still from the README title when pair.json leaves them out')
    assert.equal(geb.lastRun.by, 'Geb person'); assert.deepEqual(geb.missing, [])
    assert.equal(geb.from, 'pair.json')
    assert.equal(key.command, 'npm run interop'); assert.equal(key.expected, 'joined: ok')
    assert.deepEqual(key.lastRun, { date: '2026-10-15', by: 'Side A person', outcome: 'fail', said: 'fail' })
    assert.equal(key.expectedFile, null)
  })

  test('a broken pair.json counts as none, and the README still makes the card', () => {
    const c = cardOf({ repo: REPO, branch: 'HEAD', folder: 'rltp-geb', files: { 'README.md': GEB_README, 'pair.json': '{ not json' } })
    assert.equal(c.from, 'README.md'); assert.equal(c.lastRun.outcome, 'pass')
  })

  test('GitHub down: the last good cards stay, and the error is said', async () => {
    files = { 'rltp-geb/README.md': GEB_README }
    const p = pairsAt()
    await p.refresh(); assert.equal(p.view().pairs.length, 1)
    p.api = `${base}/nowhere`
    const v = await p.refresh()
    assert.ok(v.error?.message.includes('HTTP 404')); assert.equal(v.pairs.length, 1)
  })

  test('a short list, newest run first after the named folders', () => {
    const card = (folder, date) => ({ folder, lastRun: { date } })
    const many = Array.from({ length: 20 }, (_, i) => card(`p${String(i).padStart(2, '0')}`, `2026-10-${String(i + 1).padStart(2, '0')}`))
    const out = sortCards([...many, card('rltp-geb', '2026-01-01')], ['rltp-geb'])
    assert.equal(out.length, 12); assert.equal(out[0].folder, 'rltp-geb'); assert.equal(out[1].folder, 'p19')
  })

  test('the room serves them at /api/pairs, and the front page draws them', async () => {
    files = { 'rltp-geb/README.md': GEB_README, 'rltp-geb/reader-output.txt': GEB_OUTPUT }
    const dir = mkdtempSync(join(tmpdir(), 'wpi-pairs-'))
    const ctx = await createApp({ ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, githubToken: '', checkEveryMinutes: 0, boardDataUrl: 'data:application/json,' + encodeURIComponent('{"projects":[],"runs":[]}'), llm: { ...baseConfig.llm, provider: 'openai', apiKey: '' } }, { hostWelcomeMs: null, pairs: { api: base, raw: `${base}/raw` } })
    await new Promise((r) => ctx.server.listen(0, r))
    try {
      assert.equal(ctx.pairs.repo, 'Project-Weave-Tech/interopathon', 'the interopathon repository by default')
      await ctx.pairs.refresh()
      const r = await fetch(`http://localhost:${ctx.server.address().port}/api/pairs`)
      const body = await r.json()
      assert.equal(r.status, 200); assert.equal(body.pairs[0].folder, 'rltp-geb'); assert.equal(body.source, `https://github.com/${REPO}`)
    } finally { await ctx.stop(); rmSync(dir, { recursive: true, force: true }) }
    const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
    assert.ok(app.includes("api('/api/pairs')") && app.includes('function pairCard'), 'the Watch tab, the front page, loads and draws the cards')
  })
})
