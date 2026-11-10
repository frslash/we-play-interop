// The community whose membership pass the room takes (src/server/community.js): COMMUNITY_DID, GET /api/community,
// POST /api/community/pass and the `community` entry of /api/info (the room itself no longer serves these: see start() below). The community is played by the stand-in in
// test/support/standin-community.js, which answers the way OpenVTC's vtc-service does (each shape cites its file
// there). This shows the room's side holds together; test/live/community-live.test.js is the check against a real one.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { config as baseConfig } from '../src/server/config.js'
import { Community, MAX_CHECKS_PER_MINUTE } from '../src/server/community.js'
import { createResolver } from '../src/server/resolver.js'
import { PASS_CHECK_TYPE, passCheck } from '../src/shared/dtg.js'
import { didKeyOnly } from '../src/shared/chain.js'
import { newIdentity } from '../src/shared/did.js'
import { sign } from '../src/shared/proof.js'
import { ERROR_PREFIX, signedTask, verifyTask } from '../src/shared/trusttask.js'
import { standInCommunity } from './support/standin-community.js'
import { startCommunity } from './helpers/community-room.js'

const settings = (dir, extra) => ({ ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, publicUrl: '', checkEveryMinutes: 0, boardDataUrl: 'data:application/json,{}', llm: { ...baseConfig.llm, apiKey: '' }, ...extra })
const start = startCommunity
const getJson = async (url) => (await fetch(url)).json()
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) })

describe('no community is set', () => {
  let ctx, base, dir
  before(async () => { dir = mkdtempSync(join(tmpdir(), 'wpi-community-off-')); ({ ctx, base } = await start(settings(dir, { communityDid: '' }))) })
  after(async () => { await ctx.stop(); rmSync(dir, { recursive: true, force: true }) })

  test('the room says so, and takes no pass', async () => {
    assert.deepEqual(await getJson(`${base}/api/community`), { set: false, words: 'No community is set for this room, so it takes no membership pass.' })
    assert.deepEqual((await getJson(`${base}/api/info`)).community, { set: false })
    assert.deepEqual((await getJson(`${base}/api/state`)).community, { set: false }, 'the page reads it from here')
    const holder = newIdentity()
    const res = await post(`${base}/api/community/pass`, passCheck(holder, { room: ctx.identity.did, membership: {} }))
    assert.equal(res.status, 422) // the https binding's table: unsupportedType has no status of its own
    const reply = await res.json()
    assert.ok(reply.type.startsWith(ERROR_PREFIX)); assert.equal(reply.payload.code, 'unsupportedType'); assert.match(reply.payload.message, /no community is set/)
  })
})

test('a COMMUNITY_DID that is not a did:webvh is said out loud, never silently off', async () => {
  const room = newIdentity()
  for (const communityDid of ['https://vtc.example', 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH', 'did:webvh:no spaces:vtc.example']) {
    const community = new Community({ config: { communityDid }, resolver: createResolver(), identity: room, room: () => room })
    assert.equal(community.set, false)
    assert.deepEqual(community.summary(), { set: false, problem: 'COMMUNITY_DID is set but is not a did:webvh, so no community is in use' })
    assert.match((await community.describe()).problem, /not a did:webvh/)
  }
})

test('only https addresses are read from a community\'s DID document, and a profile for another DID gives no name', async () => {
  const room = newIdentity(), did = 'did:webvh:QmExampleExampleExampleExampleExampleExampleEx:vtc.example'
  const service = [{ id: `${did}#sign-in-portal`, type: 'SignInPortal', serviceEndpoint: 'javascript:alert(1)' }, { id: `${did}#vtc-rest`, type: 'VTCRest', serviceEndpoint: 'http://vtc.example/v1' }, { id: `${did}#trust-tasks`, type: 'TrustTaskHTTPS', serviceEndpoint: 'https://vtc.example/v1' }]
  const asked = []
  const fetch = async (url) => { asked.push(url); return url.endsWith('/public-profile') ? new Response(JSON.stringify({ communityDid: 'did:webvh:QmSomeoneElse:other.example', name: 'Someone else' }), { headers: { 'content-type': 'application/json' } }) : new Response('', { status: 404 }) }
  const community = new Community({ config: { communityDid: did }, resolver: { resolve: async () => ({ id: did, service }), keyFor: async () => null }, identity: room, room: () => room, fetch })
  const seen = await community.describe()
  assert.deepEqual(seen.services, { trustTasks: 'https://vtc.example/v1', signInPortal: null, rest: null, statusLists: null })
  assert.equal(seen.joinPage, null); assert.equal(seen.name, null)
  assert.deepEqual(seen.profile, { url: 'https://vtc.example/v1/community/public-profile', answers: false, why: 'the profile there is for another DID' })
  assert.ok(asked.every((u) => u.startsWith('https://vtc.example/v1/')), 'nothing but the https base was asked')
  // an older document: VTCRest is the bare public URL, and the API is under /v1 (vta-sdk/src/did_templates/tests.rs)
  const old = new Community({ config: { communityDid: did }, resolver: { resolve: async () => ({ id: did, service: [{ type: 'VTCRest', serviceEndpoint: 'https://first.example' }] }), keyFor: async () => null }, identity: room, room: () => room, fetch: async (url) => new Response(JSON.stringify({ communityDid: did, name: '  An older community  ' }), { status: url.includes('/v1/') ? 200 : 405, headers: { 'content-type': 'application/json' } }) })
  const got = await old.describe()
  assert.equal(got.name, 'An older community'); assert.equal(got.profile.url, 'https://first.example/v1/community/public-profile')
})

describe('the room takes a community\'s membership pass', () => {
  let c, ctx, base, dir, room
  const member = newIdentity(new Uint8Array(32).fill(21)), other = newIdentity(new Uint8Array(32).fill(22))
  const ask = async (doc) => { const res = await post(`${base}/api/community/pass`, doc); return { status: res.status, headers: res.headers, reply: await res.json() } }
  const show = (holder, membership, fields) => ask(signedTask(holder, { type: PASS_CHECK_TYPE, recipient: room, payload: { membership }, ...fields }))

  before(async () => {
    c = await standInCommunity()
    dir = mkdtempSync(join(tmpdir(), 'wpi-community-'))
    ;({ ctx, base } = await start(settings(dir, { communityDid: c.did }), { resolver: c.resolver, communityFetch: c.fetch }))
    ctx.community.lists.ttlMs = 0 // every check reads the stand-in's list afresh (the half-minute reuse has its own test in status-list.test.js)
    ctx.community.lists.failTtlMs = 0
    room = ctx.join.did
  })
  after(async () => { await ctx.stop(); await c.close(); rmSync(dir, { recursive: true, force: true }) })

  test('GET /api/community: who it is, where to join, and that each part answers', async () => {
    const got = await getJson(`${base}/api/community`)
    assert.equal(got.set, true); assert.equal(got.did, c.did); assert.equal(got.resolves, true)
    assert.equal(got.name, 'Stand-in community', 'from its public profile')
    assert.deepEqual(got.services, { trustTasks: 'https://vtc.example/v1', signInPortal: 'https://vtc.example/members/', rest: 'https://vtc.example/v1', statusLists: 'https://vtc.example/v1/status-lists' }, 'read from its DID document by type')
    assert.deepEqual(got.profile, { url: 'https://vtc.example/v1/community/public-profile', answers: true })
    assert.deepEqual(got.joinPage, { url: 'https://vtc.example/members/?join', answers: true })
    assert.deepEqual(got.didQr, { url: 'https://vtc.example/v1/community/did-qr.svg', answers: true, local: `/api/qr.svg?text=${encodeURIComponent(c.did)}` })
    assert.deepEqual(got.statusList, { url: 'https://vtc.example/v1/status-lists/revocation', answers: true, verifies: true })
    assert.deepEqual([got.pass.check, got.pass.type, got.pass.recipient], ['/api/community/pass', 'urn:we-play-interop:tasks:spec:community:pass:check:0.1', room])
    const hits = c.hits.length
    await getJson(`${base}/api/community`)
    assert.equal(c.hits.length, hits, 'a second look within the minute asks the community nothing')
  })

  test('a current member\'s pass is accepted, in a signed answer', async () => {
    const { credential } = c.issueVmc(member.did, { personhood: true })
    assert.ok(Array.isArray(credential.proof) && credential.proof.length === 2, 'as a community with a post-quantum key signs: one proof per key')
    const { status, reply } = await show(member, credential)
    assert.equal(status, 200)
    assert.equal(reply.type, `${PASS_CHECK_TYPE}#response`); assert.equal(reply.issuer, room); assert.equal(reply.recipient, member.did)
    const signed = await verifyTask(reply, { keyFor: didKeyOnly, me: member.did, purposes: ['authentication'] })
    assert.deepEqual(signed, { ok: true, signer: room }, 'the answer is the room\'s own signed statement')
    const p = reply.payload
    assert.equal(p.member, true); assert.equal(p.community, c.did); assert.equal(p.subject, member.did); assert.equal(p.status, 'good')
    assert.equal(p.personhood, true); assert.deepEqual(p.context, { name: 'registry-v1', current: true }); assert.equal(p.validUntil, credential.validUntil)
    assert.equal(p.lists[0].purpose, 'revocation'); assert.equal(p.lists[0].cached, false)
    assert.match(p.notes.join(' '), /a proof this room cannot check \(mldsa44-jcs-2024\)/, 'the second proof is named as not checked, not passed off as checked')
    // the same pass as its JSON text and as base64url, the two forms the room host takes
    assert.equal((await show(member, JSON.stringify(credential))).reply.payload.member, true)
    assert.equal((await show(member, Buffer.from(JSON.stringify(credential)).toString('base64url'))).reply.payload.member, true)
  })

  test('it is refused once the community sets its bit', async () => {
    const { credential, slot } = c.issueVmc(member.did)
    assert.equal((await show(member, credential)).reply.payload.member, true)
    c.revoke(slot)
    const { status, reply } = await show(member, credential)
    assert.equal(status, 200)
    assert.deepEqual([reply.payload.member, reply.payload.problem, reply.payload.reason, reply.payload.status], [false, 'revoked', 'the community has revoked this pass', 'revoked'])
    const second = c.issueVmc(member.did)
    assert.equal((await show(member, second.credential)).reply.payload.member, true, 'another pass on the same list is untouched')
  })

  test('fail closed: when the community\'s list cannot be read the pass is "not confirmed", and the answer says so', async () => {
    const { credential } = c.issueVmc(member.did)
    c.state.list = (_p, res) => { res.writeHead(503); res.end() }
    const down = (await show(member, credential)).reply.payload
    assert.deepEqual([down.member, down.problem, down.status], [false, 'status-unknown', 'unknown'])
    assert.match(down.reason, /could not be read \(the list's address answered 503\), so this pass is not confirmed/)
    c.state.list = (p) => { const l = c.listCredential(p); l.credentialSubject.encodedList = 'uH4sIAAAAAAAAA-3BMQEAAADCoPVPbQwfoAAAAAAAAAAAAAAAAAAAAIC3AYbSVKsAQAAA'; return l } // a list changed after the community signed it
    const forged = (await show(member, credential)).reply.payload
    assert.deepEqual([forged.member, forged.problem], [false, 'status-unknown']); assert.match(forged.reason, /signature does not hold/)
    c.state.list = null
    assert.equal((await show(member, credential)).reply.payload.member, true)
  })

  test('every "no" says why', async () => {
    const mine = c.issueVmc(member.did).credential
    const no = async (holder, membership, problem, re) => { const { status, reply } = await show(holder, membership); assert.equal(status, 200); assert.equal(reply.payload.member, false); assert.equal(reply.payload.problem, problem, reply.payload.reason); assert.match(reply.payload.reason, re) }
    await no(other, mine, 'presenter', /about someone else/) // a pass someone else is showing
    const changed = structuredClone(mine); changed.credentialSubject.id = other.did
    await no(other, changed, 'proof', /signature does not verify/) // rewritten to be about them
    // another community's pass, perfectly signed
    const elsewhere = await standInCommunity({ host: 'other.example', seed: new Uint8Array(32).fill(72) })
    try { await no(member, elsewhere.issueVmc(member.did).credential, 'issuer', /not issued by the community this room names/) } finally { await elsewhere.close() }
    // the member's own half of the pair: issued by the member, about the community (OpenVTC docs/03-vtc/credentials.md)
    const half = sign({ '@context': mine['@context'], type: ['VerifiableCredential', 'DTGCredential', 'MembershipCredential'], issuer: member.did, issuerScope: 'directed', validFrom: '2026-11-09T00:00:00Z', credentialSubject: { id: c.did, digestMultibase: 'zQmExample' } }, { seed: member.seed, verificationMethod: member.verificationMethod, created: '2026-11-09T00:00:00Z', proofPurpose: 'assertionMethod' })
    await no(member, half, 'issuer', /your own half of the pair/)
    await no(member, c.issueVmc(member.did, { change: (v) => ({ ...v, validFrom: '2026-01-01T00:00:00Z', validUntil: '2026-01-31T00:00:00Z' }) }).credential, 'dates', /ran out on 2026-01-31/)
    await no(member, c.issueVmc(member.did, { change: (v) => { delete v.validUntil; return v } }).credential, 'dates', /says when it ends/)
    await no(member, c.issueVmc(member.did, { change: (v) => ({ ...v, type: ['VerifiableCredential', 'DTGCredential', 'InvitationCredential'] }) }).credential, 'kind', /an invitation credential; a membership credential is needed/)
    await no(member, c.issueVmc(member.did, { change: (v) => ({ ...v, '@context': [v['@context'][0], 'https://openvtc.org/contexts/dtg-membership-v1.jsonld'] }) }).credential, 'shape', /the DTG context second/)
    await no(member, 'not a credential', 'shape', /payload\.membership/)
    await no(member, undefined, 'shape', /payload\.membership/)
    // a pass with no status entry holds until it runs out, and the answer says that
    const { reply } = await show(member, c.issueVmc(member.did, { status: false }).credential)
    assert.deepEqual([reply.payload.member, reply.payload.status], [true, 'none']); assert.match(reply.payload.notes.join(' '), /names no revocation list/)
  })

  test('a request that is not a fresh, signed document for this room is refused, with the shared codes', async () => {
    const mine = c.issueVmc(member.did).credential
    const refused = async (doc, status, code, re) => { const r = await ask(doc); assert.equal(r.status, status, JSON.stringify(r.reply.payload)); assert.ok(r.reply.type.startsWith(ERROR_PREFIX)); assert.equal(r.reply.payload.code, code); if (re) assert.match(r.reply.payload.message, re); return r }
    const good = () => signedTask(member, { type: PASS_CHECK_TYPE, recipient: room, payload: { membership: mine } })
    await refused('{ not json', 400, 'malformedRequest', /as JSON/)
    await refused(signedTask(member, { type: 'https://trusttasks.org/spec/credential-exchange/present/0.1', recipient: room, payload: { vp_token: {} } }), 422, 'unsupportedType', /community:pass:check:0\.1/)
    await refused(signedTask(member, { type: PASS_CHECK_TYPE, recipient: other.did, payload: { membership: mine } }), 422, 'wrongRecipient')
    await refused(signedTask(member, { type: PASS_CHECK_TYPE, payload: { membership: mine } }), 400, 'malformedRequest', /recipient/) // no recipient: it was never good
    await refused(signedTask(member, { type: PASS_CHECK_TYPE, recipient: room, payload: { membership: mine }, issuedAt: new Date(Date.now() - 3_600_000).toISOString().replace(/\.\d+Z$/, 'Z') }), 422, 'expired', /older than ten minutes/)
    const { proof: _p, ...unsigned } = good()
    await refused(unsigned, 422, 'proofRequired')
    await refused({ ...good(), payload: { membership: mine, extra: 1 } }, 422, 'proofInvalid', /does not verify/) // changed after signing
    await refused({ ...signedTask(other, { type: PASS_CHECK_TYPE, recipient: room, payload: { membership: mine } }), issuer: member.did }, 422, 'proofInvalid') // signed by someone else, naming the member
    await refused(signedTask(member, { type: PASS_CHECK_TYPE, recipient: room, payload: { membership: mine } }, { purpose: 'assertionMethod' }), 422, 'proofInvalid', /authentication/)
    const r = await refused('{ not json', 400, 'malformedRequest')
    assert.equal((await verifyTask(r.reply, { keyFor: didKeyOnly, requireRecipient: false })).ok, true, 'a refusal is signed by the room too')
    assert.equal((await fetch(`${base}/api/community/pass`)).status, 405)
    assert.equal((await post(`${base}/api/community`, {})).status, 405)
    // a body over the room's 64 KB cap: the room stops keeping it and answers 413 (the connection is not cut before the answer)
    const big = await post(`${base}/api/community/pass`, 'x'.repeat(70_000)).then((res) => res.status, () => 'closed')
    assert.equal(big, 413)
  })

  test('the check changes nothing in the room, and /api/info counts outcomes without naming anyone', async () => {
    const before = ctx.log.entries.length
    const { credential } = c.issueVmc(member.did)
    assert.equal((await show(member, credential)).reply.payload.member, true)
    assert.equal(ctx.log.entries.length, before, 'no line in the room\'s log')
    assert.equal(ctx.log.state.participants.has(member.did), false, 'showing a pass is not joining the room')
    const info = (await getJson(`${base}/api/info`)).community
    assert.equal(info.set, true)
    assert.deepEqual(info.answered, { did: true, profile: true, joinPage: true, didQr: true, statusList: true })
    assert.ok(info.passes.asked >= 20); assert.ok(info.passes.current >= 6)
    for (const reason of ['revoked', 'status-unknown', 'presenter', 'issuer', 'proof', 'dates', 'kind', 'shape']) assert.ok(info.passes.notCurrent[reason] >= 1, `${reason} is counted`)
    for (const code of ['malformedRequest', 'unsupportedType', 'wrongRecipient', 'expired', 'proofRequired', 'proofInvalid']) assert.ok(info.passes.refused[code] >= 1, `${code} is counted`)
    assert.ok(info.statusLists.fetched >= 6); assert.ok(info.statusLists.failed.fetch >= 1); assert.ok(info.statusLists.failed.proof >= 1)
    const text = JSON.stringify(info)
    assert.ok(!text.includes('did:') && !text.includes('vtc.example'), 'counts and reasons only: no DID, no address')
  })

  test('when the community is down the room says which parts do not answer', async () => {
    ctx.community.seen = null; c.state.down = true
    try {
      const got = await getJson(`${base}/api/community`)
      assert.equal(got.resolves, true, 'its DID was read a moment ago and is still held')
      assert.equal(got.name, null)
      assert.deepEqual([got.profile.answers, got.joinPage.answers, got.didQr.answers, got.statusList.answers, got.statusList.verifies], [false, false, false, false, false])
      assert.match(got.profile.why, /answered 503/)
      assert.deepEqual((await getJson(`${base}/api/info`)).community.answered, { did: true, profile: false, joinPage: false, didQr: false, statusList: false })
    } finally { c.state.down = false; ctx.community.seen = null }
  })

  test('checks are capped, so the room cannot be used to send requests for someone else', async () => {
    ctx.community.recent = Array(MAX_CHECKS_PER_MINUTE).fill(Date.now())
    const r = await show(member, c.issueVmc(member.did).credential)
    assert.equal(r.status, 503); assert.equal(r.reply.payload.code, 'unavailable'); assert.equal(r.headers.get('retry-after'), '60')
    ctx.community.recent = []
    assert.equal((await show(member, c.issueVmc(member.did).credential)).status, 200)
  })

  test('unsigned posts take no place in the budget, so they cannot shut a real holder out', async () => {
    ctx.community.recent = []
    const unsigned = { id: 'urn:uuid:00000000-0000-4000-8000-000000000000', type: PASS_CHECK_TYPE, recipient: room, issuer: member.did, issuedAt: new Date().toISOString(), payload: { membership: {} } }
    for (let i = 0; i < MAX_CHECKS_PER_MINUTE + 5; i++) assert.notEqual((await ask(unsigned)).status, 200)
    assert.equal(ctx.community.recent.length, 0, 'none of them counted')
    assert.equal((await show(member, c.issueVmc(member.did).credential)).status, 200)
    assert.equal(ctx.community.recent.length, 1)
  })
})
