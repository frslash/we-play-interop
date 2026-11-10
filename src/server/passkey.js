// Passkeys (WebAuthn), verified here with node:crypto alone. A passkey only opens a session: it never signs a line,
// and the room never holds a person's key. What the room keeps for each passkey is public material and the person's
// own words about it: the credential id, its public key (SPKI), the algorithm, the signature counter, transports, the DID
// it opens, whether it gave the browser a PRF secret, the seed wrapped with that secret (opaque to the room: the room has
// never seen the secret that opens it), a label, and when it was made and last used.
//
// What is checked (WebAuthn level 3, the parts a relying party needs; attestation is "none", so there is nothing to
// trust about the device and none is asked):
//   clientDataJSON      type webauthn.create / webauthn.get, the challenge the room issued (single use, 2 minutes), and the
//                       room's own origin (PUBLIC_URL's), never a cross-origin or embedded call
//   authenticatorData   rpIdHash = SHA-256(rpId), the user-present flag; user-verified is recorded; on registration the
//                       attested-credential flag and the credential id inside it must equal rawId
//   signature           over authenticatorData || SHA-256(clientDataJSON), with the stored key: ES256 (DER), Ed25519, RS256
//   counter             a counter that does not rise is refused when either side is non-zero (a cloned authenticator)
import { constants, createHash, createPublicKey, verify } from 'node:crypto'

export const ALGS = { '-7': 'ES256', '-8': 'EdDSA', '-257': 'RS256' }
export const MAX_PER_PERSON = 10
const TRANSPORTS = ['usb', 'nfc', 'ble', 'internal', 'hybrid', 'smart-card']
const FLAG_UP = 0x01, FLAG_UV = 0x04, FLAG_AT = 0x40

/** A refusal with the HTTP status to answer. The message says what to do, never what was received. */
export class PasskeyError extends Error { constructor (message, status = 400) { super(message); this.status = status } }
const no = (m, s) => { throw new PasskeyError(m, s) }

const sha256 = (b) => createHash('sha256').update(b).digest()
/** base64url text to bytes, strictly: only the alphabet, at most `max` characters. */
function bytesOf (s, name, max) {
  if (typeof s !== 'string' || !s.length || s.length > max || !/^[A-Za-z0-9_-]+$/.test(s)) no(`${name}: base64url text`)
  return Buffer.from(s, 'base64url')
}

/** Where the room is, for WebAuthn: the host of PUBLIC_URL is the rpId, its origin the only one accepted. */
export function rpOf (publicUrl) {
  let u; try { u = new URL(publicUrl) } catch { no('this room has no public address (PUBLIC_URL), so passkeys cannot be used yet', 503) }
  return { id: u.hostname, origin: u.origin }
}

/** The seed-wrapping salt for the PRF extension: base64url of SHA-256("inwove passkey seed wrap v1|" + rpId). */
export const prfSaltOf = (rpId) => sha256(Buffer.from('inwove passkey seed wrap v1|' + rpId, 'utf8')).toString('base64url')

/** user.id for a person: base64url of the first 16 bytes of SHA-256(did). It is also the userHandle a sign-in returns. */
export const userHandleOf = (did) => sha256(Buffer.from(did, 'utf8')).subarray(0, 16).toString('base64url')

/** The wrapped seed as the browser made it, or null. Opaque to the room: only its shape is checked (a 12-byte iv, and a 32-byte seed plus its 16-byte tag). */
export function checkWrappedSeed (w) {
  if (w === null || w === undefined) return null
  if (typeof w !== 'object' || Array.isArray(w) || Object.keys(w).some((k) => k !== 'iv' && k !== 'ct')) no('wrappedSeed: { iv, ct } or null')
  if (bytesOf(w.iv, 'wrappedSeed.iv', 32).length !== 12) no('wrappedSeed.iv: 12 bytes')
  if (bytesOf(w.ct, 'wrappedSeed.ct', 128).length !== 48) no('wrappedSeed.ct: 48 bytes (a 32-byte seed and its tag)')
  return { iv: w.iv, ct: w.ct }
}

/** The public key (SPKI DER) as a key object, checked to be the kind its algorithm names. */
export function keyFrom (spki, alg) {
  let key
  try { key = createPublicKey({ key: spki, format: 'der', type: 'spki' }) } catch { no('publicKey: not a public key (SPKI)') }
  const t = key.asymmetricKeyType, d = key.asymmetricKeyDetails ?? {}
  if (alg === -7 && !(t === 'ec' && d.namedCurve === 'prime256v1')) no('publicKey: not a P-256 key, which ES256 needs')
  if (alg === -8 && t !== 'ed25519') no('publicKey: not an Ed25519 key')
  if (alg === -257 && !(t === 'rsa' && d.modulusLength >= 2048 && d.modulusLength <= 8192)) no('publicKey: not an RSA key of 2048 to 8192 bits')
  if (!ALGS[String(alg)]) no('publicKeyAlgorithm: -7 (ES256), -8 (Ed25519) or -257 (RS256)')
  return key
}

/** Whether `sig` is the key's signature over `data`. Anything malformed is just "no". */
export function signatureHolds (key, alg, data, sig) {
  try {
    if (alg === -7) return verify('sha256', data, key, sig) // ECDSA, a DER signature
    if (alg === -8) return verify(null, data, key, sig)
    if (alg === -257) return verify('sha256', data, { key, padding: constants.RSA_PKCS1_PADDING }, sig)
  } catch { /* falls through */ }
  return false
}

/** authenticatorData: { rpIdHash, flags, up, uv, counter, credentialId? }. */
export function parseAuthData (buf) {
  if (buf.length < 37) no('authenticatorData: too short')
  const flags = buf[32], out = { rpIdHash: buf.subarray(0, 32), flags, up: Boolean(flags & FLAG_UP), uv: Boolean(flags & FLAG_UV), counter: buf.readUInt32BE(33) }
  if (flags & FLAG_AT) {
    if (buf.length < 55) no('authenticatorData: the attested credential is cut short')
    const len = buf.readUInt16BE(53)
    if (len < 1 || len > 1023 || buf.length < 55 + len) no('authenticatorData: the credential id is cut short')
    out.credentialId = buf.subarray(55, 55 + len)
  }
  return out
}

/** The client data, parsed and held to its type and origin. The challenge is returned for the caller to take. */
function clientDataOf (b64, type, rp) {
  const raw = bytesOf(b64, 'clientDataJSON', 4096)
  let c; try { c = JSON.parse(raw.toString('utf8')) } catch { no('clientDataJSON: not JSON') }
  if (!c || typeof c !== 'object') no('clientDataJSON: not an object')
  if (c.type !== type) no(`clientDataJSON: this is not a ${type} response`)
  if (c.origin !== rp.origin) no('clientDataJSON: this response came from another site, not this room', 403)
  if (c.crossOrigin === true) no('clientDataJSON: a cross-origin call is not accepted', 403)
  if (typeof c.challenge !== 'string') no('clientDataJSON: no challenge')
  return { raw, challenge: c.challenge }
}

function authDataOf (b64, rp) {
  const buf = bytesOf(b64, 'authenticatorData', 4096), a = parseAuthData(buf)
  if (!a.rpIdHash.equals(sha256(Buffer.from(rp.id, 'utf8')))) no('authenticatorData: this passkey is for another site', 403)
  if (!a.up) no('authenticatorData: the passkey did not confirm that you are present')
  return { buf, ...a }
}

/**
 * A registration, checked. body is what POST /api/passkey/register carries; `did` is the signed-in person it is for.
 * Returns the record to keep. Throws PasskeyError. The challenge is used up whatever the outcome after it is read.
 */
export function verifyRegistration (body, { did, rp, challenges }) {
  if (!body || typeof body !== 'object') no('send a JSON body')
  const id = bytesOf(body.id, 'id', 1400), raw = bytesOf(body.rawId, 'rawId', 1400)
  if (!id.equals(raw)) no('id and rawId must be the same credential')
  const cd = clientDataOf(body.clientDataJSON, 'webauthn.create', rp)
  const meta = challenges.take(cd.challenge, 'register')
  if (!meta || meta.did !== did) no('that registration is not current (it was used, is older than two minutes, or was asked for by someone else): start again', 400)
  const a = authDataOf(body.authenticatorData, rp)
  if (!a.credentialId) no('authenticatorData: it carries no new credential')
  if (!a.credentialId.equals(raw)) no('authenticatorData: its credential is not the one you named')
  const alg = body.publicKeyAlgorithm
  if (!Number.isInteger(alg)) no('publicKeyAlgorithm: -7, -8 or -257')
  const spki = bytesOf(body.publicKey, 'publicKey', 1400)
  keyFrom(spki, alg)
  if (typeof body.prf !== 'boolean') no('prf: true or false')
  const wrapped = checkWrappedSeed(body.wrappedSeed)
  if (wrapped && !body.prf) no('wrappedSeed: a seed is wrapped only with a PRF secret (prf: true)')
  const transports = Array.isArray(body.transports) ? [...new Set(body.transports.filter((t) => TRANSPORTS.includes(t)))] : []
  const label = typeof body.label === 'string' ? body.label.trim().replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, 60) : ''
  return { id: id.toString('base64url'), did, publicKey: spki.toString('base64url'), alg, counter: a.counter, transports, prf: body.prf, wrappedSeed: wrapped, label: label || 'Passkey', userVerified: a.uv }
}

/**
 * A sign-in, checked against the credential it names (`find(id)` gives the stored record or null). Returns
 * { credential, counter, uv }. Throws PasskeyError. The challenge is used up as soon as it is read.
 */
export function verifySignIn (body, { rp, challenges, find }) {
  if (!body || typeof body !== 'object') no('send a JSON body')
  const id = bytesOf(body.id, 'id', 1400), raw = bytesOf(body.rawId, 'rawId', 1400)
  if (!id.equals(raw)) no('id and rawId must be the same credential')
  const cd = clientDataOf(body.clientDataJSON, 'webauthn.get', rp)
  if (!challenges.take(cd.challenge, 'signin')) no('that sign-in is not current (it was used, or is older than two minutes): try again', 401)
  const a = authDataOf(body.authenticatorData, rp)
  const cred = find(id.toString('base64url'))
  if (!cred) no('this room does not know that passkey', 401)
  const sig = bytesOf(body.signature, 'signature', 1400)
  const key = keyFrom(Buffer.from(cred.publicKey, 'base64url'), cred.alg)
  if (!signatureHolds(key, cred.alg, Buffer.concat([a.buf, sha256(cd.raw)]), sig)) no('the passkey\'s signature does not check', 401)
  if (body.userHandle !== undefined && body.userHandle !== null && body.userHandle !== '' && body.userHandle !== userHandleOf(cred.did)) no('the passkey belongs to someone else', 401)
  if ((cred.counter !== 0 || a.counter !== 0) && a.counter <= cred.counter) no('the passkey\'s counter did not go up, so it may have been copied: it is refused', 401)
  return { credential: cred, counter: a.counter, uv: a.uv }
}

/** What the room holds for each passkey, in memory and in the database. */
export class Passkeys {
  constructor ({ db, now = Date.now }) { Object.assign(this, { db, now }); this.byId = new Map() }

  async load () {
    const { rows } = await this.db.query('select id, did, public_key, alg, counter, transports, prf, wrapped_seed, label, user_verified, created_ms, last_used_ms from passkeys')
    for (const r of rows) this.byId.set(r.id, { id: r.id, did: r.did, publicKey: r.public_key, alg: Number(r.alg), counter: Number(r.counter), transports: JSON.parse(r.transports), prf: r.prf, wrappedSeed: r.wrapped_seed ? JSON.parse(r.wrapped_seed) : null, label: r.label, userVerified: r.user_verified, createdAt: Number(r.created_ms), lastUsedAt: r.last_used_ms == null ? null : Number(r.last_used_ms) })
  }

  find (id) { return this.byId.get(id) ?? null }
  list (did) { return [...this.byId.values()].filter((p) => p.did === did) }
  count (did) { return this.list(did).length }

  async add (r) {
    if (this.byId.has(r.id)) no('this passkey is already registered', 409)
    if (this.count(r.did) >= MAX_PER_PERSON) no(`you have ${MAX_PER_PERSON} passkeys already; remove one first`, 409)
    const p = { ...r, createdAt: this.now(), lastUsedAt: null }
    await this.db.query('insert into passkeys (id, did, public_key, alg, counter, transports, prf, wrapped_seed, label, user_verified, created_ms, last_used_ms) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,null)', [p.id, p.did, p.publicKey, p.alg, p.counter, JSON.stringify(p.transports), p.prf, p.wrappedSeed ? JSON.stringify(p.wrappedSeed) : null, p.label, p.userVerified, p.createdAt])
    this.byId.set(p.id, p)
    return p
  }

  /** A sign-in worked: the new counter, whether the user was verified, and when. */
  async used (id, counter, uv) {
    const p = this.byId.get(id); if (!p) return
    p.counter = counter; p.userVerified = uv; p.lastUsedAt = this.now()
    await this.db.query('update passkeys set counter = $2, user_verified = $3, last_used_ms = $4 where id = $1', [id, counter, uv, p.lastUsedAt])
  }

  /** A person left or was replaced: their passkeys go. */
  async deleteFor (did) {
    await this.db.query('delete from passkeys where did = $1', [did])
    for (const [id, p] of this.byId) if (p.did === did) this.byId.delete(id)
  }
}
