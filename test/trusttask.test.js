// Standard Trust Task documents: the shape, the proof, the freshness window and the replies other projects' services
// expect (OpenVTC's trust agent, community and room host; RLTP's shared-connect). See src/shared/trusttask.js.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { fromBase58btc, multibase } from '../src/shared/crypto.js'
import { newIdentity } from '../src/shared/did.js'
import { createResolver } from '../src/server/resolver.js'
import {
  ACCEPT_MS, ERROR_TYPE, MAX_DOCUMENT_BYTES, MAX_EXPIRY_MS, SKEW_MS, acceptedUntil, checkTask, classify, instant, isError, multihashOf, parseType, postTask, refusalTo, responseTo, sameDid, sameDigest,
  seedFromPrivateMultibase, serviceEndpoint, signedTask, signerOf, statusFor, taskDocument, typeUri, verifyTask,
} from '../src/shared/trusttask.js'

const keyFor = createResolver().keyFor
const service = newIdentity(), person = newIdentity(), other = newIdentity()
const JOIN = typeUri('vtc/join-requests/submit', '0.3')

test('a type address is https://trusttasks.org/spec/<family>/<major.minor>, with #response for the answer', () => {
  assert.equal(JOIN, 'https://trusttasks.org/spec/vtc/join-requests/submit/0.3')
  assert.deepEqual(parseType(JOIN), { family: 'vtc/join-requests/submit', version: '0.3', response: false })
  assert.deepEqual(parseType(`${JOIN}#response`), { family: 'vtc/join-requests/submit', version: '0.3', response: true })
  for (const no of ['https://trusttasks.org/spec/vtc/join/1', 'https://trusttasks.org/openvtc/vtc/join/0.1', 'http://trusttasks.org/spec/a/0.1', 'urn:we-play-interop:tasks:spec:note:0.1', '', null]) assert.equal(parseType(no), null, String(no))
})

test('a time is whole seconds, never ".000Z"', () => {
  assert.equal(instant(Date.parse('2026-11-09T12:00:00.000Z')), '2026-11-09T12:00:00Z')
  assert.equal(instant(Date.parse('2026-11-09T12:00:00.987Z')), '2026-11-09T12:00:00Z')
  assert.match(taskDocument({ type: JOIN, issuer: person.did, recipient: service.did }).issuedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
})

test('a member that is not set is left out, never null', () => {
  const doc = taskDocument({ type: JOIN, issuer: person.did, recipient: service.did, payload: { vp: { type: 'VerifiablePresentation', holder: person.did } } })
  assert.deepEqual(Object.keys(doc), ['id', 'type', 'issuer', 'recipient', 'issuedAt', 'payload'])
  assert.match(doc.id, /^urn:uuid:[0-9a-f-]{36}$/)
  assert.equal(JSON.stringify(doc).includes('null'), false)
})

test('a signed document verifies: its proof is eddsa-jcs-2022 by its issuer, for authentication unless told otherwise', async () => {
  const doc = signedTask(person, { type: JOIN, recipient: service.did, payload: { a: 1 } })
  assert.equal(doc.proof.cryptosuite, 'eddsa-jcs-2022'); assert.equal(doc.proof.proofPurpose, 'authentication'); assert.equal(doc.proof.created, doc.issuedAt)
  assert.equal(signerOf(doc), person.did)
  assert.deepEqual(await verifyTask(doc, { keyFor, me: service.did }), { ok: true, signer: person.did })
  const grant = signedTask(person, { type: typeUri('auth/oob/grant', '0.3'), recipient: service.did }, { purpose: 'assertionMethod' })
  assert.equal(grant.proof.proofPurpose, 'assertionMethod')
  assert.equal((await verifyTask(grant, { keyFor, me: service.did })).ok, true)
  assert.equal((await verifyTask(grant, { keyFor, me: service.did, purposes: ['authentication'] })).code, 'proofInvalid') // an attestation is not a request
})

test('each way a document can be wrong gets the code every Trust Task consumer shares', async () => {
  const now = Date.parse('2026-11-09T12:00:00Z'), at = (ms) => instant(now + ms)
  const mk = (over = {}, id = person) => signedTask(id, { type: JOIN, recipient: service.did, issuedAt: at(0), ...over })
  const code = async (doc, opts = {}) => (await verifyTask(doc, { keyFor, me: service.did, now, ...opts })).code ?? 'ok'
  assert.equal(await code(mk()), 'ok')
  assert.equal(await code(mk({ issuedAt: at(-ACCEPT_MS - SKEW_MS - 2000) })), 'expired') // older than ten minutes and the slack
  assert.equal(await code(mk({ issuedAt: at(-ACCEPT_MS) })), 'ok') // ten minutes old still passes
  assert.equal(await code(mk({ issuedAt: at(SKEW_MS + 2000) })), 'malformedRequest') // from the future: never good, so not "expired" (waiting will not fix it)
  assert.equal(await code(mk({ issuedAt: at(SKEW_MS - 2000) })), 'ok') // a clock a little ahead is the ordinary case
  assert.equal(await code(mk({ issuedAt: at(-3600_000), expiresAt: at(3600_000) })), 'ok') // it states its own expiry
  assert.equal(await code(mk({ issuedAt: at(-3600_000), expiresAt: at(-120_000) })), 'expired')
  assert.equal(await code(mk({ expiresAt: at(0) })), 'malformedRequest') // an expiry at its own issuedAt: no moment it was good
  assert.equal(await code(mk({ issuedAt: at(-60_000), expiresAt: at(-90_000) })), 'malformedRequest')
  assert.equal(await code(mk({ expiresAt: at(31 * 24 * 3600_000) })), 'ok') // an expiry past thirty days counts as thirty days, it is not refused
  assert.equal(await code(mk({ issuedAt: at(-MAX_EXPIRY_MS - SKEW_MS - 2000), expiresAt: at(24 * 3600_000) })), 'expired') // thirty days after it was written, whatever it says
  assert.equal(await code(mk({ issuedAt: at(-2 * 3600_000), expiresAt: at(3600_000) }), { horizonMs: 3600_000 }), 'expired') // a consumer may honour a stated expiry for less
  assert.equal(await code(mk({ issuedAt: '2026-13-45T25:61:61Z' })), 'malformedRequest') // the shape of a time, and no time at all: it must not pass as forever fresh
  assert.equal(await code(mk({ expiresAt: '2026-02-31T00:00:00+99:00' })), 'malformedRequest')
  assert.equal(await code(mk({ recipient: other.did })), 'wrongRecipient')
  assert.equal(await code(mk({ recipient: undefined })), 'malformedRequest') // it must name who it is for; one that names nobody was never good
  assert.equal(await code(mk({ recipient: undefined }), { requireRecipient: false }), 'ok')
  assert.equal(await code(mk({ recipient: other.did }), { me: [service.did, other.did] }), 'ok') // a service that answers to more than one DID
  assert.equal(await code(mk({ recipient: person.did }), { me: [service.did, other.did] }), 'wrongRecipient')
  assert.equal(acceptedUntil({ issuedAt: at(0) }), now + ACCEPT_MS + SKEW_MS) // also how long the record of an accepted id is kept
  assert.equal(acceptedUntil({ issuedAt: at(0), expiresAt: at(3600_000) }), now + 3600_000 + SKEW_MS)
  assert.equal(acceptedUntil({ issuedAt: at(0), expiresAt: at(90 * 24 * 3600_000) }), now + MAX_EXPIRY_MS + SKEW_MS)
  const { proof, ...unsigned } = mk()
  assert.equal(await code(unsigned), 'proofRequired')
  assert.equal(await code({ ...mk(), payload: { changed: true } }), 'proofInvalid')
  assert.equal(await code({ ...mk({}, other), issuer: person.did }), 'proofInvalid') // signed by someone other than its issuer
  assert.equal(await code(mk(), { bytes: MAX_DOCUMENT_BYTES + 1 }), 'malformedRequest')
  assert.deepEqual(checkTask(mk(), { me: service.did, now, bytes: MAX_DOCUMENT_BYTES + 1 }).details, { maxBytes: MAX_DOCUMENT_BYTES })
  for (const bad of [null, [], { id: 'x' }, { ...unsigned, issuedAt: undefined }, { ...unsigned, payload: 'text' }, { ...unsigned, issuer: 'not-a-did' }]) assert.equal(checkTask(bad, { now }).code, 'malformedRequest')
})

test('an answer is the request\'s type with #response; a refusal is a trust-task-error, small and addressed back', () => {
  const req = signedTask(person, { type: JOIN, recipient: service.did })
  const ok = responseTo(req, { requestId: 'r1' }, service.did)
  assert.equal(ok.type, `${JOIN}#response`); assert.equal(ok.recipient, person.did); assert.equal(ok.threadId, req.id); assert.equal(ok.issuer, service.did)
  assert.deepEqual(classify(ok, JOIN), { kind: 'response', payload: { requestId: 'r1' } })
  const refused = refusalTo(req, { code: 'unsupportedVersion', message: 'this room serves 0.3', details: { servedVersions: ['0.3'] } }, service.did)
  assert.equal(refused.type, ERROR_TYPE); assert.equal(isError(refused), true); assert.equal(refused.recipient, person.did)
  assert.equal(classify(refused, JOIN).code, 'unsupportedVersion'); assert.deepEqual(classify(refused).details, { servedVersions: ['0.3'] })
  assert.equal(classify({ type: 'https://trusttasks.org/spec/trust-task-error/0.3', payload: { code: 'expired' } }).kind, 'error') // any version of the error type
  assert.equal(classify({ type: 'https://trusttasks.org/spec/trust-task-next-step/0.1', payload: {} }).kind, 'next-step')
  assert.equal(refusalTo(req, { code: 'x', message: 'y', details: { big: 'z'.repeat(5000) } }, service.did).payload.details, undefined) // too large: dropped, the code stays
  const unread = refusalTo(null, { code: 'malformedRequest', message: 'not JSON' }, service.did)
  assert.equal(unread.recipient, undefined); assert.equal(unread.threadId, undefined)
  assert.equal(statusFor('permissionDenied'), 403); assert.equal(statusFor('idConflict'), 409); assert.equal(statusFor('auth/oob/redeem:pending'), 422); assert.equal(statusFor('taskFailed'), 422)
})

test('a refusal has the members of the registry\'s error and no others, and always says whether to try again', () => {
  const req = signedTask(person, { type: JOIN, recipient: service.did })
  const members = ['code', 'retryable', 'inResponseTo', 'message', 'retryAfter', 'details'] // trust-task-error 0.3 to 0.6, as RLTP's reader holds an error to them (lib/src/adapters/vti-mediator.ts)
  const no = refusalTo(req, { code: 'permissionDenied', message: 'join first' }, service.did).payload
  assert.deepEqual(no, { code: 'permissionDenied', retryable: false, message: 'join first', inResponseTo: { typeUri: JOIN, id: req.id } })
  const later = refusalTo(req, { code: 'unavailable', message: 'busy', retryAfter: '2026-11-09T12:01:00Z', details: { why: 'restarting' } }, service.did).payload
  assert.equal(later.retryable, true); assert.equal(later.retryAfter, '2026-11-09T12:01:00Z')
  assert.ok(Object.keys(later).every((k) => members.includes(k)))
  assert.equal(refusalTo(req, { code: 'vtc/x:busy', message: 'm', retryable: true }, service.did).payload.retryable, true) // a task's own code is not retryable unless it says so
  assert.equal(refusalTo(req, { code: 'vtc/x:busy', message: 'm' }, service.did).payload.retryable, false)
  assert.equal([...refusalTo(req, { code: 'taskFailed', message: 'é'.repeat(3000) }, service.did).payload.message].length, 1024)
  const unread = refusalTo({ id: 'x'.repeat(500), type: 7, threadId: { a: 1 } }, { code: 'malformedRequest', message: 'no' }, service.did) // nothing unchecked is copied into the answer
  assert.equal(unread.threadId, undefined); assert.equal(unread.payload.inResponseTo, undefined)
})

test('the status that goes with a refusal over https is the binding\'s table: 400, 403, 409, 503, 500, and 422 for the rest', () => {
  assert.deepEqual(['malformedRequest', 'permissionDenied', 'idConflict', 'unavailable', 'internalError'].map(statusFor), [400, 403, 409, 503, 500])
  for (const c of ['unsupportedType', 'unsupportedVersion', 'expired', 'proofRequired', 'proofInvalid', 'wrongRecipient', 'identityMismatch', 'cancelled', 'taskFailed', 'indeterminate', 'rooms:versionConflict']) assert.equal(statusFor(c), 422, c)
})

test('postTask sends to <base>/trust-tasks with no token, and goes by the answer\'s type', async () => {
  const calls = []
  const reply = (status, body) => async (url, init) => { calls.push({ url, init }); return new Response(body === null ? null : JSON.stringify(body), { status }) }
  const req = signedTask(person, { type: JOIN, recipient: service.did })
  const a = await postTask('https://vtc.example/v1/', req, { fetch: reply(200, responseTo(req, { requestId: 'r' }, service.did)) })
  assert.equal(calls[0].url, 'https://vtc.example/v1/trust-tasks'); assert.equal(calls[0].init.headers.authorization, undefined); assert.deepEqual(JSON.parse(calls[0].init.body), req)
  assert.equal(a.kind, 'response'); assert.deepEqual(a.payload, { requestId: 'r' })
  const b = await postTask('https://vtc.example/v1', req, { fetch: reply(403, refusalTo(req, { code: 'auth/oob/redeem:pending', message: 'waiting', details: { matchNumber: '42' } }, service.did)) })
  assert.equal(b.kind, 'error'); assert.equal(b.code, 'auth/oob/redeem:pending'); assert.equal(b.details.matchNumber, '42')
  assert.equal((await postTask('https://x.example', req, { fetch: reply(202, null) })).kind, 'in-flight')
  assert.equal((await postTask('https://x.example', req, { fetch: reply(429, null) })).kind, 'slow-down')
  await postTask('https://vta.example', req, { fetch: reply(204, null), bearer: 'tok' })
  assert.equal(calls.at(-1).init.headers.authorization, 'Bearer tok')
})

test('a service is found in a DID document by its type, never by its #id', () => {
  const doc = { service: [{ id: '#whatever', type: 'LinkedDomains', serviceEndpoint: 'https://a.example/' }, { id: '#x', type: 'TrustTaskHTTPS', serviceEndpoint: 'https://vtc.example/v1' }, { id: '#d', type: 'DIDCommMessaging', serviceEndpoint: [{ uri: 'did:webvh:abc:mediator.example', accept: ['didcomm/v2'] }] }, { id: '#t', type: ['TSPTransport'], serviceEndpoint: { uri: 'did:webvh:abc:mediator.example' } }] }
  assert.equal(serviceEndpoint(doc, 'TrustTaskHTTPS'), 'https://vtc.example/v1')
  assert.equal(serviceEndpoint(doc, 'DIDCommMessaging'), 'did:webvh:abc:mediator.example')
  assert.equal(serviceEndpoint(doc, 'TSPTransport'), 'did:webvh:abc:mediator.example')
  assert.equal(serviceEndpoint(doc, 'VTARest'), null)
})

test('digests bind one document to another: "z" + base58btc(0x12 0x20 + SHA-256 of the canonical JSON)', () => {
  const v = { b: 2, a: [1, 'x'] }, d = multihashOf(v)
  const bytes = fromBase58btc(d.slice(1))
  assert.equal(d[0], 'z'); assert.equal(bytes[0], 0x12); assert.equal(bytes[1], 0x20)
  assert.equal(Buffer.from(bytes.slice(2)).toString('hex'), createHash('sha256').update('{"a":[1,"x"],"b":2}').digest('hex'))
  assert.equal(multihashOf({ a: [1, 'x'], b: 2 }), d) // key order does not matter
  assert.equal(sameDigest(d, 'u' + Buffer.from(bytes).toString('base64url')), true) // the base64url spelling of the same bytes
  assert.equal(sameDigest(d, multihashOf({ a: 1 })), false); assert.equal(sameDigest(d, 'nonsense'), false); assert.equal(sameDigest(null, d), false)
})

test('a did:scid "src" hint is not part of who someone is; a private key reads in both spellings', () => {
  assert.equal(sameDid('did:scid:vh:1:abc?src=example.org/x', 'did:scid:vh:1:abc'), true)
  assert.equal(sameDid(person.did, other.did), false)
  assert.deepEqual([...seedFromPrivateMultibase(multibase(person.seed))], [...person.seed])
  assert.deepEqual([...seedFromPrivateMultibase(multibase(new Uint8Array([0x80, 0x26, ...person.seed])))], [...person.seed])
  assert.throws(() => seedFromPrivateMultibase(multibase(new Uint8Array(10))), /not an Ed25519 private key/)
})
