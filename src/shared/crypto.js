// The small crypto core, shared by the server, the browser page and the agent
// bridge: bytes helpers, base58btc, SHA-256, Ed25519 and RFC 8785 (JCS).
// It runs unchanged in Node and in the browser (the page maps the two
// @noble imports with an import map).
import * as ed from '@noble/ed25519'
import { sha256 as _sha256, sha512 } from '@noble/hashes/sha2.js'

// Synchronous SHA-512 so signing works on plain http (no crypto.subtle), e.g. a phone on a LAN.
ed.hashes.sha512 = (m) => sha512(m)

const te = new TextEncoder()
const td = new TextDecoder()
export const utf8 = (s) => te.encode(s)
export const fromUtf8 = (b) => td.decode(b)
export const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let i = 0
  for (const p of parts) { out.set(p, i); i += p.length }
  return out
}
export const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
export const fromHex = (h) => {
  if (typeof h !== 'string' || !/^([0-9a-f]{2})*$/i.test(h)) throw new Error('not hex')
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  return out
}
export const sha256 = (bytes) => _sha256(typeof bytes === 'string' ? utf8(bytes) : bytes)
export const randomBytes = (n = 32) => crypto.getRandomValues(new Uint8Array(n))

// base58btc (the Bitcoin alphabet), used by multibase 'z'
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const MAP = Object.fromEntries([...ALPHABET].map((c, i) => [c, i]))
export function base58btc (bytes) {
  let zeros = 0
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++
  const digits = []
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]
    for (let j = 0; j < digits.length; j++) { carry += digits[j] << 8; digits[j] = carry % 58; carry = (carry / 58) | 0 }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0 }
  }
  return '1'.repeat(zeros) + digits.reverse().map((d) => ALPHABET[d]).join('')
}
export function fromBase58btc (str) {
  if (typeof str !== 'string' || !str.length) throw new Error('empty base58')
  let zeros = 0
  while (zeros < str.length && str[zeros] === '1') zeros++
  const bytes = []
  for (let i = zeros; i < str.length; i++) {
    const v = MAP[str[i]]
    if (v === undefined) throw new Error('not base58btc')
    let carry = v
    for (let j = 0; j < bytes.length; j++) { carry += bytes[j] * 58; bytes[j] = carry & 0xff; carry >>= 8 }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8 }
  }
  return new Uint8Array([...new Array(zeros).fill(0), ...bytes.reverse()])
}
export const multibase = (bytes) => 'z' + base58btc(bytes)
export const fromMultibase = (s) => {
  if (typeof s !== 'string' || s[0] !== 'z') throw new Error('only multibase base58btc (z…) is supported')
  return fromBase58btc(s.slice(1))
}

// RFC 8785 JSON Canonicalization Scheme. JS's own number and string
// serialization are the ones JCS specifies; keys sort by UTF-16 code units.
export function canonicalize (value) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('JCS: non-finite number')
    return JSON.stringify(value)
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map((v) => (v === undefined ? 'null' : canonicalize(v))).join(',') + ']'
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort()
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}'
  }
  throw new Error('JCS: unsupported value ' + typeof value)
}

// Ed25519 over 32-byte seeds
export const ed25519 = {
  publicKey: (seed) => ed.getPublicKey(seed),
  sign: (message, seed) => ed.sign(message, seed),
  verify: (signature, message, publicKey) => {
    try { return ed.verify(signature, message, publicKey) } catch { return false }
  },
}
