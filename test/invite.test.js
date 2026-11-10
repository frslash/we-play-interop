// Invites: how a newcomer gets in. A member (or, for the first one, the room) makes a code; the log holds its hash.
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { hashOf, newCode } from '../src/server/invites.js'
import { startRoom } from './helpers/room.js'

describe('invites', () => {
  let room, a
  before(async () => { room = await startRoom(); a = await room.firstMember('Person A') })
  after(() => room.stop())
  const join = (id, invite, name = 'Newcomer') => room.say(id, 'join', { name, ...(invite ? { invite } : {}) })
  const lookup = async (code) => (await room.call('/api/invite/' + code)).body

  test('the room\'s first invite is printed once, in the contract\'s words, and it works', async () => {
    const fresh = await startRoom()
    try {
      const lines = []
      const code = await fresh.ctx.ensureFirstInvite({ print: (l) => lines.push(l) })
      assert.equal(lines.length, 1); assert.equal(code.length, 22)
      assert.equal(lines[0], `First invite (give it to the first member): ${fresh.config.publicUrl}/i/${code}`)
      assert.equal(await fresh.ctx.ensureFirstInvite({ print: (l) => lines.push(l) }), null, 'a restart while that one is good says nothing more')
      assert.equal(lines.length, 1)
      const seen = await fresh.call('/api/invite/' + code)
      assert.equal(seen.body.valid, true); assert.deepEqual(seen.body.invitedBy, { name: fresh.config.workspaceName })
      const days = (Date.parse(seen.body.expiresAt) - Date.now()) / 86400000; assert.ok(days > 6.9 && days <= 7, `${days} days`)
      const log = JSON.stringify(fresh.ctx.log.entries); assert.ok(!log.includes(code), 'the log holds the hash, never the code'); assert.ok(log.includes(hashOf(code)))
      const person = newIdentity(); assert.equal((await fresh.say(person, 'join', { name: 'First', invite: code })).status, 201)
      assert.equal(await fresh.ctx.ensureFirstInvite({ print: (l) => lines.push(l) }), null, 'with a member in, the room makes no more of its own')
      assert.equal((await fresh.call('/api/invite/' + code)).body.valid, false)
      assert.equal(lines.length, 1)
    } finally { await fresh.stop() }
  })

  test('a room with no members and no good invite makes a new one at the next start (the old one ran out)', async () => {
    const fresh = await startRoom()
    try {
      const lines = []; await fresh.ctx.ensureFirstInvite({ print: (l) => lines.push(l) })
      assert.equal(await fresh.ctx.ensureFirstInvite({ print: (l) => lines.push(l), now: Date.now() + 8 * 86400000 }) !== null, true)
      assert.equal(lines.length, 2)
    } finally { await fresh.stop() }
  })

  test('a join without an invite is refused', async () => {
    const r = await join(newIdentity()); assert.equal(r.status, 403); assert.match(r.body.payload.message, /invite/)
    assert.equal(room.ctx.log.state.humanCount(), 1)
  })

  test('a valid invite lets one newcomer in, once; the same code for a second person is refused', async () => {
    const code = await room.invite(a.id)
    const v = await lookup(code); assert.equal(v.valid, true); assert.deepEqual(v.invitedBy, { name: 'Person A' }); assert.ok(Date.parse(v.expiresAt) > Date.now())
    const b = newIdentity(); assert.equal((await join(b, code, 'Person B')).status, 201)
    assert.equal(room.ctx.log.state.nameOf(b.did), 'Person B')
    assert.deepEqual(await lookup(code), { valid: false, reason: 'used' })
    const c = await join(newIdentity(), code); assert.equal(c.status, 403); assert.match(c.body.payload.message, /already used/)
  })

  test('two joins at the same moment with one code: exactly one gets in', async () => {
    const code = await room.invite(a.id)
    const rs = await Promise.all([join(newIdentity(), code, 'Racer 1'), join(newIdentity(), code, 'Racer 2'), join(newIdentity(), code, 'Racer 3')])
    assert.deepEqual(rs.map((r) => r.status).sort(), [201, 403, 403])
  })

  test('an expired invite, an unknown one and one made up are refused', async () => {
    const code = await room.invite(a.id)
    room.ctx.log.state.invites.get(hashOf(code)).expiresAt = new Date(Date.now() - 1000).toISOString() // the day has come and gone
    assert.deepEqual(await lookup(code), { valid: false, reason: 'expired' })
    const r = await join(newIdentity(), code); assert.equal(r.status, 403); assert.match(r.body.payload.message, /run out/)
    const made = newCode()
    assert.deepEqual(await lookup(made), { valid: false, reason: 'unknown' })
    const u = await join(newIdentity(), made); assert.equal(u.status, 403); assert.match(u.body.payload.message, /not one this room knows/)
    assert.equal((await join(newIdentity(), 'short')).status, 400, 'a code is 22 to 64 characters')
    assert.equal((await room.call('/api/invite/' + 'x'.repeat(200))).status, 401, 'and an address that long is not a code, so it is not on the open list')
  })

  test('an invite must come from a member: a non-member cannot write one, and one by someone who has left is dead', async () => {
    const outsider = newIdentity(), code = newCode()
    const w = await room.say(outsider, 'invite', { codeHash: hashOf(code), expiresAt: new Date(Date.now() + 86400000).toISOString() })
    assert.equal(w.status, 403); assert.deepEqual(await lookup(code), { valid: false, reason: 'unknown' })
    const b = await room.newMember(a.id, 'Leaver'), mine = await room.invite(b.id)
    assert.equal((await lookup(mine)).valid, true)
    await room.say(b.id, 'leave', {})
    assert.deepEqual(await lookup(mine), { valid: false, reason: 'inviter-left' })
    assert.equal((await join(newIdentity(), mine)).status, 403)
    const after = await room.say(b.id, 'invite', { codeHash: hashOf(newCode()), expiresAt: new Date(Date.now() + 86400000).toISOString() })
    assert.equal(after.status, 403, 'and a member who left cannot make another')
  })

  test('someone who left needs a new invite to come back', async () => {
    const b = await room.newMember(a.id, 'Comes and goes')
    await room.say(b.id, 'leave', {})
    const back = await join(b.id); assert.equal(back.status, 403, 'no invite: refused')
    const code = await room.invite(a.id)
    const again = await join(b.id, code, 'Comes and goes'); assert.equal(again.status, 201)
    assert.equal(room.ctx.log.state.isCurrentMember(b.id.did), true)
    assert.deepEqual(await lookup(code), { valid: false, reason: 'used' })
  })

  test('a member who joins again to change their profile needs no invite, and spends none', async () => {
    const code = await room.invite(a.id), b = await room.newMember(a.id, 'Changes mind')
    const r = await join(b.id, undefined, 'Changed name'); assert.equal(r.status, 201)
    assert.equal(room.ctx.log.state.nameOf(b.id.did), 'Changed name')
    assert.equal((await lookup(code)).valid, true, 'the unspent invite is still good')
    const again = await join(b.id, code, 'Changed again'); assert.equal(again.status, 201)
    assert.equal((await lookup(code)).valid, true, 'a member showing a code does not use it up')
  })

  test('an invite lives at most 14 days, and a line that says more is refused', async () => {
    const mk = (days) => room.say(a.id, 'invite', { codeHash: hashOf(newCode()), expiresAt: new Date(Date.now() + days * 86400000).toISOString() })
    assert.equal((await mk(13.9)).status, 201); assert.equal((await mk(14.5)).status, 400); assert.equal((await mk(-1)).status, 400)
    for (const bad of [{ codeHash: 'x', expiresAt: new Date(Date.now() + 1000).toISOString() }, { codeHash: hashOf('c') }, { codeHash: hashOf('c'), expiresAt: 'tomorrow' }]) assert.equal((await room.say(a.id, 'invite', bad)).status, 400)
  })

  test('agents cannot make invites (people only)', async () => {
    assert.equal((await room.linkGithub(a)).status, 201)
    const hosted = await room.say(a.id, 'host', { label: 'Helper', repos: ['acme/app'] }), agent = room.ctx.hosted.byToken(hosted.body.hosted.connector.split('/').pop())
    const doc = (await import('../src/shared/types.js')).signedDocument(agent.identity, { type: (await import('../src/shared/types.js')).TYPES.invite, payload: { codeHash: hashOf('x'), expiresAt: new Date(Date.now() + 86400000).toISOString() }, onBehalfOf: a.id.did, delegation: 'f'.repeat(64) })
    assert.equal((await room.call('/api/entries', { method: 'POST', body: doc })).status, 403)
  })

  test('the log with invites in it still verifies end to end', async () => {
    const v = await room.call('/api/verify', { cookie: a.cookie })
    assert.equal(v.status, 200); assert.equal(v.body.ok, true, JSON.stringify(v.body).slice(0, 300))
  })

  test('lookups from one address stop after the allowance', async () => {
    const limited = await startRoom({ extra: { signInPerMinute: 3 } })
    try {
      const codes = []; for (let i = 0; i < 5; i++) codes.push((await limited.call('/api/invite/' + newCode())).status)
      assert.deepEqual(codes, [200, 200, 200, 429, 429])
    } finally { await limited.stop() }
  })
})
