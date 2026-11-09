// P4 wallet joins: Security's nine conditions (bus 2026-11-09), each a test. Test members and test values only.
// Condition 9's words are tested as text; wiring them into the page is page work (not done here).
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { createResolver } from '../src/server/resolver.js'
import { issueCredential, newRoomPersona } from '../src/shared/sealed.js'
import { SealedHost } from '../src/server/sealed-host.js'
import { toHex } from '../src/shared/crypto.js'
import { JoinDesk, LeafGate, MAX_MESSAGE_BYTES, approval, invitation, bindLeaf, joinRequest, joinScreenWords, INVITE_MAX_MS, MAX_OPEN_INVITES_PER_ROOM } from '../src/server/join.js'

const setup = (opts = {}) => {
  let t = Date.parse('2026-11-09T12:00:00Z')
  const room = newIdentity(), member = newRoomPersona()
  const desk = new JoinDesk({ room, host: 'host.test', resolver: createResolver(), now: () => t, ...opts })
  desk.roomName = 'We Play Interop'; desk.seed(member.did)
  const clock = { advance: (ms) => { t += ms }, now: () => t }
  const request = (joiner, token, over = {}) => joinRequest(joiner, { room: room.did, host: 'host.test', token, nonce: desk.challenge(), ...over })
  const invite = (m = member) => desk.invite(invitation(m, { room: room.did, nonce: desk.challenge() }))
  return { room, member, desk, clock, request, invite }
}
const refused = (fn, re) => assert.rejects(async () => fn(), (e) => e.constructor.name === 'Refused' && (!re || re.test(e.message)))

describe('P4 wallet joins (test members only)', () => {
  test('1. the QR is not membership: a good handshake makes a pending request that reads nothing, until a member taps', async () => {
    const s = setup(), joiner = newRoomPersona()
    const inv = s.invite()
    const r = await s.desk.receive(s.request(joiner, inv.token))
    assert.equal(r.status, 'pending'); assert.equal(r.credential, undefined); assert.equal(s.desk.members.has(joiner.did), false)
    // the pending joiner holds no credential, so the sealed host refuses it everything
    const host = new SealedHost({ host: 'host.test', now: s.clock.now }); host.createRoom(s.room.did)
    await refused(() => host.call({ room: s.room.did, host: 'host.test', op: 'list', nonce: host.challenge(), holder: joiner.did }), /malformed|credential/)
    // a joiner cannot approve itself; a stranger cannot approve; a member can
    await refused(() => s.desk.approve(r.requestId, approval(joiner, { room: s.room.did, nonce: s.desk.challenge(), request: r.requestId })), /only a member|yourself/)
    const cred = s.desk.approve(r.requestId, approval(s.member, { room: s.room.did, nonce: s.desk.challenge(), request: r.requestId }))
    assert.equal(cred.credentialSubject.id, joiner.did); assert.ok(!cred.credentialSubject.scopes.includes('members:admin'))
    assert.ok(Date.parse(cred.validUntil) - Date.parse(cred.validFrom) <= 7 * 24 * 3600e3)
  })

  test('2. the invite is single-use, an hour at most, bound to the room, stored hashed, revocable', async () => {
    const s = setup()
    assert.throws(() => new JoinDesk({ room: s.room, host: 'h', resolver: createResolver(), inviteMs: INVITE_MAX_MS + 1 }), /an hour/)
    const a = s.invite()
    assert.ok(!s.desk.dumpAll().includes(a.token), 'only a hash is stored')
    await s.desk.receive(s.request(newRoomPersona(), a.token))
    await refused(() => s.desk.receive(s.request(newRoomPersona(), a.token)), /not valid/) // reuse
    const b = s.invite(); s.clock.advance(INVITE_MAX_MS + 1)
    await refused(() => s.desk.receive(s.request(newRoomPersona(), b.token)), /not valid/) // expired
    const c = s.invite(); s.desk.revokeInvite(c.token)
    await refused(() => s.desk.receive(s.request(newRoomPersona(), c.token)), /not valid/) // revoked
    const other = setup(), d = other.invite() // an invite from room A in room B
    await refused(() => s.desk.receive(s.request(newRoomPersona(), d.token)), /not valid/)
    await refused(() => s.desk.receive(s.request(newRoomPersona(), a.token, { room: other.room.did })), /another room/)
    assert.throws(() => s.invite(newRoomPersona()), /only a member/)
  })

  test('3. nothing sensitive in the QR; the token never reaches a log', async () => {
    const s = setup(), inv = s.invite()
    const text = JSON.stringify(inv.invitation)
    for (const bad of [s.member.did, s.member.seedHex, '@', 'mailto']) assert.ok(!text.includes(bad))
    assert.deepEqual(Object.keys(inv.invitation.body).sort(), ['accept', 'goal', 'goal_code'])
    await refused(() => s.desk.receive(s.request(newRoomPersona(), 'f'.repeat(32))), /not valid/)
    await s.desk.receive(s.request(newRoomPersona(), inv.token))
    assert.ok(!JSON.stringify(s.desk.events).includes(inv.token)); assert.ok(!JSON.stringify(s.desk.events).includes(s.room.did))
  })

  test('4. the joiner proves it owns the DID: wrong key, replayed nonce, private address all refused', async () => {
    const s = setup(), inv = () => s.invite().token
    const joiner = newRoomPersona(), liar = newRoomPersona()
    // wrong key: signs as the liar but claims the joiner's DID
    const t1 = inv(), nonce = s.desk.challenge()
    const forged = joinRequest(liar, { room: s.room.did, host: 'host.test', token: t1, nonce })
    await refused(() => s.desk.receive({ ...forged, holder: joiner.did }), /own that DID/)
    // replayed nonce
    const t2 = inv(), n2 = s.desk.challenge(), good = joinRequest(joiner, { room: s.room.did, host: 'host.test', token: t2, nonce: n2 })
    await s.desk.receive(good)
    const t3 = inv()
    await refused(() => s.desk.receive({ ...joinRequest(newRoomPersona(), { room: s.room.did, host: 'host.test', token: t3, nonce: n2 }) }), /nonce/)
    // a DID that resolves to a private address: the real resolver refuses before any request is made
    const t4 = inv(), priv = { did: 'did:webvh:QmFake:localhost', seed: joiner.seed, verificationMethod: 'did:webvh:QmFake:localhost#key-1' }
    await refused(() => s.desk.receive(joinRequest(priv, { room: s.room.did, host: 'host.test', token: t4, nonce: s.desk.challenge() })), /own that DID/)
    // and a resolver that is never reached on a bad nonce
    let called = 0; const spy = setup({ resolver: { keyFor: async () => { called++; throw new Error('x') } } })
    const t5 = spy.invite().token
    await refused(() => spy.desk.receive(spy.request(newRoomPersona(), t5, { nonce: 'deadbeef' })), /nonce/); assert.equal(called, 0)
  })

  test('5. rate limits: open invites per room and redemptions per minute, refusals logged by reason', async () => {
    const s = setup()
    for (let i = 0; i < MAX_OPEN_INVITES_PER_ROOM; i++) s.invite()
    assert.throws(() => s.invite(), /too many open invites/)
    const r = setup(); const tok = r.invite().token
    // garbage tokens never count toward the cap (Security should-fix 4): a real joiner is not locked out
    for (let i = 0; i < 30; i++) await r.desk.receive(r.request(newRoomPersona(), 'a'.repeat(32))).catch(() => {})
    // requests carrying a currently valid token do count
    const valid = Array.from({ length: 10 }, () => r.invite().token)
    for (const v of valid) await r.desk.receive(r.request(newRoomPersona(), v, { nonce: 'deadbeef' })).catch(() => {})
    await refused(() => r.desk.receive(r.request(newRoomPersona(), tok)), /too many redemptions/)
    assert.ok(r.desk.events.some((e) => e.outcome === 'refused' && e.reason === 'too many redemptions'))
    r.clock.advance(61e3); await r.desk.receive(r.request(newRoomPersona(), tok)) // a new minute, a new allowance
  })

  test('6. wallet messages are data: oversize, malformed, unknown type refused; no credential is ever accepted back', async () => {
    const s = setup(), tok = s.invite().token
    await refused(() => s.desk.receive({ ...s.request(newRoomPersona(), tok), pad: 'x'.repeat(MAX_MESSAGE_BYTES) }), /oversize/)
    for (const bad of [null, 'text', [], {}, { type: 'wpi/join-request/1' }]) await refused(() => s.desk.receive(bad), /malformed|unknown type/)
    await refused(() => s.desk.receive({ ...s.request(newRoomPersona(), tok), type: 'credential-offer' }), /unknown type/)
    await refused(() => s.desk.receive({ type: 'https://didcomm.org/issue-credential/3.0/offer-credential', body: {} }), /unknown type/)
    assert.equal(s.desk.pending.size, 0)
  })

  test('7. unverified stays unverified: a leaf with no DID-signed binding is handed no key and decrypts nothing', async () => {
    const s = setup(), key = new Uint8Array(32).fill(7)
    const gate = new LeafGate({ desk: s.desk, epochKey: key })
    const leaf = toHex(crypto.getRandomValues(new Uint8Array(32)))
    assert.equal(await gate.register({ did: s.member.did, leafKey: leaf, binding: null }), 'unverified'); assert.equal(gate.keyFor(leaf), null)
    const stranger = newRoomPersona(), b = bindLeaf(stranger, { room: s.room.did, leaf })
    assert.equal(await gate.register({ did: stranger.did, leafKey: leaf, binding: b }), 'unverified', 'signed, but not a member')
    const wrongLeaf = bindLeaf(s.member, { room: s.room.did, leaf: 'aa' })
    assert.equal(await gate.register({ did: s.member.did, leafKey: leaf, binding: wrongLeaf }), 'unverified', 'binding for another leaf')
    assert.equal(await gate.register({ did: s.member.did, leafKey: leaf, binding: bindLeaf(s.member, { room: s.room.did, leaf }) }), 'verified')
    assert.deepEqual(gate.keyFor(leaf), key); assert.equal(gate.keyFor('00'), null)
  })

  test('8. a fresh room persona on join: the same DID is never admitted twice, and never the inviter', async () => {
    const s = setup(), j = newRoomPersona()
    await s.desk.receive(s.request(j, s.invite().token))
    await refused(() => s.desk.receive(s.request(j, s.invite().token)), /fresh identity/)
    await refused(() => s.desk.receive(s.request(s.member, s.invite().token)), /fresh identity/)
  })

  test('9. the join screen names the room and the host domain, and says the code alone lets nobody in', () => {
    const w = joinScreenWords({ roomName: 'We Play Interop', hostDomain: 'interop.example' })
    assert.match(w, /We Play Interop/); assert.match(w, /interop\.example/); assert.match(w, /a member of the room has to say yes/)
  })

  test('Security must-fix: an invite needs a signed presentation; a bare DID, a wrong key or a replay is refused', async () => {
    const s = setup()
    assert.throws(() => s.desk.invite(s.member.did), /nonce|invitation/)
    const forged = invitation(newRoomPersona(), { room: s.room.did, nonce: s.desk.challenge() }); forged.holder = s.member.did
    assert.throws(() => s.desk.invite(forged), /only a member/)
    const good = invitation(s.member, { room: s.room.did, nonce: s.desk.challenge() })
    s.desk.invite(good); assert.throws(() => s.desk.invite(good), /nonce/)
    const wrongOp = invitation(s.member, { room: s.room.did, nonce: s.desk.challenge() }); wrongOp.op = 'approve_member'
    assert.throws(() => s.desk.invite(wrongOp), /not an invitation|only a member/)
  })

  test('Security should-fix: removing a member drops their invites, pending requests and verified leaf', async () => {
    const s = setup(), gate = new LeafGate({ desk: s.desk, epochKey: 'k' })
    const inv = s.invite()
    assert.equal(await gate.register({ did: s.member.did, leafKey: 'leaf1', binding: bindLeaf(s.member, { room: s.room.did, leaf: 'leaf1' }) }), 'verified')
    assert.equal(gate.keyFor('leaf1'), 'k')
    s.desk.removeMember(s.member.did, { gate })
    assert.equal(gate.keyFor('leaf1'), null)
    await refused(() => s.desk.receive(s.request(newRoomPersona(), inv.token)), /invite not valid/)
  })
})
