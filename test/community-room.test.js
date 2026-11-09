// A member's bridge entering a community's encrypted room through the person's own trust agent (agent/community-room.js),
// against the stand-ins in test/helpers/fake-vti.js (the trust agent and the room host) and test/helpers/fake-vtc-rooms.js
// (the community's offers and acceptance). They follow the wire of each task's bundle; they prove the bridge's side is
// self-consistent, not interop (test/live/community-room-live.test.js is the check against a real community).
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { instant, typeUri } from '../src/shared/trusttask.js'
import { Vta, VtiError, decodeCredential } from '../agent/vta.js'
import { CommunityRoom, asCredential, communityWords } from '../agent/community-room.js'
import { VtiNotebook } from '../agent/vti-notebook.js'
import { startFakeVti } from './helpers/fake-vti.js'
import { startFakeCommunity } from './helpers/fake-vtc-rooms.js'

const noWait = async () => {}
const closers = [], dirs = []
after(async () => { await Promise.all(closers.map((c) => c())); for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
const ACCEPT = typeUri('vtc/rooms/offers/accept', '0.1')
const LIST = typeUri('vtc/rooms/offers/list', '0.4')
const KEYPACKAGE = typeUri('rooms/keys/key-package', '0.2'), WELCOME = typeUri('rooms/keys/welcome', '0.1'), RECEIVE = typeUri('vault/credentials/receive', '0.1')

/** A community with one attributed room, offered to a member whose trust agent the bridge talks to. */
async function world ({ community: copts, credential, visibility = 'attributed', offer = {}, sleeps } = {}) {
  const fake = await startFakeVti(); closers.push(() => fake.close())
  const community = await startFakeCommunity(fake, copts); closers.push(() => community.close())
  const persona = fake.persona()
  const room = fake.room(newIdentity().did, { visibility })
  const o = community.offer(room, persona, { visibility, ...offer })
  const vta = new Vta({ credential: decodeCredential(fake.credential([persona], credential)), sleep: noWait })
  const dir = mkdtempSync(join(tmpdir(), 'community-room-')); dirs.push(dir)
  const statePath = join(dir, 'community-room.json')
  const cr = new CommunityRoom({ vta, communityDid: community.did, member: persona, resolver: community.resolver, fetch: globalThis.fetch, statePath, sleep: sleeps ? async (ms) => { sleeps.push(ms) } : noWait })
  return { fake, community, persona, room, offer: o, vta, cr, statePath }
}
/** What each service was sent, in order; a rooms/keys/act is named by the request inside it. */
const sent = (fake, which = 'vta') => fake.received[which].map((r) => { const d = JSON.parse(r); return d.payload?.document?.type ?? d.type })
const rejects = (p, code) => assert.rejects(p, (e) => (e instanceof VtiError || e instanceof Error) && e.code === code, `expected ${code}`)

describe('the offers', () => {
  test('lists the one room offered, without its credential strings, and counts what it read', async () => {
    const { cr, room, offer } = await world({ offer: { label: 'Gardening' } })
    const list = await cr.offers()
    assert.equal(list.length, 1)
    assert.equal(list[0].roomId, room); assert.equal(list[0].label, 'Gardening'); assert.equal(list[0].visibility, 'attributed'); assert.equal(list[0].state, 'open')
    assert.equal(list[0].credentials, undefined)
    assert.ok(!JSON.stringify(list).includes(offer.credentials.invitation.slice(20, 60)))
    assert.equal(cr.counts.offersRead, 1); assert.equal(cr.last.ok, true)
  })
  test('follows the cursor through every page and stops at its end', async () => {
    const { fake, community, persona, cr } = await world({ community: { pageSize: 1 } })
    for (let i = 0; i < 2; i++) community.offer(fake.room(newIdentity().did), persona)
    assert.equal((await cr.offers()).length, 3)
    assert.equal(community.seen[LIST], 3, 'one request a page')
  })
  test('renewals of admissions already held are reported, not acted on', async () => {
    const { community, persona, room, cr, fake } = await world()
    community.renewal(room, persona)
    assert.equal((await cr.offers()).length, 1)
    assert.equal(cr.renewals.length, 1); assert.equal(cr.renewals[0].credentials, undefined); assert.equal(cr.counts.renewalsSeen, 1)
    assert.equal(fake.seen.vta[KEYPACKAGE], undefined); assert.equal(community.seen[ACCEPT], undefined)
  })
  test('an offer that names another host, or lacks a member of the shape, is ignored and counted', async () => {
    const { community, cr } = await world()
    community.offers[0].host = 'did:key:z6MkOtherHost'
    assert.equal((await cr.offers()).length, 0); assert.equal(cr.counts.ignored, 1)
  })
  test('a DID the community does not list as a member is told so, in words', async () => {
    const { fake, community, cr } = await world()
    const stranger = fake.persona()
    const other = new CommunityRoom({ vta: new Vta({ credential: decodeCredential(fake.credential([stranger])), sleep: noWait }), communityDid: community.did, member: stranger, resolver: community.resolver, fetch: globalThis.fetch, statePath: join(dirs[0], 'x.json') })
    await assert.rejects(other.offers(), (e) => e.code === 'vtc/rooms/offers/list:notAMember' && /does not list this person as a member/.test(e.message))
    assert.deepEqual(other.counts.refusedBy, { 'vtc/rooms/offers/list:notAMember': 1 }); assert.equal(other.last.ok, false)
    assert.equal((await cr.offers()).length, 1)
  })
})

describe('accepting an attributed room', () => {
  test('stores the three credentials, then key-package, accept, welcome in that order, and ends at the room\'s epoch', async () => {
    const { fake, community, persona, room, vta, cr, offer, statePath } = await world()
    const st = await cr.accept(room)
    const order = sent(fake).filter((t) => [RECEIVE, KEYPACKAGE, WELCOME, ACCEPT].includes(t))
    assert.deepEqual(order, [RECEIVE, RECEIVE, RECEIVE, KEYPACKAGE, ACCEPT, WELCOME], 'the vault, then the KeyPackage, the acceptance (completed as the member), and the Welcome')
    assert.equal(community.seen[ACCEPT], 1)
    assert.equal(community.accepts[0].withKeyPackage, true)
    const epoch = fake.epochOf(room, persona)
    assert.equal(epoch, 2, 'the community added the member: epoch 2')
    assert.deepEqual({ ...st, joinedAt: typeof st.joinedAt }, { roomId: room, visibility: 'attributed', roomEpoch: epoch, mlsEpoch: epoch - 1, joinedAt: 'string' })
    assert.equal((await vta.queryCredentials({ status: 'valid' })).length, 3, 'three credentials in the person\'s own vault')
    assert.equal(cr.counts.accepted, 1); assert.equal(cr.counts.welcomes, 1); assert.equal(vta.counts.credentialsStored, 3)
    // the file keeps stages and epochs: no credential, no KeyPackage, no Welcome; and only its owner may read it
    const file = readFileSync(statePath, 'utf8')
    assert.equal(statSync(statePath).mode & 0o777, 0o600)
    for (const s of [offer.credentials.invitation, offer.credentials.membership, 'credentialSubject', offer.kept?.welcome].filter(Boolean)) assert.ok(!file.includes(s))
    assert.equal(JSON.parse(file).rooms[room].stage, 'joined')
  })
  test('the Welcome and ratchet tree reach the trust agent unchanged', async () => {
    const { fake, room, cr } = await world({ community: { withRatchetTree: true } })
    await cr.accept(room)
    const accepted = JSON.parse(fake.received.vta.find((r) => JSON.parse(r).payload?.document?.type === ACCEPT))
    assert.equal(typeof accepted.payload.document.payload.keyPackage, 'string')
    const w = JSON.parse(fake.received.vta.find((r) => JSON.parse(r).type === WELCOME)).payload
    assert.equal(w.ratchetTree, 'cmF0Y2hldC10cmVl')
    assert.equal(JSON.parse(Buffer.from(w.welcome, 'base64url').toString()).keyPackage, accepted.payload.document.payload.keyPackage, 'the Welcome is for the KeyPackage the trust agent minted')
    assert.equal(typeof JSON.parse(w.invitation).credentialSubject.id, 'string', 'the invitation goes back exactly as the community sent it')
  })
  test('a second accept resumes: it ends in the same state and asks the community for nothing more', async () => {
    const { fake, community, room, cr } = await world()
    const first = await cr.accept(room)
    const asked = { kp: fake.seen.vta[KEYPACKAGE], accepts: community.seen[ACCEPT], welcomes: fake.seen.vta[WELCOME] }
    const second = await cr.accept(room)
    assert.deepEqual(second, first)
    assert.deepEqual({ kp: fake.seen.vta[KEYPACKAGE], accepts: community.seen[ACCEPT], welcomes: fake.seen.vta[WELCOME] }, asked)
  })
  test('an acceptance begun and not finished is finished: the same KeyPackage, the Welcome the community kept', async () => {
    const { fake, community, persona, room, vta, cr, offer } = await world()
    const kp = await vta.keyPackage(room, offer.credentials.invitation) // another surface began it: minted, accepted, never welcomed
    await cr.request('vtc/rooms/offers/accept', '0.1', { roomId: room, keyPackage: kp.keyPackage })
    assert.equal(fake.epochOf(room, persona), undefined)
    const st = await cr.accept(room)
    assert.equal(st.mlsEpoch, 1); assert.equal(st.roomEpoch, 2)
    assert.equal(community.accepts.length, 2); assert.equal(fake.epochOf(room, persona), 2)
    assert.equal(community.offers[0].kept.epoch, 2, 'one admission, answered twice')
  })
  test('alreadyAccepted: asks for a KeyPackage again; the same one is accepted again, a refusal after that is said in words', async () => {
    const { community, room, vta, cr, offer } = await world()
    const kp = await vta.keyPackage(room, offer.credentials.invitation)
    await cr.request('vtc/rooms/offers/accept', '0.1', { roomId: room, keyPackage: kp.keyPackage })
    community.offers[0].kept.digest = 'another KeyPackage was admitted' // the community kept the Welcome for another KeyPackage
    await assert.rejects(cr.accept(room), (e) => e.code === 'vtc/rooms/offers/accept:alreadyAccepted' && /remove(s)? and admit(s)? them again/.test(e.message))
    assert.equal(community.accepts.length, 3, 'the one before, then the acceptance and its single repeat')
  })
  test('admissionPending is retried with the identical request, a few seconds apart, until the community answers', async () => {
    const sleeps = []
    const { community, room, cr, fake, persona } = await world({ community: { pending: 2 }, sleeps })
    await cr.accept(room)
    assert.deepEqual(sleeps.filter((ms) => ms === 3000), [3000, 3000]); assert.equal(community.accepts.length, 3)
    assert.equal(fake.epochOf(room, persona), 2)
  })
  test('admissionPending that does not end is said after a few tries', async () => {
    const { room, cr } = await world({ community: { pending: 99 } })
    await assert.rejects(cr.accept(room), (e) => /admissionPending/.test(e.code) && /had not finished admitting/.test(e.message))
  })
  test('with no KeyPackage the community refuses an attributed room: keyPackageRequired', async () => {
    const { room, cr } = await world()
    await rejects(cr.request('vtc/rooms/offers/accept', '0.1', { roomId: room }), 'vtc/rooms/offers/accept:keyPackageRequired')
    assert.match(communityWords(new VtiError('vtc/rooms/offers/accept:keyPackageRequired', 'x')), /wanted a KeyPackage/)
  })
  test('a KeyPackage the trust agent did not mint is refused by the trust agent before the community hears of it', async () => {
    const { community, room, cr } = await world()
    await assert.rejects(cr.request('vtc/rooms/offers/accept', '0.1', { roomId: room, keyPackage: Buffer.alloc(48, 7).toString('base64url') }), (e) => e.code === 'rooms/keys/act:keyPackageNotHeld')
    assert.equal(community.seen[ACCEPT], undefined)
  })
  test('an expired offer is refused before anything is stored or sent', async () => {
    const { fake, community, room, cr } = await world({ offer: { validUntil: instant(Date.now() - 60_000) } })
    await assert.rejects(cr.accept(room), (e) => e.code === 'vtc/rooms/offers/accept:offerExpired' && /run out/.test(e.message))
    assert.equal(fake.seen.vta[RECEIVE], undefined); assert.equal(fake.seen.vta[KEYPACKAGE], undefined); assert.equal(community.seen[ACCEPT], undefined)
    assert.deepEqual(cr.counts.refusedBy, { 'vtc/rooms/offers/accept:offerExpired': 1 })
  })
  test('a room nobody offered this member is not found', async () => {
    const { fake, cr } = await world()
    await rejects(cr.accept(fake.room(newIdentity().did)), 'vtc/rooms/offers/accept:notFound')
  })
  test('a credential the trust agent has down as a delegate is refused by it, and the bridge says so in words', async () => {
    const { fake, community, room, cr } = await world({ credential: { delegate: true } })
    await assert.rejects(cr.accept(room), (e) => e.code === 'permissionDenied' && /AI agent \(a delegate\)/.test(e.message) && /^Entering the community's room did not work/.test(e.message))
    assert.deepEqual(cr.counts.refusedBy, { permissionDenied: 1 })
    assert.equal(fake.seen.vta[RECEIVE], undefined); assert.equal(community.seen[ACCEPT], undefined)
  })
  test('after the join, the room is the same room the notebook reads and writes, through the community\'s door', async () => {
    const { fake, community, room, vta, cr, persona } = await world()
    await cr.accept(room)
    const agent = newIdentity()
    const nb = new VtiNotebook({ vta, host: cr.host, roomId: room, agent: agent.did, secret: agent.seed, keyFor: fake.resolver.keyFor })
    await nb.add('first note from the member')
    const read = await nb.get()
    assert.equal(read.notes.length, 1); assert.match(read.notes[0].text, /first note/)
    assert.ok(community.seen[typeUri('rooms/records/put', '0.5')] >= 1, 'through the community, not around it')
    assert.ok(!fake.hostDump().includes('first note'), 'the host holds ciphertext only')
    assert.equal(fake.epochOf(room, persona), 2)
  })
  test('commits after the join are fetched from the host and applied by the trust agent', async () => {
    const { fake, room, persona, cr } = await world()
    await cr.accept(room)
    fake.advance(room); fake.advance(room)
    const r = await cr.catchUp(room)
    assert.equal(r.applied, 2); assert.equal(r.epoch, 4); assert.equal(fake.epochOf(room, persona), 4)
    assert.equal(cr.counts.commitsApplied, 2)
    assert.equal((await cr.state(room)).mlsEpoch, 3)
    assert.deepEqual((await cr.catchUp(room)).applied, 0)
  })
  test('catching up before accepting says what is missing', async () => {
    const { room, cr } = await world()
    await rejects(cr.catchUp(room), 'rooms/keys/commit:notAMember')
  })
})

describe('an open room', () => {
  test('is accepted with no KeyPackage, asks the trust agent for no key step, and is kept as joined', async () => {
    const { fake, community, room, cr, statePath } = await world({ visibility: 'open' })
    const st = await cr.accept(room)
    assert.equal(community.accepts[0].withKeyPackage, false)
    assert.equal(fake.seen.vta[KEYPACKAGE], undefined); assert.equal(fake.seen.vta[WELCOME], undefined)
    assert.deepEqual({ roomId: st.roomId, visibility: st.visibility, roomEpoch: st.roomEpoch, mlsEpoch: st.mlsEpoch }, { roomId: room, visibility: 'open', roomEpoch: 1, mlsEpoch: null })
    assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).rooms[room].stage, 'joined')
  })
})

describe('the words', () => {
  test('a credential string as the vault takes it: JSON as is, base64url of JSON decoded, anything else untouched', () => {
    const j = '{"id":"urn:uuid:1"}'
    assert.equal(asCredential(j), j); assert.equal(asCredential(` ${j} `), j)
    assert.equal(asCredential(Buffer.from(j).toString('base64url')), j)
    assert.equal(asCredential('eyJhbGciOiJFZERTQSJ9.e30.sig'), 'eyJhbGciOiJFZERTQSJ9.e30.sig')
  })
  test('a bridge asked for a room without the person\'s trust agent or the community says what is missing', () => {
    assert.throws(() => new CommunityRoom({ communityDid: 'did:x:y', member: 'did:x:z' }), /needs the person's trust agent/)
  })
})
