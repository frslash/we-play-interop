// An agent's notebook kept in a sealed room its person holds (agent/vta.js, agent/room-host.js, agent/vti-notebook.js),
// against the stand-in trust agent and room host in test/helpers/fake-vti.js. The stand-in follows the real wire and
// seals with the real cipher and associated data, so these tests exercise the same bytes; they do not prove interop
// with the real services (test/live/vti-notebook-live.test.js does, when it is given one).
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, test } from 'node:test'
import { promisify } from 'node:util'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { newIdentity } from '../src/shared/did.js'
import { AGENT_SCOPES, TYPES, signedDocument } from '../src/shared/types.js'
import { postTask, signedTask, typeUri } from '../src/shared/trusttask.js'
import { config as baseConfig } from '../src/server/config.js'
import { createApp } from '../src/server/index.js'
import { Vta, VtiError, decodeCredential, readCredential } from '../agent/vta.js'
import { RoomHost, isVersionConflict } from '../agent/room-host.js'
import { NOTE_TAG, VtiNotebook, notebookFromEnv } from '../agent/vti-notebook.js'
import { startFakeVti } from './helpers/fake-vti.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const noWait = async () => {}
const T = (family, v) => typeUri(family, v)
const texts = (r) => r.notes.map((n) => n.text)

/** A sealed room at a stand-in host, owned by one persona, with a second persona (the person's member) added: the room is at epoch 2. */
async function world (opts) {
  const fake = await startFakeVti(opts)
  const owner = fake.persona(), member = fake.persona()
  const room = fake.room(owner, opts?.room)
  fake.admit(room, member)
  const agent = newIdentity()
  /** One machine: its own sign-in at the person's trust agent, acting as `persona`, running the notebook of `agentId`. */
  const device = (persona = member, agentId = agent, more = {}) => {
    const vta = new Vta({ credential: decodeCredential(fake.credential(persona ? [persona] : [], more)), sleep: noWait })
    const host = new RoomHost({ vta, hostDid: fake.host.did, resolver: fake.resolver, fetch: globalThis.fetch, sleep: noWait })
    return { vta, host, nb: new VtiNotebook({ vta, host, roomId: room, agent: agentId.did, secret: agentId.seed, keyFor: fake.resolver.keyFor }) }
  }
  return { fake, owner, member, room, agent, device }
}
/** The person's own wallet writes a record into the room, the way `pnm rooms put` does: a body signed as the member, sealed, put. */
async function walletPut ({ vta, host }, room, fields) {
  const head = (await host.listPage(room, { limit: 1 })).headVersion ?? 0
  const key = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url')
  const sealed = await vta.seal(room, key, head + 1, Buffer.from(JSON.stringify({ roomId: room, key, version: head + 1, author: host.member, ...fields })), { signAsPrincipal: true })
  return host.put(room, { key, sealed, expectedVersion: 0 })
}

describe('a person\'s trust agent, from the bridge', () => {
  let w
  before(async () => { w = await world() })
  after(() => w.fake.close())

  test('the credential is the kit\'s one line; a file other accounts can read is refused', () => {
    const line = w.fake.credential([w.member]), c = decodeCredential(line)
    assert.match(c.did, /^did:key:z6Mk/); assert.equal(c.vtaDid, w.fake.vta.did); assert.equal(c.vtaUrl, w.fake.vta.url); assert.equal(c.seed.length, 32)
    assert.throws(() => decodeCredential('not a credential'), /not readable/)
    assert.throws(() => decodeCredential(Buffer.from(JSON.stringify({ did: newIdentity().did, privateKeyMultibase: JSON.parse(Buffer.from(line, 'base64url')).privateKeyMultibase, vtaDid: c.vtaDid })).toString('base64url')), /does not belong/)
    assert.equal(readCredential({}), null)
    const dir = mkdtempSync(join(tmpdir(), 'wpi-vta-cred-')), file = join(dir, 'credential')
    try {
      writeFileSync(file, line, { mode: 0o644 }); chmodSync(file, 0o644)
      if (process.platform !== 'win32') assert.throws(() => readCredential({ VTA_CREDENTIAL_FILE: file }), /chmod 600/)
      chmodSync(file, 0o600)
      assert.equal(readCredential({ VTA_CREDENTIAL_FILE: file }).did, c.did)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('sign-in is a challenge answered with the credential\'s key; a token that ran out is renewed once and the task goes through', async () => {
    const { vta } = w.device()
    assert.deepEqual((await vta.list()).map((r) => [r.roomId, r.member, r.epoch]), [[w.room, w.member, 2]])
    assert.equal(vta.counts.signIns, 1)
    w.fake.expireSessions()
    assert.equal((await vta.list()).length, 1) // HTTP 401, then the refresh token for a new pair, then the same task again
    assert.deepEqual([vta.counts.signIns, vta.counts.refreshes], [1, 1])
    assert.equal(w.fake.seen.vta[T('auth/refresh', '0.2')], 1)
  })

  test('one session per credential: a second machine signing in ends the first\'s, which signs in again and carries on', async () => {
    const line = w.fake.credential([w.member])
    const a = new Vta({ credential: decodeCredential(line), sleep: noWait }), b = new Vta({ credential: decodeCredential(line), sleep: noWait })
    await a.list(); await b.list() // b's sign-in superseded a's token and its refresh token
    assert.equal((await a.list()).length, 1)
    assert.deepEqual([a.counts.signIns, a.counts.refreshes], [2, 0])
  })

  test('"slow down" is obeyed for the time the door names, then the same task is sent again; too long a wait is said, not sat through', async () => {
    const waits = []
    const vta = new Vta({ credential: decodeCredential(w.fake.credential([w.member])), sleep: async (ms) => { waits.push(ms) } })
    await vta.list()
    w.fake.slowDown('vta', 2, 1)
    assert.equal((await vta.list()).length, 1)
    assert.deepEqual(waits, [2000, 1000]); assert.equal(vta.counts.slowDowns, 2)
    w.fake.slowDown('vta', 600)
    await assert.rejects(vta.list(), (e) => e instanceof VtiError && e.code === 'unavailable' && e.retryAfterMs === 600_000 && /slow down/.test(e.message))
  })

  test('a refusal carries the shared code and never the credential', async () => {
    const stranger = new Vta({ credential: decodeCredential(w.fake.credential([w.member])), sleep: noWait })
    stranger.me = { ...stranger.me, ...newIdentity() }; stranger.did = stranger.me.did // a key the trust agent was never told about
    await assert.rejects(stranger.list(), (e) => e.code === 'auth/challenge:subjectNotRecognized' && !JSON.stringify({ ...e, m: e.message }).includes('privateKey'))
  })
})

describe('a notebook in a sealed room', () => {
  let w
  before(async () => { w = await world() })
  after(() => w.fake.close())

  test('add, then read back: each note is one sealed record, signed as the member, under a key that says nothing', async () => {
    const { nb } = w.device()
    await nb.add('Wants to meet people building wallets.'); await nb.add('Keep their travel plans private.')
    const r = await nb.get()
    assert.deepEqual(texts(r), ['Wants to meet people building wallets.', 'Keep their travel plans private.'])
    assert.deepEqual(r.notes.map((n) => n.from), ['agent', 'agent']); assert.equal(r.older, 0); assert.deepEqual(r.unreadable, {})
    assert.match(r.notes[0].at, /^\d{4}-\d\d-\d\dT/)
    for (const n of r.notes) assert.match(n.key, /^[A-Za-z0-9_-]{22}$/, 'sixteen random bytes: nothing for the host to read into it')
    // what the host holds for one of them: ciphertext, a nonce, the epoch, who wrote it. Opened with the room's key and the
    // real associated data it is OpenVTC's record body: signed by its author for the place it sits.
    const stored = w.fake.stored(w.room, r.notes[0].key)
    assert.deepEqual(Object.keys(stored.sealed).sort(), ['ciphertext', 'nonce']); assert.equal(stored.author, w.member); assert.equal(stored.epoch, 2)
    const fresh = w.device() // a second machine: it has to fetch and open everything itself
    const body = fresh.nb.opened.get(r.notes[0].key) ?? (await fresh.nb.get(), fresh.nb.opened.get(r.notes[0].key))
    assert.deepEqual(Object.keys(body.body).sort(), ['author', 'basis', 'body', 'key', 'proof', 'roomId', 'tags', 'title', 'version'])
    assert.equal(body.body.author, w.member); assert.equal(body.body.proof.proofPurpose, 'assertionMethod'); assert.equal(body.body.basis, 'inferred'); assert.ok(body.body.tags.includes(NOTE_TAG))
    assert.deepEqual([body.body.roomId, body.body.key, body.body.version], [w.room, r.notes[0].key, stored.version])
    // sent at the versions the pinned trust agent and host serve
    assert.ok(w.fake.seen.vta[T('rooms/keys/act', '0.12')] > 0 && w.fake.seen.vta[T('rooms/keys/seal', '0.3')] === 2 && w.fake.seen.vta[T('rooms/keys/open', '0.2')] > 0)
    assert.ok(w.fake.seen.host[T('rooms/records/put', '0.5')] === 2 && w.fake.seen.host[T('rooms/records/list', '0.6')] > 0 && w.fake.seen.host[T('rooms/records/get', '0.3')] > 0 && w.fake.seen.host[T('rooms/info', '0.3')] > 0)
    const s = nb.status()
    assert.equal(s.lives, 'sealed-room'); assert.equal(s.member, w.member); assert.equal(s.tier, 'attributed'); assert.equal(s.records, 2); assert.equal(s.added, 2)
    assert.equal(s.roomHost.last.ok, true); assert.ok(!JSON.stringify(s).includes('wallets'), 'the numbers hold no note')
  })

  test('a second device catches up: it reads what the first wrote, then only what is new', async () => {
    const one = w.device(), two = w.device()
    assert.equal((await two.nb.get()).notes.length, 2)
    const gets = () => w.fake.seen.host[T('rooms/records/get', '0.3')]
    const before = gets()
    await one.nb.add('Third thing, from the first device.')
    assert.deepEqual(texts(await two.nb.get()).at(-1), 'Third thing, from the first device.')
    assert.equal(gets() - before, 1, 'the listing above the last version seen named one record; only that one was fetched')
    await two.nb.get(); assert.equal(gets() - before, 1, 'nothing new: nothing fetched')
  })

  test('the room is the notebook: what the person writes with their own wallet is a note from them, unread until the agent opens its notebook', async () => {
    const agentSide = w.device(), wallet = w.device()
    await wallet.host.info(w.room)
    await walletPut(wallet, w.room, { title: 'About Thursday', body: 'Say yes to the panel, no to the dinner.' })
    const unread = await agentSide.nb.unread()
    assert.deepEqual(unread.map((n) => [n.from, n.text]), [['person', 'About Thursday\nSay yes to the panel, no to the dinner.']])
    const book = agentSide.nb.adapter({ card: async () => ({ workingOn: 'a wallet' }) })
    agentSide.nb.peeked = { at: 0, unread: 0 }
    assert.deepEqual(await book('peek'), { unread: 1 })
    const read = await book('read')
    assert.equal(read.notes.at(-1).from, 'person'); assert.deepEqual(read.card, { workingOn: 'a wallet' }); assert.deepEqual(Object.keys(read.notes[0]).sort(), ['at', 'from', 'text'])
    assert.deepEqual(await agentSide.nb.unread(), [])
    assert.deepEqual(await w.device().nb.unread(), [], 'another device of the same agent finds "read up to here" in the room itself')
    assert.equal((await w.device(w.member, newIdentity()).nb.unread()).length, 1, 'another agent of the same person keeps its own place')
    const records = agentSide.nb.records.size
    await book('read'); assert.equal(agentSide.nb.records.size, records, 'nothing new to mark: nothing written')
    await walletPut(wallet, w.room, { body: 'One more.' }); await book('read')
    assert.equal((await agentSide.nb.get()).notes.length + 1, agentSide.nb.records.size, 'the marker is one record, rewritten in place')
  })

  test('two writes at once: the one that lost its place is sealed again for where it landed, and both open', async () => {
    const a = w.device(), b = w.device()
    await a.nb.get(); await b.nb.get()
    const put = b.host.put.bind(b.host); let once = true
    b.host.put = async (...args) => { if (once) { once = false; await a.nb.add('Slipped in between the seal and the put.') } return put(...args) }
    await b.nb.add('Sealed for a version another write took.')
    assert.equal(b.nb.counts.resealed, 1)
    const all = texts(await w.device().nb.get())
    assert.ok(all.includes('Slipped in between the seal and the put.') && all.includes('Sealed for a version another write took.'))
  })

  test('the room moves to a new epoch: a write sealed under the old one is refused, the missed commit is fetched and applied, and it goes through', async () => {
    const { nb } = w.device()
    await nb.get()
    assert.equal(w.fake.advance(w.room), 3) // the owner renews; the member's trust agent is one commit behind
    assert.equal(w.fake.epochOf(w.room, w.member), 2)
    await nb.add('Written after the room moved on.')
    assert.equal(nb.counts.catchUps, 1); assert.equal(w.fake.epochOf(w.room, w.member), 3)
    assert.equal(w.fake.seen.vta[T('rooms/keys/commit', '0.1')], 1); assert.equal(w.fake.stored(w.room, [...nb.records.keys()].at(-1)).epoch, 3)
    // and the other way round: a record sealed at an epoch this trust agent has not reached opens once it has caught up
    const ownerWallet = w.device(w.owner)
    w.fake.advance(w.room); await ownerWallet.host.info(w.room)
    await walletPut(ownerWallet, w.room, { body: 'From the owner, at epoch 4.' })
    assert.equal(texts(await nb.get()).at(-1), 'From the owner, at epoch 4.')
    assert.equal(nb.counts.catchUps, 2); assert.equal(w.fake.epochOf(w.room, w.member), 4)
    assert.equal((await nb.get()).notes.at(-1).from, 'person', 'the host recorded the owner as its author, and the owner signed it')
  })

  test('a record the host moved, or one nobody signed, is not shown: it is counted, with why', async () => {
    const { nb, vta, host } = w.device()
    const r = await nb.get(), a = w.fake.stored(w.room, r.notes[0].key), b = w.fake.stored(w.room, r.notes[1].key)
    const kept = { ...a.sealed }
    a.sealed = { ...b.sealed } // the host serves another record's ciphertext under this key
    const moved = await w.device().nb.get()
    assert.equal(moved.notes.length, r.notes.length - 1); assert.deepEqual(moved.unreadable, { 'did-not-open': 1 })
    a.sealed = kept
    assert.deepEqual((await w.device().nb.get()).unreadable, {})
    // a member seals bytes that are not a signed body (rooms/keys/seal without signAsPrincipal): readers refuse it
    const head = (await host.listPage(w.room, { limit: 1 })).headVersion, key = 'unsigned-' + head
    await host.put(w.room, { key, sealed: await vta.seal(w.room, key, head + 1, Buffer.from(JSON.stringify({ roomId: w.room, key, version: head + 1, author: w.member, body: 'No proof.' }))), expectedVersion: 0 })
    assert.equal((await w.device().nb.get()).unreadable['not-signed-by-its-author'], 1)
  })

  test('a non-member is refused: by the trust agent (no credential for that room), and by the host (someone else\'s credentials)', async () => {
    const outsider = w.device(w.fake.persona())
    await assert.rejects(outsider.nb.get(), (e) => e instanceof VtiError && e.code === 'rooms/keys/act:notAMember' && e.from === 'the trust agent')
    await assert.rejects(outsider.nb.add('Should not land.'), (e) => e.code === 'rooms/keys/act:notAMember')
    // straight at the host: a real member's presentation, captured from a request, under a stranger's signature
    const captured = w.fake.received.host.map((raw) => JSON.parse(raw)).find((d) => d.type === T('rooms/records/list', '0.6'))
    const thief = newIdentity()
    const stolen = await postTask(w.fake.host.url, signedTask(thief, { type: T('rooms/records/list', '0.6'), recipient: w.fake.host.did, payload: { roomId: w.room, presentation: captured.payload.presentation } }))
    assert.equal(stolen.status, 403); assert.equal(stolen.code, 'permissionDenied')
    const replay = await postTask(w.fake.host.url, captured) // the very same document again: a read is answered once
    assert.equal(replay.status, 204)
    assert.equal((await postTask(w.fake.host.url, { ...captured, payload: { ...captured.payload, prefix: 'x' } })).code, 'idConflict')
    // a credential the person registered as an AI agent (a delegate) may not act as the member: said plainly, nothing written
    const delegate = w.device(w.member, w.agent, { delegate: true })
    await assert.rejects(delegate.nb.add('As a delegate.'), (e) => e.code === 'permissionDenied' && /delegate/.test(e.message))
    // and through the agent's tool, each of these is said in words its person can act on, with the code
    await assert.rejects(delegate.nb.adapter()('add', 'As a delegate.'), (e) => e.code === 'permissionDenied' && /register it as their own client/.test(e.message) && /\(permissionDenied\)$/.test(e.message))
    await assert.rejects(outsider.nb.adapter()('read'), /holds no place in that room.*\(rooms\/keys\/act:notAMember\)$/)
    assert.equal(outsider.nb.status().trustAgent.last.code, 'rooms/keys/act:notAMember', 'whoami shows why the last call failed')
  })

  test('an open room is refused: its host would read every note', async () => {
    const o = await world({ room: { visibility: 'open' } })
    try { await assert.rejects(o.device().nb.get(), /open: its host can read everything/) } finally { await o.fake.close() }
  })
})

describe('a member added later', () => {
  test('in a room that keeps its key chain, the trust agent fetches the older keys and everything opens', async () => {
    const w = await world()
    try {
      await w.device().nb.add('From before the newcomer.')
      const late = w.fake.persona(); assert.equal(w.fake.admit(w.room, late), 3)
      const d = w.device(late)
      assert.deepEqual(texts(await d.nb.get()), ['From before the newcomer.'])
      assert.equal(d.nb.counts.backfills, 1); assert.equal(w.fake.seen.vta[T('rooms/keys/backfill', '0.2')], 1)
    } finally { await w.fake.close() }
  })

  test('in a room that does not, what was written before it joined stays sealed: counted and said, never guessed at', async () => {
    const w = await world({ room: { retentionPolicy: 'fromJoin' } })
    try {
      const first = w.device()
      await first.nb.add('Old one.'); await first.nb.add('Old two.')
      const late = w.fake.persona(); w.fake.admit(w.room, late)
      const d = w.device(late)
      assert.deepEqual(await d.nb.get(), { notes: [], older: 0, unreadable: { 'from-before-this-membership': 2 } })
      assert.equal(w.fake.seen.host[T('rooms/records/get', '0.3')], 1, 'once the earliest readable epoch is known, older records are not fetched at all')
      await d.nb.add('New, at the epoch it joined.')
      const r = await (await d.nb.adapter()('read'))
      assert.deepEqual(r.notes.map((n) => n.text), ['New, at the epoch it joined.']); assert.deepEqual(r.unreadable, { 'from-before-this-membership': 2 })
      await first.nb.get() // the earlier member catches up and reads both sides
      assert.equal((await first.nb.get()).notes.length, 3)
    } finally { await w.fake.close() }
  })
})

describe('an older trust agent and host (the versions the openvti starter kit targets)', () => {
  test('refused at the newer versions, the same notebook is written and read at act 0.8, seal 0.2, put 0.3, list 0.5, get 0.2', async () => {
    const w = await world({ vtaServes: { 'rooms/keys/act': ['0.8'], 'rooms/keys/seal': ['0.2'] }, hostServes: { 'rooms/records/put': ['0.3'], 'rooms/records/list': ['0.5'], 'rooms/records/get': ['0.2'] } })
    try {
      const { nb, vta } = w.device()
      await nb.add('Works on the older pin too.')
      assert.deepEqual(texts(await w.device().nb.get()), ['Works on the older pin too.'])
      assert.equal(vta.olderTable, true)
      assert.ok(w.fake.seen.host[T('rooms/records/put', '0.3')] === 1 && w.fake.seen.host[T('rooms/records/list', '0.5')] > 0 && w.fake.seen.host[T('rooms/records/get', '0.2')] === 1)
      assert.equal(w.fake.seen.host[T('rooms/records/put', '0.5')], undefined, 'the trust agent would not complete the newer request, so the host never saw one')
    } finally { await w.fake.close() }
  })

  test('a host that signs its answers is checked; a lost write is recognised by its words', async () => {
    const w = await world()
    try {
      w.fake.host.signs = true
      const { nb, host, vta } = w.device()
      await nb.add('Signed for.'); assert.ok(host.counts.signedAnswers > 0)
      const key = [...nb.records.keys()][0], sealed = await vta.seal(w.room, key, 99, Buffer.from('x'))
      await assert.rejects(host.put(w.room, { key, sealed, expectedVersion: 0 }), (e) => isVersionConflict(e) && e.code === 'taskFailed')
      await assert.rejects(host.put(w.room, { key, sealed, expectedVersion: 7 }), isVersionConflict)
    } finally { await w.fake.close() }
  })
})

describe('the bridge with the three settings', () => {
  let w, ctx, base, dir, cred
  const person = newIdentity(), agent = newIdentity(), hits = []
  const MARK = 'MARK-' + Buffer.from(crypto.getRandomValues(new Uint8Array(9))).toString('hex')
  const post = async (path, id, type, payload, extra) => { const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signedDocument(id, { type, payload, ...extra })) }); return { status: r.status, body: await r.json() } }
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/token|github|secret|credential|notebook|^vta_/i.test(k)))
  const settings = () => ({ ...clean, WPI_URL: base, WPI_AGENT_KEY: agent.seedHex, VTA_CREDENTIAL: cred, NOTEBOOK_ROOM: w.room, NOTEBOOK_HOST_DID: w.fake.host.did, NOTEBOOK_HOST_URL: w.fake.host.url })
  const bridge = async (env, fn) => {
    const client = new Client({ name: 'vti-notebook-test', version: '0' })
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(ROOT, 'agent', 'bridge.js')], cwd: ROOT, env, stderr: 'ignore' }))
    const call = async (name, args = {}) => { const res = await client.callTool({ name, arguments: args }); assert.ok(!res.isError, res.content[0].text); return JSON.parse(res.content[0].text) }
    try { return await fn(call) } finally { await client.close() }
  }
  const onServer = async () => { ctx.notebooks.cache.clear(); return ctx.notebooks.get(agent.did) }

  before(async () => {
    w = await world(); cred = w.fake.credential([w.member])
    dir = mkdtempSync(join(tmpdir(), 'wpi-vti-notebook-'))
    const board = { generated: new Date().toISOString().slice(0, 10), projects: [], credentialProfiles: { profiles: {} }, runs: [] }
    ctx = await createApp({ ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, githubToken: '', weaverIntervalMinutes: 0, weaverQuietMinutes: 0, ratePerMinute: 1000, publicUrl: 'https://interop.example', boardDataUrl: 'data:application/json,' + encodeURIComponent(JSON.stringify(board)), llm: { ...baseConfig.llm, apiKey: '', anthropicKey: '', provider: 'openai' } })
    ctx.server.prependListener('request', (req) => hits.push(`${req.method} ${req.url}`)) // every request the room's server is sent
    await new Promise((r) => ctx.server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${ctx.server.address().port}`
    assert.equal((await post('/api/entries', person, TYPES.join, { name: 'Person N' })).status, 201)
    assert.equal((await post('/api/entries', person, TYPES.delegate, { delegate: agent.did, scope: AGENT_SCOPES, label: 'Notebook agent' }, { expiresAt: new Date(Date.now() + 86400000).toISOString() })).status, 201)
  })
  after(async () => { await ctx.stop(); await w.fake.close(); rmSync(dir, { recursive: true, force: true }) })

  test('some of the three settings is refused out loud, never a quiet fall back to the room\'s server', () => {
    assert.equal(notebookFromEnv({}, { agent }), null)
    assert.throws(() => notebookFromEnv({ VTA_CREDENTIAL: cred, NOTEBOOK_ROOM: w.room }, { agent }), /NOTEBOOK_HOST_DID is not set/)
    assert.throws(() => notebookFromEnv({ NOTEBOOK_HOST_DID: w.fake.host.did }, { agent }), /VTA_CREDENTIAL and NOTEBOOK_ROOM are not set/)
    assert.equal(notebookFromEnv({ VTA_CREDENTIAL: cred, NOTEBOOK_ROOM: w.room, NOTEBOOK_HOST_DID: w.fake.host.did }, { agent }).status().lives, 'sealed-room')
  })

  test('without them the bridge works as today: the notebook is on the room\'s server, and whoami says so', async () => {
    await bridge({ ...clean, WPI_URL: base, WPI_AGENT_KEY: agent.seedHex }, async (call) => {
      assert.equal((await call('remember', { text: 'Kept the old way.' })).remembered, true)
      assert.equal((await call('whoami')).notebook.lives, 'room-server')
    })
    assert.equal((await post('/api/notebook', person, TYPES.notebook, { agent: agent.did, op: 'add', text: 'From the person, on the room page.' })).status, 200)
    assert.deepEqual((await onServer()).map((n) => [n.from, n.text]), [['agent', 'Kept the old way.'], ['person', 'From the person, on the room page.']])
  })

  test('the move: the notes the room\'s server holds are copied into the sealed room and read back; the server\'s copy is left as it was', async () => {
    const run = promisify(execFile), args = [join(ROOT, 'agent', 'bridge.js'), 'move-notebook']
    const first = await run(process.execPath, args, { cwd: ROOT, env: settings() })
    assert.deepEqual(JSON.parse(first.stdout), { notes: 2, moved: 2, alreadyThere: 0, verified: true })
    assert.match(first.stderr, /still holds its copy/); assert.ok(!first.stderr.includes('Kept the old way') && !first.stderr.includes(cred), 'counts and plain words only')
    assert.equal((await onServer()).length, 2, 'the old copy stays until the person removes it themselves')
    assert.deepEqual(JSON.parse((await run(process.execPath, args, { cwd: ROOT, env: settings() })).stdout), { notes: 2, moved: 0, alreadyThere: 2, verified: true })
    await assert.rejects(run(process.execPath, args, { cwd: ROOT, env: { ...clean, WPI_URL: base, WPI_AGENT_KEY: agent.seedHex } }), (e) => e.code === 1 && /Set VTA_CREDENTIAL/.test(e.stderr))
  })

  test('with them, the notebook never touches the room\'s server: a marker written to it is nowhere the server or the host could read', async () => {
    hits.length = 0
    const serverRows = JSON.stringify((await ctx.db.query('select * from agent_notes')).rows)
    await bridge(settings(), async (call) => {
      const me = await call('whoami')
      assert.equal(me.notebook.lives, 'sealed-room'); assert.equal(me.notebook.room, w.room); assert.equal(me.notebook.host, w.fake.host.did); assert.match(me.notebook.inWords, /never sees it/)
      assert.equal((await call('remember', { text: `Their door code is ${MARK}.` })).remembered, true)
      assert.match((await call('tell_my_person', { text: `I wrote ${MARK} down.` })).note, /sealed room they hold/)
      const book = await call('my_notebook')
      assert.deepEqual(book.notes.map((n) => [n.from, n.text]), [['agent', 'Kept the old way.'], ['person', 'From the person, on the room page.'], ['agent', `Their door code is ${MARK}.`], ['agent', `I wrote ${MARK} down.`]])
      await call('inbox')
      assert.equal((await call('whoami')).notebook.added, 2)
    })
    assert.ok(hits.length > 0, 'the bridge did talk to the room (who it is, its inbox)')
    assert.deepEqual(hits.filter((h) => h.includes('/api/notebook')), [], 'and never asked it for the notebook')
    assert.equal(JSON.stringify((await ctx.db.query('select * from agent_notes')).rows), serverRows, 'what the room\'s server keeps did not change')
    assert.ok(!JSON.stringify(await onServer()).includes(MARK) && !JSON.stringify(ctx.log.entries).includes(MARK), 'not in the server\'s notebook, not in the log')
    const dump = w.fake.hostDump()
    for (const clear of [MARK, 'door code', 'Kept the old way', 'From the person', NOTE_TAG, agent.did]) assert.ok(!dump.includes(clear), `the host holds and was sent ciphertext only (${clear})`)
    assert.ok(!hits.join('\n').includes(cred) && !dump.includes(cred), 'the trust agent credential went to neither')
    // the test can see a leak: the same marker IS in what the person's own trust agent was asked to seal, and in what the host's ciphertext opens to
    assert.ok(w.fake.received.vta.some((raw) => { const p = JSON.parse(raw).payload?.plaintext; return p && Buffer.from(p, 'base64url').toString('utf8').includes(MARK) }))
    const { nb } = w.device(w.member, agent), last = (await nb.get()).notes.at(-2), stored = w.fake.stored(w.room, last.key)
    assert.ok(last.text.includes(MARK), 'another device of the person reads it back through their trust agent')
    assert.ok(stored.sealed.ciphertext.length > MARK.length && !JSON.stringify(stored).includes(MARK), 'while the host\'s own copy of that record is ciphertext')
  })
})
