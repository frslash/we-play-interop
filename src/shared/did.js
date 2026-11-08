// did:key (Ed25519) and did:peer:4, both resolvable without a network.
// did:webvh needs the network and lives in src/server/resolver.js.
import { concat, ed25519, fromMultibase, multibase, randomBytes, sha256, utf8, fromUtf8, toHex, fromHex } from './crypto.js'

const ED25519_PUB = [0xed, 0x01] // multicodec ed25519-pub, varint
const JSON_CODEC = [0x80, 0x04] // multicodec json (0x0200), varint
const SHA2_256 = [0x12, 0x20] // multihash sha2-256, 32 bytes

export const SIGNING_RELATIONSHIPS = ['authentication', 'assertionMethod', 'capabilityInvocation', 'capabilityDelegation']

/** Multikey (z6Mk…) for a raw Ed25519 public key. */
export const ed25519Multikey = (publicKey) => multibase(concat(new Uint8Array(ED25519_PUB), publicKey))

/** Raw 32-byte Ed25519 key from a Multikey value, or throws. */
export function multikeyToEd25519 (mk) {
  const b = fromMultibase(mk)
  if (b.length !== 34 || b[0] !== ED25519_PUB[0] || b[1] !== ED25519_PUB[1]) throw new Error('not an Ed25519 multikey')
  return b.slice(2)
}

export function didKeyFromPublicKey (publicKey) {
  return 'did:key:' + ed25519Multikey(publicKey)
}

/** A new identity: a 32-byte seed (keep it secret) and its did:key. */
export function newIdentity (seed = randomBytes(32)) {
  const publicKey = ed25519.publicKey(seed)
  const did = didKeyFromPublicKey(publicKey)
  return { seed, seedHex: toHex(seed), publicKey, did, verificationMethod: did + '#' + did.slice('did:key:'.length) }
}
export const identityFromSeedHex = (hex) => {
  const seed = fromHex(String(hex).trim())
  if (seed.length !== 32) throw new Error('a key is 32 bytes (64 hex characters)')
  return newIdentity(seed)
}

/** did:key DID document (Ed25519 only, the signing key in every signing relationship). */
export function resolveDidKey (did) {
  const m = /^did:key:(z[1-9A-HJ-NP-Za-km-z]+)$/.exec(did)
  if (!m) throw new Error('malformed did:key')
  const publicKey = multikeyToEd25519(m[1])
  const vmId = did + '#' + m[1]
  const doc = {
    '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'],
    id: did,
    verificationMethod: [{ id: vmId, type: 'Multikey', controller: did, publicKeyMultibase: m[1] }],
  }
  for (const r of SIGNING_RELATIONSHIPS) doc[r] = [vmId]
  return doc
}

// did:peer:4 (DIF Peer DID method 4): the long form carries the whole input
// document; the short form is its hash and resolves only once the long form was seen.
export function didPeer4FromDocument (inputDoc) {
  const encoded = multibase(concat(new Uint8Array(JSON_CODEC), utf8(JSON.stringify(inputDoc))))
  const hash = multibase(concat(new Uint8Array(SHA2_256), sha256(utf8(encoded))))
  return { long: `did:peer:4${hash}:${encoded}`, short: `did:peer:4${hash}` }
}

export function resolveDidPeer4 (did) {
  const m = /^did:peer:4(z[1-9A-HJ-NP-Za-km-z]+):(z[1-9A-HJ-NP-Za-km-z]+)$/.exec(did)
  if (!m) throw new Error(did.startsWith('did:peer:4') ? 'did:peer:4 short form: resolvable only after its long form was seen' : 'malformed did:peer:4')
  const [, hash, encoded] = m
  const expect = multibase(concat(new Uint8Array(SHA2_256), sha256(utf8(encoded))))
  if (expect !== hash) throw new Error('did:peer:4 hash does not match its document')
  const bytes = fromMultibase(encoded)
  if (bytes[0] !== JSON_CODEC[0] || bytes[1] !== JSON_CODEC[1]) throw new Error('did:peer:4 document is not multicodec json')
  const input = JSON.parse(fromUtf8(bytes.slice(2)))
  const short = `did:peer:4${hash}`
  // contextualize: the DID is the long form; relative references stay relative,
  // verification methods without a controller get the DID.
  const doc = { ...input, id: did, alsoKnownAs: [...(input.alsoKnownAs ?? []), short] }
  if (Array.isArray(doc.verificationMethod)) doc.verificationMethod = doc.verificationMethod.map((vm) => ({ ...vm, controller: vm.controller ?? did }))
  return { doc, short }
}
