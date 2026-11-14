// Invites: how a newcomer gets in. A member (or, for the first one, the room) makes a code; the log holds its hash.
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { firstInviteFile, hashOf, newCode } from '../src/server/invites.js'
import { startRoom } from './helpers/room.js'

describe('invites', () => {
  let room, a
  before(async () => { room = await startRoom(); a = await room.firstMember('Person A') })
  after(() => room.stop())
  const join = (id, invite, name = 'Newcomer') => room.say(id, 'join', { name, ...(invite ? { invite } : {}) })
  const lookup = async (code) => (await room.call('/api/invite/' + code)).body

  test('the room\'s first invite goes to a file on the data volume (mode 0600), and only the file\'s path is printed', async () => {
    const fresh = await startRoom()
    try {
      const lines = []
      const code = await fresh.ctx.ensureFirstInvite({ print: (l) => lines.push(l) })
      const file = firstInviteFile(fresh.config)
      assert.equal(lines.length, 1); assert.equal(code.length, 22)
      assert.ok(lines[0].includes(file), 'the line names the file'); assert.ok(!lines[0].includes(code) && !lines[0].includes('/i/'), 'and never the link or the code')
      assert.equal(readFileSync(file, 'utf8'), `${fresh.config.publicUrl}/i/${code}\n`)
      assert.equal(statSync(file).mode & 0o777, 0o600, 'only the owner can read it')
      const seen = await fresh.call('/api/invite/' + code)
      assert.deepEqual(seen.body, { valid: true }, 'the lookup says valid and nothing about who made it or when it ends')
      const log = fresh.ctx.log.entries.filter((e) => e.document.payload?.codeHash).at(-1).document
      const hours = (Date.parse(log.payload.expiresAt) - Date.parse(log.issuedAt)) / 3600_000; assert.ok(hours > 23.99 && hours <= 24, `good for 24 hours, not ${hours}`)
      const log2 = JSON.stringify(fresh.ctx.log.entries); assert.ok(!log2.includes(code), 'until it is used the log holds the hash, never the code'); assert.ok(log2.includes(hashOf(code)))
      const person = newIdentity(); assert.equal((await fresh.say(person, 'join', { name: 'First', invite: code })).status, 201)
      assert.equal(existsSync(file), false, 'with the first member in, the file is gone')
      assert.equal(await fresh.ctx.ensureFirstInvite({ print: (l) => lines.push(l) }), null, 'with a member in, the room makes no more of its own')
      assert.deepEqual((await fresh.call('/api/invite/' + code)).body, { valid: false, reason: 'used' })
      assert.equal(lines.length, 1); assert.equal(existsSync(file), false)
    } finally { await fresh.stop() }
  })

  test('a restart while the room is still empty replaces the first invite: the old code stops working, the new one works once', async () => {
    const fresh = await startRoom()
    try {
      const first = await fresh.ctx.ensureFirstInvite({ print: () => {} }), second = await fresh.ctx.ensureFirstInvite({ print: () => {} })
      assert.notEqual(first, second)
      assert.deepEqual((await fresh.call('/api/invite/' + first)).body, { valid: false, reason: 'unknown' }, 'the old one is dead, not one of two')
      assert.equal((await fresh.say(newIdentity(), 'join', { name: 'Late', invite: first })).status, 403)
      assert.equal(readFileSync(firstInviteFile(fresh.config), 'utf8'), `${fresh.config.publicUrl}/i/${second}\n`, 'the file holds only the new one')
      assert.equal((await fresh.say(newIdentity(), 'join', { name: 'First', invite: second })).status, 201)
      assert.equal((await fresh.say(newIdentity(), 'join', { name: 'Again', invite: second })).status, 403, 'one use')
    } finally { await fresh.stop() }
  })

  test('a first invite that is not used in 24 hours is dead, and the next start writes a new one', async () => {
    const fresh = await startRoom()
    try {
      const old = await fresh.ctx.ensureFirstInvite({ print: () => {} })
      fresh.ctx.log.state.invites.get(hashOf(old)).expiresAt = new Date(Date.now() - 1000).toISOString()
      assert.deepEqual((await fresh.call('/api/invite/' + old)).body, { valid: false, reason: 'expired' })
      const next = await fresh.ctx.ensureFirstInvite({ print: () => {} }); assert.equal((await fresh.call('/api/invite/' + next)).body.valid, true)
    } finally { await fresh.stop() }
  })

  test('once a member is in, a room invite that was never used is dead too', async () => {
    const fresh = await startRoom()
    try {
      const m = await fresh.firstMember('Person A') // joins with a first invite
      const extra = await fresh.ctx.log.appendAsWorkspace('invite', { codeHash: hashOf('x'.repeat(22)), expiresAt: new Date(Date.now() + 3600_000).toISOString() })
      assert.ok(extra); assert.deepEqual((await fresh.call('/api/invite/' + 'x'.repeat(22))).body, { valid: false, reason: 'unknown' })
      void m
    } finally { await fresh.stop() }
  })

  test('a join without an invite is refused', async () => {
    const r = await join(newIdentity()); assert.equal(r.status, 403); assert.match(r.body.payload.message, /invite/)
    assert.equal(room.ctx.log.state.humanCount(), 1)
  })

  test('a valid invite lets one newcomer in, once; the same code for a second person is refused', async () => {
    const code = await room.invite(a.id)
    assert.deepEqual(await lookup(code), { valid: true }, 'valid, and nothing about who made it')
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

  test('a member who leaves and comes back does not bring their old unused invites back to life', async () => {
    const b = await room.newMember(a.id, 'Back again'), unused = await room.invite(b.id)
    await room.say(b.id, 'leave', {})
    assert.deepEqual(await lookup(unused), { valid: false, reason: 'inviter-left' })
    assert.equal((await join(b.id, await room.invite(a.id), 'Back again')).status, 201); assert.equal(room.ctx.log.state.isCurrentMember(b.id.did), true)
    assert.deepEqual(await lookup(unused), { valid: false, reason: 'inviter-left' }, 'they are a member again, but that invite stays dead')
    assert.equal((await join(newIdentity(), unused)).status, 403)
  })

  test('codes are compared with crypto.timingSafeEqual over every stored hash, and only an exact code finds an invite', async () => {
    const src = readFileSync(new URL('../src/server/state.js', import.meta.url), 'utf8')
    assert.match(src, /timingSafeEqual\(want, Buffer\.from\(hex, 'hex'\)\) && !found/, 'the comparison runs on each hash before anything is decided')
    const code = await room.invite(a.id), st = room.ctx.log.state
    assert.equal(st.findInvite(code)?.hash, st.invites.get(hashOf(code)).hash)
    for (const bad of [code.slice(0, -1), code + 'x', code.toUpperCase() === code ? code.toLowerCase() : code.toUpperCase(), '', null, undefined, 42]) assert.equal(st.findInvite(bad), null)
  })

  test('a member who joins again to change their profile needs no invite, and spends none', async () => {
    const code = await room.invite(a.id), b = await room.newMember(a.id, 'Changes mind')
    const r = await join(b.id, undefined, 'Changed name'); assert.equal(r.status, 201)
    assert.equal(room.ctx.log.state.nameOf(b.id.did), 'Changed name')
    assert.equal((await lookup(code)).valid, true, 'the unspent invite is still good')
    const again = await join(b.id, code, 'Changed again'); assert.equal(again.status, 403, 'a member\'s join carrying a code is refused, so the live code never enters the record (Security 17716)')
    assert.equal(room.ctx.log.state.nameOf(b.id.did), 'Changed name')
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
