// A person's key (32 bytes) wrapped by a passkey, so a new device can get it back after a passkey sign-in.
// The passkey gives the browser a secret answer (the WebAuthn PRF extension); the room never sees that answer.
//   key = HKDF-SHA-256(answer, empty salt, info "inwove seed wrap v1") -> AES-256-GCM
//   iv = 12 random bytes; additional data = the member's DID (so a wrapped key only opens for its own DID)
// Only crypto.subtle, btoa and atob: the same in a browser and in Node 22.
const te = new TextEncoder()
const INFO = 'inwove seed wrap v1'

/** base64url without padding. */
export const b64url = (bytes) => {
  const b = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let s = ''
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000))
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}
/** Bytes from base64url; throws on anything that is not base64url. */
export const unb64url = (str) => {
  if (typeof str !== 'string' || !/^[A-Za-z0-9_-]*$/.test(str) || str.length % 4 === 1) throw new Error('not base64url')
  const s = atob(str.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (str.length % 4)) % 4))
  return Uint8Array.from(s, (c) => c.charCodeAt(0))
}

async function wrapKey (prfOutput, usage) {
  const out = prfOutput instanceof ArrayBuffer ? new Uint8Array(prfOutput) : prfOutput
  if (!(out instanceof Uint8Array) || out.length < 16) throw new Error('the passkey gave no secret to wrap with')
  const base = await crypto.subtle.importKey('raw', out, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: te.encode(INFO) }, base, { name: 'AES-GCM', length: 256 }, false, [usage])
}

/** { iv, ct } (base64url) holding the 32-byte seed, openable only with the same passkey answer and the same DID. */
export async function wrapSeed (seed, prfOutput, did) {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) throw new Error('a key is 32 bytes')
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(did) }, await wrapKey(prfOutput, 'encrypt'), seed)
  return { iv: b64url(iv), ct: b64url(ct) }
}

/** The 32-byte seed, or throws when the answer, the DID or any byte is wrong. */
export async function unwrapSeed (wrapped, prfOutput, did) {
  const iv = unb64url(wrapped?.iv), ct = unb64url(wrapped?.ct)
  if (iv.length !== 12) throw new Error('the wrapped key is damaged')
  const seed = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: te.encode(did) }, await wrapKey(prfOutput, 'decrypt'), ct))
  if (seed.length !== 32) throw new Error('the wrapped key is damaged')
  return seed
}
