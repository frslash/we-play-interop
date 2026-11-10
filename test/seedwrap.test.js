import { test } from 'node:test'
import assert from 'node:assert/strict'
import { b64url, unb64url, wrapSeed, unwrapSeed } from '../src/shared/seedwrap.js'
import { assertionBody, creationOptions, prfAnswer, registrationBody, requestOptions } from '../src/shared/passkeyjson.js'

const rand = (n) => crypto.getRandomValues(new Uint8Array(n))
const DID = 'did:key:z6MkTestOnly'

test('base64url round-trips and refuses other text', () => {
  for (const n of [0, 1, 2, 3, 31, 32, 33, 60000]) { const b = rand(n); assert.deepEqual(unb64url(b64url(b)), b) }
  const big = new Uint8Array(100000).fill(200) // longer than one chunk of the encoder
  assert.deepEqual(unb64url(b64url(big)), big)
  assert.equal(b64url(new Uint8Array([251, 255, 254])), '-__-')
  for (const bad of ['a+b', 'a/b', 'a=', 'abcde', 'a b', 5]) assert.throws(() => unb64url(bad), /base64url/)
})

test('a wrapped key opens with the same answer and DID, and only then', async () => {
  const seed = rand(32), answer = rand(32)
  const w = await wrapSeed(seed, answer, DID)
  assert.deepEqual(Object.keys(w).sort(), ['ct', 'iv'])
  assert.equal(unb64url(w.iv).length, 12)
  assert.equal(unb64url(w.ct).length, 32 + 16)
  assert.deepEqual(await unwrapSeed(w, answer, DID), seed)
  await assert.rejects(unwrapSeed(w, rand(32), DID), 'another answer')
  await assert.rejects(unwrapSeed(w, answer, DID + 'x'), 'another DID')
  const ct = unb64url(w.ct); ct[5] ^= 1
  await assert.rejects(unwrapSeed({ iv: w.iv, ct: b64url(ct) }, answer, DID), 'a changed byte')
  const iv = unb64url(w.iv); iv[0] ^= 1
  await assert.rejects(unwrapSeed({ iv: b64url(iv), ct: w.ct }, answer, DID), 'a changed iv')
  await assert.rejects(unwrapSeed({ iv: w.iv }, answer, DID), 'a missing part')
})

test('the same key wrapped twice differs (fresh iv) and a too-short answer or key is refused', async () => {
  const seed = rand(32), answer = rand(32)
  const a = await wrapSeed(seed, answer, DID), b = await wrapSeed(seed, answer, DID)
  assert.notEqual(a.iv, b.iv); assert.notEqual(a.ct, b.ct)
  await assert.rejects(wrapSeed(seed, rand(4), DID))
  await assert.rejects(wrapSeed(rand(31), answer, DID))
})

test('a fixed wrapping is the one the contract describes (HKDF-SHA-256, empty salt, the stated info, DID as extra data)', async () => {
  const seed = new Uint8Array(32).fill(7), answer = new Uint8Array(32).fill(9), iv = new Uint8Array(12).fill(3)
  const base = await crypto.subtle.importKey('raw', answer, 'HKDF', false, ['deriveKey'])
  const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('inwove seed wrap v1') }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt'])
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(DID) }, key, seed)
  assert.deepEqual(await unwrapSeed({ iv: b64url(iv), ct: b64url(ct) }, answer, DID), seed)
})

test('the room\'s options become browser options, with the secret-answer request', () => {
  const salt = rand(32), c = rand(32), uid = rand(16), ex = rand(20)
  const o = creationOptions({ rp: { id: 'x.test', name: 'X' }, user: { id: b64url(uid), name: 'a', displayName: 'A' }, challenge: b64url(c), pubKeyCredParams: [{ type: 'public-key', alg: -7 }], timeout: 120000, attestation: 'none', authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' }, excludeCredentials: [{ type: 'public-key', id: b64url(ex) }], prfSalt: b64url(salt) })
  assert.deepEqual(o.challenge, c); assert.deepEqual(o.user.id, uid); assert.deepEqual(o.excludeCredentials[0].id, ex)
  assert.deepEqual(o.extensions, { prf: { eval: { first: salt } } })
  const g = requestOptions({ challenge: b64url(c), rpId: 'x.test', timeout: 120000, userVerification: 'preferred', prfSalt: b64url(salt) })
  assert.equal(g.rpId, 'x.test'); assert.deepEqual(g.extensions.prf.eval.first, salt); assert.equal(g.allowCredentials, undefined)
})

test('what the browser returns becomes the bodies the routes take', () => {
  const buf = (n, v) => new Uint8Array(n).fill(v).buffer
  const reg = registrationBody({ id: b64url(new Uint8Array(4).fill(1)), rawId: buf(4, 1), response: { clientDataJSON: buf(5, 2), getAuthenticatorData: () => buf(6, 3), getPublicKey: () => buf(7, 4), getPublicKeyAlgorithm: () => -7, getTransports: () => ['internal'] } }, { prf: true, wrappedSeed: { iv: 'a', ct: 'b' }, label: 'This device' })
  assert.deepEqual(reg, { id: 'AQEBAQ', rawId: 'AQEBAQ', clientDataJSON: b64url(buf(5, 2)), authenticatorData: b64url(buf(6, 3)), publicKey: b64url(buf(7, 4)), publicKeyAlgorithm: -7, transports: ['internal'], prf: true, wrappedSeed: { iv: 'a', ct: 'b' }, label: 'This device' })
  const as = assertionBody({ id: 'AQEBAQ', rawId: buf(4, 1), response: { clientDataJSON: buf(5, 2), authenticatorData: buf(6, 3), signature: buf(8, 5), userHandle: null } })
  assert.equal(as.userHandle, null); assert.equal(as.signature, b64url(buf(8, 5)))
  assert.equal(prfAnswer({}), null); assert.equal(prfAnswer({ prf: { enabled: true } }), null)
  assert.deepEqual(prfAnswer({ prf: { results: { first: buf(32, 9) } } }), new Uint8Array(32).fill(9))
})
