// The wrapping used to move the room's WORKSPACE_KEY from one server to another without a person seeing it
// (agent/export-workspace-key.js and agent/import-workspace-key.js; the steps are in HANDOVER.md).
//
// A fresh X25519 pair is made on the receiving server. The sending server makes an ephemeral X25519 key, does ECDH with
// the receiver's public half, runs the shared secret through HKDF-SHA-256 and seals the key with AES-256-GCM. Only the
// public values, the version and the ciphertext are in the file. node:crypto only.
//
// Rules every caller keeps: the key is never an argument, never printed, never logged; every error is a fixed sentence
// that quotes nothing it was given (an argument may be a key typed in the wrong place).
import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto'
import { closeSync, fsyncSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { identityFromSeedHex } from '../src/shared/did.js'

export const FORMAT_VERSION = 1
export const HKDF_INFO = 'inwove/workspace-key-move/v1' // names the purpose and the version
const PKCS8_X25519_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex')

/** A failure with one fixed sentence to show. */
export class WrapError extends Error {}

export const b64u = (buf) => Buffer.from(buf).toString('base64url')
const fromB64u = (s) => {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]+$/.test(s)) throw new WrapError('that is not a public half made by import-workspace-key.js init')
  return Buffer.from(s, 'base64url')
}

/** First 8 hex characters of the SHA-256 of the public bytes. */
export const fingerprint = (publicBytes) => createHash('sha256').update(publicBytes).digest('hex').slice(0, 8)

/** The key's public fingerprint: the room's did:key for that seed (public, never a piece of the secret). */
export const keyDid = (seedHex) => identityFromSeedHex(seedHex).did

/** A 64-hex string anywhere in an argument is a key (or looks like one): refuse before doing anything else. */
export function refuseKeyInArguments (args) {
  if (args.some((a) => /[0-9a-fA-F]{64}/.test(a))) throw new WrapError('a key is never given as an argument (it would show in the process list and the shell history): set WORKSPACE_KEY in the environment, or use --env-file')
}

export function newWrappingPair () {
  const { privateKey, publicKey } = generateKeyPairSync('x25519')
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url')
  const priv = Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url')
  return { pub, priv }
}

const publicObject = (pub) => createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: b64u(pub) }, format: 'jwk' })
const privateObject = (priv) => createPrivateKey({ key: Buffer.concat([PKCS8_X25519_PREFIX, priv]), format: 'der', type: 'pkcs8' })

const deriveKey = (shared, epk, recipient) => Buffer.from(hkdfSync('sha256', shared, Buffer.concat([epk, recipient]), HKDF_INFO, 32))
const header = (epk, to) => Buffer.from(JSON.stringify({ v: FORMAT_VERSION, epk: b64u(epk), to }))

/** The file's text: the 32-byte seed wrapped to the recipient's public half (32 raw bytes). */
export function wrapSeed (seedHex, recipientPub) {
  if (!/^[0-9a-fA-F]{64}$/.test(seedHex)) throw new WrapError('WORKSPACE_KEY must be 64 hex characters (32 bytes)')
  if (recipientPub.length !== 32) throw new WrapError('that is not a public half made by import-workspace-key.js init')
  const eph = newWrappingPair()
  const to = fingerprint(recipientPub)
  const key = deriveKey(diffieHellman({ privateKey: privateObject(eph.priv), publicKey: publicObject(recipientPub) }), eph.pub, recipientPub)
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  c.setAAD(header(eph.pub, to))
  const ct = Buffer.concat([c.update(Buffer.from(seedHex.trim(), 'hex')), c.final()])
  return JSON.stringify({ v: FORMAT_VERSION, epk: b64u(eph.pub), to, iv: b64u(iv), ct: b64u(Buffer.concat([ct, c.getAuthTag()])) }) + '\n'
}

/** The seed (as hex) from a file's text and the receiver's private half; throws a WrapError with a fixed sentence. */
export function unwrapSeed (text, recipientPriv) {
  let f
  try { f = JSON.parse(text) } catch { throw new WrapError('that file is not a wrapped key') }
  if (!f || f.v !== FORMAT_VERSION) throw new WrapError('that file is not a wrapped key of a version this tool opens')
  let pub
  try {
    const mine = privateObject(recipientPriv)
    pub = Buffer.from(createPublicKey(mine).export({ format: 'jwk' }).x, 'base64url')
    if (f.to !== fingerprint(pub)) throw new WrapError('that file was wrapped to a different public half than this wrapping key')
    const epk = fromB64u(f.epk), iv = fromB64u(f.iv), all = fromB64u(f.ct)
    if (epk.length !== 32 || iv.length !== 12 || all.length !== 48) throw new WrapError('that file is damaged')
    const d = createDecipheriv('aes-256-gcm', deriveKey(diffieHellman({ privateKey: mine, publicKey: publicObject(epk) }), epk, pub), iv)
    d.setAAD(header(epk, f.to))
    d.setAuthTag(all.subarray(32))
    return Buffer.concat([d.update(all.subarray(0, 32)), d.final()]).toString('hex')
  } catch (e) {
    if (e instanceof WrapError) throw e
    throw new WrapError('that file did not open: it is damaged, or it was not wrapped to this wrapping key')
  }
}

/** The value of the one WORKSPACE_KEY line in an env file's text, or undefined. Nothing else in the file is read. */
export function workspaceKeyLine (text) {
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?WORKSPACE_KEY\s*=\s*(.*?)\s*$/.exec(line)
    if (m) return m[1].replace(/^(['"])(.*)\1$/, '$2')
  }
  return undefined
}

/** The text with the one WORKSPACE_KEY line replaced (or added), every other line kept. */
export function withWorkspaceKey (text, seedHex) {
  const lines = text === '' ? [] : text.split('\n')
  let done = false
  const out = lines.map((l) => (!done && /^\s*(?:export\s+)?WORKSPACE_KEY\s*=/.test(l) ? (done = true, `WORKSPACE_KEY=${seedHex}`) : l))
  if (!done) {
    if (out.length && out.at(-1) === '') out.splice(out.length - 1, 0, `WORKSPACE_KEY=${seedHex}`)
    else out.push(`WORKSPACE_KEY=${seedHex}`, '')
  }
  return out.join('\n')
}

/**
 * Overwrite a file with random bytes, then delete it. An overwrite is NOT a guarantee on every filesystem: journaling, copy-on-write
 * and flash drives with wear levelling may keep the old blocks. The disk is encrypted (docs/hosting.md), and that is what protects
 * what an overwrite cannot reach; the overwrite narrows the window, it does not close it.
 */
export function shredFile (path) {
  const size = statSync(path).size
  const fd = openSync(path, 'r+')
  try { writeSync(fd, randomBytes(Math.max(size, 1))); fsyncSync(fd) } finally { closeSync(fd) }
  unlinkSync(path)
}

export const readText = (path, what) => {
  try { return readFileSync(path, 'utf8') } catch { throw new WrapError(`${what} cannot be read`) }
}

/** Run a command's main: a WrapError prints its fixed sentence and exits 2; anything else prints a fixed sentence too (never the error). */
export async function run (main) {
  try { await main() } catch (e) {
    console.error(e instanceof WrapError ? e.message : 'something went wrong, and nothing was printed that could hold the key')
    process.exit(2)
  }
}
