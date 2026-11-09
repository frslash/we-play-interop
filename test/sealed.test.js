// P2 sealed notebooks: Security's 12 conditions (bus 2026-11-09), each as a test where code can show it.
// Test members and test values only. Conditions 5 (screen words) and 12 (served page CSP) are page work, not covered here.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { present, issueCredential, newRoomKey, newRoomPersona, openNote, sealNote, MAX_NOTE_BYTES } from '../src/shared/sealed.js'
import { SealedHost } from '../src/server/sealed-host.js'
import { toHex } from '../src/shared/crypto.js'

const HOUR = 3600e3
function setup (opts = {}) {
  let t = Date.parse('2026-11-09T12:00:00Z')
  const clock = { now: () => t, advance: (ms) => { t += ms } }
  const host = new SealedHost({ now: clock.now, ...opts })
  const room = newIdentity(), person = newRoomPersona(), agent = newRoomPersona()
  host.createRoom(room.did)
  const memberCred = issueCredential(room, { subject: person.did, role: 'member', scopes: ['notes:read', 'notes:write', 'members:admin'], notBefore: new Date(t), ttlMs: 24 * HOUR })
  const agentCred = issueCredential(room, { subject: agent.did, role: 'agent', scopes: ['notes:read', 'notes:write'], notBefore: new Date(t), ttlMs: 24 * HOUR, delegatedBy: person.did })
  const key = newRoomKey()
  const call = (who, cred, op, args = {}, over = {}) => host.call(present(who, cred, { room: room.did, nonce: host.challenge(), op, host: host.host, ...over }), args)
  const write = async (who, cred, id, text, epoch = 0) => call(who, cred, 'write', { recordId: id, epoch, sealed: await sealNote(key, { room: room.did, recordId: id, epoch }, text) })
  return { host, room, person, agent, memberCred, agentCred, key, call, write, clock }
}
const refused = (fn, re) => assert.rejects(async () => fn(), (e) => e.constructor.name === 'Refused' && (!re || re.test(e.message)))

describe('P2 sealed notebooks (test members only)', () => {
  test('1. the host sees ciphertext only: marker absent from storage and logs', async () => {
    const s = setup(); const MARKER = 'MARKER-' + toHex(crypto.getRandomValues(new Uint8Array(8)))
    await s.write(s.person, s.memberCred, 'n1', 'dear notebook ' + MARKER)
    assert.ok(!s.host.dumpAll().includes(MARKER)); assert.ok(!s.host.dumpAll().includes(s.person.did), 'no roster in the clear')
    const got = await s.call(s.person, s.memberCred, 'read', { recordId: 'n1' })
    assert.equal(await openNote(s.key, { room: s.room.did, recordId: 'n1', epoch: got.epoch }, got.sealed), 'dear notebook ' + MARKER)
  })

  test('2. doors fail closed: stranger, revoked, expired, other room, stale status', async () => {
    const s = setup()
    const stranger = newRoomPersona(); await refused(() => s.call(stranger, s.memberCred, 'list'), /holder does not own/)
    const forged = issueCredential(newIdentity(), { subject: stranger.did, role: 'member', scopes: ['notes:read'], notBefore: new Date(s.clock.now()), ttlMs: HOUR })
    await refused(() => s.call(stranger, forged, 'list'), /credential is for another room|not signed by the room/)
    s.host.revoke(s.room.did, s.memberCred.id); await refused(() => s.call(s.person, s.memberCred, 'list'), /revoked/)
    const s2 = setup(); s2.clock.advance(25 * HOUR); s2.host.refreshStatus(); await refused(() => s2.call(s2.person, s2.memberCred, 'list'), /expired/)
    const s3 = setup(); s3.clock.advance(2 * HOUR); await refused(() => s3.call(s3.person, s3.memberCred, 'list'), /stale/) // log older than 1h
    const s4 = setup(); const roomB = newIdentity(); s4.host.createRoom(roomB.did)
    await refused(() => s4.host.call(present(s4.person, s4.memberCred, { room: roomB.did, nonce: s4.host.challenge(), op: 'list', host: s4.host.host })), /another room/)
    const r = setup(); const p = present(r.person, r.memberCred, { room: r.room.did, nonce: r.host.challenge(), op: 'list', host: r.host.host })
    r.host.call(p); await refused(() => r.host.call(p), /nonce/) // replay
  })

  test('3. a planted key canary appears in no log, no host dump, no refusal text', async () => {
    const s = setup(); const canary = toHex(s.person.seed)
    await s.write(s.person, s.memberCred, 'n1', 'x'); await refused(() => s.call(s.agent, s.agentCred, 'remove_member'))
    assert.ok(!s.host.dumpAll().includes(canary))
    const msgs = []; for (const op of ['list', 'nope']) { try { await s.call(s.agent, s.agentCred, op, {}, { holder: undefined }) } catch (e) { msgs.push(e.message) } }
    assert.ok(!msgs.join().includes(canary))
  })

  test('4. the agent delegation is narrow and short', async () => {
    const s = setup()
    for (const op of ['remove_member', 'add_member']) await refused(() => s.call(s.agent, s.agentCred, op), /not permitted/)
    await assert.rejects(async () => issueCredential(s.room, { subject: s.agent.did, role: 'agent', scopes: ['notes:read', 'members:admin'], ttlMs: HOUR, delegatedBy: s.person.did }), /read\/write only/)
    await assert.rejects(async () => issueCredential(s.room, { subject: s.agent.did, role: 'agent', scopes: ['notes:read'], ttlMs: 8 * 24 * HOUR, delegatedBy: s.person.did }), /at most/)
    await s.write(s.agent, s.agentCred, 'a1', 'the agent writes') // allowed
    s.clock.advance(25 * HOUR); s.host.refreshStatus(); await refused(() => s.call(s.agent, s.agentCred, 'list'), /expired/)
    const s2 = setup(); await s2.write(s2.agent, s2.agentCred, 'a1', 'hi'); s2.host.revoke(s2.room.did, s2.agentCred.id)
    await refused(() => s2.call(s2.agent, s2.agentCred, 'list'), /revoked/) // on the very next call
  })

  test('6. removal really removes: a removed member cannot read notes written after it', async () => {
    const s = setup(); const old = s.key
    await s.write(s.person, s.memberCred, 'n1', 'before')
    const { epoch } = await s.call(s.person, s.memberCred, 'remove_member') // the room rules, not one member alone, decide this in the real room
    const fresh = newRoomKey(); const sealed = await sealNote(fresh, { room: s.room.did, recordId: 'n2', epoch }, 'after')
    await s.call(s.person, s.memberCred, 'write', { recordId: 'n2', epoch, sealed })
    await assert.rejects(() => openNote(old, { room: s.room.did, recordId: 'n2', epoch }, sealed)) // the removed member holds only the old key
    await refused(() => s.call(s.person, s.memberCred, 'write', { recordId: 'n3', epoch: 0, sealed }), /stale epoch/)
  })

  test('7. one persona per person per room: nothing shared between rooms', () => {
    const a = newRoomPersona(), b = newRoomPersona()
    assert.notEqual(a.did, b.did); assert.notEqual(toHex(a.seed), toHex(b.seed))
  })

  test('8. caps and own-only: oversize, burst, listing others', async () => {
    const s = setup({ writesPerMinute: 3 })
    await assert.rejects(() => sealNote(s.key, { room: s.room.did, recordId: 'big', epoch: 0 }, 'x'.repeat(MAX_NOTE_BYTES + 1)), /at most/)
    await refused(() => s.call(s.person, s.memberCred, 'write', { recordId: 'big', epoch: 0, sealed: 'ab'.repeat(70 * 1024) }), /too large/) // the host checks too
    for (let i = 0; i < 3; i++) await s.write(s.person, s.memberCred, 'n' + i, 'x')
    await refused(() => s.write(s.person, s.memberCred, 'n9', 'x'), /too many/)
    const other = newRoomPersona(); const oc = issueCredential(s.room, { subject: other.did, role: 'member', scopes: ['notes:read', 'notes:write'], notBefore: new Date(s.clock.now()), ttlMs: HOUR })
    assert.deepEqual(await s.call(other, oc, 'list'), []); await refused(() => s.call(other, oc, 'read', { recordId: 'n0' }), /not yours/)
  })

  test('9. logs are content-blind: only op, outcome, reason, size', async () => {
    const s = setup(); await s.write(s.person, s.memberCred, 'title-PLANTED', 'text-PLANTED')
    await refused(() => s.call(s.person, s.memberCred, 'read', { recordId: 'nope-PLANTED' }))
    assert.ok(s.host.events.length >= 2); for (const e of s.host.events) assert.deepEqual(Object.keys(e).filter((k) => !['at', 'op', 'outcome', 'reason', 'size'].includes(k)), [])
    assert.ok(!JSON.stringify(s.host.events).includes('PLANTED'))
  })

  test('11. P3 stays separate: the sealed code never touches the public log', () => {
    for (const f of ['src/server/sealed-host.js', 'src/shared/sealed.js']) assert.ok(!/log\.js|state\.js|append\(/.test(readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '')), f)
    assert.ok(readdirSync('src/server').includes('sealed-host.js'))
  })

  test('a note sealed for one room or record does not open in another (bound in)', async () => {
    const s = setup(); const sealed = await sealNote(s.key, { room: s.room.did, recordId: 'a', epoch: 0 }, 'hi')
    await assert.rejects(() => openNote(s.key, { room: s.room.did, recordId: 'b', epoch: 0 }, sealed))
    await assert.rejects(() => openNote(s.key, { room: 'did:key:other', recordId: 'a', epoch: 0 }, sealed))
  })
})
