// Step b13d0a211318: a real person signs up from Keyring with keys they hold, gets a membership pass and enters the
// encrypted room. A builder can't do that for anyone. This is the room's side of it, rehearsed end to end with
// test keys only, plus a check that the join desk is still not reachable by a real wallet (so nobody mistakes the
// rehearsal for the real thing). See docs/blocked/b13d0a211318.md.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { createResolver } from '../src/server/resolver.js'
import { newRoomPersona, openNote, present, sealNote } from '../src/shared/sealed.js'
import { SealedHost } from '../src/server/sealed-host.js'
import { toHex, randomBytes } from '../src/shared/crypto.js'
import { JoinDesk, LeafGate, approval, invitation, bindLeaf, joinRequest } from '../src/server/join.js'

describe('Keyring sign-up, rehearsed with test keys', () => {
  test('invite, signed join, a member says yes, pass issued, leaf verified, room read and written', async () => {
    let t = Date.parse('2026-11-09T12:00:00Z'); const now = () => t
    const room = newIdentity(), member = newRoomPersona(), joiner = newRoomPersona() // joiner: keys only it holds
    const desk = new JoinDesk({ room, host: 'host.test', resolver: createResolver(), now }); desk.seed(member.did)
    const host = new SealedHost({ host: 'host.test', now }); host.createRoom(room.did)
    const call = (who, cred, op, args = {}) => host.call(present(who, cred, { room: room.did, nonce: host.challenge(), op, host: 'host.test', args }), args)

    // 1. a member makes the invite the wallet scans
    const inv = desk.invite(invitation(member, { room: room.did, nonce: desk.challenge() }))
    assert.equal(inv.invitation.from, room.did)
    // 2. the wallet signs the join with the joiner's own key: pending, no pass yet
    const r = await desk.receive(joinRequest(joiner, { room: room.did, host: 'host.test', token: inv.token, nonce: desk.challenge() }))
    assert.equal(r.status, 'pending'); assert.equal(desk.members.has(joiner.did), false)
    // 3. a member's own tap issues the membership pass, for the joiner's DID, short-lived, no admin
    const pass = desk.approve(r.requestId, approval(member, { room: room.did, nonce: desk.challenge(), request: r.requestId }))
    assert.equal(pass.credentialSubject.id, joiner.did); assert.equal(pass.issuer, room.did)
    assert.ok(!pass.credentialSubject.scopes.includes('members:admin'))
    // 4. the joiner's MLS leaf, bound by its DID, is verified and gets the epoch key
    const epochKey = randomBytes(32), gate = new LeafGate({ desk, epochKey }), leaf = toHex(randomBytes(32))
    assert.equal(await gate.register({ did: joiner.did, leafKey: leaf, binding: bindLeaf(joiner, { room: room.did, leaf }) }), 'verified')
    assert.deepEqual(gate.keyFor(leaf), epochKey)
    // 5. with the pass, the joiner enters the sealed room: writes and lists
    const at = { room: room.did, recordId: 'hello', epoch: 0 }, sealed = await sealNote(gate.keyFor(leaf), at, 'hello, room')
    assert.deepEqual(call(joiner, pass, 'write', { recordId: 'hello', epoch: 0, sealed }), { ok: true })
    assert.deepEqual(call(joiner, pass, 'list'), [{ recordId: 'hello', epoch: 0 }])
    const back = call(joiner, pass, 'read', { recordId: 'hello' })
    assert.equal(await openNote(gate.keyFor(leaf), at, back.sealed), 'hello, room')
    // the pass is the joiner's alone: someone else presenting it is refused
    assert.throws(() => call(newRoomPersona(), pass, 'list'))
  })

  test('not yet real: no server route or page reaches the join desk', () => {
    // When this fails, the desk has been wired in: update docs/blocked/b13d0a211318.md and turn this into the real check.
    const files = ['src/server', 'public'].flatMap((d) => readdirSync(d).filter((f) => f.endsWith('.js')).map((f) => join(d, f)))
    const users = files.filter((f) => f !== join('src/server', 'join.js') && /JoinDesk|from '\.\/join\.js'/.test(readFileSync(f, 'utf8')))
    assert.deepEqual(users, [])
  })
})
