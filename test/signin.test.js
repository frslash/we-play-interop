// Wallet sign-in (src/server/signin.js, src/shared/signin.js): the room's side of the auth/oob exchange.
// The first test is OpenVTC's own worked exchange (vti-oob-server/tests/flow.rs at the commit the room builds from),
// step for step, with the same documents, the same DIDs and the same things checked after each step. The refusals
// after it are the ones in that file and in vtc-service/tests/it/member_portal_oob.rs. Unlike upstream's test host,
// which trusts a document's issuer, every signature here is real and verified: the browser's key, the wallet's
// throwaway key, the person's DID (a did:webvh through a stub resolver, and a did:key) and the room's attestations.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { keyFromDidDocument } from '../src/shared/chain.js'
import { ed25519Multikey, newIdentity } from '../src/shared/did.js'
import {
  AMR, CLAIM_SECONDS, DECISION_SECONDS, DEFAULT_LINK_HOST, MAX_LINK_BYTES, OOB, SIGN_IN_FLOW, checkLinkHost, contextDigest, encodeFrom, epochOf, isEd25519DidKey, linkRoom,
  newSessionKey, readTriggerLink, rfc3339, sameContextDigest, signWith, starter, triggerLink,
} from '../src/shared/signin.js'
import { instant, multihashOf, signedTask, taskDocument, typeUri, verifyTask } from '../src/shared/trusttask.js'
import { fromBase58btc } from '../src/shared/crypto.js'
import { config as baseConfig } from '../src/server/config.js'
import { createApp } from '../src/server/index.js'
import { createResolver } from '../src/server/resolver.js'
import { roomDidDocument, signInPortalEndpoint } from '../src/server/roomdid.js'
import { ENDED_RETENTION_SECONDS, MAX_PENDING_PER_ADDRESS, MAX_POLLS_PER_ADDRESS, SESSION_MAX_SECONDS, SIGNED, SignIn, browserAndOs, registerSignIn, sameNetwork } from '../src/server/signin.js'
import { realDoor, serve, standInDoor } from './helpers/door.js'
import { playSignIn } from './helpers/play.js'
import { testWallet } from './helpers/wallet.js'

// the names upstream's test uses (flow.rs:26-29)
const SERVICE = 'did:webvh:scidvtn:vtn.example.org', ORIGIN = 'https://vtn.example.org', SCOPE = 'vtn/groups'
const ALICE = 'did:webvh:scidalice:alice.example.org'
const UA = 'Mozilla/5.0 (Macintosh) Firefox/140.0'
const seeded = (n) => newIdentity(new Uint8Array(32).fill(n)) // upstream's did_key(seed)
const didDoc = (did, publicKey, fragment, service = []) => ({ id: did, verificationMethod: [{ id: did + fragment, type: 'Multikey', controller: did, publicKeyMultibase: ed25519Multikey(publicKey) }], authentication: [did + fragment], assertionMethod: [did + fragment], service })
const code = (a) => a.body?.payload?.code ?? ''

/** A room with wallet sign-in on a stand-in door. `approvers`: only these DIDs may sign in (upstream's test host); null: the room's own rule. */
async function room ({ approvers = [ALICE], gate = null, scope = [SCOPE], did = SERVICE, publicUrl = ORIGIN, name = 'Example Network', holdMs = 40, log = null, production = false, linkHost = '', services = null } = {}) {
  const key = newIdentity(), clock = { t: Date.now() }, now = () => clock.t
  const docs = new Map(), asked = [], plain = createResolver()
  const resolve = async (d) => { asked.push(d); return docs.get(d) ?? plain.resolve(d) }
  const resolver = { resolve, keyFor: async (d, vm, purpose) => keyFromDidDocument(await resolve(d), d, vm, purpose) }
  if (did) docs.set(did, didDoc(did, key.publicKey, '#room', services ?? [{ id: `${did}#trust-tasks`, type: 'TrustTaskHTTPS', serviceEndpoint: publicUrl }, { id: `${did}#sign-in-portal`, type: 'SignInPortal', serviceEndpoint: `${publicUrl}/` }]))
  const signIn = new SignIn({
    identity: key, resolver, log, now, holdMs, signingScope: scope, config: { publicUrl, workspaceName: name, production, signInLinkHost: linkHost },
    readDid: async () => (did ? { did, document: docs.get(did) } : { did: null }),
    ...(gate ? { gate } : approvers ? { gate: (stage, d) => (approvers.includes(d) ? { ok: true } : { ok: false, reason: 'not a network member' }) } : {}),
  })
  const door = (process.env.SIGNIN_STANDIN_DOOR ? standInDoor : realDoor)({ me: () => signIn.me, keyFor: resolver.keyFor, now }) // the room's own door; SIGNIN_STANDIN_DOOR=1 plays the same tests on the stand-in
  registerSignIn(door, { signIn })
  await signIn.refresh(true)
  const h = {
    signIn, door, resolver, docs, asked, clock, now, key, host: publicUrl ? new URL(publicUrl).host : 'localhost',
    /** A person whose DID is a did:webvh the stub resolver knows. */
    webvh (d, id = newIdentity()) { docs.set(d, didDoc(d, id.publicKey, '#key-0')); return { did: d, seed: id.seed, verificationMethod: `${d}#key-0` } },
    /** One document through the door, as it would arrive over https from `ip`. */
    send: (doc, { ip = '192.0.2.10', origin } = {}) => door.receive(doc, { origin, host: h.host, ip, userAgent: UA, https: true }),
    /** A document of one task, signed by `from` for authentication unless told otherwise. */
    op: (from, task, payload, { parent, purpose } = {}) => signedTask(from, { type: OOB[task], recipient: signIn.did, payload, issuedAt: instant(now()), ...(parent ? { parentThreadId: parent } : {}) }, { purpose }),
    async start (kb, ip = '192.0.2.10') { const r = await h.send(h.op(kb, 'request', { purpose: 'login', mode: 'scan' }), { ip, origin: publicUrl }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.payload.requestId },
    redeem: (kb, id, ip = '192.0.2.10') => h.send(h.op(kb, 'redeem', { requestId: id }), { ip, origin: publicUrl }),
    link: (id) => triggerLink({ linkHost: signIn.linkHost, did: signIn.did }, id, signIn.requests.get(id).claimDeadline),
    wallet: (person, ip = '192.0.2.10') => testWallet({ person, resolver, now, send: async (doc) => (await door.receive(doc, { host: h.host, ip, userAgent: 'wallet', https: true })).body }),
    /** Scan, and read the number off the browser's next poll. */
    async scanned (kb, id, person, { browserIp = '192.0.2.10', phoneIp = '192.0.2.10' } = {}) {
      const w = h.wallet(person, phoneIp), c = await w.scan(h.link(id))
      assert.equal(c.kind, 'response', JSON.stringify(c.reply))
      const p = await h.redeem(kb, id, browserIp)
      assert.equal(code(p), 'auth/oob/redeem:pending'); assert.equal(p.body.payload.details.state, 'claimed')
      return { w, number: p.body.payload.details.matchNumber }
    },
    async identified (kb, id, person, ips) { const { w, number } = await h.scanned(kb, id, person, ips); const s2 = await w.prove(number); assert.equal(s2.kind, 'response', JSON.stringify(s2.reply)); return w },
  }
  return h
}
const attestedByRoom = async (h, doc) => {
  assert.equal(doc.proof.proofPurpose, 'assertionMethod'); assert.ok(doc.proof.verificationMethod.startsWith(h.signIn.did)) // signed by sign-in itself, not again by the door
  assert.equal((await verifyTask(doc, { keyFor: h.resolver.keyFor, me: doc.recipient, now: h.now(), purposes: ['assertionMethod'] })).ok, true, 'the room\'s signature verifies against its DID document')
}

describe('the upstream exchange, step for step (vti-oob-server/tests/flow.rs)', () => {
  test('a wallet approves the browser\'s key, and redeem gives the room who approved it', async () => {
    const h = await room(), alice = h.webvh(ALICE)
    const kb = seeded(1), ka = seeded(2), browser = '192.0.2.10', phone = '192.0.2.10'
    const fromPhone = (doc) => h.send(doc, { ip: phone })

    // request
    const r = await h.send(h.op(kb, 'request', { purpose: 'login', mode: 'scan' }), { ip: browser, origin: ORIGIN })
    const id = r.body.payload.requestId
    assert.match(id, /^[A-Za-z0-9_-]{22}$/, 'a request id'); assert.equal(r.body.type, `${OOB.request}#response`)
    assert.equal(r.body.payload.ext, undefined, 'one audience: no ext')
    const closes = epochOf(r.body.payload.claimClosesAt), t0 = Math.floor(h.now() / 1000)
    assert.ok(closes > t0 && closes <= t0 + CLAIM_SECONDS, 'the code is good for two minutes')
    assert.deepEqual(Object.keys(r.body.payload).sort(), ['claimClosesAt', 'requestId'])

    // claim: step 1, signed, naming the service; no ext.
    const s1 = (await fromPhone(h.op(ka, 'claim', { requestId: id }, { parent: id }))).body
    assert.equal(s1.payload.service.did, SERVICE, JSON.stringify(s1)); assert.equal(s1.payload.service.name, 'Example Network')
    assert.ok(s1.proof && typeof s1.proof === 'object'); assert.equal(s1.payload.ext, undefined)
    await attestedByRoom(h, s1)
    assert.equal(s1.payload.origin, ORIGIN); assert.equal(s1.payload.purpose, 'login'); assert.equal(s1.payload.requestId, id)
    assert.ok(epochOf(s1.payload.decisionClosesAt) <= Math.floor(h.now() / 1000) + DECISION_SECONDS)
    assert.ok(s1.payload.sessionKey === undefined && s1.payload.requester === undefined, 'step 1 says nothing about the browser')

    // The browser learns the number.
    const p = await h.redeem(kb, id, browser)
    assert.equal(code(p), 'auth/oob/redeem:pending', JSON.stringify(p.body))
    const number = p.body.payload.details.matchNumber
    assert.match(number, /^[0-9]{2}$/)

    // prove: step 2 offers the host's scope.
    const identify = signedTask(alice, { type: OOB.identify, recipient: SERVICE, issuedAt: instant(h.now()), payload: { requestId: id, approverKey: ka.did, enteredNumber: number } })
    const s2 = (await fromPhone(h.op(ka, 'prove', { identify }))).body
    assert.equal(s2.payload.identifiedAs, ALICE, JSON.stringify(s2)); assert.deepEqual(s2.payload.signingScope, [SCOPE]); assert.equal(s2.payload.requester.sameNetwork, true)
    await attestedByRoom(h, s2)
    for (const k of ['requestId', 'service', 'origin', 'purpose', 'decisionClosesAt']) assert.deepEqual(s2.payload[k], s1.payload[k], `step 2 repeats step 1's ${k}`)
    assert.equal(s2.payload.sessionKey, kb.did)
    assert.deepEqual({ browser: s2.payload.requester.browser, os: s2.payload.requester.os, location: s2.payload.requester.location }, { browser: 'Firefox', os: 'macOS', location: 'unknown' })
    assert.equal(JSON.stringify(s2).includes(browser), false, 'never the address')

    // respond: a grant over the real step 2.
    const notAfter = Math.floor(h.now() / 1000) + 600
    const grant = signedTask(alice, { type: OOB.grant, recipient: SERVICE, issuedAt: instant(h.now()), payload: { requestId: id, decision: 'approve', sessionKey: kb.did, approverKey: ka.did, origin: ORIGIN, contextDigest: contextDigest(s2), sessionEndsAt: rfc3339(notAfter), signingScope: [SCOPE] } }, { purpose: 'assertionMethod' })
    const rs = (await fromPhone(h.op(ka, 'respond', { grant }))).body
    assert.equal(rs.payload.status, 'approved', JSON.stringify(rs)); await attestedByRoom(h, rs)

    // redeem: the browser's key now stands for the person who approved it, until the grant's end, and for nothing else.
    const done = await h.redeem(kb, id, browser)
    assert.equal(done.status, 200); assert.equal(done.body.payload.subject, ALICE, JSON.stringify(done.body)); assert.deepEqual(done.body.payload.amr, ['did', 'oob', 'uv'])
    assert.equal(done.body.payload.sessionEndsAt, rfc3339(notAfter)); assert.equal(done.body.payload.displayName, ALICE)
    const held = h.signIn.session(kb.did)
    assert.equal(held.subject, ALICE); assert.equal(held.grant.id, grant.id); assert.equal(held.sessionEndsAt, rfc3339(notAfter)); assert.equal(held.mayWrite, false)
    assert.equal(h.signIn.session(ka.did), null, 'the wallet\'s throwaway key stands for no one')

    // Spent: a second redeem is refused.
    assert.equal(code(await h.redeem(kb, id, browser)), 'auth/oob:alreadyDecided')
    const c = h.signIn.view().counts
    assert.deepEqual([c.requested, c.claimed, c.proved, c.approved, c.redeemed, c.declined, c.proofFailed, c.expired, c.cancelled], [1, 1, 1, 1, 1, 0, 0, 0, 0], 'the stages, in order, once each')
  })

  test('an unknown approver is refused before its DID is looked up, and the request declines', async () => {
    const h = await room({ approvers: [] }), mallory = h.webvh('did:webvh:scidm:mallory.example.org')
    const kb = seeded(3), ka = seeded(4)
    const id = await h.start(kb, '192.0.2.20')
    await h.send(h.op(ka, 'claim', { requestId: id }, { parent: id }), { ip: '192.0.2.21' })
    const number = (await h.redeem(kb, id, '192.0.2.20')).body.payload.details.matchNumber
    h.asked.length = 0
    const identify = signedTask(mallory, { type: OOB.identify, recipient: SERVICE, payload: { requestId: id, approverKey: ka.did, enteredNumber: number } })
    const pr = await h.send(h.op(ka, 'prove', { identify }), { ip: '192.0.2.21' })
    assert.equal(code(pr), 'auth/oob:notAuthorized', JSON.stringify(pr.body)); assert.equal(pr.body.payload.details, undefined, 'no reason')
    assert.equal(h.asked.includes(mallory.did), false, 'refused from what the room knows, with nothing looked up')
    assert.equal(code(await h.redeem(kb, id, '192.0.2.20')), 'auth/oob/redeem:declined')
    assert.deepEqual(h.signIn.view().declinedFor, { 'not a network member': 1 }, 'the room\'s own count says why; the wire does not')
  })

  test('request is https only, from the room\'s own page only, and the room has one kind of sign-in', async () => {
    const h = await room(), kb = seeded(5), req = (payload = { purpose: 'login', mode: 'scan' }) => h.op(kb, 'request', payload)
    const off = await h.door.receive(req(), undefined) // not over the web at all
    assert.equal(code(off), 'permissionDenied', JSON.stringify(off.body)); assert.equal(off.status, 403)
    assert.equal(code(await h.send(req(), { ip: '192.0.2.30', origin: 'https://evil.example' })), 'permissionDenied', 'another site\'s page')
    assert.equal(code(await h.send(req(), { ip: '192.0.2.30' })), 'permissionDenied', 'no Origin at all')
    assert.equal(code(await h.door.receive(req(), { origin: ORIGIN, host: h.host, ip: '192.0.2.30', userAgent: UA, https: false })), 'permissionDenied', 'plain http to a public host')
    const ext = { 'org.openvtc.session': { audience: 'admin' } }
    assert.equal(code(await h.send(req({ purpose: 'login', mode: 'scan', ext }), { origin: ORIGIN })), 'malformedRequest', 'a session the room does not have')
    assert.equal(code(await h.send(req({ purpose: 'step-up', mode: 'scan' }), { origin: ORIGIN })), 'auth/oob/request:purposeUnsupported')
    assert.equal(code(await h.send(req({ purpose: 'login', mode: 'code' }), { origin: ORIGIN })), 'auth/oob/request:modeUnsupported')
    assert.equal(code(await h.send(req({ purpose: 'login', mode: 'scan', more: 1 }), { origin: ORIGIN })), 'malformedRequest')
    assert.equal((await h.send(req({ purpose: 'login', mode: 'scan', ext: { 'org.example.other': { x: 1 } } }), { origin: ORIGIN })).status, 200, 'an ext member that is not the room\'s to read is left alone')
    assert.equal(h.signIn.view().counts.requested, 1)
    assert.equal(code(await h.door.receive(h.op(kb, 'redeem', { requestId: 'A'.repeat(22) }), undefined)), 'permissionDenied', 'redeem is https only too')
  })

  test('any signer but an Ed25519 did:key is refused before its proof is read', async () => {
    const h = await room(), alice = h.webvh(ALICE)
    assert.equal(h.signIn.precheck(taskDocument({ type: OOB.claim, issuer: ALICE, recipient: SERVICE, payload: { requestId: 'x' } })).code, 'auth/oob:keyUnsupported')
    assert.equal(h.signIn.precheck(taskDocument({ type: typeUri('vtn/groups/register', '0.1'), issuer: ALICE, recipient: SERVICE })), undefined, 'another task is not this file\'s to refuse')
    h.asked.length = 0
    const forged = { ...h.op(seeded(6), 'request', { purpose: 'login', mode: 'scan' }), issuer: 'did:webvh:abc:attacker.example' }
    const r = await h.send(forged, { origin: ORIGIN })
    assert.equal(code(r), 'auth/oob:keyUnsupported', JSON.stringify(r.body)); assert.deepEqual(h.asked, [], 'nothing was looked up for it')
    assert.equal(code(await h.send(h.op(alice, 'claim', { requestId: 'A'.repeat(22) }, { parent: 'A'.repeat(22) }))), 'auth/oob:keyUnsupported', 'a person\'s own DID never claims: the wallet uses a key made for the scan')
    for (const [did, ok] of [[seeded(7).did, true], ['did:key:zDnaeexample', false], ['did:webvh:abc:example.com', false], ['did:key:z6Mk', false], [null, false]]) assert.equal(isEd25519DidKey(did), ok, String(did))
    // identify and grant are only ever carried inside prove and respond
    const bare = await h.send(signedTask(alice, { type: OOB.identify, recipient: SERVICE, payload: { requestId: 'x', approverKey: 'did:key:z6Mkx', enteredNumber: '00' } }))
    assert.equal(code(bare), 'unsupportedType', JSON.stringify(bare.body))
  })
})

describe('every refusal in the upstream tests (vtc-service/tests/it/member_portal_oob.rs)', () => {
  test('before a wallet scans, the browser learns only that it waits; twenty polls in a row are all answered', async () => {
    const h = await room(), kb = newIdentity(), id = await h.start(kb)
    for (let n = 0; n < 20; n++) {
      const r = await h.redeem(kb, id)
      assert.equal(code(r), 'auth/oob/redeem:pending', `poll ${n}`); assert.deepEqual(r.body.payload.details, { state: 'pending' }, 'no number yet')
    }
  })

  test('a held poll keeps the room running until it is answered, and stop() answers it at once', async () => {
    // Node 22's test runner cancels a test whose only pending work is an unref'd timer ("the event loop has already
    // resolved"); Node 26 does not. Checked here on any Node: while a poll is held, a referenced timer is active.
    const h = await room({ holdMs: 5000 }), kb = newIdentity(), id = await h.start(kb)
    const timers = () => process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length
    const before = timers(), held = h.redeem(kb, id)
    await new Promise((resolve) => setImmediate(resolve)); await new Promise((resolve) => setImmediate(resolve))
    assert.equal(h.signIn.polls.open.has(id), true, 'the poll is held'); assert.ok(timers() > before, 'its timer is referenced')
    const t0 = Date.now(); h.signIn.stop()
    assert.equal(code(await held), 'auth/oob/redeem:pending'); assert.ok(Date.now() - t0 < 1000, 'stop() answered the held poll at once')
  })

  test('a bystander who scans first locks the request and cannot get past the person\'s proof', async () => {
    const h = await room(), kb = newIdentity(), id = await h.start(kb)
    const stranger = newIdentity() // not someone this room lets in
    const { w: bystander, number } = await h.scanned(kb, id, stranger, { phoneIp: '203.0.113.20' })
    const second = await h.wallet(h.webvh(ALICE)).scan(h.link(id))
    assert.equal(second.code, 'auth/oob/claim:alreadyClaimed'); assert.equal(second.details, undefined, 'a second scanner learns nothing about the first')
    const r = await bystander.prove(number)
    assert.equal(r.code, 'auth/oob:notAuthorized'); assert.equal(h.signIn.requests.get(id).state, 'declined')
    assert.equal(code(await h.redeem(kb, id)), 'auth/oob/redeem:declined')
  })

  test('a wrong number declines the request, and the right one afterwards does not help', async () => {
    const h = await room(), alice = h.webvh(ALICE), kb = newIdentity(), id = await h.start(kb)
    const { w, number } = await h.scanned(kb, id, alice)
    const wrong = String((Number(number) + 1) % 100).padStart(2, '0')
    const r = await w.prove(wrong)
    assert.equal(r.code, 'auth/oob/prove:numberMismatch', JSON.stringify(r.reply)); assert.equal(h.signIn.requests.get(id).state, 'declined')
    assert.notEqual((await w.prove(number)).kind, 'response', 'one attempt per request')
    assert.deepEqual(h.signIn.view().declinedFor, { 'wrong number': 1 })
  })

  test('only the key that scanned may prove, and the person\'s statement must name it', async () => {
    const h = await room(), alice = h.webvh(ALICE), kb = newIdentity(), id = await h.start(kb)
    const { w, number } = await h.scanned(kb, id, alice)
    const other = newIdentity()
    const r = await w.prove(number, { by: other }) // another device wrapping the person's statement
    assert.equal(r.code, 'auth/oob:notClaimant', JSON.stringify(r.reply)); assert.equal(h.signIn.requests.get(id).state, 'claimed', 'a stranger\'s failure changes nothing')
    const r2 = await w.prove(number, { identify: w.identify(number, { approverKey: other.did }) }) // a statement naming a different key, from the key that scanned
    assert.equal(r2.code, 'auth/oob:notAuthorized'); assert.equal(h.signIn.requests.get(id).state, 'declined')
  })

  test('the person\'s statement is signed for authentication, fresh, for this room, and complete', async () => {
    for (const [why, make] of [
      ['signed for assertionMethod', (w, n) => w.identify(n, {}, { purpose: 'assertionMethod' })],
      ['one member too many', (w, n) => w.identify(n, { also: true })],
      ['addressed to another service', (w, n) => signedTask(w.person, { type: OOB.identify, recipient: 'did:webvh:other:elsewhere.example', payload: { requestId: w.requestId, approverKey: w.ka.did, enteredNumber: n } })],
      ['eleven minutes old', (w, n) => signedTask(w.person, { type: OOB.identify, recipient: SERVICE, issuedAt: instant(Date.now() - 11 * 60_000 - 5000), payload: { requestId: w.requestId, approverKey: w.ka.did, enteredNumber: n } })],
      ['signed by someone else', (w, n) => ({ ...signedTask(newIdentity(), { type: OOB.identify, recipient: SERVICE, payload: { requestId: w.requestId, approverKey: w.ka.did, enteredNumber: n } }), issuer: ALICE })],
      ['changed after signing', (w, n) => { const d = w.identify(n); return { ...d, issuedAt: instant(Date.parse(d.issuedAt) - 2000) } }],
    ]) {
      const h = await room(), alice = h.webvh(ALICE), kb = newIdentity(), id = await h.start(kb)
      const { w, number } = await h.scanned(kb, id, alice)
      const r = await w.prove(number, { identify: make(w, number) })
      assert.equal(r.code, 'auth/oob:notAuthorized', why); assert.equal(r.details, undefined, why)
      assert.equal(h.signIn.requests.get(id).state, 'declined', why)
    }
  })

  test('a grant for anything but what the person was shown is refused and ends the request', async () => {
    for (const [why, over] of [
      ['a digest of something else', { contextDigest: multihashOf({ not: 'step 2' }) }],
      ['another browser key', { sessionKey: newIdentity().did }],
      ['another origin', { origin: 'https://evil.example' }],
      ['more signing than the room offered', { signingScope: [SCOPE, 'vtc/directory'] }],
      ['no signing where the room offered some', { signingScope: undefined }],
    ]) {
      const h = await room(), alice = h.webvh(ALICE), kb = newIdentity(), id = await h.start(kb)
      const w = await h.identified(kb, id, alice)
      const r = await w.respond('approve', { grant: w.grant('approve', over) })
      assert.equal(r.code, 'auth/oob/respond:contextMismatch', why); assert.equal(h.signIn.requests.get(id).state, 'declined', why)
      assert.equal(code(await h.redeem(kb, id)), 'auth/oob/redeem:declined', why)
    }
    // a grant naming another request: with nothing else to find the request by, there is no such request, and nothing
    // changes; sent in this request's thread, it is not what the person was shown
    const h = await room(), alice = h.webvh(ALICE), kb = newIdentity(), id = await h.start(kb)
    const w = await h.identified(kb, id, alice)
    assert.equal((await w.respond('approve', { grant: w.grant('approve', { requestId: 'B'.repeat(22) }) })).code, 'auth/oob:requestNotFound'); assert.equal(h.signIn.requests.get(id).state, 'identified')
    const id3 = await h.start(kb), w3 = await h.identified(kb, id3, alice)
    assert.equal(code(await h.send(h.op(w3.ka, 'respond', { grant: w3.grant('approve', { requestId: id }) }, { parent: id3 }))), 'auth/oob/respond:contextMismatch'); assert.equal(h.signIn.requests.get(id3).state, 'declined')
    // the same digest spelled in base64url is the same digest
    const u = 'u' + Buffer.from(fromBase58btc(contextDigest(w.step2).slice(1))).toString('base64url')
    assert.equal((await w.respond('approve', { grant: w.grant('approve', { contextDigest: u }) })).payload.status, 'approved')
  })

  test('a grant is the identified person\'s own attestation, with an end in the future', async () => {
    for (const [why, make] of [
      ['signed for authentication', (w) => w.grant('approve', {}, { purpose: 'authentication' })],
      ['from another identity', (w, h) => signedTask(h.webvh('did:webvh:scidb:bob.example.org'), { type: OOB.grant, recipient: SERVICE, payload: w.grant().payload }, { purpose: 'assertionMethod' })],
      ['an end that has passed', (w) => w.grant('approve', {}, { sessionSeconds: -5 })],
      ['a decision that is neither', (w) => w.grant('maybe')],
    ]) {
      const h = await room(), alice = h.webvh(ALICE), kb = newIdentity(), id = await h.start(kb)
      const w = await h.identified(kb, id, alice)
      const r = await w.respond('approve', { grant: make(w, h) })
      assert.equal(r.code, 'auth/oob:notAuthorized', why); assert.equal(h.signIn.requests.get(id).state, 'declined', why)
    }
    // a respond before any proof: not yet, and nothing ends
    const h = await room(), alice = h.webvh(ALICE), kb = newIdentity(), id = await h.start(kb)
    const { w, number } = await h.scanned(kb, id, alice)
    w.step2 = { payload: { sessionKey: kb.did, origin: ORIGIN } }
    assert.equal((await w.respond('approve')).code, 'auth/oob:notAuthorized'); assert.equal(h.signIn.requests.get(id).state, 'claimed')
    assert.equal((await w.prove(number)).kind, 'response')
  })

  test('the person saying no ends the request, and the browser is told it was declined', async () => {
    const h = await room(), alice = h.webvh(ALICE), kb = newIdentity(), id = await h.start(kb)
    const w = await h.identified(kb, id, alice)
    const r = await w.respond('decline')
    assert.equal(r.payload.status, 'declined', JSON.stringify(r.reply))
    const d = await h.redeem(kb, id)
    assert.equal(code(d), 'auth/oob/redeem:declined'); assert.deepEqual(d.body.payload.details, { state: 'declined' })
    assert.equal(h.signIn.session(kb.did), null); assert.equal(h.signIn.view().counts.declined, 1)
  })

  test('nothing can be used twice: a claim, a statement, a decision', async () => {
    const h = await room(), alice = h.webvh(ALICE), kb = newIdentity(), ka = newIdentity(), id = await h.start(kb)
    // a claim's handle must travel as parentThreadId (VTI-LNK-054)
    const unthreaded = await h.send(h.op(ka, 'claim', { requestId: id }))
    assert.equal(unthreaded.status, 400); assert.equal(code(unthreaded), 'malformedRequest'); assert.equal(h.signIn.requests.get(id).state, 'pending')
    // the same claim document twice is one claim: the redelivery hears the first answer, and the lock does not move
    const first = h.op(ka, 'claim', { requestId: id }, { parent: id })
    const a = await h.send(first), again = await h.send(first)
    assert.equal(a.status, 200); assert.deepEqual(again.body, a.body)
    const other = signedTask(ka, { id: first.id, type: OOB.claim, recipient: SERVICE, parentThreadId: id, issuedAt: instant(h.now()), payload: { requestId: id, ext: { 'org.example.x': 1 } } })
    assert.equal(code(await h.send(other)), 'idConflict', 'another document under the same id')
    const w = h.wallet(alice); Object.assign(w, { from: SERVICE, requestId: id, ka, step1: a.body })
    const number = h.signIn.requests.get(id).matchNumber
    const ident = w.identify(number)
    assert.equal((await w.prove(number, { identify: ident })).kind, 'response')
    assert.equal((await w.prove(number, { identify: ident })).code, 'auth/oob:notAuthorized', 'a second proof on an identified request')
    assert.equal(await h.signIn.verifyCarried(ident, OOB.identify, ALICE, 'authentication'), 'carried document replayed', 'and the statement itself is spent')
    const g = w.grant('approve')
    assert.equal((await w.respond('approve', { grant: g })).payload.status, 'approved')
    assert.equal((await w.respond('approve', { grant: g })).code, 'auth/oob:alreadyDecided')
    // approved and not yet collected: either side can still give it up, and then there is nothing to collect
    assert.equal((await w.cancel()).payload.status, 'cancelled')
    assert.deepEqual((await h.redeem(kb, id)).body.payload.details, { state: 'cancelled' }); assert.equal(h.signIn.session(kb.did), null)
  })

  test('only the browser that started a sign-in can collect it', async () => {
    const h = await room(), alice = h.webvh(ALICE), kb = newIdentity(), id = await h.start(kb)
    const w = await h.identified(kb, id, alice)
    assert.equal((await w.respond('approve')).payload.status, 'approved')
    const thief = await h.redeem(newIdentity(), id, '203.0.113.99')
    assert.equal(code(thief), 'auth/oob:notStarter'); assert.equal(thief.body.payload.details, undefined)
    assert.equal((await h.redeem(kb, id)).status, 200)
    assert.equal(code(await h.redeem(kb, 'C'.repeat(22))), 'auth/oob:requestNotFound')
  })

  test('the code runs out two minutes after it is shown, and the page\'s address is dropped when it does', async () => {
    const h = await room(), alice = h.webvh(ALICE), kb = newIdentity(), id = await h.start(kb, '198.51.100.28')
    assert.equal(h.signIn.requests.get(id).startNetwork, '198.51.100.28')
    h.clock.t += (CLAIM_SECONDS - 1) * 1000
    assert.equal(h.signIn.stateOf(h.signIn.requests.get(id)), 'pending')
    h.clock.t += 1000
    const r = await h.wallet(alice).scan(h.link(id).replace(/_exp=\d+/, '_exp=9999999999')) // a wallet whose clock is behind still hears it from the room
    assert.equal(r.code, 'auth/oob:requestExpired', JSON.stringify(r.reply))
    const rec = h.signIn.requests.get(id)
    assert.equal(rec.state, 'expired'); assert.equal(rec.startNetwork, null)
    assert.equal(code(await h.redeem(kb, id)), 'auth/oob:requestExpired')
    assert.equal(h.signIn.view().counts.expired, 1, 'written down once')
  })

  test('scanning starts two more minutes for the proof, the decision and the collecting; after that the request has expired', async () => {
    const h = await room(), alice = h.webvh(ALICE), kb = newIdentity(), id = await h.start(kb)
    h.clock.t += 100_000 // scanned late in the first window
    const { w, number } = await h.scanned(kb, id, alice)
    h.clock.t += 100_000 // 200 s after the code was shown: the first clock no longer counts
    assert.equal((await w.prove(number)).kind, 'response')
    h.clock.t += 19_000
    assert.equal((await w.respond('approve')).payload.status, 'approved')
    h.clock.t += 2000 // 121 s after the scan
    assert.equal(code(await h.redeem(kb, id)), 'auth/oob:requestExpired', 'approved, and not collected in time')
    assert.equal(h.signIn.session(kb.did), null)

    const id2 = await h.start(kb), s = await h.scanned(kb, id2, alice)
    h.clock.t += DECISION_SECONDS * 1000
    assert.equal((await s.w.prove(s.number)).code, 'auth/oob:requestExpired'); assert.equal(h.signIn.requests.get(id2).state, 'expired')
    assert.equal((await s.w.cancel()).code, 'auth/oob:alreadyDecided')
  })

  test('a cancelled request tells the browser it was cancelled; a stranger cannot cancel', async () => {
    const h = await room(), alice = h.webvh(ALICE), kb = newIdentity(), id = await h.start(kb)
    await h.scanned(kb, id, alice)
    assert.equal(code(await h.send(h.op(newIdentity(), 'cancel', { requestId: id }), { ip: '203.0.113.40' })), 'auth/oob:notAuthorized')
    const r = await h.send(h.op(kb, 'cancel', { requestId: id }), { origin: ORIGIN })
    assert.equal(r.body.payload.status, 'cancelled', JSON.stringify(r.body)); await attestedByRoom(h, r.body)
    const d = await h.redeem(kb, id)
    assert.equal(code(d), 'auth/oob/redeem:declined'); assert.deepEqual(d.body.payload.details, { state: 'cancelled' })
    assert.equal(code(await h.send(h.op(kb, 'cancel', { requestId: id }), { origin: ORIGIN })), 'auth/oob:alreadyDecided')
    // the wallet that scanned can give it up too
    const id2 = await h.start(kb), s = await h.scanned(kb, id2, alice)
    assert.equal((await s.w.cancel()).payload.status, 'cancelled')
  })
})

describe('the limits, and what the room keeps', () => {
  test('one address holds five unscanned codes at once; a scan or a code running out frees one', async () => {
    const h = await room(), alice = h.webvh(ALICE), ip = '198.51.100.50'
    const ids = []
    for (let i = 0; i < MAX_PENDING_PER_ADDRESS; i++) ids.push(await h.start(newIdentity(), ip))
    const over = await h.send(h.op(newIdentity(), 'request', { purpose: 'login', mode: 'scan' }), { ip, origin: ORIGIN })
    assert.equal(code(over), 'auth/oob:rateLimited', JSON.stringify(over.body))
    assert.equal((await h.send(h.op(newIdentity(), 'request', { purpose: 'login', mode: 'scan' }), { ip: '198.51.100.51', origin: ORIGIN })).status, 200, 'another address is not held to it')
    await h.wallet(alice).scan(h.link(ids[0]))
    await h.start(newIdentity(), ip)
    assert.equal(code(await h.send(h.op(newIdentity(), 'request', { purpose: 'login', mode: 'scan' }), { ip, origin: ORIGIN })), 'auth/oob:rateLimited')
    h.clock.t += CLAIM_SECONDS * 1000
    await h.start(newIdentity(), ip)
  })

  test('one poll is held per request, and one address holds eight at once', async () => {
    const h = await room({ holdMs: 1500 }), ip = '198.51.100.60' // long enough that a busy machine cannot make the held polls end first
    const pairs = []
    for (let i = 0; i <= MAX_POLLS_PER_ADDRESS; i++) { const kb = newIdentity(); pairs.push([kb, await h.start(kb, `198.51.100.${70 + i}`)]) }
    const t0 = Date.now()
    const held = pairs.slice(0, MAX_POLLS_PER_ADDRESS).map(([kb, id]) => h.redeem(kb, id, ip))
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(code(await h.redeem(pairs[MAX_POLLS_PER_ADDRESS][0], pairs[MAX_POLLS_PER_ADDRESS][1], ip)), 'auth/oob:rateLimited')
    const second = await h.redeem(pairs[0][0], pairs[0][1], ip) // a second poll on a request that already has one: answered at once
    assert.equal(code(second), 'auth/oob/redeem:pending'); assert.equal(h.signIn.polls.open.size, MAX_POLLS_PER_ADDRESS, 'not held: the eight before it are all still waiting')
    for (const r of await Promise.all(held)) assert.equal(code(r), 'auth/oob/redeem:pending')
    assert.ok(Date.now() - t0 >= 1450, 'the held polls waited their time')
    assert.equal(h.signIn.polls.open.size, 0); assert.equal(h.signIn.polls.perAddress.size, 0)
    assert.equal((await h.redeem(pairs[MAX_POLLS_PER_ADDRESS][0], pairs[MAX_POLLS_PER_ADDRESS][1], ip)).body.payload.code, 'auth/oob/redeem:pending', 'and the slot is free again')
  })

  test('a held poll is answered the moment the wallet scans, with the number', async () => {
    const h = await room({ holdMs: 20_000 }), alice = h.webvh(ALICE), kb = newIdentity(), id = await h.start(kb)
    const t0 = Date.now(), poll = h.redeem(kb, id)
    await new Promise((resolve) => setTimeout(resolve, 30))
    await h.wallet(alice).scan(h.link(id))
    const p = await poll
    assert.ok(Date.now() - t0 < 15_000, 'answered by the scan, not by the poll running out'); assert.equal(p.body.payload.details.state, 'claimed'); assert.match(p.body.payload.details.matchNumber, /^[0-9]{2}$/)
    assert.equal(h.signIn.requests.get(id).matchNumberDelivered, true)
    const next = h.redeem(kb, id) // the number is on the screen: this one waits for the next change
    await new Promise((resolve) => setTimeout(resolve, 30))
    h.signIn.stop()
    assert.equal(code(await next), 'auth/oob/redeem:pending')
  })

  test('an ended request is kept ten minutes, so a late document hears how it ended, then forgotten', async () => {
    const h = await room(), kb = newIdentity(), id = await h.start(kb)
    h.clock.t += CLAIM_SECONDS * 1000
    h.signIn.sweep(true)
    assert.equal(h.signIn.requests.get(id).state, 'expired'); assert.equal(h.signIn.view().counts.expired, 1)
    h.clock.t += ENDED_RETENTION_SECONDS * 1000
    h.signIn.sweep(true); assert.ok(h.signIn.requests.has(id))
    h.clock.t += 1000
    h.signIn.sweep(true); assert.equal(h.signIn.requests.size, 0)
    assert.equal(h.signIn.view().counts.expired, 1)
  })

  test('a session ends when the person\'s grant does, and never later than the room\'s own limit', async () => {
    const h = await room(), alice = h.webvh(ALICE), kb = newIdentity(), id = await h.start(kb)
    const w = await h.identified(kb, id, alice)
    await w.respond('approve', { sessionSeconds: 30 * 24 * 3600 })
    const done = await h.redeem(kb, id), t = Math.floor(h.now() / 1000)
    assert.equal(done.body.payload.sessionEndsAt, rfc3339(t + SESSION_MAX_SECONDS), 'a month was granted; the room keeps it for its own limit')
    assert.equal(h.signIn.session(kb.did).grant.payload.sessionEndsAt, rfc3339(t + 30 * 24 * 3600), 'the grant itself is kept as the person signed it')
    h.clock.t += SESSION_MAX_SECONDS * 1000
    assert.equal(h.signIn.session(kb.did), null); assert.equal(h.signIn.sessions.size, 0)
  })

  test('the room\'s own rule for who may sign in: anyone whose DID it can read, joined or not; never an agent, a replaced account or the room', async () => {
    const agent = newIdentity(), old = newIdentity(), joined = newIdentity()
    const log = { state: { participants: new Map([[agent.did, { kind: 'agent', name: 'helper' }], [old.did, { kind: 'human', name: 'Old', replacedBy: joined.did }], [joined.did, { kind: 'human', name: 'Robin' }]]) } }
    const h = await room({ approvers: null, scope: null, log })
    const go = async (person) => { const kb = newIdentity(), id = await h.start(kb), s = await h.scanned(kb, id, person); return { kb, id, r: await s.w.prove(s.number), w: s.w } }
    const a = await go(agent)
    assert.equal(a.r.code, 'auth/oob:notAuthorized'); assert.equal(a.r.details, undefined, 'before the DID is proved, no reason is given')
    assert.equal(code(await h.redeem(a.kb, a.id)), 'auth/oob/redeem:declined')
    const o = await go(old); assert.equal(o.r.code, 'auth/oob:notAuthorized')
    const stranger = await go(newIdentity()) // a did:key nobody here has seen: the room is open
    assert.equal(stranger.r.kind, 'response'); assert.equal(stranger.r.payload.signingScope, undefined, 'the room offers no signing')
    const j = await go(joined)
    assert.equal((await j.w.respond('approve')).payload.status, 'approved')
    assert.equal((await h.redeem(j.kb, j.id)).body.payload.displayName, 'Robin', 'a name only for a DID that joined under one')
    assert.equal((await h.signIn.gate('known', h.signIn.did)).ok, false); assert.equal((await h.signIn.gate('known', 'did:example:123')).ok, false)
    // a grant that asks for signing the room did not offer is not what the person was shown
    const k = await go(newIdentity())
    assert.equal((await k.w.respond('approve', { grant: k.w.grant('approve', { signingScope: ['input/note'] }) })).code, 'auth/oob/respond:contextMismatch')
    assert.throws(() => new SignIn({ identity: newIdentity(), config: {}, resolver: h.resolver, signingScope: ['auth/oob'] }), /signingScope/)
  })

  test('a refusal may say why only once the DID is proved: then the wallet is told, and so is the page', async () => {
    const told = { ok: false, reason: 'not on the list', told: 'notOnList', message: 'This identity is not on this room\'s list.' }
    const h = await room({ gate: (stage) => (stage === 'known' ? { ok: true } : told) }), alice = h.webvh(ALICE), kb = newIdentity(), id = await h.start(kb)
    const { w, number } = await h.scanned(kb, id, alice)
    const r = await w.prove(number)
    assert.deepEqual([r.code, r.message, r.details], ['auth/oob:notAuthorized', told.message, { reason: 'notOnList' }])
    const d = await h.redeem(kb, id)
    assert.equal(code(d), 'auth/oob/redeem:declined'); assert.equal(d.body.payload.message, told.message); assert.deepEqual(d.body.payload.details, { state: 'declined', reason: 'notOnList' })
    // someone who stops being welcome between approving and collecting gets nothing
    let stage2 = 'in'
    const h2 = await room({ gate: (stage) => (stage === 'redeem' && stage2 === 'out' ? { ok: false, reason: 'no longer welcome' } : { ok: true }) }), a2 = h2.webvh(ALICE), kb2 = newIdentity(), id2 = await h2.start(kb2)
    const w2 = await h2.identified(kb2, id2, a2); await w2.respond('approve'); stage2 = 'out'
    assert.equal(code(await h2.redeem(kb2, id2)), 'auth/oob:notAuthorized'); assert.equal(h2.signIn.session(kb2.did), null)
    assert.equal(code(await h2.redeem(kb2, id2)), 'auth/oob:alreadyDecided', 'and the request is spent all the same')
  })

  test('a room whose only DID is a did:key, and a person with a did:key: the exchange is the same', async () => {
    const h = await room({ did: null, approvers: null, scope: null }), person = newIdentity(), kb = newIdentity()
    assert.equal(h.signIn.did, h.key.did)
    const id = await h.start(kb)
    const w = h.wallet(person), c = await w.scan(h.link(id), { base: 'given, since a did:key lists no services' })
    assert.equal(c.payload.service.did, h.key.did)
    const number = (await h.redeem(kb, id)).body.payload.details.matchNumber
    assert.equal((await w.prove(number)).payload.identifiedAs, person.did)
    assert.equal((await w.respond('approve')).payload.status, 'approved')
    assert.equal((await h.redeem(kb, id)).body.payload.subject, person.did)
    assert.deepEqual(h.signIn.didDocument().missing, ['TrustTaskHTTPS', 'SignInPortal'], 'and the room says a real wallet could not have found it')
  })
})

describe('the trigger link', () => {
  test('its exact text, its one encoding rule and its length', () => {
    // upstream's own vectors: vtc-client/src/signin.rs:440-452 (with the flow a real service answers) and vti-oob-server/src/util.rs:354-363
    assert.equal(triggerLink({ linkHost: 'link.trustoverip.org', did: 'did:webvh:Qm1:vtc.example.com:first' }, 'AAAAAAAAAAAAAAAAAAAAAA', 1_900_000_000),
      'https://link.trustoverip.org/t#_from=did:webvh:Qm1:vtc.example.com:first&_id=AAAAAAAAAAAAAAAAAAAAAA&_exp=1900000000&_type=/vti/flow/sign-in/0.1')
    const did = 'did:webvh:QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG:members.example.org'
    const link = triggerLink({ did }, 'AbCdEfGhIjKlMnOpQrStUv', 1_760_000_000)
    assert.ok(link.startsWith('https://link.trustoverip.org/t#_from=did:webvh:')); assert.ok(link.endsWith('&_exp=1760000000&_type=/vti/flow/sign-in/0.1'))
    assert.ok(/^[\x00-\x7f]*$/.test(link) && link.length <= MAX_LINK_BYTES, `${link.length} bytes`) // eslint-disable-line no-control-regex
    assert.equal(encodeFrom('a&b=c#d%e'), 'a%26b%3Dc%23d%25e'); assert.equal(encodeFrom('did:x:a&b=c#d%e'), 'did:x:a%26b%3Dc%23d%25e')
    assert.equal(SIGN_IN_FLOW, '/vti/flow/sign-in/0.1'); assert.equal(DEFAULT_LINK_HOST, 'link.trustoverip.org'); assert.equal(MAX_LINK_BYTES, 251)
    assert.throws(() => triggerLink({ linkHost: 'x'.repeat(240) + '.example', did }, 'AAAAAAAAAAAAAAAAAAAAAA', 1), /too long/)
    assert.throws(() => triggerLink({ did: 'did:web:exämple.org' }, 'AAAAAAAAAAAAAAAAAAAAAA', 1), /too long/, 'not plain ASCII')
    // how long a DID may be: everything else in the link is fixed
    assert.deepEqual(linkRoom({ did }), { bytes: 108 + did.length, max: 251, fits: true, didMayBe: 143 })
    assert.equal(linkRoom({ did: 'did:webvh:' + 'Q'.repeat(46) + ':' + 'a'.repeat(87) }).fits, false) // 144 bytes: one too many
    assert.equal(linkRoom({ did: 'did:webvh:' + 'Q'.repeat(46) + ':' + 'a'.repeat(86) }).fits, true)
    assert.equal(linkRoom({ did: 'did:webvh:' + 'Q'.repeat(46) + ':localhost%3A8787' }).bytes, 108 + 73 + 2, 'a port costs two more: its % is encoded again')
  })

  test('a link host is a public name, and never the page\'s own domain', () => {
    // util.rs:366-374
    assert.equal(checkLinkHost(DEFAULT_LINK_HOST, 'members.example.org'), null)
    for (const [host, portal] of [['link.example.org', 'example.org'], ['example.org', 'members.example.org'], ['members.example.org', 'members.example.org'], ['localhost', null], ['10.0.0.1', null], ['Link.Example.org', null], ['printer.local', null], ['-a.example', null]]) assert.match(checkLinkHost(host, portal), /sign-in link host/, host)
  })

  test('a wallet\'s reader takes it apart again, and hands on what is not a trigger link', () => {
    const did = 'did:webvh:Qm1:room.example%3A8443', link = triggerLink({ did }, 'AbCdEfGhIjKlMnOpQrStUv', 1_760_000_000)
    assert.ok(link.includes('_from=did:webvh:Qm1:room.example%253A8443&'))
    assert.deepEqual(readTriggerLink(link), { ok: true, linkHost: 'link.trustoverip.org', from: did, id: 'AbCdEfGhIjKlMnOpQrStUv', exp: 1_760_000_000, type: SIGN_IN_FLOW, flow: 'https://link.trustoverip.org/vti/flow/sign-in/0.1' })
    assert.equal(readTriggerLink('https://room.example/?_oob=eyJ0eXBlIjoi').why, 'not-ours', 'a DIDComm invitation is for another reader')
    assert.equal(readTriggerLink('https://link.trustoverip.org/t?_from=did:key:z6Mk&_id=x').why, 'query-form')
    assert.equal(readTriggerLink(link + '&_id=again').why, 'malformed'); assert.equal(readTriggerLink(link.replace('https:', 'http:')).why, 'malformed')
    assert.equal(readTriggerLink('https://a.example/t#' + 'x'.repeat(1600)).why, 'too-long'); assert.equal(readTriggerLink('not a link').why, 'not-ours')
    // RLTP's cross-app connect is the same link with another flow: read, and plainly not a sign-in
    assert.equal(readTriggerLink(link.replace(SIGN_IN_FLOW, '/vti/flow/shared-connect/0.1')).flow, 'https://link.trustoverip.org/vti/flow/shared-connect/0.1')
  })

  test('the digest, the times, the network comparison and what is said about a browser', () => {
    const v = { b: 1, a: [true] }, d = contextDigest(v), bytes = fromBase58btc(d.slice(1))
    assert.equal(d[0], 'z'); assert.deepEqual([bytes[0], bytes[1], bytes.length], [0x12, 0x20, 34]); assert.equal(d, contextDigest({ a: [true], b: 1 }))
    assert.equal(sameContextDigest(d, 'u' + Buffer.from(bytes).toString('base64url')), true)
    assert.equal(sameContextDigest(d, Buffer.from(bytes).toString('hex')), false); assert.equal(sameContextDigest(d, 'zabc'), false); assert.equal(sameContextDigest('zabc', 'zabc'), false, 'not a digest at all')
    assert.equal(epochOf('2025-10-09T08:53:20Z'), 1_760_000_000); assert.equal(epochOf(1_760_000_000), null); assert.equal(rfc3339(1_760_000_000), '2025-10-09T08:53:20Z')
    // util.rs:304-318
    assert.equal(sameNetwork('203.0.113.5', '203.0.113.5'), true); assert.equal(sameNetwork('203.0.113.6', '203.0.113.5'), false)
    assert.equal(sameNetwork('2001:db8:1:2::99', '2001:db8:1:2::10'), true); assert.equal(sameNetwork('2001:db8:1:3::99', '2001:db8:1:2::10'), false)
    assert.equal(sameNetwork(null, '2001:db8:1:2::10'), 'unknown'); assert.equal(sameNetwork('203.0.113.5', '2001:db8:1:2::10'), 'unknown'); assert.equal(sameNetwork('2001:db8:1:2::99', '203.0.113.5'), 'unknown')
    assert.equal(sameNetwork('::ffff:203.0.113.5', '203.0.113.5'), true, 'an IPv4 address written the IPv6 way is that IPv4 address')
    // util.rs:321-336
    assert.deepEqual(browserAndOs('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'), { browser: 'Chrome', os: 'macOS' })
    assert.deepEqual(browserAndOs('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'), { browser: 'Safari', os: 'iOS' })
    assert.deepEqual(browserAndOs(undefined), { browser: 'unknown', os: 'unknown' })
    assert.deepEqual(AMR, ['did', 'oob', 'uv'])
  })
})

describe('what the room says about it', () => {
  test('the config a page reads, and why a real wallet would or would not find the room', async () => {
    const h = await room()
    const c = h.signIn.configView()
    assert.deepEqual({ on: c.on, serviceDid: c.serviceDid, vtcDid: c.vtcDid, linkHost: c.linkHost, flow: c.flow, trustTasks: c.trustTasks, didDocument: c.didDocument }, { on: true, serviceDid: SERVICE, vtcDid: SERVICE, linkHost: 'link.trustoverip.org', flow: '/vti/flow/sign-in/0.1', trustTasks: '/trust-tasks', didDocument: { status: 'ok' } })
    assert.deepEqual(c.link, { bytes: 108 + SERVICE.length, max: 251, fits: true })
    // each thing a wallet needs in the room's DID document, missing in turn
    const portal = { id: 'x', type: 'SignInPortal', serviceEndpoint: `${ORIGIN}/` }, tasks = { id: 'y', type: 'TrustTaskHTTPS', serviceEndpoint: ORIGIN }
    for (const [services, missing] of [[[tasks], ['SignInPortal']], [[portal], ['TrustTaskHTTPS']], [[tasks, { ...portal, serviceEndpoint: 'https://evil.example/' }], ['SignInPortal']], [[{ ...tasks, serviceEndpoint: `${ORIGIN}/trust-tasks` }, portal], ['TrustTaskHTTPS']], [[], ['TrustTaskHTTPS', 'SignInPortal']]]) {
      assert.deepEqual((await room({ services })).signIn.didDocument(), { status: 'missing', missing }, JSON.stringify(services))
    }
    const other = await room(); other.docs.set(SERVICE, didDoc(SERVICE, newIdentity().publicKey, '#room', [tasks, portal])); await other.signIn.refresh(true)
    assert.deepEqual(other.signIn.didDocument().missing, ['assertionMethod'], 'the published document does not list the key the room signs with')
    // a link host on the room's own domain, and a DID too long for a code: sign-in is off, and says why
    const own = await room({ linkHost: 'link.vtn.example.org' })
    assert.equal(own.signIn.configView().on, false); assert.match(own.signIn.configView().why[0], /own domain/)
    assert.equal(code(await own.send(own.op(newIdentity(), 'request', { purpose: 'login', mode: 'scan' }), { origin: ORIGIN })), 'unavailable')
    const long = await room({ did: 'did:webvh:' + 'Q'.repeat(46) + ':' + 'a'.repeat(120) + '.example.org' })
    assert.equal(long.signIn.configView().link.fits, false); assert.match(long.signIn.configView().why[0], /too long for a sign-in code.*143 bytes at most/)
    const refused = await long.send(long.op(newIdentity(), 'request', { purpose: 'login', mode: 'scan' }), { origin: ORIGIN })
    assert.equal(code(refused), 'unavailable'); assert.equal(refused.status, 503)
    // and before the six tasks are on a door, it is off
    const bare = new SignIn({ identity: newIdentity(), config: { publicUrl: ORIGIN }, resolver: h.resolver, readDid: async () => ({ did: null }) })
    assert.equal(bare.view().on, false); assert.match(bare.view().why[0], /door/)
  })

  test('the counts hold stages and reasons, and nobody\'s key, DID or address', async () => {
    const h = await room(), alice = h.webvh(ALICE), kb = newIdentity(), id = await h.start(kb, '198.51.100.7')
    const w = await h.identified(kb, id, alice, { browserIp: '198.51.100.7', phoneIp: '198.51.100.8' })
    assert.equal(w.step2.payload.requester.sameNetwork, false)
    await w.respond('approve'); await h.redeem(kb, id, '198.51.100.7')
    const v = h.signIn.view(), text = JSON.stringify(v)
    assert.equal(v.counts.redeemed, 1); assert.equal(v.refused['auth/oob/redeem:pending'], 1); assert.equal(v.sessions, 1); assert.equal(v.open, 0); assert.equal(v.sessionsMayWrite, false)
    for (const secret of [kb.did, w.ka.did, ALICE, id, '198.51.100.7', '198.51.100.8']) assert.equal(text.includes(secret), false, secret)
  })

  test('over HTTP, with the page\'s own code as the browser: a key that cannot be read out, the code, the number, the session', async () => {
    const h = await room({ did: null, approvers: null, scope: null, publicUrl: '', holdMs: 80 }), person = newIdentity()
    const s = await serve({ door: h.door, signIn: h.signIn })
    try {
      const config = await (await fetch(`${s.base}/api/signin/config`)).json()
      assert.deepEqual(await (await fetch(`${s.base}/v1/member/sign-in/config`)).json(), config, 'also where OpenVTC\'s own client looks for it')
      assert.equal(config.on, true); assert.equal(config.vtcDid, h.key.did)
      const key = await newSessionKey()
      assert.equal(key.kept, 'webcrypto'); assert.equal(key.extractable, false); assert.ok(isEd25519DidKey(key.did))
      const post = async (doc, origin = s.base) => (await fetch(s.base + config.trustTasks, { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(doc) })).json()
      const browser = starter({ config, key, send: (doc) => post(doc) })
      await assert.rejects(starter({ config, key, send: (doc) => post(doc, 'https://evil.example') }).open(), /own page/)
      const opened = await browser.open()
      assert.equal(readTriggerLink(opened.link).from, h.key.did); assert.equal(readTriggerLink(opened.link).exp, opened.claimDeadline)
      assert.deepEqual(await browser.redeem(opened.requestId), { state: 'waiting', stage: 'pending' })
      const w = testWallet({ person, resolver: h.resolver, plainHttp: true, send: (doc, base) => post(doc, null).then((r) => { assert.equal(base, s.base); return r }) })
      assert.equal((await w.scan(opened.link, { base: s.base })).kind, 'response')
      const waiting = await browser.redeem(opened.requestId)
      assert.equal(waiting.stage, 'claimed'); assert.match(waiting.matchNumber, /^[0-9]{2}$/)
      assert.equal((await w.prove(waiting.matchNumber)).payload.requester.sameNetwork, true)
      assert.equal((await browser.redeem(opened.requestId)).stage, 'identified')
      assert.equal((await w.respond('approve')).payload.status, 'approved')
      const done = await browser.redeem(opened.requestId)
      assert.deepEqual({ state: done.state, subject: done.subject, amr: done.amr }, { state: 'signed-in', subject: person.did, amr: ['did', 'oob', 'uv'] })
      // what anyone can now read about that key, and check without the room's word
      const held = await (await fetch(`${s.base}/api/signin/session?key=${encodeURIComponent(key.did)}`)).json()
      assert.equal(held.subject, person.did); assert.equal(held.sessionEndsAt, done.sessionEndsAt); assert.equal(held.mayWrite, false)
      assert.equal(held.grant.payload.sessionKey, key.did); assert.equal(held.grant.issuer, person.did)
      assert.deepEqual(await verifyTask(held.grant, { keyFor: createResolver().keyFor, me: h.key.did, purposes: ['assertionMethod'] }), { ok: true, signer: person.did })
      assert.equal((await fetch(`${s.base}/api/signin/session?key=${encodeURIComponent(w.ka.did)}`)).status, 404)
      assert.equal((await fetch(`${s.base}/api/signin/session?key=nonsense`)).status, 404); assert.equal((await fetch(`${s.base}/api/signin/session`, { method: 'POST' })).status, 405)
      assert.equal((await (await fetch(`${s.base}/api/signin`)).json()).counts.redeemed, 1)
      // a declined sign-in, an expired one and a cancelled one, as the page hears them
      const b2 = starter({ config, key: await newSessionKey(), send: (doc) => post(doc) }), o2 = await b2.open()
      const w2 = testWallet({ person, resolver: h.resolver, plainHttp: true, send: (doc) => post(doc, null) })
      await w2.scan(o2.link, { base: s.base }); await w2.prove((await b2.redeem(o2.requestId)).matchNumber); await w2.respond('decline')
      assert.deepEqual(await b2.redeem(o2.requestId), { state: 'declined', cancelled: false })
      const o3 = await b2.open(); await b2.cancel(o3.requestId)
      assert.deepEqual(await b2.redeem(o3.requestId), { state: 'declined', cancelled: true })
      const o4 = await b2.open(); h.clock.t += CLAIM_SECONDS * 1000
      assert.deepEqual(await b2.redeem(o4.requestId), { state: 'expired' })
    } finally { await s.close() }
  })

  test('the live check itself (test/live), run against a room on this machine', async () => {
    const h = await room({ did: null, approvers: null, scope: null, publicUrl: '', holdMs: 60 })
    const s = await serve({ door: h.door, signIn: h.signIn })
    try {
      const done = await playSignIn({ url: s.base, resolver: h.resolver })
      assert.equal(done.kept, 'webcrypto'); assert.equal(done.session.origin, s.base)
    } finally { await s.close() }
  })

  test('a document signed by a session key is the same proof as any other, whichever way the key is held', async () => {
    const key = await newSessionKey(), doc = await signWith(taskDocument({ type: OOB.request, issuer: key.did, recipient: SERVICE, payload: { purpose: 'login', mode: 'scan' } }), key)
    assert.equal(doc.proof.cryptosuite, 'eddsa-jcs-2022'); assert.equal(doc.proof.proofPurpose, 'authentication'); assert.equal(doc.proof.verificationMethod, `${key.did}#${key.did.slice(8)}`)
    assert.deepEqual(await verifyTask(doc, { keyFor: createResolver().keyFor, me: SERVICE }), { ok: true, signer: key.did })
    await assert.rejects(signWith({ ...doc, issuer: newIdentity().did }, key), /signed by its issuer/)
    const subtle = Object.getOwnPropertyDescriptor(globalThis.crypto, 'subtle') ?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(globalThis.crypto), 'subtle')
    Object.defineProperty(globalThis.crypto, 'subtle', { value: undefined, configurable: true }) // a page on plain http has no WebCrypto
    try {
      const plain = await newSessionKey()
      assert.equal(plain.kept, 'memory'); assert.equal(plain.extractable, true)
      const d2 = await signWith(taskDocument({ type: OOB.redeem, issuer: plain.did, recipient: SERVICE, payload: { requestId: 'A'.repeat(22) } }), plain)
      assert.equal((await verifyTask(d2, { keyFor: createResolver().keyFor, me: SERVICE })).ok, true)
    } finally { delete globalThis.crypto.subtle; if (!globalThis.crypto.subtle && subtle) Object.defineProperty(globalThis.crypto, 'subtle', subtle) }
  })

  test('in the room itself: /api/info says whether it is on, the room\'s DID asks for a sign-in page, and the page is served its part', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wpi-signin-'))
    const ctx = await createApp({ ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, publicUrl: '', checkEveryMinutes: 0, boardDataUrl: 'data:application/json,{}', llm: { ...baseConfig.llm, apiKey: '' } }, { hostWelcomeMs: null })
    await new Promise((resolve) => ctx.server.listen(0, '127.0.0.1', resolve))
    try {
      const base = `http://127.0.0.1:${ctx.server.address().port}`
      const info = (await (await fetch(`${base}/api/info`)).json()).signIn
      assert.equal(info.linkHost, 'link.trustoverip.org'); assert.equal(info.flow, '/vti/flow/sign-in/0.1'); assert.equal(info.did, ctx.identity.did)
      assert.deepEqual(info.counts, { requested: 0, claimed: 0, proved: 0, approved: 0, declined: 0, redeemed: 0, cancelled: 0, expired: 0, proofFailed: 0 })
      assert.equal(info.on, Boolean(ctx.door), 'on exactly when the room has a Trust Task door'); if (!ctx.door) assert.match(info.why[0], /door/)
      const config = await fetch(`${base}/api/signin/config`)
      assert.equal(config.status, 200); assert.equal(config.headers.get('cache-control'), 'no-store'); assert.equal((await config.json()).serviceDid, ctx.identity.did)
      assert.equal((await fetch(`${base}/api/signin/session?key=${encodeURIComponent(newIdentity().did)}`)).status, 404)
      const page = await (await fetch(`${base}/`)).text()
      assert.match(page, /"\/signin\.js":"\/r\/[0-9a-f]{12}\/signin\.js"/, 'the page can load its sign-in module from this release')
      assert.equal((await fetch(`${base}/shared/signin.js`)).status, 200); assert.equal((await fetch(`${base}/signin.js`)).status, 200)
      // the six tasks are on the room's own Trust Task door, listed beside discovery and ping
      const door = (await (await fetch(`${base}/api/info`)).json()).door
      for (const task of ['request', 'claim', 'prove', 'respond', 'cancel', 'redeem']) assert.ok(door.serves.includes(OOB[task]), `the door serves ${task}`)
    } finally { await ctx.stop(); rmSync(dir, { recursive: true, force: true }) }
    // the room's DID document asks wallets to accept its own page as the place sign-in starts: https only
    const d = roomDidDocument({ did: 'did:webvh:abc:interop.example', roomPublicKey: newIdentity().publicKey, publicUrl: 'https://interop.example/x' })
    assert.deepEqual(d.service.find((x) => x.type === 'SignInPortal'), { id: 'did:webvh:abc:interop.example#sign-in-portal', type: 'SignInPortal', serviceEndpoint: 'https://interop.example/' })
    assert.equal(signInPortalEndpoint('http://localhost:3000'), ''); assert.equal(roomDidDocument({ did: 'did:webvh:abc:localhost%3A3000', roomPublicKey: newIdentity().publicKey, publicUrl: 'http://localhost:3000' }).service.some((x) => x.type === 'SignInPortal'), false)
  })

  test('in the room itself: a whole sign-in, browser and wallet, through the room\'s real POST /trust-tasks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wpi-signin-door-'))
    const ctx = await createApp({ ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, publicUrl: '', checkEveryMinutes: 0, boardDataUrl: 'data:application/json,{}', llm: { ...baseConfig.llm, apiKey: '' } }, { hostWelcomeMs: null })
    ctx.signIn.holdMs = 80 // a poll is held a moment, not the 25 seconds a real page waits
    await new Promise((resolve) => ctx.server.listen(0, '127.0.0.1', resolve))
    try {
      const base = `http://127.0.0.1:${ctx.server.address().port}`
      const before = ctx.door.counts.answered
      const done = await playSignIn({ url: base }) // the same exchange test/live plays against a running room
      assert.equal(done.config.trustTasks, '/trust-tasks'); assert.equal(done.session.origin, base); assert.equal(done.session.mayWrite, false)
      const counts = (await (await fetch(`${base}/api/info`)).json()).door.counts
      for (const task of ['request', 'claim', 'prove', 'respond', 'redeem']) assert.ok(counts.answeredByType[OOB[task]] >= 1, `the door answered ${task}`)
      assert.ok(ctx.door.counts.answered >= before + 5)
      // the room's attestations go out as sign-in signed them (assertionMethod), not signed again by the door; its other answers the door signs (authentication)
      const kb = newIdentity(), post = (doc) => fetch(`${base}/trust-tasks`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(doc) })
      const opened = await (await post(signedTask(kb, { type: OOB.request, recipient: ctx.identity.did, payload: { purpose: 'login', mode: 'scan' } }))).json()
      assert.equal(opened.type, `${OOB.request}#response`, JSON.stringify(opened.payload)); assert.equal(opened.proof.proofPurpose, 'authentication')
      const r = await post(signedTask(kb, { type: OOB.cancel, recipient: ctx.identity.did, payload: { requestId: opened.payload.requestId } }))
      const cancelled = await r.json()
      assert.equal(r.status, 200, JSON.stringify(cancelled.payload)); assert.equal(cancelled.type, `${OOB.cancel}#response`); assert.equal(cancelled.payload.status, 'cancelled'); assert.equal(cancelled.proof.proofPurpose, 'assertionMethod')
      assert.equal((await verifyTask(cancelled, { keyFor: createResolver().keyFor, me: kb.did, purposes: ['assertionMethod'] })).ok, true)
      // another website's page cannot open one through a person's browser: the door hands sign-in the page's Origin, not the room's own address
      const evil = await fetch(`${base}/trust-tasks`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify(signedTask(newIdentity(), { type: OOB.request, recipient: ctx.identity.did, payload: { purpose: 'login', mode: 'scan' } })) })
      assert.equal((await evil.json()).payload.code, 'permissionDenied')
      const none = await fetch(`${base}/trust-tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signedTask(newIdentity(), { type: OOB.request, recipient: ctx.identity.did, payload: { purpose: 'login', mode: 'scan' } })) })
      assert.equal((await none.json()).payload.code, 'permissionDenied', 'no Origin at all: not the room\'s page')
    } finally { await ctx.stop(); rmSync(dir, { recursive: true, force: true }) }
  })
})
