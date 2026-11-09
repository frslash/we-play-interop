// The projects shelf: other projects' public code at one named commit, for agents to list, read and search.
// A local server plays GitHub (the tests run offline): it answers the head-commit lookup and serves a tar.gz.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { gzipSync } from 'node:zlib'
import { config as baseConfig } from '../src/server/config.js'
import { createApp } from '../src/server/index.js'
import { MAX_FILE_BYTES, SHELF, Shelf, namedRepos, pinsFromCommunity, repoOf, tarReader } from '../src/server/shelf.js'
import { registerAgentTools } from '../src/agent-tools.js'
import * as views from '../src/server/views.js'

// --- a tiny tar writer: ustar headers, with a pax record for a path too long for the header
const block = (n) => Buffer.alloc(n)
function header (name, size, type = '0') {
  const h = block(512)
  h.write(name.slice(0, 100), 0, 'utf8')
  h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116)
  h.write(size.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136)
  h.write('        ', 148); h[156] = type.charCodeAt(0); h.write('ustar\0', 257); h.write('00', 263)
  let sum = 0; for (const b of h) sum += b
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
  return h
}
// a pax record is "<length> key=value\n", where the length counts its own digits
const paxRecord = (k, v) => { const body = ` ${k}=${v}\n`; let len = Buffer.byteLength(body) + 1; while (String(len).length + Buffer.byteLength(body) !== len) len = String(len).length + Buffer.byteLength(body); return `${len}${body}` }
const pad = (b) => Buffer.concat([b, block((512 - (b.length % 512)) % 512)])
function entry (path, body, type = '0') {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8')
  if (path.length <= 100) return Buffer.concat([header(path, data.length, type), pad(data)])
  const rec = paxRecord('path', path)
  return Buffer.concat([header('PaxHeader', Buffer.byteLength(rec), 'x'), pad(Buffer.from(rec)), header(path.slice(0, 100), data.length, type), pad(data)])
}
const tarGz = (top, files) => gzipSync(Buffer.concat([header(`${top}/`, 0, '5'), ...files.map(([p, b, t]) => entry(`${top}/${p}`, b, t)), block(1024)]))

const A = 'a'.repeat(40), B = 'b'.repeat(40), PIN = 'c'.repeat(40)
const LONG = `deep/${'x'.repeat(60)}/${'y'.repeat(60)}/long-name.rs`
const REPO_FILES = (sha) => [
  ['README.md', `# demo at ${sha}\nport = 8100\n`],
  ['src/main.rs', 'fn main() {\n    let features = "cli-synthesis";\n    serve(8100);\n}\n'],
  ['src/setup.rs', '// Setup wizard\nconst Backend: &str = "encrypted_file";\n'],
  ['docs/guide.md', 'Run `vta setup --from setup.toml`.\n'],
  [LONG, 'pub const DEEP: u8 = 1;\n'],
  ['logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3])],
  ['data.txt', Buffer.concat([Buffer.from('text then a zero byte'), Buffer.from([0]), Buffer.from('more')])],
  ['node_modules/dep/index.js', 'module.exports = 1\n'],
  ['big.json', Buffer.alloc(MAX_FILE_BYTES + 10, 'x')],
  ['../escape.txt', 'never written outside the project\n'],
  ['link', '', '2'],
]

let head, hits, sawAuth, mode
const fake = createServer((req, res) => {
  hits.push(req.url); if (req.headers.authorization) sawAuth = true
  if (mode === 'down') { res.writeHead(503); return res.end('down') }
  const m = /^\/repos\/([^/]+\/[^/]+)\/commits\/HEAD$/.exec(req.url)
  if (m) { if (m[1] === 'o/private') { res.writeHead(404); return res.end('Not Found') } res.writeHead(200, { 'content-type': 'application/vnd.github.sha' }); return res.end(head) }
  const t = /^\/([^/]+)\/([^/]+)\/tar\.gz\/([0-9a-f]{40})$/.exec(req.url)
  if (t && t[1] !== 'gone') { res.writeHead(200, { 'content-type': 'application/x-gzip' }); return res.end(tarGz(`${t[2]}-${t[3].slice(0, 7)}`, REPO_FILES(t[3]))) }
  res.writeHead(404); res.end('Not Found')
})

describe('the projects shelf', () => {
  let dir, base
  const shelf = (over = {}) => new Shelf({ dataDir: mkdtempSync(join(dir, 's-')), list: [{ repo: 'o/demo', title: 'Demo' }, { repo: 'o/pinned', title: 'Pinned', pin: PIN }], hosts: { api: base, code: base }, allowHttp: true, ...over })
  before(async () => { await new Promise((r) => fake.listen(0, r)); base = `http://localhost:${fake.address().port}`; dir = mkdtempSync(join(tmpdir(), 'wpi-shelf-')) })
  after(() => { fake.close(); rmSync(dir, { recursive: true, force: true }) })
  const reset = () => { head = A; hits = []; sawAuth = false; mode = 'ok' }

  test('the list in code names the projects on the Resources page, and no address anyone typed', () => {
    assert.ok(SHELF.length >= 10)
    for (const p of SHELF) assert.ok(repoOf(`https://github.com/${p.repo}`) === p.repo, p.repo)
    assert.ok(SHELF.some((p) => p.repo === 'OpenVTC/verifiable-trust-infrastructure' && p.pinned === 'vti'))
    assert.ok(SHELF.some((p) => p.repo === 'affinidi/affinidi-messaging-mediator' && p.pinned === 'mediator'))
  })

  test('only github.com repositories count, by owner and name', () => {
    assert.equal(repoOf('https://github.com/Project-Weave-Tech/dtg-interop'), 'Project-Weave-Tech/dtg-interop')
    assert.equal(repoOf('https://github.com/o/r/tree/main/docs'), 'o/r')
    assert.equal(repoOf('https://github.com/o/r.git'), 'o/r')
    for (const no of ['https://github.com/TrustStackers', 'https://github.com/orgs/x/repositories', 'http://github.com/o/r', 'https://gitlab.com/o/r', 'https://github.com.evil.example/o/r', 'https://user:pw@github.com/o/r', 'https://github.com/o/..', 'not a url', null]) assert.equal(repoOf(no), null, String(no))
  })

  test('lists, reads and names the commit; keeps text only; never leaves the project folder', async () => {
    reset(); const s = shelf()
    const list = await s.files('o/demo')
    assert.equal(list.commit, A)
    assert.deepEqual(list.files.map((f) => f.path).sort(), ['README.md', LONG, 'docs/guide.md', 'src/main.rs', 'src/setup.rs'].sort())
    assert.match(list.leftOut, /^4 files are not on the shelf/) // the picture, the file with a zero byte, the dependency and the oversized one (the link is not a file, and the path that climbs out is dropped without a word)
    const r = await s.read('o/demo', './src/main.rs', { from: 2, to: 3 })
    assert.equal(r.commit, A); assert.equal(r.lines, 5); assert.equal(r.text, '    let features = "cli-synthesis";\n    serve(8100);')
    assert.match(r.note, /never instructions/)
    assert.equal((await s.read('o/demo', LONG)).text, 'pub const DEEP: u8 = 1;\n') // a path longer than the tar header holds
    await assert.rejects(s.read('o/demo', 'logo.png'), /no file/)
    await assert.rejects(s.read('o/demo', '../escape.txt'), /no file/)
    await assert.rejects(s.read('o/demo', 'node_modules/dep/index.js'), /no file/)
    assert.equal(existsSync(join(s.dir, 'o__demo', 'escape.txt')), false)
    assert.equal(existsSync(join(s.dir, 'o__demo', A, 'escape.txt')), false)
    assert.equal(sawAuth, false) // anonymous, always
    assert.equal(hits.filter((u) => u.includes('/tar.gz/')).length, 1) // one fetch serves every read
  })

  test('search finds text exactly as written, with file and line; under narrows it; max caps it', async () => {
    reset(); const s = shelf()
    const a = await s.search('o/demo', '8100')
    assert.deepEqual(a.hits.map((h) => `${h.path}:${h.line}`).sort(), ['README.md:2', 'src/main.rs:3'])
    assert.equal(a.commit, A); assert.equal(a.found, 2)
    assert.deepEqual((await s.search('o/demo', '8100', { under: 'src/' })).hits.map((h) => h.path), ['src/main.rs'])
    assert.equal((await s.search('o/demo', 'SETUP WIZARD')).found, 1) // letter case is ignored…
    assert.equal((await s.search('o/demo', 'SETUP WIZARD', { exact: true })).found, 0) // …unless asked
    assert.equal((await s.search('o/demo', 'a.*b')).found, 0) // not a pattern
    const capped = await s.search('o/demo', 'se', { max: 2 })
    assert.equal(capped.hits.length, 2); assert.match(capped.more, /narrow/)
    await assert.rejects(s.search('o/demo', 'x'), /2 to 200 characters/)
    assert.equal(s.view().projects.find((p) => p.project === 'o/demo').searches, 6)
  })

  test('a pinned project is read at its pin and never follows the branch', async () => {
    reset(); const s = shelf()
    const r = await s.read('pinned', 'README.md')
    assert.equal(r.commit, PIN); assert.match(r.text, new RegExp(`demo at ${PIN}`))
    assert.equal(hits.some((u) => u.includes('/commits/HEAD')), false)
    const v = s.view().projects.find((p) => p.project === 'o/pinned')
    assert.equal(v.pinned, true); assert.equal(v.commit, PIN); assert.equal(v.copy.commit, PIN)
  })

  test('an unpinned project follows its default branch, looked up at most every six hours', async () => {
    reset(); let now = Date.parse('2026-11-09T12:00:00Z')
    const s = shelf({ now: () => now })
    assert.equal((await s.files('o/demo')).commit, A)
    head = B
    assert.equal((await s.files('o/demo')).commit, A) // within the six hours: no new lookup
    now += 7 * 3600 * 1000
    assert.equal((await s.read('o/demo', 'README.md')).commit, B)
    assert.equal(existsSync(join(s.dir, 'o__demo', A)), false) // one copy per project
    mode = 'down'; now += 7 * 3600 * 1000
    assert.equal((await s.read('o/demo', 'README.md')).commit, B) // GitHub down: the last good copy keeps serving
  })

  test('a repository GitHub does not show to the public never lands here, and the failure is kept', async () => {
    reset(); const s = shelf({ list: [{ repo: 'o/private' }, { repo: 'gone/x', pin: PIN }] })
    await assert.rejects(s.files('o/private'), /no public repository/)
    await assert.rejects(s.files('gone/x'), /no public copy/)
    assert.match(s.view().projects.find((p) => p.project === 'gone/x').lastError.why, /no public copy/)
    assert.equal(sawAuth, false)
    const log = s.logLines()
    assert.equal(log.at(-1).project, 'gone/x'); assert.equal(log.at(-1).status, 404); assert.ok(log.at(-1).error)
    assert.equal(JSON.stringify(log).includes('demo at'), false) // the log holds no content
  })

  test('past its size the shelf drops the copy read longest ago, and fetches it again when asked', async () => {
    reset(); const s = shelf({ maxBytes: 300 })
    await s.files('o/demo'); await s.files('o/pinned') // each copy is about 230 bytes of text
    assert.equal(existsSync(join(s.dir, 'o__demo')), false); assert.equal(existsSync(join(s.dir, 'o__pinned', PIN)), true)
    assert.equal((await s.read('o/demo', 'README.md')).commit, A) // back on demand
    assert.equal(existsSync(join(s.dir, 'o__pinned')), false)
  })

  test('a project is found by owner/repository, by its name when only one has it, or by its address', async () => {
    reset(); const s = shelf({ own: 'room/code', list: [{ repo: 'o/demo' }, { repo: 'p/demo' }, { repo: 'o/other' }] })
    assert.equal(s.find('O/Demo').repo, 'o/demo')
    assert.equal(s.find('https://github.com/o/other/').repo, 'o/other')
    assert.equal(s.find('other').repo, 'o/other')
    assert.equal(s.find().repo, 'room/code') // none given: the room's own
    assert.throws(() => s.find('demo'), /matches 2 projects/)
    assert.throws(() => s.find('nobody/here'), /not on the shelf/)
  })

  test('a large project lists as folders with counts', async () => {
    const many = Array.from({ length: 450 }, (_, i) => [`pkg${i % 3}/f${i}.js`, `// ${i}\n`])
    const big = createServer((req, res) => { if (req.url.includes('/commits/')) { res.writeHead(200); return res.end(A) } res.writeHead(200); res.end(tarGz('big-aaaaaaa', [['top.md', 'hi\n'], ...many])) })
    await new Promise((r) => big.listen(0, r))
    try {
      const s = new Shelf({ dataDir: mkdtempSync(join(dir, 'b-')), list: [{ repo: 'o/big' }], hosts: { api: `http://localhost:${big.address().port}`, code: `http://localhost:${big.address().port}` }, allowHttp: true })
      const top = await s.files('o/big')
      assert.equal(top.count, 451); assert.deepEqual(top.folders.map((f) => [f.path, f.files]), [['pkg0/', 150], ['pkg1/', 150], ['pkg2/', 150]]); assert.deepEqual(top.files.map((f) => f.path), ['top.md'])
      const one = await s.files('o/big', { under: 'pkg1' })
      assert.equal(one.count, 150); assert.equal(one.files.length, 150)
      await assert.rejects(s.files('o/big', { under: 'nope' }), /no files under/)
    } finally { big.close() }
  })

  test('the tar reader hands over whole files and marks the ones over the cap', () => {
    const got = []
    const r = tarReader((path, size, body) => got.push([path, size, body === null ? null : body.toString()]), { cap: 10 })
    const tar = Buffer.concat([entry('a.txt', 'hello'), entry('b.txt', 'x'.repeat(50)), entry(LONG, 'deep'), block(1024)])
    for (let i = 0; i < tar.length; i += 37) r.write(tar.subarray(i, i + 37)) // in awkward pieces, as a network delivers them
    assert.deepEqual(got, [['a.txt', 5, 'hello'], ['b.txt', 50, null], [LONG, 4, 'deep']])
  })

  test('the commits the test host builds from come from its own Dockerfiles', () => {
    const root = mkdtempSync(join(dir, 'c-'))
    assert.deepEqual(pinsFromCommunity(root), {})
    mkdirSync(join(root, 'community/vta'), { recursive: true }); mkdirSync(join(root, 'community/mediator'), { recursive: true })
    writeFileSync(join(root, 'community/vta/Dockerfile'), `FROM x\nARG VTI_SHA=${A}\nARG FEATURES="a,b"\n`)
    writeFileSync(join(root, 'community/mediator/Dockerfile'), `ARG MEDIATOR_REPO=https://example\nARG MEDIATOR_SHA=${B}\n`)
    assert.deepEqual(pinsFromCommunity(root), { vti: A, mediator: B })
    const here = pinsFromCommunity(join(import.meta.dirname, '..')) // this repository's own files carry both pins
    assert.match(here.vti, /^[0-9a-f]{40}$/); assert.match(here.mediator, /^[0-9a-f]{40}$/)
    assert.equal(readFileSync(join(import.meta.dirname, '../Dockerfile'), 'utf8').includes('COPY community ./community'), true) // so the running room can read them
  })

  test('a repository named in the Resources or on the map is on the shelf', () => {
    const st = { resources: new Map([['k', { url: 'https://github.com/someone/their-app', title: 'Their app' }], ['j', { url: 'https://example.org/spec' }]]), mapProjects: new Map([['x', { url: 'https://github.com/team/thing/', name: 'Thing' }], ['y', { url: null }]]) }
    const named = namedRepos({ log: { state: st } }, [{ url: 'https://github.com/Project-Weave-Tech/dtg-interop', title: 'Board' }, { url: 'https://github.com/TrustStackers', title: 'An organisation, not a repository' }])
    assert.deepEqual(named.map((n) => n.repo), ['Project-Weave-Tech/dtg-interop', 'someone/their-app', 'team/thing'])
    const s = new Shelf({ dataDir: mkdtempSync(join(dir, 'n-')), list: [], named: () => named })
    assert.deepEqual(s.all().map((p) => p.repo), ['Project-Weave-Tech/dtg-interop', 'someone/their-app', 'team/thing'])
  })
})

describe('the shelf in a running room', () => {
  let dir, ctx, base, gh
  const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() } }
  before(async () => {
    head = A; hits = []; sawAuth = false; mode = 'ok'
    await new Promise((r) => fake.listen(0, r)); gh = `http://localhost:${fake.address().port}`
    dir = mkdtempSync(join(tmpdir(), 'wpi-shelf-app-'))
    const config = { ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, checkEveryMinutes: 0, githubToken: 'ghp_must_never_be_sent', workspaceRepo: 'o/demo', llm: { ...baseConfig.llm, apiKey: '', anthropicKey: '', provider: 'openai' } }
    ctx = await createApp(config, { hostWelcomeMs: null, sources: { startDelayMs: 3_600_000 }, shelf: { list: [{ repo: 'o/pinned', title: 'Pinned', pin: PIN }], hosts: { api: gh, code: gh }, allowHttp: true } })
    await new Promise((r) => ctx.server.listen(0, r)); base = `http://localhost:${ctx.server.address().port}`
  })
  after(async () => { await ctx.stop(); fake.close(); rmSync(dir, { recursive: true, force: true }) })

  test('/api/shelf lists the projects; files, read and search answer over HTTP; the room\'s token is never sent', async () => {
    const list = await get('/api/shelf')
    assert.equal(list.status, 200)
    assert.ok(list.body.projects.some((p) => p.project === 'o/pinned' && p.pinned && p.commit === PIN))
    assert.ok(list.body.projects.some((p) => p.project === 'o/demo' && p.from === 'the room itself'))
    assert.ok(list.body.projects.some((p) => p.project === 'Project-Weave-Tech/dtg-interop')) // from the Resources the page carries
    const files = await get('/api/shelf/files?project=o/pinned')
    assert.equal(files.body.commit, PIN); assert.ok(files.body.files.some((f) => f.path === 'src/main.rs'))
    const read = await get('/api/shelf/read?project=o/pinned&path=src/setup.rs')
    assert.match(read.body.text, /encrypted_file/)
    const found = await get('/api/shelf/search?project=o/pinned&q=cli-synthesis')
    assert.deepEqual(found.body.hits.map((h) => `${h.path}:${h.line}`), ['src/main.rs:2'])
    assert.equal((await get('/api/shelf/search?q=8100')).body.project, 'o/demo') // no project: the room's own
    assert.equal((await get('/api/shelf/read?project=o/pinned&path=nope.rs')).status, 404)
    assert.equal((await get('/api/shelf/files?project=nobody/here')).status, 404)
    assert.equal((await get('/api/shelf/search?project=o/pinned&q=x')).status, 400)
    assert.equal((await fetch(base + '/api/shelf', { method: 'POST' })).status, 405)
    assert.equal(sawAuth, false)
  })

  test('agents reach it through their tools, and a repository in the Resources says so', async () => {
    const tools = {}
    registerAgentTools({ registerTool: (name, def, fn) => { tools[name] = { def, fn } } }, { did: 'did:key:z6Mkagent', read: async (p) => views.read(ctx, p), act: async () => ({}) })
    const call = async (name, args) => { const out = await tools[name].fn(args); assert.ok(!out.isError, out.content?.[0]?.text); return JSON.parse(out.content[0].text) }
    assert.ok((await call('projects', {})).projects.some((p) => p.project === 'o/pinned'))
    assert.equal((await call('code_files', { project: 'o/pinned', under: 'docs' })).files[0].path, 'docs/guide.md')
    assert.match((await call('read_code', { project: 'o/pinned', path: 'docs/guide.md' })).text, /vta setup --from/)
    assert.equal((await call('search_code', { project: 'o/pinned', q: 'serve(8100)' })).hits[0].line, 3)
    const bad = await tools.read_code.fn({ project: 'o/pinned', path: 'nope' }); assert.equal(bad.isError, true)
    const res = views.resourcesView(ctx).resources.find((r) => r.url === 'https://github.com/Project-Weave-Tech/dtg-interop')
    assert.equal(res.code.project, 'Project-Weave-Tech/dtg-interop'); assert.match(res.code.files, /^\/api\/shelf\/files\?project=/)
    assert.equal(views.resourcesView(ctx).resources.find((r) => r.url === 'https://openhaven.net/api/graph.json').code, undefined)
  })
})
