// A link for a group: one code the room's host posts in a group chat. Everyone who opens it joins with their own key,
// until the day it ends, until it is turned off, or until it has let in the most it was made for. Its code never
// enters the record: a join names the link by its code's hash and sends the code beside the line.
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { NAME_OF, TYPES, signedDocument } from '../src/shared/types.js'
import { hashOf, newCode } from '../src/server/invites.js'
import { State } from '../src/server/state.js'
import { startRoom } from './helpers/room.js'

describe('a link for a group', () => {
  let room, host, member
  before(async () => {
    room = await startRoom()
    host = await room.firstMember('Host')
    room.config.hosts = [host.id.did]
    member = await room.newMember(host.id, 'Member')
  })
  after(() => room.stop())

  const days = (n) => new Date(Date.now() + n * 86400000).toISOString()
  /** The host (or someone) makes a group link. Answers { code, line, r }. */
  const makeLink = async (by = host.id, group = { name: 'Retreat', max: 10 }, expiresAt = days(3)) => {
    const code = newCode(), r = await room.say(by, 'invite', { codeHash: hashOf(code), expiresAt, group })
    return { code, line: r.body?.hash, r }
  }
  /** Joining through a group link the way the page does it: the code's hash in the line, the code beside it. */
  const joinVia = (code, name = 'Newcomer', id = newIdentity(), sendCode = code) => room.call('/api/entries', {
    method: 'POST', body: signedDocument(id, { type: TYPES.join, payload: { name, groupInvite: hashOf(code) } }), headers: sendCode ? { 'x-inwove-invite': sendCode } : {},
  })
  const lookup = async (code) => (await room.call('/api/invite', { method: 'POST', body: { code } })).body // the page's way: the code in the body

  test('the host makes one, and several people join through it, each as their own member', async () => {
    const { code, r } = await makeLink()
    assert.equal(r.status, 201)
    assert.deepEqual(await lookup(code), { valid: true, group: true }, 'the lookup says it is a group link, and nothing about who made it')
    const before = room.ctx.log.state.humanCount()
    const ids = [newIdentity(), newIdentity(), newIdentity()]
    for (const [i, id] of ids.entries()) assert.equal((await joinVia(code, `Guest ${i}`, id)).status, 201)
    const st = room.ctx.log.state
    assert.equal(st.humanCount(), before + 3)
    for (const id of ids) assert.equal(st.participants.get(id.did).joinedThrough, 'Retreat', 'each is marked as joined through the link')
    assert.equal(st.findInvite(code).joined.length, 3)
    assert.deepEqual(await lookup(code), { valid: true, group: true }, 'it still works after people use it')
    assert.ok(!JSON.stringify(room.ctx.log.entries).includes(code), 'the record never holds the code, only its hash')
  })

  test('only the room\'s host makes a group link; any member still makes a one-person invite', async () => {
    const { r } = await makeLink(member.id)
    assert.equal(r.status, 403); assert.match(r.body.payload.message, /only the room's host makes a link for a group/)
    assert.equal((await room.say(member.id, 'invite', { codeHash: hashOf(newCode()), expiresAt: days(1) })).status, 201)
    const hosts = room.config.hosts; room.config.hosts = []
    try { assert.match((await makeLink()).r.body.payload.message, /no host named yet/) } finally { room.config.hosts = hosts }
  })

  test('a group code put inside a join is refused, so it can never land in the record', async () => {
    const { code } = await makeLink()
    const r = await room.say(newIdentity(), 'join', { name: 'Careless', invite: code })
    assert.equal(r.status, 403); assert.match(r.body.payload.message, /group link: join from its page/)
    assert.ok(!JSON.stringify(room.ctx.log.entries).includes(code))
  })

  test('a join that names a group link needs that link\'s code beside it', async () => {
    const { code } = await makeLink()
    assert.equal((await joinVia(code, 'No code', newIdentity(), null)).status, 403, 'the hash alone (anyone reading the record has it) does not let anyone in')
    assert.equal((await joinVia(code, 'Wrong code', newIdentity(), newCode())).status, 403)
    const single = newCode(); await room.say(host.id, 'invite', { codeHash: hashOf(single), expiresAt: days(1) })
    const r = await joinVia(single)
    assert.equal(r.status, 403, 'a one-person invite cannot be used as a group link'); assert.match(r.body.payload.message, /for one person/)
  })

  test('a link made for at most two lets in two, then says it is full', async () => {
    const { code } = await makeLink(host.id, { name: 'Small group', max: 2 })
    assert.equal((await joinVia(code, 'One')).status, 201)
    assert.equal((await joinVia(code, 'Two')).status, 201)
    const third = await joinVia(code, 'Three')
    assert.equal(third.status, 403); assert.match(third.body.payload.message, /as many people as it was made for/)
    assert.deepEqual(await lookup(code), { valid: false, reason: 'full' })
  })

  test('people joining at the same moment never get past the most it was made for', async () => {
    const { code } = await makeLink(host.id, { name: 'Rush', max: 2 })
    const all = await Promise.all([1, 2, 3, 4, 5].map((i) => joinVia(code, `Rush ${i}`)))
    assert.equal(all.filter((r) => r.status === 201).length, 2)
    assert.equal(room.ctx.log.state.findInvite(code).joined.length, 2)
  })

  test('turning it off: the host stops it, nobody else joins, and the people who joined stay members', async () => {
    const { code, line } = await makeLink(host.id, { name: 'To stop', max: 5 })
    const guest = newIdentity(); assert.equal((await joinVia(code, 'Stays', guest)).status, 201)
    assert.equal((await room.say(member.id, 'inviteStop', { invite: line })).status, 403, 'a member who neither made it nor hosts cannot')
    assert.equal((await room.say(host.id, 'inviteStop', { invite: line })).status, 201)
    assert.deepEqual(await lookup(code), { valid: false, reason: 'stopped' })
    const late = await joinVia(code, 'Late'); assert.equal(late.status, 403); assert.match(late.body.payload.message, /turned off/)
    assert.ok(room.ctx.log.state.isCurrentMember(guest.did))
    assert.equal((await room.say(host.id, 'inviteStop', { invite: line })).status, 403, 'already off')
    assert.equal((await room.say(host.id, 'inviteStop', { invite: 'f'.repeat(64) })).status, 400)
  })

  test('a link past its last day does not let anyone in', async () => {
    const { code } = await makeLink()
    room.ctx.log.state.findInvite(code).expiresAt = new Date(Date.now() - 1000).toISOString()
    assert.deepEqual(await lookup(code), { valid: false, reason: 'expired' })
    assert.equal((await joinVia(code)).status, 403)
  })

  test('a group link lives at most 14 days, and says who it is for', async () => {
    assert.equal((await makeLink(host.id, { name: 'Too long', max: 5 }, days(15))).r.status, 400)
    assert.equal((await makeLink(host.id, { name: '', max: 5 })).r.status, 400)
    assert.equal((await makeLink(host.id, { name: 'One', max: 1 })).r.status, 400)
    assert.equal((await makeLink(host.id, { name: 'Odd', max: 5, extra: true })).r.status, 400)
  })

  test('a group link must carry a cap while nobody can be removed: one with no max is refused', async () => {
    const r = (await makeLink(host.id, { name: 'No cap' })).r
    assert.equal(r.status, 400)
    assert.match(r.body.payload.message, /group\.max/)
    assert.equal((await makeLink(host.id, { name: 'Zero', max: 0 })).r.status, 400)
  })

  test('the host\'s card lists each link, its state and who joined through it; nobody else sees it', async () => {
    const { line } = await makeLink(host.id, { name: 'Listed', max: 5 })
    const got = await room.call('/api/group-links', { cookie: host.cookie })
    assert.equal(got.status, 200)
    const mine = got.body.links.find((l) => l.hash === line)
    assert.deepEqual({ name: mine.name, max: mine.max, state: mine.state, by: mine.by, joined: mine.joined }, { name: 'Listed', max: 5, state: 'open', by: 'Host', joined: [] })
    assert.ok(got.body.links.some((l) => l.state === 'full') && got.body.links.some((l) => l.state === 'stopped'))
    assert.ok(!JSON.stringify(got.body).includes('codeHash'), 'nothing that names the code')
    assert.equal((await room.call('/api/group-links', { cookie: member.cookie })).status, 403)
    assert.equal((await room.call('/api/group-links')).status, 401)
  })

  test('the people list shows who joined through a link, to everyone in the room', async () => {
    const { code } = await makeLink(host.id, { name: 'Shown', max: 5 })
    const guest = newIdentity(); await joinVia(code, 'Shown guest', guest)
    const s = await room.call('/api/state', { cookie: member.cookie })
    assert.equal(s.body.people.find((p) => p.did === guest.did)?.joinedThrough, 'Shown')
  })

  test('when its maker leaves, their group link stops working', async () => {
    room.config.hosts = [host.id.did, member.id.did]
    try {
      const leaver = member, { code } = await makeLink(leaver.id, { name: 'Leaver\'s', max: 5 })
      assert.equal((await room.say(leaver.id, 'leave', {})).status, 201)
      assert.deepEqual(await lookup(code), { valid: false, reason: 'inviter-left' })
    } finally { room.config.hosts = [host.id.did] }
  })

  test('a current member\'s join never carries an invite, so a live code can\'t enter the record unspent', async () => {
    const { code: way } = await makeLink(host.id, { name: 'Way in', max: 5 }), m = newIdentity()
    assert.equal((await joinVia(way, 'Member', m)).status, 201)
    const single = newCode(); await room.say(host.id, 'invite', { codeHash: hashOf(single), expiresAt: days(1) })
    const r = await room.say(m, 'join', { name: 'Member again', invite: single })
    assert.equal(r.status, 403); assert.match(r.body.payload.message, /already a member/)
    assert.deepEqual(await lookup(single), { valid: true }, 'the code stays good for the friend it was made for')
    const { code } = await makeLink(host.id, { name: 'Members too', max: 5 })
    assert.equal((await joinVia(code, 'Member again', m)).status, 403)
    assert.equal(room.ctx.log.state.findInvite(code).joined.length, 0)
    assert.equal((await room.say(m, 'join', { name: 'Member again' })).status, 201, 'a member\'s plain join still works')
    const mine = room.ctx.log.entries.filter((e) => e.author === m.did && NAME_OF[e.type] === 'join')
    assert.equal(mine.length, 2, 'the way-in join and the plain one')
    assert.ok(mine.every((e) => e.document.payload.invite === undefined), 'no member join line holds a code')
  })

  test('the record alone rebuilds every link: who joined, which are full and which are off', async () => {
    const again = new State()
    for (const e of room.ctx.log.entries) again.apply(e)
    const live = room.ctx.log.state
    const view = (st) => [...st.invites.values()].filter((i) => i.group).map((i) => ({ name: i.group.name, joined: i.joined.map((j) => j.did), stopped: !!i.stopped }))
    assert.deepEqual(view(again), view(live))
  })
})

// keep the signed document helper honest: the page sends exactly this shape
test('a group join line holds the code\'s hash and nothing else about the link', () => {
  const id = newIdentity(), code = newCode()
  const doc = signedDocument(id, { type: TYPES.join, payload: { name: 'X', groupInvite: hashOf(code) } })
  assert.ok(!JSON.stringify(doc).includes(code))
})

describe('a group link\'s code stays out of every URL, and guessing at codes is slowed and counted (Security 13731)', () => {
  let room, host
  before(async () => {
    room = await startRoom({ extra: { inviteMissesPerMinute: 3 } })
    host = await room.firstMember('Host')
    room.config.hosts = [host.id.did]
  })
  after(() => room.stop())
  const make = async () => { const code = newCode(); await room.say(host.id, 'invite', { codeHash: hashOf(code), expiresAt: new Date(Date.now() + 86400000).toISOString(), group: { name: 'Retreat', max: 5 } }); return code }

  test('the lookup by URL never answers for a group code; the page asks with the code in the body', async () => {
    const code = await make()
    assert.deepEqual((await room.call('/api/invite/' + code)).body, { valid: false, reason: 'unknown' })
    assert.deepEqual((await room.call('/api/invite', { method: 'POST', body: { code } })).body, { valid: true, group: true })
    assert.equal((await room.call('/api/invite', { method: 'POST', body: { code: 'x' } })).status, 400)
  })

  test('the page the link opens sends no Referer anywhere', async () => {
    const r = await room.call('/i/')
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer')
  })

  test('wrong codes are counted, and an address that keeps guessing is slowed', async () => {
    const before = { ...room.ctx.inviteMissCount }
    for (let i = 0; i < 3; i++) assert.equal((await room.call('/api/invite', { method: 'POST', body: { code: newCode() } })).body.valid, false)
    assert.equal((await room.call('/api/invite', { method: 'POST', body: { code: newCode() } })).status, 429, 'the fourth wrong guess in a minute is slowed')
    assert.equal(room.ctx.inviteMissCount.lookup, before.lookup + 3)
    assert.equal(room.ctx.inviteMissCount.slowed, before.slowed + 1)
    const r = await room.call('/api/group-links', { cookie: host.cookie })
    assert.equal(r.body.wrongCodes.lookup, room.ctx.inviteMissCount.lookup, 'the host sees the counts, never a code')
  })
})
