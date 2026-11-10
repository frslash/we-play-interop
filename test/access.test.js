// Members-only access: the gate in front of every route, sessions, and what leaving does to a cookie.
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { TYPES, signedDocument } from '../src/shared/types.js'
import { config as baseConfig } from '../src/server/config.js'
import { createApp } from '../src/server/index.js'
import { verifyDtgCredential } from '../src/shared/dtg.js'
import { createResolver } from '../src/server/resolver.js'
import { isGone, isOpen } from '../src/server/gate.js'
import { FakeAuthenticator, fakeWrappedSeed } from './helpers/passkey.js'
import { startRoom } from './helpers/room.js'

const HASH = 'a'.repeat(64)
// every kind of route a closed room has, each with the method it takes: all must answer 401 with no session
const GATED = [
  ['GET', '/api/info'], ['GET', '/api/state'], ['GET', '/api/steps'], ['GET', '/api/map'], ['GET', '/api/board'], ['GET', '/api/resources'],
  ['GET', '/api/log'], ['GET', '/api/log/' + HASH], ['GET', '/api/messages'], ['GET', '/api/messages?me=did:key:z6MkAnyone&forMe=1'], ['GET', '/api/wait?timeout=0'], ['GET', '/api/verify'],
  ['GET', '/api/credentials/x'], ['GET', '/api/participants/x'], ['GET', '/api/qr.svg?text=hello'], ['GET', '/api/events'], ['GET', '/api/shelf'], ['GET', '/api/sources'],
  ['GET', '/api/workshop'], ['GET', '/api/files/' + HASH], ['GET', '/api/photos/' + HASH], ['GET', '/api/pulls/1/diff'], ['GET', '/patches/' + HASH], ['GET', '/media/' + HASH],
  ['POST', '/mcp'], ['POST', '/api/draft'], ['POST', '/api/check'], ['POST', '/api/notebook'], ['POST', '/api/changes'], ['POST', '/api/media'], ['POST', '/api/drafts'],
  ['POST', '/api/for-you'], ['POST', '/api/never'], ['POST', '/api/wake'], ['POST', '/api/session/end'], ['POST', '/api/passkey/register/options'], ['POST', '/api/passkey/register'],
  ['GET', '/api/me/pass'], ['GET', '/api/nothing-here'],
]
// and the routes that are open to anyone
const OPEN = [
  ['GET', '/'], ['GET', '/index.html'], ['GET', '/i/abcdefghijklmnopqrstuv'], ['GET', '/app.js'], ['GET', '/style.css'], ['GET', '/shared/types.js'], ['GET', '/rules.json'], ['GET', '/healthz'],
  ['GET', '/.well-known/did.jsonl'], ['GET', '/api/session'], ['POST', '/api/session/key/challenge'], ['POST', '/api/session/passkey/options'], ['GET', '/api/invite/abcdefghijklmnopqrstuv'],
  ['POST', '/api/session/key'], ['POST', '/api/session/passkey'], ['POST', '/api/entries'], ['GET', '/mcp/a/not-a-real-token'], ['POST', '/mcp/a/not-a-real-token/call/say'],
]
const GONE = [['POST', '/trust-tasks'], ['POST', '/v1/trust-tasks'], ['GET', '/api/signin/config'], ['GET', '/api/signin'], ['GET', '/api/signin/session?key=x'], ['GET', '/x/member/sign-in/config'], ['GET', '/api/community'], ['POST', '/api/community/pass'], ['GET', '/.well-known/webfinger?resource=acct:room@x'], ['GET', '/ap/room'], ['POST', '/ap/room/inbox']]

describe('the gate', () => {
  let room, member
  before(async () => { room = await startRoom(); member = await room.firstMember() })
  after(() => room.stop())

  test('a room started the way production starts it answers 401 to every route on the closed list', async () => {
    for (const [method, path] of GATED) {
      const r = await room.call(path, { method, ...(method === 'POST' ? { body: {} } : {}) })
      assert.equal(r.status, 401, `${method} ${path} (no session) is refused`)
      assert.deepEqual(r.body, { error: 'Sign in first.' }, `${method} ${path} says to sign in`)
      assert.equal(r.headers.get('access-control-allow-origin'), null, `${method} ${path} gives no cross-origin permission`)
    }
  })

  test('a page path that is not open sends the browser to the front door', async () => {
    for (const path of ['/somewhere', '/j/abc', '/admin/x', '/some/deep/page.html']) {
      const r = await room.call(path)
      assert.equal(r.status, 303, path); assert.equal(r.headers.get('location'), '/')
    }
  })

  test('every route on the open list answers without a session (and none of them is a 401)', async () => {
    for (const [method, path] of OPEN) {
      const r = await room.call(path, { method, ...(method === 'POST' ? { body: {} } : {}) })
      assert.notEqual(r.status, 401, `${method} ${path} needs no session`)
      assert.notEqual(r.status, 303, `${method} ${path} is not sent to the front door`)
    }
    const page = await room.call('/'); assert.equal(page.status, 200); assert.match(page.text, /<html/i)
    assert.equal((await room.call('/i/abcdefghijklmnopqrstuv')).status, 200, 'an invite link is the page itself')
    const release = /\/r\/([0-9a-f]{12})\//.exec(page.text)?.[1]; assert.ok(release, 'the page names its release')
    assert.equal((await room.call(`/r/${release}/app.js`)).status, 200)
    assert.equal((await room.call('/api/session')).body.signedIn, false)
    assert.equal((await room.call('/healthz')).headers.get('access-control-allow-origin'), '*', 'the plain reads keep their open door')
  })

  test('a join without an invite reaches the room (the signature is the credential) and is refused there, not at the gate', async () => {
    const r = await room.say(newIdentity(), 'join', { name: 'Stranger' })
    assert.equal(r.status, 403); assert.match(r.body.payload.message, /invite/)
  })

  test('ActivityPub, the Trust Task door, wallet sign-in and /api/community are gone: 404 for everyone, signed in or not', async () => {
    for (const [method, path] of GONE) {
      for (const cookie of [undefined, member.cookie]) {
        const r = await room.call(path, { method, cookie, ...(method === 'POST' ? { body: {} } : {}) })
        assert.equal(r.status, 404, `${method} ${path} ${cookie ? 'with' : 'without'} a session`)
      }
    }
  })

  test('with a session every closed route is for the member, and none gives cross-origin permission', async () => {
    for (const path of ['/api/info', '/api/state', '/api/log', '/api/map', '/api/resources', '/api/verify', '/api/sources', '/api/workshop', '/api/steps']) {
      const r = await room.call(path, { cookie: member.cookie })
      assert.equal(r.status, 200, path); assert.equal(r.headers.get('access-control-allow-origin'), null, path)
    }
    const s = await room.call('/api/session', { cookie: member.cookie })
    assert.equal(s.body.signedIn, true); assert.equal(s.body.did, member.id.did); assert.equal(s.body.name, 'Person A'); assert.equal(s.body.passkeys, 0)
    assert.equal(s.body.room.name, room.config.workspaceName); assert.ok(Date.parse(s.body.expiresAt) > Date.now() + 29 * 86400000)
  })

  test('the session cookie is exactly the contract, and the room keeps only its hash', async () => {
    const r = await room.signInWithKey(member.id), set = r.headers.get('set-cookie')
    assert.match(set, /^inwove_session=[A-Za-z0-9_-]{43}; HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=2592000$/)
    const token = /inwove_session=([^;]+)/.exec(set)[1]
    const { rows } = await room.ctx.db.query('select token_hash, did from sessions')
    assert.ok(rows.length >= 1); assert.ok(rows.every((x) => x.token_hash !== token && /^[0-9a-f]{64}$/.test(x.token_hash)), 'a table that holds a hash, never the cookie')
    assert.deepEqual(r.body, { did: member.id.did, name: 'Person A' })
  })

  test('the agent routes keep their token: a real link works with no session, and sets an agent viewer', async () => {
    const delegate = newIdentity()
    assert.equal((await room.linkGithub(member)).status, 201)
    const made = await room.say(member.id, 'host', { label: 'My agent', repos: ['acme/app'] })
    assert.equal(made.status, 201); const link = new URL(made.body.hosted.connector).pathname
    const r = await room.call(link); assert.equal(r.status, 200); assert.notEqual(r.status, 401)
    void delegate
  })

  test('a cookie from someone who then leaves stops working, and their sessions are deleted', async () => {
    const b = await room.newMember(member.id, 'Person B')
    assert.equal((await room.call('/api/state', { cookie: b.cookie })).status, 200)
    assert.equal(room.ctx.sessions.count(b.id.did), 1)
    assert.equal((await room.say(b.id, 'leave', {})).status, 201)
    const after = await room.call('/api/state', { cookie: b.cookie })
    assert.equal(after.status, 401); assert.equal(room.ctx.sessions.count(b.id.did), 0)
    assert.equal((await room.signInWithKey(b.id)).status, 403, 'and they cannot sign in again with their key')
    assert.equal((await room.call('/api/state', { cookie: member.cookie })).status, 200, 'other members are untouched')
  })

  test('a person who leaves loses their passkeys too', async () => {
    const b = await room.newMember(member.id, 'Person C'), auth = new FakeAuthenticator()
    const opts = (await room.call('/api/passkey/register/options', { method: 'POST', cookie: b.cookie })).body
    const reg = await room.call('/api/passkey/register', { method: 'POST', cookie: b.cookie, body: auth.create({ challenge: opts.challenge, rpId: opts.rp.id, origin: room.config.publicUrl, prf: true, wrappedSeed: fakeWrappedSeed() }) })
    assert.equal(reg.status, 200); assert.equal(room.ctx.passkeys.count(b.id.did), 1)
    await room.say(b.id, 'leave', {})
    assert.equal(room.ctx.passkeys.count(b.id.did), 0)
    const o = (await room.call('/api/session/passkey/options', { method: 'POST' })).body
    assert.equal((await room.call('/api/session/passkey', { method: 'POST', body: auth.get({ challenge: o.challenge, rpId: o.rpId, origin: room.config.publicUrl, userHandle: opts.user.id }) })).status, 401)
  })

  test('an expired session stops working (and is deleted on the lookup)', async () => {
    const cookie = member.cookie, token = /=(.+)$/.exec(cookie)[1]
    assert.equal((await room.call('/api/state', { cookie })).status, 200)
    const real = room.ctx.sessions.now
    try {
      room.ctx.sessions.now = () => Date.now() + 31 * 86400000
      assert.equal((await room.call('/api/state', { cookie })).status, 401, 'thirty-one days on')
    } finally { room.ctx.sessions.now = real }
    assert.equal(room.ctx.sessions.lookup(token), null, 'it was deleted, not just skipped')
    member.cookie = (await room.signInWithKey(member.id)).headers.get('set-cookie').split(';')[0]
  })

  test('signing out ends the person\'s sessions and clears the cookie', async () => {
    const b = await room.newMember(member.id, 'Person D')
    const out = await room.call('/api/session/end', { method: 'POST', cookie: b.cookie })
    assert.equal(out.status, 200); assert.match(out.headers.get('set-cookie'), /inwove_session=; .*Max-Age=0/)
    assert.equal((await room.call('/api/state', { cookie: b.cookie })).status, 401)
  })

  test('a cookie that is made up, malformed or someone else\'s name for nothing is just "not signed in"', async () => {
    for (const cookie of ['inwove_session=' + 'A'.repeat(43), 'inwove_session=short', 'inwove_session=', 'other=1', 'inwove_session=' + 'A'.repeat(43) + 'x']) {
      assert.equal((await room.call('/api/state', { cookie })).status, 401, cookie)
    }
  })

  test('/api/messages?me= no longer lets a caller name someone else', async () => {
    const b = await room.newMember(member.id, 'Person E'), c = await room.newMember(member.id, 'Person F')
    await room.say(b.id, 'note', { kind: 'message', text: 'Person A, please look at this.' })
    const own = (await room.call('/api/messages?forMe=1', { cookie: member.cookie })).body.items
    assert.ok(own.some((m) => /look at this/.test(m.text)), 'A sees the line meant for A')
    const spoof = (await room.call(`/api/messages?forMe=1&me=${encodeURIComponent(member.id.did)}`, { cookie: c.cookie })).body.items
    assert.ok(!spoof.some((m) => /look at this/.test(m.text)), 'F, asking as A, still gets F\'s own')
    const plain = (await room.call(`/api/messages?me=${encodeURIComponent(member.id.did)}`, { cookie: c.cookie })).body.items
    assert.ok(plain.every((m) => !m.forYou || m.forYou !== 'mention'), 'and nothing is marked as being for A')
  })

  test('the membership pass is a DTG membership credential the room signs, and the room\'s own check accepts it', async () => {
    assert.equal((await room.call('/api/me/pass')).status, 401)
    const r = await room.call('/api/me/pass', { cookie: member.cookie })
    assert.equal(r.status, 200); assert.equal(r.headers.get('content-disposition'), 'attachment; filename="inwove-pass.json"')
    const vc = r.body
    assert.deepEqual(vc['@context'], ['https://www.w3.org/ns/credentials/v2', 'https://registry.trustoverip.org/dtg/context/v1'])
    assert.deepEqual(vc.type, ['VerifiableCredential', 'DTGCredential', 'MembershipCredential']); assert.match(vc.id, /^urn:uuid:/)
    assert.equal(vc.issuer, room.ctx.join.room.did); assert.equal(vc.issuerScope, 'public'); assert.equal(vc.credentialSubject.id, member.id.did); assert.equal(vc.credentialStatus, undefined)
    assert.equal(vc.proof.type, 'DataIntegrityProof'); assert.equal(vc.proof.cryptosuite, 'eddsa-jcs-2022'); assert.equal(vc.proof.proofPurpose, 'assertionMethod'); assert.equal(vc.proof.verificationMethod, room.ctx.join.room.verificationMethod)
    const days = (Date.parse(vc.validUntil) - Date.parse(vc.validFrom)) / 86400000; assert.equal(days, 90)
    const checked = await verifyDtgCredential(vc, { keyFor: createResolver().keyFor })
    assert.equal(checked.ok, true, JSON.stringify(checked)); assert.equal(checked.kind, 'membership'); assert.equal(checked.checked, true); assert.equal(checked.context.current, true)
    vc.credentialSubject.id = newIdentity().did
    assert.equal((await verifyDtgCredential(vc, { keyFor: createResolver().keyFor })).ok, false, 'a pass for someone else does not verify')
  })

  test('the open list and the gone list are written once, in gate.js', () => {
    assert.equal(isOpen('GET', '/api/state'), false); assert.equal(isOpen('GET', '/api/session'), true); assert.equal(isOpen('POST', '/api/session'), false)
    assert.equal(isOpen('GET', '/api/invite/abc'), true); assert.equal(isOpen('GET', '/api/invite/a/b'), false)
    assert.equal(isOpen('GET', '/ap/room'), false); assert.equal(isOpen('GET', '/ap/room', { activitypub: true }), true)
    assert.equal(isGone('/ap/room'), true); assert.equal(isGone('/ap/room', { activitypub: true }), false)
  })
})

describe('openRoom is for tests only', () => {
  test('production config never opens the room: not from a config field, not from the environment', async () => {
    assert.equal(baseConfig.activitypub, false, 'ActivityPub is off unless ACTIVITYPUB=1')
    assert.equal(baseConfig.checkEveryMinutes, 0, 'the room check is off unless ROOM_CHECK_MINUTES says so')
    process.env.OPEN_ROOM = '1'; process.env.OPENROOM = '1'
    let room
    try {
      room = await startRoom({ extra: { openRoom: true, open: true } })
      assert.equal((await room.call('/api/state')).status, 401)
      assert.equal((await room.say(newIdentity(), 'join', { name: 'Someone' })).status, 403, 'and a join still needs an invite')
    } finally { delete process.env.OPEN_ROOM; delete process.env.OPENROOM; await room?.stop() }
  })

  test('createApp(config, { openRoom: true }) has no gate, no invites, and every request is a person with no DID', async () => {
    const room = await startRoom({ options: { openRoom: true } })
    try {
      assert.equal((await room.call('/api/state')).status, 200)
      assert.equal((await room.say(newIdentity(), 'join', { name: 'Open Person' })).status, 201)
      assert.equal(await room.ctx.ensureFirstInvite(), null, 'an open room makes no first invite')
      assert.equal((await room.call('/trust-tasks', { method: 'POST', body: {} })).status, 404, 'what went dark stays dark')
      assert.equal((await room.call('/api/session')).body.signedIn, false, 'there is no session to be in')
    } finally { await room.stop() }
  })
})

describe('what the room prints and answers never carries a secret', () => {
  test('a cookie, a challenge, an invite code, a wrapped seed and a key planted in a whole sign-up never reach the output', async () => {
    const out = []
    const grab = (orig) => (chunk, ...rest) => { out.push(String(chunk)); return orig.call(process.stdout, chunk, ...rest) }
    const o1 = process.stdout.write, o2 = process.stderr.write
    process.stdout.write = grab(o1); process.stderr.write = (chunk, ...rest) => { out.push(String(chunk)); return o2.call(process.stderr, chunk, ...rest) }
    const room = await startRoom(), secrets = []
    const answers = []
    try {
      const a = await room.firstMember()
      secrets.push(a.code, a.cookie.split('=')[1], a.id.seedHex)
      const code = await room.invite(a.id); secrets.push(code)
      const bad = await room.say(newIdentity(), 'join', { name: 'X', invite: code + 'z' }); answers.push(bad.text) // a wrong code
      const reused = newIdentity(); await room.say(reused, 'join', { name: 'Y', invite: code }); const again = await room.say(newIdentity(), 'join', { name: 'Z', invite: code }); answers.push(again.text)
      const { body: ch } = await room.call('/api/session/key/challenge', { method: 'POST' }); secrets.push(ch.challenge)
      const replay = await room.call('/api/session/key', { method: 'POST', body: { document: signedDocument(a.id, { type: TYPES.sessionKey, payload: { challenge: ch.challenge } }) } })
      const again2 = await room.call('/api/session/key', { method: 'POST', body: { document: signedDocument(a.id, { type: TYPES.sessionKey, payload: { challenge: ch.challenge } }) } })
      answers.push(again2.text); assert.equal(replay.status, 200); assert.equal(again2.status, 400, 'a challenge is single use')
      const auth = new FakeAuthenticator(), wrapped = fakeWrappedSeed(); secrets.push(wrapped.iv, wrapped.ct)
      const opts = (await room.call('/api/passkey/register/options', { method: 'POST', cookie: a.cookie })).body; secrets.push(opts.challenge)
      const badReg = await room.call('/api/passkey/register', { method: 'POST', cookie: a.cookie, body: auth.create({ challenge: opts.challenge, rpId: 'elsewhere.example', origin: room.config.publicUrl, prf: true, wrappedSeed: wrapped }) }); answers.push(badReg.text)
      const opts2 = (await room.call('/api/passkey/register/options', { method: 'POST', cookie: a.cookie })).body; secrets.push(opts2.challenge)
      assert.equal((await room.call('/api/passkey/register', { method: 'POST', cookie: a.cookie, body: auth.create({ challenge: opts2.challenge, rpId: opts2.rp.id, origin: room.config.publicUrl, prf: true, wrappedSeed: wrapped }) })).status, 200)
      const o = (await room.call('/api/session/passkey/options', { method: 'POST' })).body; secrets.push(o.challenge)
      const bad2 = await room.call('/api/session/passkey', { method: 'POST', body: auth.get({ challenge: o.challenge, rpId: o.rpId, origin: room.config.publicUrl, badSignature: true }) }); answers.push(bad2.text)
      const o2b = (await room.call('/api/session/passkey/options', { method: 'POST' })).body; secrets.push(o2b.challenge)
      const ok = await room.call('/api/session/passkey', { method: 'POST', body: auth.get({ challenge: o2b.challenge, rpId: o2b.rpId, origin: room.config.publicUrl }) })
      assert.equal(ok.status, 200); assert.deepEqual(ok.body.wrappedSeed, wrapped); secrets.push(ok.headers.get('set-cookie').match(/=([^;]+)/)[1])
      await room.call('/api/invite/' + code, {}); await room.call('/api/session', { cookie: a.cookie })
    } finally { process.stdout.write = o1; process.stderr.write = o2; await room.stop() }
    const seen = out.join('\n')
    for (const s of secrets) { assert.ok(s.length >= 16); assert.ok(!seen.includes(s), 'the server\'s output holds a secret it must not'); for (const body of answers) assert.ok(!body.includes(s), 'an answer to a refused call echoed a secret') }
  })
})
