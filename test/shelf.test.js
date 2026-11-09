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
import { FETCHES_PER_MINUTE, MAX_FILE_BYTES, SHELF, SIGNER_FETCHES_PER_HOUR, Shelf, namedRepos, pinOf, pinsFromCommunity, insideFolder, repoOf, secretPath, tarReader } from '../src/server/shelf.js'
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
// git writes the commit an archive was cut from into its first record (`comment=<commit>`); `cutFrom` plays that
const globalHeader = (cutFrom) => { const rec = paxRecord('comment', cutFrom); return Buffer.concat([header('pax_global_header', Buffer.byteLength(rec), 'g'), pad(Buffer.from(rec))]) }
const tarGz = (top, files, cutFrom) => gzipSync(Buffer.concat([...(cutFrom ? [globalHeader(cutFrom)] : []), header(`${top}/`, 0, '5'), ...files.map(([p, b, t]) => entry(`${top}/${p}`, b, t)), block(1024)]))

const A = 'a'.repeat(40), B = 'b'.repeat(40), PIN = 'c'.repeat(40), D = 'd'.repeat(40)
const PLANTED = 'ghp_PLANTEDfakeTOKEN0123456789abcdefABCD' // a made-up token in a fetched file: it must never reach a log line
const LONG = `deep/${'x'.repeat(60)}/${'y'.repeat(60)}/long-name.rs`
const REPO_FILES = (sha) => [
  ['README.md', `# demo at ${sha}\nport = 8100\n`],
  ['LICENSE', 'Apache License, Version 2.0\n'],
  ['notes.txt', `someone left this in a text file: ${PLANTED}\n`],
  ['.env', `TOKEN=${PLANTED}\n`],
  ['.env.example', `TOKEN=${PLANTED}\n`], // a kept example file: public, so it reads as itself, and still never reaches a log line
  ['deploy/server.key', '-----BEGIN PRIVATE KEY-----\n'],
  ['.ssh/config', 'Host x\n'],
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

let head, hits, sawAuth, mode, override // `override(sha, repo)`: the files the stand-in serves instead of REPO_FILES
const fake = createServer((req, res) => {
  hits.push(req.url); if (req.headers.authorization) sawAuth = true
  if (mode === 'down') { res.writeHead(503); return res.end('down') }
  const m = /^\/repos\/([^/]+\/[^/]+)\/commits\/HEAD$/.exec(req.url)
  if (m) { if (m[1] === 'o/private') { res.writeHead(404); return res.end('Not Found') } res.writeHead(200, { 'content-type': 'application/vnd.github.sha' }); return res.end(head) }
  const t = /^\/([^/]+)\/([^/]+)\/tar\.gz\/([0-9a-f]{40})$/.exec(req.url)
  if (t && mode === 'redirect') { res.writeHead(302, { location: 'http://127.0.0.1:9/elsewhere.tar.gz' }); return res.end() }
  if (t && t[1] !== 'gone') {
    const files = override ? override(t[3], t[2]) : t[2] === 'nolicence' ? REPO_FILES(t[3]).filter(([p]) => p !== 'LICENSE') : REPO_FILES(t[3])
    res.writeHead(200, { 'content-type': 'application/x-gzip', 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '57', 'x-ratelimit-reset': '1794000000' })
    return res.end(tarGz(`${t[2]}-${t[3]}`, files, mode === 'wrong-commit' ? D : t[3]))
  }
  res.writeHead(404); res.end('Not Found')
})

describe('the projects shelf', () => {
  let dir, base
  const shelf = (over = {}) => new Shelf({ dataDir: mkdtempSync(join(dir, 's-')), list: [{ repo: 'o/demo', title: 'Demo', pin: A }, { repo: 'o/pinned', title: 'Pinned', pin: PIN }], hosts: { api: base, code: base }, allowHttp: true, ...over })
  before(async () => { await new Promise((r) => fake.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${fake.address().port}`; dir = mkdtempSync(join(tmpdir(), 'wpi-shelf-')) })
  after(() => { fake.close(); rmSync(dir, { recursive: true, force: true }) })
  const reset = () => { head = A; hits = []; sawAuth = false; mode = 'ok'; override = null }

  test('the list in code names the projects on the Resources page, and no address anyone typed', () => {
    assert.ok(SHELF.length >= 9)
    for (const p of SHELF) { assert.ok(repoOf(`https://github.com/${p.repo}`) === p.repo, p.repo); assert.match(p.pin, /^[0-9a-f]{40}$/, `${p.repo} names one full commit`) }
    assert.equal(new Shelf({ dataDir: mkdtempSync(join(dir, 'l-')) }).all().every((p) => p.pin), true) // every listed project is read at a pin
    assert.ok(SHELF.some((p) => p.repo === 'OpenVTC/verifiable-trust-infrastructure' && p.pinned === 'vti'))
    assert.ok(SHELF.some((p) => p.repo === 'affinidi/affinidi-messaging-mediator' && p.pinned === 'mediator'))
  })

  test('only github.com repositories count, by owner and name', () => {
    assert.equal(repoOf('https://github.com/Project-Weave-Tech/dtg-interop'), 'Project-Weave-Tech/dtg-interop')
    assert.equal(repoOf('https://github.com/o/r/tree/main/docs'), 'o/r')
    assert.equal(repoOf('https://github.com/o/r.git'), 'o/r')
    assert.equal(pinOf(`https://github.com/o/r/tree/${A}`), A); assert.equal(pinOf(`https://github.com/o/r/commit/${A}`), A); assert.equal(pinOf(`https://github.com/o/r/blob/${A}/src/x.rs`), A)
    for (const no of ['https://github.com/o/r', 'https://github.com/o/r/tree/main', 'https://github.com/o/r/tree/v1.2.3', `https://github.com/o/r/tree/${A.slice(0, 12)}`, `https://github.com/o/r/releases/tag/${A}`, `https://gitlab.com/o/r/tree/${A}`, `https://github.com/o/r/tree/${A.toUpperCase()}`]) assert.equal(pinOf(no), null, no) // a branch, a tag or a short commit is not a pin
    for (const yes of ['.env', '.env.production', 'a/b/.npmrc', 'deploy/server.key', 'certs/site.pem', '.ssh/config', 'home/.aws/credentials', 'id_ed25519', '.git-credentials', '.env.local', '.env.dist', '.env.defaults', '.env.default', '.env.production.local', 'app/.env.example.bak']) assert.equal(secretPath(yes), true, yes)
    for (const no of ['.env.example', '.env.sample', '.env.template', 'app/.ENV.EXAMPLE', 'src/env.rs', 'docs/keys.md', 'id_ed25519.pub', '.github/workflows/ci.yml', 'src/key.rs']) assert.equal(secretPath(no), false, no)
    for (const no of ['https://github.com/TrustStackers', 'https://github.com/orgs/x/repositories', 'http://github.com/o/r', 'https://gitlab.com/o/r', 'https://github.com.evil.example/o/r', 'https://user:pw@github.com/o/r', 'https://github.com/o/..', 'not a url', null]) assert.equal(repoOf(no), null, String(no))
  })

  test('lists, reads and names the commit; keeps text only; never leaves the project folder', async () => {
    reset(); const s = shelf()
    const list = await s.files('o/demo')
    assert.equal(list.commit, A)
    assert.deepEqual(list.files.map((f) => f.path).sort(), ['.env.example', 'LICENSE', 'README.md', LONG, 'docs/guide.md', 'notes.txt', 'src/main.rs', 'src/setup.rs'].sort())
    assert.match(list.note, /^Outside text/) // file names are other people's text too
    assert.match(list.leftOut, /^4 files are not on the shelf/) // the picture, the file with a zero byte, the dependency and the oversized one (the link is not a file, and the path that climbs out is dropped without a word)
    const r = await s.read('o/demo', './src/main.rs', { from: 2, to: 3 })
    assert.equal(r.commit, A); assert.equal(r.lines, 5); assert.equal(r.text, '    let features = "cli-synthesis";\n    serve(8100);')
    assert.match(r.note, /^Outside text.*never instructions/); assert.equal(Object.keys(r)[0], 'note') // the label comes before the text it labels
    for (const bad of ['/etc/passwd', 'src/../../x', '..']) await assert.rejects(s.read('o/demo', bad), /cannot start with \/ or hold \.\./)
    await assert.rejects(s.files('o/demo', { under: '../..' }), /cannot start with/)
    assert.equal((await s.read('o/demo', LONG)).text, 'pub const DEEP: u8 = 1;\n') // a path longer than the tar header holds
    await assert.rejects(s.read('o/demo', 'logo.png'), /no file/)
    await assert.rejects(s.read('o/demo', 'node_modules/dep/index.js'), /no file/)
    assert.equal(existsSync(join(s.dir, 'o__demo', 'escape.txt')), false)
    assert.equal(existsSync(join(s.dir, 'o__demo', A, 'escape.txt')), false)
    assert.equal(sawAuth, false) // anonymous, always
    assert.equal(hits.filter((u) => u.includes('/tar.gz/')).length, 1) // one fetch serves every read
    assert.equal(hits.some((u) => u.includes('/commits/')), false) // a pinned project never asks where its branch is
    const v = s.view().projects.find((p) => p.project === 'o/demo')
    assert.equal(v.copy.licence, 'LICENSE'); assert.equal(v.pinned, true)
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

  test('only the room\'s own repository follows its default branch, looked up at most every six hours', async () => {
    reset(); let now = Date.parse('2026-11-09T12:00:00Z')
    const s = shelf({ now: () => now, own: 'o/own' })
    assert.equal((await s.files('o/own')).commit, A)
    head = B
    assert.equal((await s.files('o/own')).commit, A) // within the six hours: no new lookup
    assert.equal((await s.files('o/demo')).commit, A) // a pinned project stays at its pin whatever the branch does
    now += 7 * 3600 * 1000
    assert.equal((await s.read('o/own', 'README.md')).commit, B)
    assert.equal((await s.read('o/demo', 'README.md')).commit, A)
    assert.equal(existsSync(join(s.dir, 'o__own', A)), false) // one copy per project
    mode = 'down'; now += 7 * 3600 * 1000
    assert.equal((await s.read('o/own', 'README.md')).commit, B) // GitHub down: the last good copy keeps serving
    assert.deepEqual(s.logLines().filter((l) => l.kind === 'head').map((l) => [l.status, l.commit]), [[200, A], [200, B], [503, null]]) // each lookup is in the log
  })

  test('a repository that is not on the registry is refused, and GitHub is never asked about it', async () => {
    reset(); const s = shelf()
    await assert.rejects(s.files('nobody/here'), (e) => e.status === 404 && /not on the shelf, and nothing is fetched/.test(e.message))
    await assert.rejects(s.read('https://github.com/evil/repo', 'README.md'), /not on the shelf/)
    await assert.rejects(s.search('o/unlisted', 'token'), /not on the shelf/)
    assert.deepEqual(hits, []); assert.deepEqual(s.logLines(), [])
  })

  test('a signed entry puts a repository on the shelf only at one full commit; a newer entry moves the pin; taking it away purges the copy', async () => {
    reset(); let named = [{ repo: 'team/thing', title: 'Thing', from: 'added to the Resources in the room', pin: null, by: 'did:key:zMember', at: '2026-11-09T10:00:00Z' }]
    const s = shelf({ list: [], named: () => named })
    assert.deepEqual(s.all(), []) // a branch or a bare address is not a pin
    await assert.rejects(s.files('team/thing'), /named in the room without a commit.*all 40 characters/)
    assert.deepEqual(s.view().waitingForACommit.map((w) => w.project), ['team/thing'])
    assert.deepEqual(hits, []) // nothing was fetched for it
    named = [...named, { repo: 'team/thing', title: 'Thing', from: 'added to the Resources in the room', pin: A, by: 'did:key:zMember', at: '2026-11-09T11:00:00Z' }]
    assert.equal((await s.read('team/thing', 'README.md')).commit, A)
    assert.deepEqual(s.view().waitingForACommit, [])
    named = [...named, { repo: 'team/thing', title: 'Thing', from: 'a project on the map', pin: B, by: 'did:key:zOther', at: '2026-11-09T12:00:00Z' }]
    assert.equal(s.find('team/thing').pin, B) // the newest signed entry names the pin
    s.view(); assert.equal(existsSync(join(s.dir, 'team__thing', A)), false) // the copy at the old pin left the disk before anything else was answered
    assert.equal((await s.read('team/thing', 'README.md')).commit, B)
    named = []
    s.view(); assert.equal(existsSync(join(s.dir, 'team__thing')), false) // no longer named: purged
    await assert.rejects(s.read('team/thing', 'README.md'), /not on the shelf/)
    assert.deepEqual(s.logLines().filter((l) => l.kind === 'purge').map((l) => l.why), ['its pin moved', 'no longer named in the room'])
    assert.equal(s.view().projects.length, 0)
  })

  test('a file named like a secret is never kept, and a planted token never reaches a log line', async () => {
    reset(); const s = shelf()
    const list = await s.files('o/demo')
    for (const gone of ['.env', 'deploy/server.key', '.ssh/config']) { assert.equal(list.files.some((f) => f.path === gone), false, gone); await assert.rejects(s.read('o/demo', gone), /no file/) }
    assert.match((await s.read('o/demo', 'notes.txt')).text, new RegExp(PLANTED)) // the text file that holds it is public code, and reads as itself…
    assert.match((await s.read('o/demo', '.env.example')).text, new RegExp(PLANTED)) // the kept example file reads as itself too
    assert.equal((await s.search('o/demo', PLANTED)).found, 2) // notes.txt and .env.example
    await assert.rejects(s.read('o/demo', `${PLANTED}.txt`), /no file/)
    s.flush()
    const kept = [readFileSync(join(s.dir, 'fetch-log.jsonl'), 'utf8'), readFileSync(join(s.dir, 'use.json'), 'utf8'), JSON.stringify(s.view()), JSON.stringify(s.logLines())].join('\n')
    assert.equal(kept.includes(PLANTED), false) // …but no log line, counter or view repeats it, a search's words included
    assert.equal(kept.includes('demo at'), false)
    const line = s.logLines().find((l) => l.kind === 'copy')
    assert.deepEqual([line.project, line.commit, line.status, line.files, line.commitConfirmed], ['o/demo', A, 200, 8, true])
    assert.deepEqual(line.refused, { paths: 1, secrets: 3 }); assert.ok(line.bytes > 0); assert.ok(line.ms >= 0)
    assert.deepEqual(line.github, { 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '57', 'x-ratelimit-reset': '1794000000' }) // what GitHub said about its limits is kept
  })

  test('the copy must be the pinned commit, come without a redirect, and state a licence', async () => {
    reset(); mode = 'wrong-commit'
    const s = shelf({ list: [{ repo: 'o/demo', pin: A }, { repo: 'o/nolicence', pin: A }] })
    await assert.rejects(s.files('o/demo'), /different commit than the one o\/demo is pinned at/)
    assert.equal(existsSync(join(s.dir, 'o__demo', A)), false)
    reset(); mode = 'redirect'
    const s2 = shelf()
    await assert.rejects(s2.files('o/demo'), /could not fetch o\/demo/)
    assert.equal(existsSync(join(s2.dir, 'o__demo', A)), false); assert.equal(hits.length, 1) // the redirect was not followed
    reset()
    await assert.rejects(s.files('o/nolicence'), (e) => e.status === 409 && /states no licence at its top level/.test(e.message))
    await assert.rejects(s.files('o/nolicence'), /states no licence/) // and it is not asked for again at that commit
    assert.equal(hits.filter((u) => u.includes('/nolicence/')).length, 1); assert.equal(existsSync(join(s.dir, 'o__nolicence', A)), false)
  })

  test('a file is written only inside its own project\'s folder', () => {
    const root = join(dir, 'copy', 'files')
    for (const ok of [join(root, 'a.txt'), join(root, 'src/deep/b.rs'), join(root, 'a/../b.txt')]) assert.equal(insideFolder(root, ok), true, ok)
    for (const no of [join(root, '../escape.txt'), join(root, 'a/../../x'), '/etc/passwd', root, join(root, '..', 'files-other', 'x'), join(dir, 'copy', 'index.json')]) assert.equal(insideFolder(root, no), false, no)
  })

  test('a cap that is passed stops the unpack and discards it: no partial copy, and no second try at that commit', async () => {
    const refuseAt = async (limits, why, files = null) => {
      reset(); override = files; const s = shelf({ limits })
      await assert.rejects(s.files('o/demo'), (e) => e.status === 413 && why.test(e.message) && /no copy was kept/.test(e.message))
      assert.equal(existsSync(join(s.dir, 'o__demo', A)), false); assert.equal(existsSync(join(s.dir, 'o__demo', `${A}.tmp`)), false) // nothing left on disk
      await assert.rejects(s.files('o/demo'), /no copy was kept/); assert.equal(hits.filter((u) => u.includes('/tar.gz/')).length, 1) // a refusal that cannot change is not asked for again
      assert.equal(s.logLines().find((l) => l.kind === 'copy').error.includes('no copy'), true)
      return s
    }
    await refuseAt({ bytes: 100 }, /more than 100 bytes of text/)
    await refuseAt({ files: 2 }, /more than 2 files/)
    await refuseAt({ depth: 1 }, /more than 1 folders deep/)
    await refuseAt({ download: 200 }, /download of more than 200 bytes/) // the compressed bytes are counted as they arrive
    await refuseAt({ unpacked: 1_000_000 }, /more than 1000000 bytes once unpacked/, () => [['LICENSE', 'MIT License\n'], ['junk.bin', Buffer.alloc(5_000_000)]]) // a few KB that inflate to 5 MB, none of it kept
    reset(); assert.equal((await shelf().files('o/demo')).commit, A) // the real limits let an ordinary project through
    assert.equal('partial' in shelf().view().projects[0], false)
  })

  test('a failed fetch waits ten minutes; one minute and one member each have their own limit', async () => {
    reset(); let now = Date.parse('2026-11-09T12:00:00Z')
    const s = shelf({ now: () => now, list: [{ repo: 'gone/x', pin: PIN }] })
    await assert.rejects(s.files('gone/x'), /no public copy/)
    await assert.rejects(s.files('gone/x'), /asks GitHub again ten minutes after a failure/)
    assert.equal(hits.length, 1)
    now += 11 * 60 * 1000
    await assert.rejects(s.files('gone/x'), /no public copy/); assert.equal(hits.length, 2)

    reset(); const many = Array.from({ length: FETCHES_PER_MINUTE + 1 }, (_, i) => ({ repo: `o/r${i}`, pin: A }))
    const m = shelf({ now: () => now, list: many })
    for (const p of many.slice(0, FETCHES_PER_MINUTE)) await m.files(p.repo)
    await assert.rejects(m.files(many.at(-1).repo), (e) => e.status === 429 && /a minute/.test(e.message))
    now += 61_000
    assert.equal((await m.files(many.at(-1).repo)).commit, A) // a refusal for being busy is not held against the project

    reset(); const theirs = Array.from({ length: SIGNER_FETCHES_PER_HOUR + 1 }, (_, i) => ({ repo: `one/r${i}`, pin: A, by: 'did:key:zOne', at: i }))
    const g = shelf({ now: () => now, list: [], named: () => [...theirs, { repo: 'two/r', pin: A, by: 'did:key:zTwo', at: 0 }] })
    for (const p of theirs.slice(0, SIGNER_FETCHES_PER_HOUR)) { await g.files(p.repo); now += 15_000 }
    await assert.rejects(g.files(theirs.at(-1).repo), (e) => e.status === 429 && /one member named/.test(e.message))
    assert.equal((await g.files('two/r')).commit, A) // another member's entry is still served
    assert.equal(g.view().limits.fetchedThisHour, SIGNER_FETCHES_PER_HOUR + 1)
  })

  test('how much the shelf is used is counted per project and kept across a restart', async () => {
    reset(); const dataDir = mkdtempSync(join(dir, 'u-'))
    const s = shelf({ dataDir })
    await s.files('o/demo'); await s.read('o/demo', 'README.md'); await s.search('o/demo', 'port')
    s.flush()
    const again = shelf({ dataDir }), v = again.view().projects.find((p) => p.project === 'o/demo')
    assert.equal(v.reads, 2); assert.equal(v.searches, 1); assert.ok(v.lastReadAt)
    const use = JSON.parse(readFileSync(join(again.dir, 'use.json'), 'utf8'))
    assert.deepEqual(Object.values(use.projects['o/demo'].days), [{ reads: 2, searches: 1 }])
  })

  test('a repository GitHub does not show to the public never lands here, and the failure is kept', async () => {
    reset(); const s = shelf({ own: 'o/private', list: [{ repo: 'gone/x', pin: PIN }] })
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
    reset(); const s = shelf({ own: 'room/code', list: [{ repo: 'o/demo', pin: A }, { repo: 'p/demo', pin: A }, { repo: 'o/other', pin: A }] })
    assert.equal(s.find('O/Demo').repo, 'o/demo')
    assert.equal(s.find('https://github.com/o/other/').repo, 'o/other')
    assert.equal(s.find('other').repo, 'o/other')
    assert.equal(s.find().repo, 'room/code') // none given: the room's own
    assert.throws(() => s.find('demo'), /matches 2 projects/)
    assert.throws(() => s.find('nobody/here'), /not on the shelf/)
  })

  test('a large project lists as folders with counts', async () => {
    const many = Array.from({ length: 450 }, (_, i) => [`pkg${i % 3}/f${i}.js`, `// ${i}\n`])
    const big = createServer((req, res) => { if (req.url.includes('/commits/')) { res.writeHead(200); return res.end(A) } res.writeHead(200); res.end(tarGz('big-aaaaaaa', [['LICENSE', 'MIT\n'], ['top.md', 'hi\n'], ...many])) })
    await new Promise((r) => big.listen(0, '127.0.0.1', r))
    try {
      const s = new Shelf({ dataDir: mkdtempSync(join(dir, 'b-')), list: [{ repo: 'o/big', pin: A }], hosts: { api: `http://127.0.0.1:${big.address().port}`, code: `http://127.0.0.1:${big.address().port}` }, allowHttp: true })
      const top = await s.files('o/big')
      assert.equal(top.count, 452); assert.deepEqual(top.folders.map((f) => [f.path, f.files]), [['pkg0/', 150], ['pkg1/', 150], ['pkg2/', 150]]); assert.deepEqual(top.files.map((f) => f.path), ['LICENSE', 'top.md'])
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
    const st = {
      resources: new Map([
        ['k', { url: `https://github.com/someone/their-app/tree/${A}`, title: 'Their app', addedBy: 'did:key:zAdder', at: '2026-11-09T10:00:00Z' }],
        ['b', { url: 'https://github.com/someone/on-a-branch/tree/main', title: 'On a branch', addedBy: 'did:key:zAdder', at: '2026-11-09T10:00:00Z' }],
        ['n', { url: `https://github.com/someone/only-a-note/tree/${A}`, title: null, addedBy: null, notes: [{ text: 'a note', by: 'did:key:zX' }] }],
        ['j', { url: 'https://example.org/spec', title: 'A spec', addedBy: 'did:key:zAdder' }],
      ]),
      mapProjects: new Map([['x', { url: `https://github.com/team/thing/commit/${B}`, name: 'Thing', addedBy: 'did:key:zFirst', updatedBy: 'did:key:zLast', at: '2026-11-09T11:00:00Z' }], ['y', { url: null }]]),
    }
    const named = namedRepos({ log: { state: st } }, [{ url: 'https://github.com/Project-Weave-Tech/dtg-interop', title: 'Board' }, { url: 'https://github.com/TrustStackers', title: 'An organisation, not a repository' }])
    assert.deepEqual(named.map((n) => [n.repo, n.pin, n.by]), [['Project-Weave-Tech/dtg-interop', null, null], ['someone/their-app', A, 'did:key:zAdder'], ['someone/on-a-branch', null, 'did:key:zAdder'], ['team/thing', B, 'did:key:zLast']])
    const s = new Shelf({ dataDir: mkdtempSync(join(dir, 'n-')), list: [], named: () => named })
    assert.deepEqual(s.all().map((p) => [p.repo, p.pin, p.by]), [['team/thing', B, 'did:key:zLast'], ['someone/their-app', A, 'did:key:zAdder']]) // only what a signed entry named at one commit
    assert.deepEqual(s.waitingForACommit.map((w) => w.project).sort(), ['Project-Weave-Tech/dtg-interop', 'someone/on-a-branch'])
    assert.equal(s.has('Someone/Their-App'), true); assert.equal(s.has('someone/on-a-branch'), false)
  })
})

describe('the shelf in a running room', () => {
  let dir, ctx, base, gh
  const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() } }
  before(async () => {
    head = A; hits = []; sawAuth = false; mode = 'ok'
    await new Promise((r) => fake.listen(0, '127.0.0.1', r)); gh = `http://127.0.0.1:${fake.address().port}`
    dir = mkdtempSync(join(tmpdir(), 'wpi-shelf-app-'))
    const config = { ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, checkEveryMinutes: 0, githubToken: 'ghp_must_never_be_sent', workspaceRepo: 'o/demo', llm: { ...baseConfig.llm, apiKey: '', anthropicKey: '', provider: 'openai' } }
    ctx = await createApp(config, { hostWelcomeMs: null, sources: { startDelayMs: 3_600_000 }, shelf: { list: [{ repo: 'o/pinned', title: 'Pinned', pin: PIN }, { repo: 'Project-Weave-Tech/dtg-interop', title: 'Board', pin: A }], hosts: { api: gh, code: gh }, allowHttp: true } })
    await new Promise((r) => ctx.server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${ctx.server.address().port}`
  })
  after(async () => { await ctx.stop(); fake.close(); rmSync(dir, { recursive: true, force: true }) })

  test('/api/shelf lists the projects; files, read and search answer over HTTP; the room\'s token is never sent', async () => {
    const list = await get('/api/shelf')
    assert.equal(list.status, 200)
    assert.ok(list.body.projects.some((p) => p.project === 'o/pinned' && p.pinned && p.commit === PIN))
    assert.ok(list.body.projects.some((p) => p.project === 'o/demo' && p.from === 'the room itself'))
    assert.ok(list.body.projects.some((p) => p.project === 'Project-Weave-Tech/dtg-interop' && p.commit === A))
    assert.ok(list.body.waitingForACommit.some((w) => w.project === 'Mickens-Lab/openvti-starter')) // on the Resources page, but this room's list gives it no commit: listed, never fetched
    assert.match(list.body.fetchedWith, /no account/)
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
    assert.equal(views.resourcesView(ctx).resources.find((r) => r.url === 'https://github.com/Mickens-Lab/openvti-starter').code, undefined) // not on the registry here: no promise that its code can be read
  })
})
