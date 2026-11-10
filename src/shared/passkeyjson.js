// The two ends of a passkey call, as plain data: the room's JSON options into what navigator.credentials wants,
// and what the browser gives back into the JSON the room's routes take. No browser object is touched here, so
// it runs in Node too (a test passes it stand-ins). The calls themselves are in public/passkey.js.
import { b64url, unb64url } from './seedwrap.js'

const prfExtension = (salt) => ({ prf: { eval: { first: unb64url(salt) } } })

/** The options for navigator.credentials.create, from POST /api/passkey/register/options. */
export function creationOptions (o) {
  return {
    challenge: unb64url(o.challenge),
    rp: o.rp,
    user: { id: unb64url(o.user.id), name: o.user.name, displayName: o.user.displayName },
    pubKeyCredParams: o.pubKeyCredParams,
    timeout: o.timeout,
    attestation: o.attestation ?? 'none',
    authenticatorSelection: o.authenticatorSelection,
    excludeCredentials: (o.excludeCredentials ?? []).map((c) => ({ type: c.type ?? 'public-key', id: unb64url(c.id) })),
    extensions: o.prfSalt ? prfExtension(o.prfSalt) : {},
  }
}

/** The options for navigator.credentials.get, from POST /api/session/passkey/options (no list: the browser offers the passkeys it has for this site). */
export function requestOptions (o) {
  return { challenge: unb64url(o.challenge), rpId: o.rpId, timeout: o.timeout, userVerification: o.userVerification ?? 'preferred', extensions: o.prfSalt ? prfExtension(o.prfSalt) : {} }
}

/** The secret answer the passkey gave, when it gave one (from getClientExtensionResults()); else null. */
export const prfAnswer = (results) => {
  const first = results?.prf?.results?.first
  return first ? new Uint8Array(first instanceof ArrayBuffer ? first : first.buffer.slice(first.byteOffset, first.byteOffset + first.byteLength)) : null
}

/** The body of POST /api/passkey/register. `prf`: whether the passkey can wrap a key. `wrappedSeed`: { iv, ct } or null. */
export function registrationBody (cred, { prf, wrappedSeed, label }) {
  const r = cred.response
  return {
    id: cred.id,
    rawId: b64url(cred.rawId),
    clientDataJSON: b64url(r.clientDataJSON),
    authenticatorData: b64url(r.getAuthenticatorData()),
    publicKey: b64url(r.getPublicKey()),
    publicKeyAlgorithm: r.getPublicKeyAlgorithm(),
    transports: typeof r.getTransports === 'function' ? r.getTransports() : [],
    prf: Boolean(prf),
    wrappedSeed: wrappedSeed ?? null,
    label,
  }
}

/** The body of POST /api/session/passkey. */
export function assertionBody (cred) {
  const r = cred.response
  return {
    id: cred.id,
    rawId: b64url(cred.rawId),
    clientDataJSON: b64url(r.clientDataJSON),
    authenticatorData: b64url(r.authenticatorData),
    signature: b64url(r.signature),
    userHandle: r.userHandle ? b64url(r.userHandle) : null,
  }
}
