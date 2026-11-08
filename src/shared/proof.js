// Data Integrity proofs with the eddsa-jcs-2022 cryptosuite (W3C vc-di-eddsa),
// the baseline every Trust Task consumer verifies:
//   hashData = SHA-256(JCS(proofConfig)) || SHA-256(JCS(document without proof))
//   proofValue = 'z' + base58btc(Ed25519(hashData))
import { canonicalize, concat, ed25519, fromMultibase, multibase, sha256, toHex } from './crypto.js'

export const CRYPTOSUITE = 'eddsa-jcs-2022'

export function proofConfig ({ verificationMethod, created, proofPurpose = 'authentication', context }) {
  const cfg = { type: 'DataIntegrityProof', cryptosuite: CRYPTOSUITE, created, verificationMethod, proofPurpose }
  if (context) cfg['@context'] = context
  return cfg
}

/** The exact bytes an Ed25519 key signs for this document and proof config. */
export function signingInput (unsignedDocument, cfg) {
  const { proof: _ignored, ...doc } = unsignedDocument
  return concat(sha256(canonicalize(cfg)), sha256(canonicalize(doc)))
}

export function sign (unsignedDocument, { seed, verificationMethod, created = new Date().toISOString(), proofPurpose = 'authentication' }) {
  const cfg = proofConfig({ verificationMethod, created, proofPurpose, context: unsignedDocument['@context'] })
  const signature = ed25519.sign(signingInput(unsignedDocument, cfg), seed)
  return { ...unsignedDocument, proof: { ...cfg, proofValue: multibase(signature) } }
}

/** Verifies the signature only (key lookup and purpose checks are the caller's). */
export function verifySignature (document, publicKey) {
  const proof = document?.proof
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) return { ok: false, reason: 'no single proof object' }
  if (proof.type !== 'DataIntegrityProof') return { ok: false, reason: 'proof type is not DataIntegrityProof' }
  if (proof.cryptosuite !== CRYPTOSUITE) return { ok: false, reason: `unsupported cryptosuite ${proof.cryptosuite}` }
  const { proofValue, ...cfg } = proof
  let signature
  try { signature = fromMultibase(proofValue) } catch { return { ok: false, reason: 'proofValue is not multibase base58btc' } }
  if (signature.length !== 64) return { ok: false, reason: 'signature is not 64 bytes' }
  const ok = ed25519.verify(signature, signingInput(document, cfg), publicKey)
  return ok ? { ok: true } : { ok: false, reason: 'signature does not verify' }
}

/** Hex of the bytes to sign, for agents that bring their own Ed25519 signer. */
export const signingInputHex = (doc, cfg) => toHex(signingInput(doc, cfg))
