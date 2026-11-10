// Passkey checks against the WebAuthn specification's own test vectors, one per algorithm the room accepts (ES256,
// EdDSA/Ed25519, RS256), then the refusals the security review asks for, each starting from a real vector.
//
// Source: Web Authentication Level 3, https://www.w3.org/TR/webauthn-3/ section 16 "Test Vectors", read 2026-11-09:
//   ES256   16.2  "ES256 Credential with No Attestation"
//   RS256   16.10 "Packed Attestation with RS256 Credential"
//   EdDSA   16.11 "Packed Attestation with Ed25519 Credential"
// (all use RP ID example.org and origin https://example.org). For each, registration gives clientDataJSON and the
// attestationObject (whose authData holds the credential id and the COSE public key), and authentication gives
// clientDataJSON, authenticatorData and signature. The values are the specification's, copied unchanged; hex as printed.
// The room's registration takes attestation "none", so the packed attestation statements in 16.10 and 16.11 are not read:
// only their authData, as the browser would hand it.
import assert from 'node:assert/strict'
import { createPublicKey } from 'node:crypto'
import { describe, test } from 'node:test'
import { ALGS, PasskeyError, verifyRegistration, verifySignIn } from '../src/server/passkey.js'
import { Challenges } from '../src/server/session.js'

// Vectors copied from https://www.w3.org/TR/webauthn-3/ section 16 (Test Vectors), read 2026-11-09.
export const VECTORS = {
  // 16.2. ES256 Credential with No Attestation
  ES256: {
    rc: '7b2274797065223a22776562617574686e2e637265617465222c226368616c6c656e6765223a22414d4d507434557878475453746e63647134313759447742466938767049612d7077386f4f755657345441222c226f726967696e223a2268747470733a2f2f6578616d706c652e6f7267222c2263726f73734f726967696e223a66616c73652c22657874726144617461223a22636c69656e74446174614a534f4e206d617920626520657874656e6465642077697468206164646974696f6e616c206669656c647320696e20746865206675747572652c207375636820617320746869733a20426b5165446a646354427258426941774a544c453551227d',
    ao: 'a363666d74646e6f6e656761747453746d74a068617574684461746158a4bfabc37432958b063360d3ad6461c9c4735ae7f8edd46592a5e0f01452b2e4b559000000008446ccb9ab1db374750b2367ff6f3a1f0020f91f391db4c9b2fde0ea70189cba3fb63f579ba6122b33ad94ff3ec330084be4a5010203262001215820afefa16f97ca9b2d23eb86ccb64098d20db90856062eb249c33a9b672f26df61225820930a56b87a2fca66334b03458abf879717c12cc68ed73290af2e2664796b9220',
    ac: '7b2274797065223a22776562617574686e2e676574222c226368616c6c656e6765223a224f63446e55685158756c5455506f334a5558543049393770767a7a59425039745a63685879617630314167222c226f726967696e223a2268747470733a2f2f6578616d706c652e6f7267222c2263726f73734f726967696e223a66616c73657d',
    ad: 'bfabc37432958b063360d3ad6461c9c4735ae7f8edd46592a5e0f01452b2e4b51900000000',
    sg: '3046022100f50a4e2e4409249c4a853ba361282f09841df4dd4547a13a87780218deffcd380221008480ac0f0b93538174f575bf11a1dd5d78c6e486013f937295ea13653e331e87',
    cid: 'f91f391db4c9b2fde0ea70189cba3fb63f579ba6122b33ad94ff3ec330084be4',
  },
  // 16.10. Packed Attestation with RS256 Credential
  RS256: {
    rc: '7b2274797065223a22776562617574686e2e637265617465222c226368616c6c656e6765223a2276716a776477414a76566679774e3976367039304f69666b7468752d6b6a79474c48717465705f49354b59222c226f726967696e223a2268747470733a2f2f6578616d706c652e6f7267222c2263726f73734f726967696e223a66616c73657d',
    ao: 'a363666d74667061636b65646761747453746d74a363616c672663736967584730450221008b8c5c6ea8c142c032e0be69e1353d44461c5c9109941cdda951b976eb95b6b302204d52f406c19e254b3ff9589bd18070fb055ac8db12fdd0a6734bea9d7168e900637835638159022630820222308201c7a00302010202101f6fb7a5ece81b45896b983a995da5f3300a06082a8648ce3d0403023062311e301c06035504030c15576562417574686e207465737420766563746f7273310c300a060355040a0c0357334331253023060355040b0c1c41757468656e74696361746f72204174746573746174696f6e204341310b30090603550406130241413020170d3234303130313030303030305a180f33303234303130313030303030305a305f311e301c06035504030c15576562417574686e207465737420766563746f7273310c300a060355040a0c0357334331223020060355040b0c1941757468656e74696361746f72204174746573746174696f6e310b30090603550406130241413059301306072a8648ce3d020106082a8648ce3d03010703420004b7b36b7542a11120b443c794d0c99fdc25a06b76586413d81e086163ef6fe147a557afc34e2861d9057d6d465d4705a0310550bdeeb5f35ee35b9425ab859981a360305e300c0603551d130101ff04023000300e0603551d0f0101ff040403020780301d0603551d0e04160414fb37b647bccfb9e54d989eaaacc1633868703fb3301f0603551d2304183016801445aff715b0dd786741fee996ebc16547a3931b1e300a06082a8648ce3d0403020349003046022100b86bc129d92afca7d9869a39f70f139a305b4073a39eb654d81424bed5757d91022100cf9f7c60cab7c4a7d3e7f0020f281a93d4fd0a9f95121b989f56932a68885fba68617574684461746159021bbfabc37432958b063360d3ad6461c9c4735ae7f8edd46592a5e0f01452b2e4b55d00000000428f8878298b9862a36ad8c7527bfef20020992a18acc83f67533600c1138a4b4c4bd236de13629cf025ed17cb00b00b74dfa4010303390100205901b403fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff800000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000012143010001',
    ac: '7b2274797065223a22776562617574686e2e676574222c226368616c6c656e6765223a224b56395a39667150356978617970346e596d7834794e6f33617562597a5333536d75757459423462784d55222c226f726967696e223a2268747470733a2f2f6578616d706c652e6f7267222c2263726f73734f726967696e223a66616c73657d',
    ad: 'bfabc37432958b063360d3ad6461c9c4735ae7f8edd46592a5e0f01452b2e4b51900000000',
    sg: '01063d52d7c39b4d432fc7063c5d93e582bdcb16889cd71f888d67d880ea730a428498d3bc8e1ee11f2b1ecbe6c292b118c55ffaaddefa8cad0a54dd137c51f1eec673f1bb6c4d1789d6826a222b22d0f585fc901fdc933212e579d199b89d672aa44891333e6a1355536025e82b25590256c3538229b55737083b2f6b9377e49e2472f11952f79fdd0da180b5ffd901b4049a8f081bb40711bef76c62aed943571f2d0575304cb549d68d8892f95086a30f93716aee818f8dc06e96c0d5e0ed4cfa9fd8773d90464b68cf140f7986666ff9c9e3302acd0535d60d769f465e2ab57ef8aabc89fccfef7ba32a64154a8b3d26be2298f470b8cc5377dbe3dfd4b0b45f8f01e63bde6cfc76b62771f9b70aa27cf40152cad93aa5acd784fd4b90f676e2ea828d0bf2400aebbaae4153e5838f537f88b6228346782a93a899be66ec77de45b3efcf311da6321c92e6b0cd11bfe653bf3e98cee8e341f02d67dbb6f9c98d9e8178090cfb5b70fbc6d541599ac794ae2f1d4de1286ec8de8c2daf7b1d15c8438e90d924df5c19045220a4c8438c1b979bbe016cf3d0eeec23c3999d4882cc645b776de930756612cdc6dd398160ff02a6',
    cid: '992a18acc83f67533600c1138a4b4c4bd236de13629cf025ed17cb00b00b74df',
  },
  // 16.11. Packed Attestation with Ed25519 Credential
  EdDSA: {
    rc: '7b2274797065223a22776562617574686e2e637265617465222c226368616c6c656e6765223a22714b763532723347734e396a526d733576616e6f6f306f303459557a656c6e7878586d5a426e6254733730222c226f726967696e223a2268747470733a2f2f6578616d706c652e6f7267222c2263726f73734f726967696e223a66616c73652c22657874726144617461223a22636c69656e74446174614a534f4e206d617920626520657874656e6465642077697468206164646974696f6e616c206669656c647320696e20746865206675747572652c207375636820617320746869733a20425f44543567375a445f2d394f544c59583549764551227d',
    ao: 'a363666d74667061636b65646761747453746d74a363616c67266373696758483046022100d83f60bd80269537583218858aefb03ac57d45fa06e42feaae332d187f62da9f022100a02bd3cb6f7e1d283c93bad1f3f4b5a4c0494463da7fdbf256949116754d1f17637835638159022730820223308201c8a003020102021100b2cfc9ea33c8643b0e1a760463eaf164300a06082a8648ce3d0403023062311e301c06035504030c15576562417574686e207465737420766563746f7273310c300a060355040a0c0357334331253023060355040b0c1c41757468656e74696361746f72204174746573746174696f6e204341310b30090603550406130241413020170d3234303130313030303030305a180f33303234303130313030303030305a305f311e301c06035504030c15576562417574686e207465737420766563746f7273310c300a060355040a0c0357334331223020060355040b0c1941757468656e74696361746f72204174746573746174696f6e310b30090603550406130241413059301306072a8648ce3d020106082a8648ce3d03010703420004dd2b7a564b73b8c0b81c4c62e521925c4d1198ec9f583dbf1eebe364b65cd9c29a9bdf346aaa81fb6b9507e5249a52fdaf8e39e26b0b7dc45992a7e233b70f70a360305e300c0603551d130101ff04023000300e0603551d0f0101ff040403020780301d0603551d0e041604140ae27546bc7eccb1b4b597bd354f0c0b1f1f8f8e301f0603551d2304183016801445aff715b0dd786741fee996ebc16547a3931b1e300a06082a8648ce3d0403020349003046022100a0d434ecb5fc3bfd7da5f41904517ad2836249f561bd834ba7a438a8ab7a4ce8022100fac845bb7a02513b58e9f319654dbe49b0f02b95835bac568c71f8a18cdde9ab6861757468446174615881bfabc37432958b063360d3ad6461c9c4735ae7f8edd46592a5e0f01452b2e4b54100000000d5aa33581e8ca478e20fe713f5d32ff20020ce9f840ed96599580cd140fbc7bb3230633f50f61041aff73308ae71caa8a2bda401010327200621582044e06ddd331c36a8dc667bab52bcae63486c916aa5e339e6acebaa84934bf832',
    ac: '7b2274797065223a22776562617574686e2e676574222c226368616c6c656e6765223a2269566c583442786a4f6d6d44534b4c596f7870557439736e364d48454f7943413135726947514a6e763949222c226f726967696e223a2268747470733a2f2f6578616d706c652e6f7267222c2263726f73734f726967696e223a66616c73657d',
    ad: 'bfabc37432958b063360d3ad6461c9c4735ae7f8edd46592a5e0f01452b2e4b50100000000',
    sg: 'f5c59c7e46c34f6f8cc197101ddf9934fa2595f68eb1913a637e8419eb9ba4cfdfc48f85393bc0d40b011f0d6fecb097d6607525713223a0dc0d453993dae00b',
    cid: 'ce9f840ed96599580cd140fbc7bb3230633f50f61041aff73308ae71caa8a2bd',
  },
}

// The vectors give their values as hex; the room takes base64url. Nothing below changes a vector's bytes except the
// tests that say they flip one.
const RP = { id: 'example.org', origin: 'https://example.org' } // "All examples use the RP ID example.org, the origin https://example.org"
const ALGNUM = { ES256: -7, EdDSA: -8, RS256: -257 }
const hex = (h) => Buffer.from(h, 'hex')
const b64u = (b) => Buffer.from(b).toString('base64url')
const DID = 'did:example:test-person'

// A minimal CBOR reader (what a COSE key and an attestation object use: ints, byte and text strings, arrays, maps).
function cborAt (buf, o = 0) {
  const major = buf[o] >> 5, info = buf[o] & 31
  let n = info, p = o + 1
  if (info === 24) { n = buf[p]; p += 1 } else if (info === 25) { n = buf.readUInt16BE(p); p += 2 } else if (info === 26) { n = buf.readUInt32BE(p); p += 4 } else if (info > 26) throw new Error('cbor: unsupported')
  if (major === 0) return [n, p]
  if (major === 1) return [-1 - n, p]
  if (major === 2) return [buf.subarray(p, p + n), p + n]
  if (major === 3) return [buf.subarray(p, p + n).toString('utf8'), p + n]
  if (major === 4) { const a = []; for (let i = 0; i < n; i++) { const [v, q] = cborAt(buf, p); a.push(v); p = q } return [a, p] }
  if (major === 5) { const m = new Map(); for (let i = 0; i < n; i++) { const [k, q] = cborAt(buf, p), [v, r] = cborAt(buf, q); m.set(k, v); p = r } return [m, p] }
  throw new Error('cbor: unsupported major type')
}

/**
 * From a vector's registration: the authenticatorData, the credential id, and the public key as SPKI. The specification
 * gives the key as a COSE key inside authenticatorData, so it is converted here with node:crypto: the COSE fields become a
 * JWK (EC2 P-256 x,y; OKP Ed25519 x; RSA n,e) and createPublicKey exports it as SPKI DER, the form the room stores.
 */
function registrationOf (v) {
  const [ao] = cborAt(hex(v.ao)), authData = ao.get('authData')
  const idLen = authData.readUInt16BE(53), credentialId = authData.subarray(55, 55 + idLen)
  const [cose] = cborAt(authData, 55 + idLen)
  const kty = cose.get(1), alg = cose.get(3), jwk = {}
  if (kty === 2) Object.assign(jwk, { kty: 'EC', crv: 'P-256', x: b64u(cose.get(-2)), y: b64u(cose.get(-3)) }) // -1 (crv) is 1 = P-256
  else if (kty === 1) Object.assign(jwk, { kty: 'OKP', crv: 'Ed25519', x: b64u(cose.get(-2)) }) // -1 (crv) is 6 = Ed25519
  else if (kty === 3) Object.assign(jwk, { kty: 'RSA', n: b64u(cose.get(-1)), e: b64u(cose.get(-2)) })
  const spki = createPublicKey({ key: jwk, format: 'jwk' }).export({ type: 'spki', format: 'der' })
  return { authData, credentialId, alg, spki }
}

const challengeOf = (clientDataB64u) => JSON.parse(Buffer.from(clientDataB64u, 'base64url').toString('utf8')).challenge

/** The room's own challenge store, holding exactly the challenge a vector was made with, issued `kind` for `meta`. */
function storeWith (challenge, kind, meta = {}, opts = {}) {
  const c = new Challenges(opts)
  c.held.set(challenge, { kind, meta, until: c.now() + c.ttlMs })
  return c
}

for (const alg of ['ES256', 'EdDSA', 'RS256']) {
  const v = VECTORS[alg]
  const reg = registrationOf(v)
  const ID = b64u(hex(v.cid))

  const registerBody = (over = {}) => ({ id: ID, rawId: ID, clientDataJSON: b64u(hex(v.rc)), authenticatorData: b64u(reg.authData), publicKey: b64u(reg.spki), publicKeyAlgorithm: reg.alg, transports: [], prf: false, wrappedSeed: null, label: 'Vector', ...over })
  const register = (body = registerBody(), { rp = RP, challenges = storeWith(challengeOf(b64u(hex(v.rc))), 'register', { did: DID }) } = {}) => verifyRegistration(body, { did: DID, rp, challenges })

  const stored = (over = {}) => ({ id: ID, did: DID, publicKey: b64u(reg.spki), alg: reg.alg, counter: 0, ...over })
  const signInBody = (over = {}) => ({ id: ID, rawId: ID, clientDataJSON: b64u(hex(v.ac)), authenticatorData: b64u(hex(v.ad)), signature: b64u(hex(v.sg)), userHandle: null, ...over })
  /** Signs in with the vector (or a changed copy of it). The store holds the challenge the body's clientDataJSON carries, so only what the test changed can refuse it. */
  const signIn = (body = signInBody(), { rp = RP, cred = stored(), challenges, find } = {}) =>
    verifySignIn(body, { rp, challenges: challenges ?? storeWith(challengeOf(body.clientDataJSON), 'signin'), find: find ?? ((id) => (id === ID ? cred : null)) })

  const flip = (b64, at) => { const b = Buffer.from(b64, 'base64url'); b[at < 0 ? b.length + at : at] ^= 0x01; return b64u(b) }
  const refused = (status, message) => (e) => e instanceof PasskeyError && e.status === status && message.test(e.message)

  describe(`${alg} (${ALGNUM[alg]}): the specification's own vector`, () => {
    test('the vector is what it says: the credential id and algorithm in its registration', () => {
      assert.equal(reg.alg, ALGNUM[alg]); assert.deepEqual(reg.credentialId, hex(v.cid))
      assert.ok(ALGS[String(reg.alg)], 'the room accepts this algorithm')
    })

    test('registration is accepted, and keeps the vector\'s credential id, key and algorithm', () => {
      const r = register()
      assert.equal(r.id, ID); assert.equal(r.alg, ALGNUM[alg]); assert.equal(r.publicKey, b64u(reg.spki)); assert.equal(r.did, DID); assert.equal(r.counter, 0)
    })

    test('registration is refused when the credential id inside authenticatorData is changed by one byte', () => {
      const ad = Buffer.from(reg.authData); ad[55 + 4] ^= 0x01
      assert.throws(() => register(registerBody({ authenticatorData: b64u(ad) })), refused(400, /not the one you named/))
    })

    test('sign-in is accepted with the stored credential and a store holding the vector\'s challenge', () => {
      const store = storeWith(challengeOf(b64u(hex(v.ac))), 'signin')
      const r = signIn(signInBody(), { challenges: store })
      assert.equal(r.credential.id, ID); assert.equal(r.counter, 0)
      assert.equal(store.held.size, 0, 'the challenge is used up')
    })

    test('changing one byte of the signature makes it refuse (each of its first, middle and last bytes)', () => {
      const n = hex(v.sg).length
      for (const at of [0, n >> 1, n - 1]) assert.throws(() => signIn(signInBody({ signature: flip(b64u(hex(v.sg)), at) })), refused(401, /signature/), `byte ${at}`)
    })

    test('changing one byte of the authenticator data makes it refuse (the counter byte, so only the signature can notice)', () => {
      assert.throws(() => signIn(signInBody({ authenticatorData: flip(b64u(hex(v.ad)), -1) })), refused(401, /signature/))
    })

    test('changing one byte of the client data makes it refuse (one character of the challenge, held by the store so only the signature can notice)', () => {
      const cd = Buffer.from(hex(v.ac)); const at = cd.indexOf('"challenge":"') + 13 + 3; cd[at] = cd[at] === 0x41 ? 0x42 : 0x41 // changes one character of the challenge text
      const body = signInBody({ clientDataJSON: b64u(cd) })
      assert.notEqual(challengeOf(body.clientDataJSON), challengeOf(b64u(hex(v.ac))))
      assert.throws(() => signIn(body), refused(401, /signature/))
    })

    test('a signature from the vector does not open another credential\'s key', () => {
      const other = registrationOf(VECTORS[alg === 'ES256' ? 'EdDSA' : 'ES256'])
      assert.throws(() => signIn(signInBody(), { cred: stored({ publicKey: b64u(other.spki), alg: other.alg }) }), refused(401, /signature/))
      assert.throws(() => signIn(signInBody(), { cred: stored({ alg: other.alg }) }), PasskeyError) // the key does not fit the algorithm named
    })

    test('refused: an origin that is not the room\'s, exactly (no suffix, no other scheme, port or subdomain)', () => {
      for (const origin of ['https://example.org.evil.example', 'https://evil.example', 'http://example.org', 'https://example.org:8443', 'https://sub.example.org', 'https://example.org/', 'https://EXAMPLE.org', 'https://example.org.']) {
        assert.throws(() => signIn(signInBody(), { rp: { id: 'example.org', origin } }), refused(403, /another site/), `the room is at ${origin}`)
      }
      // and the other way round: the vector's origin altered, the room at example.org (the store holds the altered challenge's text, which is unchanged)
      for (const origin of ['https://example.org.evil.example', 'https://evil.example', 'https://sub.example.org', 'https://example.org:8443']) {
        const cd = hex(v.ac).toString('utf8').replace('"origin":"https://example.org"', `"origin":"${origin}"`)
        assert.notEqual(cd, hex(v.ac).toString('utf8'))
        assert.throws(() => signIn(signInBody({ clientDataJSON: b64u(cd) })), refused(403, /another site/), `the page says ${origin}`)
      }
    })

    test('refused: a registration from an origin that is not the room\'s', () => {
      assert.throws(() => register(registerBody(), { rp: { id: 'example.org', origin: 'https://example.org.evil.example' } }), refused(403, /another site/))
    })

    test('refused: an rpId whose hash is not the vector\'s (another site, a parent or a subdomain)', () => {
      for (const id of ['example.com', 'sub.example.org', 'org', 'example.org.evil.example', 'EXAMPLE.org']) {
        assert.throws(() => signIn(signInBody(), { rp: { id, origin: RP.origin } }), refused(403, /another site/), id)
        assert.throws(() => register(registerBody(), { rp: { id, origin: RP.origin } }), refused(403, /another site/), id)
      }
    })

    test('refused: a challenge used already', () => {
      const store = storeWith(challengeOf(b64u(hex(v.ac))), 'signin')
      signIn(signInBody(), { challenges: store })
      assert.throws(() => signIn(signInBody(), { challenges: store }), refused(401, /not current/))
      const reg1 = storeWith(challengeOf(b64u(hex(v.rc))), 'register', { did: DID })
      register(registerBody(), { challenges: reg1 })
      assert.throws(() => register(registerBody(), { challenges: reg1 }), refused(400, /not current/))
    })

    test('refused: a challenge that was never issued, or was issued for another purpose', () => {
      assert.throws(() => signIn(signInBody(), { challenges: new Challenges() }), refused(401, /not current/))
      assert.throws(() => signIn(signInBody(), { challenges: storeWith(challengeOf(b64u(hex(v.ac))), 'register', { did: DID }) }), refused(401, /not current/))
      assert.throws(() => register(registerBody(), { challenges: storeWith(challengeOf(b64u(hex(v.rc))), 'register', { did: 'did:example:someone-else' }) }), refused(400, /not current/))
    })

    test('refused: an expired challenge (the room\'s own store, its clock moved past the time to live)', () => {
      let t = 1_000_000
      const store = storeWith(challengeOf(b64u(hex(v.ac))), 'signin', {}, { now: () => t })
      t += store.ttlMs + 1
      assert.throws(() => signIn(signInBody(), { challenges: store }), refused(401, /not current/))
      const ok = storeWith(challengeOf(b64u(hex(v.ac))), 'signin', {}, { now: () => t })
      t += store.ttlMs - 1 // still inside the time to live: accepted
      assert.equal(signIn(signInBody(), { challenges: ok }).counter, 0)
      const reg1 = storeWith(challengeOf(b64u(hex(v.rc))), 'register', { did: DID }, { now: () => t })
      t += reg1.ttlMs + 1
      assert.throws(() => register(registerBody(), { challenges: reg1 }), refused(400, /not current/))
    })

    test('refused: the user-present flag missing (bit 0 of the flags byte cleared)', () => {
      const ad = hex(v.ad); assert.equal(ad[32] & 0x01, 0x01, 'the vector has it set'); ad[32] &= ~0x01
      assert.throws(() => signIn(signInBody({ authenticatorData: b64u(ad) })), refused(400, /present/))
      const rad = Buffer.from(reg.authData); rad[32] &= ~0x01
      assert.throws(() => register(registerBody({ authenticatorData: b64u(rad) })), refused(400, /present/))
    })

    test('refused: a counter that goes backwards (the room holds a higher one than the vector\'s), or does not go up', () => {
      assert.equal(hex(v.ad).readUInt32BE(33), 0, 'the vector\'s counter')
      for (const counter of [1, 5, 4_000_000_000]) assert.throws(() => signIn(signInBody(), { cred: stored({ counter }) }), refused(401, /counter/), `held ${counter}`)
      assert.equal(signIn().counter, 0, 'held 0 and vector 0: counters that are not used are accepted')
    })

    test('refused: an unknown credential id (not held, or one byte away from the held one)', () => {
      assert.throws(() => signIn(signInBody(), { find: () => null }), refused(401, /does not know/))
      const other = b64u(Buffer.from(hex(v.cid).map((x, i) => (i === 0 ? x ^ 1 : x))))
      assert.throws(() => signIn(signInBody({ id: other, rawId: other })), refused(401, /does not know/))
    })
  })
}
