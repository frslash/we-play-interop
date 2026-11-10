// A fake authenticator for tests: what a browser's WebAuthn call hands the page, made with node:crypto alone.
// It makes P-256 (ES256), Ed25519 or RSA (RS256) credentials, builds clientDataJSON and authenticatorData with the
// flags and counter a test asks for, and signs authenticatorData || SHA-256(clientDataJSON). Every field a test may want
// to get wrong (origin, rpId, flags, counter, challenge, signature) can be overridden per call.
import { constants, createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'

const b64u = (b) => Buffer.from(b).toString('base64url')
const sha256 = (b) => createHash('sha256').update(b).digest()

// a COSE_Key, the way an authenticator puts it after the credential id (the room does not read it; a real one is there)
function cbor (v) {
  const head = (major, n) => (n < 24 ? Buffer.from([(major << 5) | n]) : n < 256 ? Buffer.from([(major << 5) | 24, n]) : Buffer.from([(major << 5) | 25, n >> 8, n & 255]))
  if (Number.isInteger(v)) return v >= 0 ? head(0, v) : head(1, -1 - v)
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v])
  return Buffer.concat([head(5, v.length), ...v.flatMap(([k, x]) => [cbor(k), cbor(x)])]) // v: [[key, value], …]
}

export const ALG = { ES256: -7, Ed25519: -8, RS256: -257 }

export class FakeAuthenticator {
  /** kind: 'ES256' | 'Ed25519' | 'RS256'. */
  constructor ({ kind = 'ES256', counter = 0 } = {}) {
    this.kind = kind; this.alg = ALG[kind]; this.counter = counter
    const pair = kind === 'ES256' ? generateKeyPairSync('ec', { namedCurve: 'P-256' }) : kind === 'Ed25519' ? generateKeyPairSync('ed25519') : generateKeyPairSync('rsa', { modulusLength: 2048 })
    this.privateKey = pair.privateKey; this.publicKey = pair.publicKey
    this.spki = pair.publicKey.export({ type: 'spki', format: 'der' })
    this.credentialId = randomBytes(32)
    this.id = b64u(this.credentialId)
  }

  #cose () {
    const jwk = this.publicKey.export({ format: 'jwk' })
    if (this.kind === 'ES256') return cbor([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]])
    if (this.kind === 'Ed25519') return cbor([[1, 1], [3, -8], [-1, 6], [-2, Buffer.from(jwk.x, 'base64url')]])
    return cbor([[1, 3], [3, -257], [-1, Buffer.from(jwk.n, 'base64url')], [-2, Buffer.from(jwk.e, 'base64url')]])
  }

  #clientData (type, { challenge, origin, extra }) { return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false, ...extra }), 'utf8') }

  #authData ({ rpId, up = true, uv = true, counter, attested }) {
    const flags = (up ? 0x01 : 0) | (uv ? 0x04 : 0) | (attested ? 0x40 : 0), c = Buffer.alloc(4); c.writeUInt32BE(counter)
    const head = Buffer.concat([sha256(Buffer.from(rpId, 'utf8')), Buffer.from([flags]), c])
    if (!attested) return head
    const len = Buffer.alloc(2); len.writeUInt16BE(this.credentialId.length)
    return Buffer.concat([head, Buffer.alloc(16), len, this.credentialId, this.#cose()])
  }

  /**
   * navigator.credentials.create(): what POST /api/passkey/register is sent (plus whatever the page adds).
   * Overrides: origin, rpId, up, uv, counter, credentialId (bytes the authData names), clientType.
   */
  create ({ challenge, rpId, origin, up = true, uv = true, counter = this.counter, credentialId, clientType = 'webauthn.create', label = 'Test passkey', prf = false, wrappedSeed = null, transports = ['internal'] }) {
    const saved = this.credentialId
    if (credentialId) this.credentialId = credentialId
    const authData = this.#authData({ rpId, up, uv, counter, attested: true }); this.credentialId = saved
    this.counter = counter
    return { id: this.id, rawId: this.id, clientDataJSON: b64u(this.#clientData(clientType, { challenge, origin })), authenticatorData: b64u(authData), publicKey: b64u(this.spki), publicKeyAlgorithm: this.alg, transports, prf, wrappedSeed, label }
  }

  /**
   * navigator.credentials.get(): what POST /api/session/passkey is sent. The counter goes up by one each call unless an
   * override is given. Overrides: origin, rpId, up, uv, counter, userHandle, badSignature, clientType.
   */
  get ({ challenge, rpId, origin, up = true, uv = true, counter, userHandle, badSignature = false, clientType = 'webauthn.get' }) {
    this.counter = counter ?? this.counter + 1
    const clientData = this.#clientData(clientType, { challenge, origin }), authData = this.#authData({ rpId, up, uv, counter: this.counter, attested: false })
    const data = Buffer.concat([authData, sha256(clientData)])
    let signature = this.kind === 'ES256' ? sign('sha256', data, this.privateKey) : this.kind === 'Ed25519' ? sign(null, data, this.privateKey) : sign('sha256', data, { key: this.privateKey, padding: constants.RSA_PKCS1_PADDING })
    if (badSignature) { signature = Buffer.from(signature); signature[signature.length - 1] ^= 0x55 }
    return { id: this.id, rawId: this.id, clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(signature), userHandle: userHandle ?? null }
  }
}

/** A wrapped seed in the shape the room accepts (12-byte iv, 32-byte seed and 16-byte tag): random bytes, since the room never opens it. */
export const fakeWrappedSeed = () => ({ iv: b64u(randomBytes(12)), ct: b64u(randomBytes(48)) })
