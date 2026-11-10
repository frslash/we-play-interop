// Passkeys: registering one, signing in with it, and every way a response can be wrong. The authenticator is a fake
// (test/helpers/passkey.js) that makes the same bytes a browser would hand the page.
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { FakeAuthenticator, fakeWrappedSeed } from './helpers/passkey.js'
import { startRoom } from './helpers/room.js'
import { prfSaltOf, userHandleOf } from '../src/server/passkey.js'
import { createHash } from 'node:crypto'

describe('passkeys', () => {
  let room, me, origin, rpId
  before(async () => { room = await startRoom(); me = await room.firstMember(); origin = room.config.publicUrl; rpId = new URL(origin).hostname })
  after(() => room.stop())

  const registerOptions = async (cookie = me.cookie) => (await room.call('/api/passkey/register/options', { method: 'POST', cookie })).body
  const register = async (auth, over = {}, { cookie = me.cookie, opts } = {}) => {
    const o = opts ?? await registerOptions(cookie)
    return room.call('/api/passkey/register', { method: 'POST', cookie, body: auth.create({ challenge: o.challenge, rpId: o.rp.id, origin, ...over }) })
  }
  const signInOptions = async () => (await room.call('/api/session/passkey/options', { method: 'POST' })).body
  const signIn = async (auth, over = {}, { opts } = {}) => {
    const o = opts ?? await signInOptions()
    return room.call('/api/session/passkey', { method: 'POST', body: auth.get({ challenge: o.challenge, rpId: o.rpId, origin, ...over }) })
  }
  const fresh = async (kind = 'ES256', reg = {}) => { const a = new FakeAuthenticator({ kind }); const r = await register(a, reg); assert.equal(r.status, 200, r.text); return a }

  test('the options say what the contract says', async () => {
    const o = await registerOptions()
    assert.deepEqual(o.rp, { id: rpId, name: room.config.workspaceName })
    assert.equal(o.user.id, createHash('sha256').update(me.id.did).digest().subarray(0, 16).toString('base64url'))
    assert.equal(o.user.id, userHandleOf(me.id.did)); assert.equal(o.user.name, 'Person A'); assert.equal(o.user.displayName, 'Person A')
    assert.deepEqual(o.pubKeyCredParams, [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -8 }, { type: 'public-key', alg: -257 }])
    assert.equal(o.timeout, 120000); assert.equal(o.attestation, 'none'); assert.deepEqual(o.authenticatorSelection, { residentKey: 'required', userVerification: 'preferred' })
    assert.equal(Buffer.from(o.challenge, 'base64url').length, 32); assert.deepEqual(o.excludeCredentials, [])
    assert.equal(o.prfSalt, createHash('sha256').update('inwove passkey seed wrap v1|' + rpId).digest('base64url'))
    assert.equal(o.prfSalt, prfSaltOf(rpId))
    const s = await signInOptions()
    assert.deepEqual(Object.keys(s).sort(), ['challenge', 'prfSalt', 'rpId', 'timeout', 'userVerification']); assert.equal(s.rpId, rpId); assert.equal(s.userVerification, 'preferred'); assert.equal(s.timeout, 120000)
    assert.equal((await room.call('/api/passkey/register/options', { method: 'POST' })).status, 401, 'registering needs a session')
  })

  for (const kind of ['ES256', 'Ed25519', 'RS256']) {
    test(`${kind}: register, then sign in with it, and the session works`, async () => {
      const auth = await fresh(kind, { label: `My ${kind}`, transports: ['internal', 'hybrid', 'bogus'] })
      const r = await signIn(auth, { userHandle: userHandleOf(me.id.did) })
      assert.equal(r.status, 200, r.text); assert.deepEqual(r.body, { did: me.id.did, name: 'Person A', wrappedSeed: null })
      const cookie = room.cookieOf(r); assert.match(r.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Strict/)
      assert.equal((await room.call('/api/state', { cookie })).status, 200)
      const kept = room.ctx.passkeys.find(auth.id)
      assert.equal(kept.did, me.id.did); assert.equal(kept.alg, auth.alg); assert.equal(kept.label, `My ${kind}`); assert.deepEqual(kept.transports, ['internal', 'hybrid']); assert.equal(kept.counter, 1); assert.equal(kept.userVerified, true); assert.ok(kept.lastUsedAt)
      assert.equal((await room.call('/api/session', { cookie })).body.passkeys >= 1, true)
      assert.equal((await signIn(auth)).status, 200, 'and again, the counter going up')
    })
  }

  test('a registration that is wrong in any way is refused and keeps nothing', async () => {
    const count = room.ctx.passkeys.count(me.id.did)
    const cases = [
      ['wrong origin', { origin: 'https://evil.example' }, 403],
      ['wrong rpId', { rpId: 'evil.example' }, 403],
      ['no user-present flag', { up: false }, 400],
      ['a sign-in response', { clientType: 'webauthn.get' }, 400],
      ['another challenge', { challenge: Buffer.alloc(32, 1).toString('base64url') }, 400],
      ['a credential id in authData that is not rawId', { credentialId: Buffer.alloc(32, 7) }, 400],
    ]
    for (const [what, over, status] of cases) {
      const r = await register(new FakeAuthenticator(), over)
      assert.equal(r.status, status, `${what}: ${r.text}`); assert.ok(r.body.error, what)
    }
    const auth = new FakeAuthenticator(), o = await registerOptions()
    const good = auth.create({ challenge: o.challenge, rpId, origin })
    for (const [what, bad] of [['a key of the wrong kind', { ...good, publicKeyAlgorithm: -8 }], ['an unknown algorithm', { ...good, publicKeyAlgorithm: -36 }], ['junk for a key', { ...good, publicKey: 'AAAA' }], ['rawId that differs', { ...good, rawId: new FakeAuthenticator().id }], ['a seed with no PRF', { ...good, prf: false, wrappedSeed: fakeWrappedSeed() }], ['a seed of the wrong size', { ...good, prf: true, wrappedSeed: { iv: 'AAAA', ct: 'AAAA' } }]]) {
      const r = await room.call('/api/passkey/register', { method: 'POST', cookie: me.cookie, body: bad })
      assert.equal(r.status, 400, `${what}: ${r.text}`)
      Object.assign(o, await registerOptions()); Object.assign(good, auth.create({ challenge: o.challenge, rpId, origin })) // each try uses up its challenge
    }
    assert.equal(room.ctx.passkeys.count(me.id.did), count)
  })

  test('a registration challenge is single use, two minutes long, and for the person who asked', async () => {
    const auth = new FakeAuthenticator(), o = await registerOptions()
    assert.equal((await register(auth, {}, { opts: o })).status, 200)
    const again = new FakeAuthenticator()
    assert.equal((await register(again, {}, { opts: o })).status, 400, 'reused')
    const stale = await registerOptions(), real = room.ctx.challenges.now
    try { room.ctx.challenges.now = () => Date.now() + 121_000; assert.equal((await register(again, {}, { opts: stale })).status, 400, 'older than two minutes') } finally { room.ctx.challenges.now = real }
    const b = await room.newMember(me.id, 'Person B'), theirs = await registerOptions(b.cookie)
    assert.equal((await register(again, {}, { opts: theirs })).status, 400, 'a challenge asked for by someone else')
    assert.equal((await register(auth, {})).status, 409, 'the same passkey twice')
  })

  test('a sign-in that is wrong in any way is refused: origin, rpId, reused or stale challenge, bad signature, counter, no user-present flag', async () => {
    const auth = await fresh('ES256')
    assert.equal((await signIn(auth)).status, 200)
    const refused = async (what, over, status) => { const r = await signIn(auth, over); assert.equal(r.status, status, `${what}: ${r.text}`); assert.equal(r.headers.get('set-cookie'), null, `${what}: no cookie`); assert.ok(r.body.error) }
    await refused('wrong origin', { origin: 'https://evil.example' }, 403)
    await refused('wrong rpId', { rpId: 'evil.example' }, 403)
    await refused('bad signature', { badSignature: true }, 401)
    await refused('no user-present flag', { up: false }, 400)
    await refused('a creation response', { clientType: 'webauthn.create' }, 400)
    await refused('someone else\'s user handle', { userHandle: userHandleOf(newIdentity().did) }, 401)
    // the counter: after counter 2 (the good sign-in above and this one), 2 again and 1 are both refused
    assert.equal((await signIn(auth)).status, 200)
    await refused('a counter that stays', { counter: auth.counter }, 401)
    await refused('a counter that goes back', { counter: 1 }, 401)
    auth.counter = room.ctx.passkeys.find(auth.id).counter // the authenticator itself never went back: only the forged tries did
    assert.equal((await signIn(auth)).status, 200, 'and the real counter still works after the refusals')
    const o = await signInOptions(); assert.equal((await signIn(auth, {}, { opts: o })).status, 200)
    assert.equal((await signIn(auth, {}, { opts: o })).status, 401, 'a challenge cannot be used twice')
    const stale = await signInOptions(), real = room.ctx.challenges.now
    try { room.ctx.challenges.now = () => Date.now() + 121_000; assert.equal((await signIn(auth, {}, { opts: stale })).status, 401, 'two minutes and a second') } finally { room.ctx.challenges.now = real }
    assert.equal((await signIn(new FakeAuthenticator())).status, 401, 'a passkey the room does not know')
    const o2 = await signInOptions(), forged = auth.get({ challenge: o2.challenge, rpId, origin }); forged.signature = new FakeAuthenticator().get({ challenge: o2.challenge, rpId, origin }).signature
    assert.equal((await room.call('/api/session/passkey', { method: 'POST', body: forged })).status, 401, 'a signature from another key')
  })

  test('an authenticator that keeps no count (always 0) signs in again and again', async () => {
    const auth = await fresh('Ed25519', { counter: 0 })
    for (let i = 0; i < 3; i++) assert.equal((await signIn(auth, { counter: 0 })).status, 200, `sign-in ${i + 1}`)
  })

  test('the wrapped seed comes back only to the credential it was made with', async () => {
    const wa = fakeWrappedSeed(), wb = fakeWrappedSeed()
    const a = await fresh('ES256', { prf: true, wrappedSeed: wa }), b = await fresh('Ed25519', { prf: true, wrappedSeed: wb }), c = await fresh('ES256', { prf: false })
    const ra = await signIn(a), rb = await signIn(b), rc = await signIn(c)
    assert.deepEqual(ra.body.wrappedSeed, wa); assert.deepEqual(rb.body.wrappedSeed, wb); assert.equal(rc.body.wrappedSeed, null)
    assert.equal(room.ctx.passkeys.find(a.id).prf, true); assert.equal(room.ctx.passkeys.find(c.id).prf, false)
    // and nothing else the room answers carries it
    for (const path of ['/api/session', '/api/state', '/api/info', '/api/log', '/api/me/pass']) {
      const r = await room.call(path, { cookie: room.cookieOf(ra) }); assert.ok(!r.text.includes(wa.ct) && !r.text.includes(wb.ct), path)
    }
    const o = await registerOptions(); assert.ok(o.excludeCredentials.some((x) => x.id === a.id), 'the options exclude what the person already holds')
  })

  test('a person may hold several, and no more than ten', async () => {
    const b = await room.newMember(me.id, 'Person G')
    for (let i = 0; i < 10; i++) { const r = await register(new FakeAuthenticator(), {}, { cookie: b.cookie }); assert.equal(r.status, 200, `passkey ${i + 1}: ${r.text}`) }
    assert.equal((await register(new FakeAuthenticator(), {}, { cookie: b.cookie })).status, 409)
    assert.equal((await room.call('/api/session', { cookie: b.cookie })).body.passkeys, 10)
  })

  test('a passkey of someone who is no longer a member opens nothing', async () => {
    const b = await room.newMember(me.id, 'Person H'), auth = new FakeAuthenticator()
    assert.equal((await register(auth, {}, { cookie: b.cookie })).status, 200)
    room.ctx.log.state.participants.get(b.id.did).left = new Date().toISOString() // gone without the room clearing their passkeys: the check is made at sign-in too
    const r = await signIn(auth); assert.equal(r.status, 403); assert.equal(r.headers.get('set-cookie'), null)
  })

  test('a sign-in with a passkey ends in a session that survives a restart of the room\'s memory (it is in the database)', async () => {
    const auth = await fresh('ES256'), r = await signIn(auth), token = /=([^;]+)/.exec(r.headers.get('set-cookie'))[1]
    const { rows } = await room.ctx.db.query('select did from sessions where token_hash = $1', [createHash('sha256').update(token).digest('hex')])
    assert.equal(rows[0].did, me.id.did)
  })

  test('a member sees their own passkeys, with no key material, and can remove one: the passkey and the key it wrapped go together', async () => {
    const b = await room.newMember(me.id, 'Person I'), other = await room.newMember(me.id, 'Person J')
    const wrapped = fakeWrappedSeed(), keep = new FakeAuthenticator(), lost = new FakeAuthenticator(), foreign = new FakeAuthenticator()
    assert.equal((await register(keep, { prf: false }, { cookie: b.cookie })).status, 200)
    assert.equal((await register(lost, { prf: true, wrappedSeed: wrapped }, { cookie: b.cookie })).status, 200)
    assert.equal((await register(foreign, { prf: true, wrappedSeed: fakeWrappedSeed() }, { cookie: other.cookie })).status, 200)
    assert.equal((await room.call('/api/passkeys')).status, 401)
    const list = await room.call('/api/passkeys', { cookie: b.cookie })
    assert.equal(list.status, 200); assert.equal(list.body.passkeys.length, 2)
    for (const p of list.body.passkeys) { assert.deepEqual(Object.keys(p).sort(), ['canRestoreKey', 'createdAt', 'id', 'label', 'lastUsedAt']); assert.ok(Date.parse(p.createdAt) > 0) }
    assert.deepEqual(list.body.passkeys.map((p) => [p.id, p.canRestoreKey]).sort(), [[keep.id, false], [lost.id, true]].sort())
    assert.ok(!list.text.includes(wrapped.ct) && !list.text.includes(foreign.id), 'nothing wrapped, and nothing of anyone else\'s')
    await signIn(lost); assert.ok((await room.call('/api/passkeys', { cookie: b.cookie })).body.passkeys.find((p) => p.id === lost.id).lastUsedAt, 'last used is shown')
    // someone else's cannot be removed, nor an unknown one
    for (const id of [foreign.id, 'nothing-here', undefined]) assert.equal((await room.call('/api/passkey/delete', { method: 'POST', cookie: b.cookie, body: { id } })).status, 404)
    assert.equal(room.ctx.passkeys.count(other.id.did), 1, 'the other person\'s passkey is untouched')
    // remove their own
    assert.equal((await room.call('/api/passkey/delete', { method: 'POST', cookie: b.cookie, body: { id: lost.id } })).status, 200)
    assert.equal(room.ctx.passkeys.find(lost.id), null)
    const { rows } = await room.ctx.db.query('select wrapped_seed from passkeys where id = $1', [lost.id]); assert.equal(rows.length, 0, 'the wrapped key left the database with it')
    assert.equal((await signIn(lost)).status, 401, 'and it opens nothing now')
    assert.equal((await room.call('/api/passkeys', { cookie: b.cookie })).body.passkeys.length, 1)
    assert.equal((await room.call('/api/session', { cookie: b.cookie })).body.passkeys, 1)
    assert.equal((await room.call('/api/passkey/delete', { method: 'POST', cookie: b.cookie, body: { id: lost.id } })).status, 404, 'twice is not found')
    assert.equal((await room.call('/api/passkey/delete', { method: 'POST', cookie: b.cookie, body: { id: keep.id }, origin: null })).status, 403, 'the Origin check covers it')
    assert.ok(room.ctx.passkeys.find(keep.id))
  })

  test('RS256 is kept for authenticators that need it, with a 2048-bit floor', async () => {
    const k = await room.newMember(me.id, 'Person K')
    assert.equal((await register(new FakeAuthenticator({ kind: 'RS256' }), {}, { cookie: k.cookie })).status, 200)
    const { keyFrom } = await import('../src/server/passkey.js'), { generateKeyPairSync } = await import('node:crypto')
    const weak = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ type: 'spki', format: 'der' })
    assert.throws(() => keyFrom(weak, -257), /2048 to 8192/)
  })
})
