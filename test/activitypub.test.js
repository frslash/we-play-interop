// The room on the fediverse: a read-only Group account that Mastodon can follow. Offline: the
// "Mastodon" here is a local server holding its own RSA key, signing and checking the way Mastodon does.
import assert from 'node:assert/strict'
import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { TYPES, signedDocument } from '../src/shared/types.js'
import { config as baseConfig } from '../src/server/config.js'
import { createApp } from '../src/server/index.js'
import { parseSignature } from '../src/server/activitypub.js'

const AP = 'application/activity+json'
const digest = (body) => 'SHA-256=' + createHash('sha256').update(body).digest('base64')

/** A pretend Mastodon account on its own server: an actor with an RSA key, an inbox that keeps what it gets. */
async function fakeRemote () {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const got = [], fetched = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks)
      if (req.method === 'GET' && req.url === '/users/fan') { fetched.push({ signed: Boolean(req.headers.signature) }); res.writeHead(200, { 'content-type': AP }); return res.end(JSON.stringify(remote.actorDoc)) }
      if (req.method === 'POST' && req.url === '/users/fan/inbox') { got.push({ headers: req.headers, raw, body: JSON.parse(raw.toString('utf8')), url: req.url }); res.writeHead(202); return res.end() }
      res.writeHead(404); res.end()
    })
  })
  await new Promise((r) => server.listen(0, r))
  const base = `http://localhost:${server.address().port}`, actor = `${base}/users/fan`
  const remote = {
    server, got, fetched, actor, privateKey,
    actorDoc: { '@context': ['https://www.w3.org/ns/activitystreams', 'https://w3id.org/security/v1'], id: actor, type: 'Person', preferredUsername: 'fan', inbox: `${actor}/inbox`, publicKey: { id: `${actor}#main-key`, owner: actor, publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) } },
    /** POST an activity to an inbox, signed as Mastodon signs: (request-target) host date digest. */
    async post (inbox, activity, { key = privateKey, tamper = false, unsigned = false } = {}) {
      const u = new URL(inbox), body = JSON.stringify(activity), date = new Date().toUTCString(), dg = digest(body)
      const str = `(request-target): post ${u.pathname}\nhost: ${u.host}\ndate: ${date}\ndigest: ${dg}`
      const signature = `keyId="${actor}#main-key",algorithm="rsa-sha256",headers="(request-target) host date digest",signature="${sign('sha256', Buffer.from(str), key).toString('base64')}"`
      const sent = tamper ? body.replace('Follow', 'Follow ') : body
      const r = await fetch(inbox, { method: 'POST', headers: { 'content-type': AP, date, digest: dg, ...(unsigned ? {} : { signature }) }, body: sent })
      return r.status
    },
  }
  return remote
}

/** What a receiving server checks: the signature over the signed headers, with the room's published key, and the digest. */
function checkSignature (req, pem) {
  const sig = parseSignature(req.headers.signature)
  const str = sig.headers.split(' ').map((h) => (h === '(request-target)' ? `${h}: post ${req.url}` : `${h}: ${req.headers[h]}`)).join('\n')
  return verify('sha256', Buffer.from(str), createPublicKey(pem), Buffer.from(sig.signature, 'base64')) && req.headers.digest === digest(req.raw)
}
const until = async (what, ms = 5000) => { const t0 = Date.now(); while (!what()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 20)) } }

describe('the room on the fediverse (ActivityPub, read only)', () => {
  let ctx, base, dir, remote, config
  const personA = newIdentity(), personB = newIdentity()
  const post = async (doc) => (await fetch(`${base}/api/entries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(doc) })).status
  const say = (id, payload, extra) => post(signedDocument(id, { type: TYPES.note, payload: { kind: 'message', ...payload }, ...extra }))
  const getAp = async (p, accept = AP) => { const r = await fetch(p.startsWith('http') ? p : base + p, { headers: { accept } }); return { status: r.status, type: r.headers.get('content-type'), body: await r.json() } }
  const outboxTexts = async () => (await getAp('/ap/room/outbox?page=1')).body.orderedItems.map((a) => a.object.content).join('\n')

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wpi-ap-'))
    config = { ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, githubToken: '', ratePerMinute: 1000, boardDataUrl: 'data:application/json,' + encodeURIComponent(JSON.stringify({ projects: [] })), llm: { ...baseConfig.llm, apiKey: '' } }
    ctx = await createApp(config, { apFetch: fetch, hostWelcomeMs: null }) // apFetch: the plain fetch, so the room can reach the local pretend server
    await new Promise((r) => ctx.server.listen(0, r))
    base = `http://localhost:${ctx.server.address().port}`
    config.publicUrl = base // the room's public address, as PUBLIC_URL gives it
    remote = await fakeRemote()
    assert.equal(await post(signedDocument(personA, { type: TYPES.join, payload: { name: 'Person A' } })), 201)
    await post(signedDocument(personB, { type: TYPES.join, payload: { name: 'Person B' } }))
  })
  after(async () => { await ctx.stop(); remote.server.close(); rmSync(dir, { recursive: true, force: true }) })

  test('WebFinger finds the room as @room@<its host>', async () => {
    const host = new URL(base).host
    const r = await fetch(`${base}/.well-known/webfinger?resource=${encodeURIComponent(`acct:room@${host}`)}`)
    assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /application\/jrd\+json/)
    const j = await r.json()
    assert.equal(j.subject, `acct:room@${host}`)
    assert.deepEqual(j.links.find((l) => l.rel === 'self'), { rel: 'self', type: AP, href: `${base}/ap/room` })
    assert.equal((await fetch(`${base}/.well-known/webfinger?resource=acct:someone@${host}`)).status, 404)
    // no public address: no account; a temporary tunnel's address: the room says not to share it yet
    config.publicUrl = ''
    assert.equal((await fetch(`${base}/.well-known/webfinger?resource=${encodeURIComponent(`acct:room@${host}`)}`)).status, 404)
    config.publicUrl = 'https://some-words.trycloudflare.com'
    assert.match(ctx.activitypub.summary().temporary, /fixed address/)
    config.publicUrl = base
    assert.equal(ctx.activitypub.summary().temporary, undefined)
  })

  test('the actor is a Group with an inbox, an outbox, followers and an RSA key kept in the data folder', async () => {
    const { status, type, body: a } = await getAp('/ap/room')
    assert.equal(status, 200); assert.equal(type, AP)
    assert.equal(a.type, 'Group'); assert.equal(a.id, `${base}/ap/room`); assert.equal(a.preferredUsername, 'room')
    assert.equal(a.inbox, `${a.id}/inbox`); assert.equal(a.outbox, `${a.id}/outbox`); assert.equal(a.followers, `${a.id}/followers`)
    assert.equal(a.publicKey.owner, a.id); assert.match(a.publicKey.publicKeyPem, /^-----BEGIN PUBLIC KEY-----/)
    assert.equal(createPublicKey(a.publicKey.publicKeyPem).asymmetricKeyType, 'rsa')
    const ld = await getAp('/ap/room', 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"')
    assert.equal(ld.body.id, a.id); assert.match(ld.type, /^application\/ld\+json/)
    const keyFile = join(dir, 'activitypub-key.pem')
    assert.ok(existsSync(keyFile)); assert.equal(statSync(keyFile).mode & 0o077, 0, 'only the host can read the key')
  })

  test('the outbox lists public lines, never a line to one person or the room check\'s', async () => {
    assert.equal(await say(personA, { text: 'Hello from the room, fediverse.' }), 201)
    assert.equal(await say(personA, { text: 'Just between us two.' }, { recipient: personB.did }), 201)
    const check = ctx.check.me // the room check's test person
    await post(signedDocument(check, { type: TYPES.join, payload: { name: 'Room check' } }))
    assert.equal(await say(check, { text: 'A test line from the check.' }), 201)
    assert.equal(await say(personA, { text: 'Plain: we tried it. Technical: the long, technical layer.' }), 201)
    const outbox = (await getAp('/ap/room/outbox')).body
    assert.equal(outbox.type, 'OrderedCollection'); assert.equal(outbox.totalItems, ctx.activitypub.lines().length)
    const page = (await getAp(outbox.first)).body
    assert.equal(page.type, 'OrderedCollectionPage')
    const create = page.orderedItems.find((a) => a.object.content.includes('Hello from the room'))
    assert.equal(create.type, 'Create'); assert.equal(create.object.type, 'Note'); assert.equal(create.object.attributedTo, `${base}/ap/room`)
    assert.ok(create.object.to.includes('https://www.w3.org/ns/activitystreams#Public'))
    assert.match(create.object.content, /<strong>Person A<\/strong>/); assert.equal(create.object.url, `${base}/#tab=talk`)
    const texts = await outboxTexts()
    assert.ok(!texts.includes('Just between us two'), 'a line to one person stays out')
    assert.ok(!texts.includes('A test line from the check'), 'the room check stays out')
    assert.ok(texts.includes('<strong>Person A</strong>: we tried it.') && !texts.includes('technical layer') && !texts.includes('Plain:'), 'the plain layer only')
    const note = await getAp(create.object.id) // each Note can be fetched at its id
    assert.equal(note.status, 200); assert.equal(note.body.content, create.object.content)
  })

  test('an unsigned or badly signed Follow is refused', async () => {
    const inbox = `${base}/ap/room/inbox`, follow = { '@context': 'https://www.w3.org/ns/activitystreams', id: `${remote.actor}#follows/0`, type: 'Follow', actor: remote.actor, object: `${base}/ap/room` }
    assert.equal(await remote.post(inbox, follow, { unsigned: true }), 401)
    assert.equal(await remote.post(inbox, follow, { key: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey }), 401) // signed by a key that isn't theirs
    assert.equal(await remote.post(inbox, follow, { tamper: true }), 401) // the body changed after signing: the digest no longer matches
    assert.equal(ctx.activitypub.followers.size, 0)
    assert.equal((await getAp('/ap/room/followers')).body.totalItems, 0)
  })

  test('a signed Follow is accepted with a signed Accept, and new public lines reach the follower, signed', async () => {
    const roomKey = (await getAp('/ap/room')).body.publicKey.publicKeyPem
    const follow = { '@context': 'https://www.w3.org/ns/activitystreams', id: `${remote.actor}#follows/1`, type: 'Follow', actor: remote.actor, object: `${base}/ap/room` }
    assert.equal(await remote.post(`${base}/ap/room/inbox`, follow), 202)
    await until(() => remote.got.some((g) => g.body.type === 'Accept'))
    const accept = remote.got.find((g) => g.body.type === 'Accept')
    assert.equal(accept.body.actor, `${base}/ap/room`); assert.equal(accept.body.object.id, follow.id)
    assert.ok(checkSignature(accept, roomKey), 'the Accept is signed with the room\'s published key')
    assert.ok(remote.fetched.every((f) => f.signed), 'the room signs its own key lookups too')
    assert.equal((await getAp('/ap/room/followers')).body.totalItems, 1)

    assert.equal(await say(personA, { text: 'A direct word to Person B.' }, { recipient: personB.did }), 201)
    assert.equal(await say(personB, { text: 'News for everyone following along.' }), 201)
    await until(() => remote.got.some((g) => g.body.type === 'Create'))
    const creates = remote.got.filter((g) => g.body.type === 'Create')
    assert.equal(creates.length, 1, 'only the public line was sent')
    assert.match(creates[0].body.object.content, /News for everyone following along/)
    assert.ok(checkSignature(creates[0], roomKey), 'the Create is signed with the room\'s published key')

    const record = readFileSync(join(dir, 'activitypub-record.jsonl'), 'utf8')
    const sent = record.trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.dir === 'out')
    assert.ok(sent.some((r) => r.what === 'Create' && r.ok && r.status === 202 && Number.isInteger(r.ms)), 'each delivery is recorded with its status and timing')
    assert.ok(!record.includes('News for everyone'), 'the record never holds anyone\'s words')
    assert.equal((await (await fetch(`${base}/api/info`)).json()).fediverse.followers, 1)
  })

  test('an Undo of the Follow ends it: nothing more is sent', async () => {
    const undo = { '@context': 'https://www.w3.org/ns/activitystreams', id: `${remote.actor}#follows/1/undo`, type: 'Undo', actor: remote.actor, object: { id: `${remote.actor}#follows/1`, type: 'Follow', actor: remote.actor, object: `${base}/ap/room` } }
    assert.equal(await remote.post(`${base}/ap/room/inbox`, undo), 202)
    assert.equal(ctx.activitypub.followers.size, 0)
    const before = remote.got.length
    assert.equal(await say(personA, { text: 'After the unfollow.' }), 201)
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(remote.got.length, before); assert.equal(ctx.activitypub.queue.length, 0)
  })
})
