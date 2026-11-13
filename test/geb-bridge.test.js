// InWove on Geb, step 0 (src/server/geb.js): the room keeps one Geb room in step with this one, through a node that here
// is a fake behaving the way Geb's CLI 0.5.18 does. Linking takes two proofs, People only lines never cross, someone who
// leaves is taken out of the Geb room, and nothing goes out while that cannot be done.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { State } from '../src/server/state.js'
import { newLinkCode, outboundText } from '../src/server/geb.js'
import { startRoom } from './helpers/room.js'

/** A Geb identity's shape (did:peer:2 with .A, .V and .E keys); `tag` keeps them apart. */
const gebDid = (tag) => { const k = ('z6Mk' + tag).padEnd(47, 'x'); return `did:peer:2.A${k}.V${k}.E${('z6LS' + tag).padEnd(47, 'y')}` }

/** A Geb node as the bridge sees one, holding its rooms in memory. */
class FakeGeb {
  constructor (did) { Object.assign(this, { did, rooms: new Map(), posted: [], accepted: [], removeFails: false, onEvent: null }) }
  async start (onEvent) { this.onEvent = onEvent }
  async stop () {}
  async send (did, text) { this.posted.push({ to: did, text }) }
  async gsend (group, text) { this.posted.push({ group, text }) }
  async accept (did) { this.accepted.push(did) }
  async groupNew (name, dids) { const id = `room-${this.rooms.size + 1}`; this.rooms.set(id, new Set([this.did, ...dids])); return id }
  async groupAdd (group, dids) { for (const d of dids) this.rooms.get(group).add(d) }
  async groupRemove (group, dids) { if (this.removeFails) throw new Error('not supported'); for (const d of dids) this.rooms.get(group).delete(d) }
  async members (group) { return [...this.rooms.get(group)] }
  /** Geb delivering a line to the room. */
  say (from, text, { group, direct = false, id = randomBytes(16).toString('hex'), signed = true } = {}) { return this.onEvent({ type: 'message', id, group, direct, from, text, at: Date.now(), signed, replay: false }) }
}

describe('InWove on Geb (step 0, with a fake Geb node)', () => {
  let room, fake, bridge, host, member, hostGeb, otherGeb, group
  const say = (who, text, extra = {}) => room.say(who.id, 'note', { kind: 'message', text, ...extra })
  const settle = () => bridge.outbox
  /** The whole link: a code, Geb's connect request, the code sent over Geb, then the person's own line. */
  const link = async (who, did) => {
    const code = (await room.call('/api/geb/link-code', { method: 'POST', cookie: who.cookie, body: {} })).body.code
    await fake.onEvent({ type: 'request', from: did })
    await fake.say(did, code, { direct: true, group: 'dyad' })
    return room.say(who.id, 'linkGeb', { did })
  }

  before(async () => {
    fake = new FakeGeb(gebDid('room'))
    room = await startRoom({ options: { gebNode: fake } })
    host = await room.firstMember('Host')
    room.config.hosts = [host.id.did]
    member = await room.newMember(host.id, 'Member')
    bridge = room.ctx.geb
    await bridge.start()
    hostGeb = gebDid('host'); otherGeb = gebDid('other')
  })
  after(() => room.stop())

  test('before anyone links there is no Geb room, and lines here wait for one', async () => {
    assert.equal(room.ctx.log.state.gebRoom, null)
    await say(member, 'Said before the Geb room exists'); await settle()
    assert.equal(fake.posted.length, 0)
    assert.equal((await room.call('/api/geb', { cookie: member.cookie })).body.running, true)
  })

  test('a link needs the code to come from that Geb identity: the line alone, or a code from another identity, is refused', async () => {
    const alone = await room.say(host.id, 'linkGeb', { did: hostGeb })
    assert.equal(alone.status, 403); assert.match(alone.body.payload.message, /has not heard your code/)
    const code = (await room.call('/api/geb/link-code', { method: 'POST', cookie: host.cookie, body: {} })).body.code
    await fake.say(otherGeb, code, { direct: true, group: 'dyad' })
    assert.equal((await room.say(host.id, 'linkGeb', { did: hostGeb })).status, 403, 'the code came from someone else')
    assert.deepEqual((await room.call('/api/geb/link-code', { cookie: host.cookie })).body, { proven: true, did: otherGeb }, 'the room says which identity it heard')
  })

  test('only the host links for now; a member gets no code and no link', async () => {
    assert.equal((await room.call('/api/geb/link-code', { method: 'POST', cookie: member.cookie, body: {} })).status, 403)
    const r = await room.say(member.id, 'linkGeb', { did: gebDid('member') })
    assert.equal(r.status, 403); assert.match(r.body.payload.message, /only the room's host links/)
  })

  test("the host links: Geb's request is accepted only while a code waits, the code proves it, and the Geb room is made with them in it", async () => {
    await fake.onEvent({ type: 'request', from: gebDid('stranger') })
    assert.ok(!fake.accepted.includes(gebDid('stranger')), 'no code waiting: a stranger is not accepted')
    const r = await link(host, hostGeb)
    assert.equal(r.status, 201, r.text)
    assert.ok(fake.accepted.includes(hostGeb))
    await settle()
    const st = room.ctx.log.state
    assert.equal(st.gebLinks.get(host.id.did).did, hostGeb)
    group = st.gebRoom?.group
    assert.ok(group, 'the record says which Geb room the room keeps')
    assert.deepEqual(new Set(await fake.members(group)), new Set([fake.did, hostGeb]))
    assert.equal((await room.call('/api/geb', { cookie: host.cookie })).body.mine, hostGeb)
    assert.equal((await room.say(host.id, 'linkGeb', { did: hostGeb })).status, 403, 'already linked')
    assert.equal((await room.say(member.id, 'linkGeb', { did: fake.did })).status, 403, "the room's own identity is never anyone's")
  })

  test('a line said here in People and AIs goes to the Geb room naming its author; a People only line never does', async () => {
    fake.posted.length = 0
    await say(member, 'Hello from the web room')
    await say(member, 'Only for people, never for Geb', { audience: 'people' })
    await settle()
    assert.deepEqual(fake.posted, [{ group, text: 'Member: Hello from the web room' }])
  })

  test('a line said in the Geb room by the linked host is written here, signed by the room and naming the host, and is not sent back', async () => {
    fake.posted.length = 0
    const id = randomBytes(16).toString('hex')
    await fake.say(hostGeb, 'Hello from Geb', { group, id })
    const e = room.ctx.log.entries.at(-1)
    assert.equal(e.author, room.ctx.log.state.workspace)
    assert.deepEqual({ member: e.document.payload.member, from: e.document.payload.from, text: e.document.payload.text, id: e.document.payload.id }, { member: host.id.did, from: hostGeb, text: 'Hello from Geb', id })
    await settle()
    assert.equal(fake.posted.length, 0, 'a relayed line does not go back to Geb')
    const before = room.ctx.log.entries.length
    await fake.say(hostGeb, 'Hello from Geb', { group, id }) // Geb replays what it queued after a restart
    assert.equal(room.ctx.log.entries.length, before, 'the same Geb line is written once')
  })

  test('lines that do not count are refused and counted, never written', async () => {
    const before = room.ctx.log.entries.length
    await fake.say(otherGeb, 'from someone not linked', { group })
    await fake.say(hostGeb, 'not signed', { group, signed: false })
    await fake.say(fake.did, 'the room itself', { group })
    await fake.say(hostGeb, 'in another room', { group: 'elsewhere' })
    await fake.say(hostGeb, 'my key is sk-ant-' + 'a'.repeat(30), { group })
    await fake.say(hostGeb, 'a direct line that is not a code', { direct: true, group: 'dyad' })
    assert.equal(room.ctx.log.entries.length, before)
    const counts = (await room.call('/api/geb', { cookie: host.cookie })).body.counts
    const n = (what) => counts.filter((c) => c.what === what).reduce((a, c) => a + c.n, 0)
    assert.ok(n('refused-unlinked') >= 1 && n('refused-unsigned') >= 1 && n('other-rooms') >= 1 && n('refused-guard') >= 1 && n('direct-ignored') >= 1)
    assert.ok(n('in') >= 1 && n('out') >= 1 && n('codes-heard') >= 1)
    assert.ok(!JSON.stringify(counts).includes('sk-ant'), 'counts never hold what was said')
    assert.equal((await room.call('/api/geb', { cookie: member.cookie })).body.counts, undefined, 'only a host sees the counts')
  })

  test('if someone who left cannot be taken out of the Geb room, nothing more goes out until they are', async () => {
    room.config.hosts = [host.id.did, member.id.did]
    const memberGeb = gebDid('member')
    try { assert.equal((await link(member, memberGeb)).status, 201) } finally { room.config.hosts = [host.id.did] }
    await settle()
    assert.ok((await fake.members(group)).includes(memberGeb))
    fake.removeFails = true
    assert.equal((await room.say(member.id, 'leave', {})).status, 201)
    await settle()
    assert.match(bridge.status().paused, /could not be taken out/)
    fake.posted.length = 0
    await say(host, 'This must not reach someone who left'); await settle()
    assert.equal(fake.posted.length, 0, 'held while paused')
    fake.removeFails = false
    await bridge.later(() => bridge.reconcile())
    assert.equal(bridge.status().paused, null)
    assert.ok(!(await fake.members(group)).includes(memberGeb), 'taken out once Geb allows it')
    await say(host, 'Back to normal'); await settle()
    assert.deepEqual(fake.posted.map((p) => p.text), ['Host: Back to normal'])
  })

  test('unlinking takes the person out of the Geb room', async () => {
    assert.equal((await room.say(host.id, 'linkGeb', { did: hostGeb, end: true })).status, 201)
    await settle()
    assert.ok(!(await fake.members(group)).includes(hostGeb))
    assert.equal(room.ctx.log.state.gebLinks.has(host.id.did), false)
  })

  test('the record alone rebuilds who is linked, the Geb room and the relayed ids', () => {
    const again = new State(), live = room.ctx.log.state
    for (const e of room.ctx.log.entries) again.apply(e)
    assert.deepEqual([...again.gebLinks], [...live.gebLinks])
    assert.deepEqual(again.gebRoom, live.gebRoom)
    assert.deepEqual([...again.gebSeen], [...live.gebSeen])
  })
})

test('a room with no Geb identity says so, and refuses a link', async () => {
  const room = await startRoom()
  try {
    const host = await room.firstMember('Host')
    room.config.hosts = [host.id.did]
    assert.deepEqual((await room.call('/api/geb', { cookie: host.cookie })).body, { running: false })
    const r = await room.say(host.id, 'linkGeb', { did: gebDid('host') })
    assert.equal(r.status, 403); assert.match(r.body.payload.message, /not on Geb yet/)
    assert.equal((await room.call('/api/geb')).status, 401, 'nobody signed out sees even that')
  } finally { await room.stop() }
})

test('a link code reads off a screen, and an outgoing line can never start like a command-line flag', () => {
  assert.match(newLinkCode(), /^INWOVE-[A-HJ-NP-Z2-9]{10}$/)
  assert.equal(outboundText('--home', 'x'), '––home: x')
  assert.equal(outboundText('Ann', 'y'.repeat(5000)).length, 4000)
  void newIdentity
})
