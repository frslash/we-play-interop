// The passkey calls. The room's JSON options become what the browser wants (src/shared/passkeyjson.js), the
// browser's answer becomes the room's JSON. Where the passkey can give a secret answer (the browser's "prf"
// extension), the person's key is wrapped with it, so a new device can get the key back after signing in.
// Everything is feature-checked: no passkeys, or no secret answer, is a plain result, never a crash.
import { call } from '/dom.js'
import { newIdentity } from '/shared/did.js'
import { unwrapSeed, wrapSeed } from '/shared/seedwrap.js'
import { assertionBody, creationOptions, prfAnswer, registrationBody, requestOptions } from '/shared/passkeyjson.js'

export const passkeysAvailable = () => typeof window !== 'undefined' && Boolean(window.isSecureContext && window.PublicKeyCredential && navigator.credentials?.create && navigator.credentials?.get)

const said = (err) => {
  switch (err?.name) {
    case 'NotAllowedError': return 'That was cancelled, or it took too long. Try again when you are ready.'
    case 'InvalidStateError': return 'This device already has a passkey for this room.'
    case 'NotSupportedError': return 'This browser or device cannot make that kind of passkey.'
    case 'SecurityError': return 'Passkeys only work on the room\'s own secure address.'
    default: return 'Your browser could not do that with a passkey.'
  }
}
const refused = (r) => ({ ok: false, error: r.body?.error ?? (r.status === 429 ? 'Too many tries. Wait a minute, then try again.' : 'The room did not accept that. Try again in a moment.') })

// Some passkeys only reveal their secret answer when asked to sign in, not when made: ask once more, for this passkey only.
// The signature is thrown away; only the answer is used, and it never leaves the browser.
async function answerFor (rawId, options) {
  const o = requestOptions({ challenge: 'AAAA', rpId: options.rp.id, timeout: options.timeout, userVerification: options.authenticatorSelection?.userVerification, prfSalt: options.prfSalt })
  const got = await navigator.credentials.get({ publicKey: { ...o, challenge: crypto.getRandomValues(new Uint8Array(32)), allowCredentials: [{ type: 'public-key', id: rawId }] } })
  return prfAnswer(got.getClientExtensionResults())
}

/**
 * Make a passkey for the signed-in person and tell the room. With `seed` (their 32-byte key) and `did`, the key is
 * wrapped by the passkey when it can. → { ok: true, wrapped: boolean } or { ok: false, error }.
 */
export async function registerPasskey ({ seed, did, label }) {
  if (!passkeysAvailable()) return { ok: false, error: 'This browser cannot make passkeys.' }
  try {
    const opt = await call('/api/passkey/register/options', {})
    if (!opt.ok) return refused(opt)
    const cred = await navigator.credentials.create({ publicKey: creationOptions(opt.body) })
    if (!cred) return { ok: false, error: 'No passkey was made.' }
    const ext = cred.getClientExtensionResults()
    let answer = prfAnswer(ext)
    if (!answer && ext?.prf?.enabled && seed) { try { answer = await answerFor(cred.rawId, opt.body) } catch { answer = null } }
    const wrappedSeed = answer && seed && did ? await wrapSeed(seed, answer, did) : null
    const r = await call('/api/passkey/register', registrationBody(cred, { prf: Boolean(answer), wrappedSeed, label }))
    return r.ok ? { ok: true, wrapped: Boolean(wrappedSeed) } : refused(r)
  } catch (err) { return { ok: false, error: said(err) } }
}

/**
 * Sign in with a passkey this browser offers for the room. → { ok: true, did, name, seedHex } (seedHex is null when
 * the passkey could not hand the key back) or { ok: false, error }.
 */
export async function signInWithPasskey () {
  if (!passkeysAvailable()) return { ok: false, error: 'This browser cannot use passkeys.' }
  try {
    const opt = await call('/api/session/passkey/options', {})
    if (!opt.ok) return refused(opt)
    const cred = await navigator.credentials.get({ publicKey: requestOptions(opt.body) })
    if (!cred) return { ok: false, error: 'No passkey was chosen.' }
    const answer = prfAnswer(cred.getClientExtensionResults())
    const r = await call('/api/session/passkey', assertionBody(cred))
    if (!r.ok) return refused(r)
    let seedHex = null
    if (r.body.wrappedSeed && answer) {
      try { // only a key that really is this person's is kept
        const seed = await unwrapSeed(r.body.wrappedSeed, answer, r.body.did)
        const id = newIdentity(seed)
        if (id.did === r.body.did) seedHex = id.seedHex
      } catch { seedHex = null }
    }
    return { ok: true, did: r.body.did, name: r.body.name, seedHex }
  } catch (err) { return { ok: false, error: said(err) } }
}
