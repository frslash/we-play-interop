#!/usr/bin/env node
// Run on the NEW server. Two one-time commands (HANDOVER.md has the whole sequence):
//
//   node agent/import-workspace-key.js init <dir>
//       Makes a one-time X25519 pair. The private half goes to <dir>/wrap-key (mode 0600, never overwritten); prints the public
//       half (base64url) and its fingerprint (first 24 hex characters of the SHA-256 of the public bytes). Nothing else.
//   node agent/import-workspace-key.js open <dir> <file> --env-file <path>
//       (--into is the same as --env-file. Node itself reads an --env-file after the script name and stops when that file is
//       missing; --into does not, so it is the one to use for a file that does not exist yet.)
//       Opens the file the old server wrote, checks it was wrapped to this wrapping key, writes WORKSPACE_KEY=... straight into
//       the env file (created 0600, or only that one line replaced, the rest and its mode kept), prints only the key's public
//       fingerprint (its did:key), then overwrites and deletes the file and the wrapping private half.
//
// Nothing here prints, logs or writes the key anywhere but the env file; every error is a fixed sentence.
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WrapError, b64u, fingerprint, keyDid, newWrappingPair, readText, refuseKeyInArguments, run, shredFile, unwrapSeed, withWorkspaceKey } from './workspace-key-wrap.js'

const USAGE = 'usage: import-workspace-key.js init <dir>   |   import-workspace-key.js open <dir> <file> --env-file <path>'

run(() => {
  const args = process.argv.slice(2)
  refuseKeyInArguments(args)
  const [cmd, ...rest] = args
  if (cmd === 'init') return init(rest)
  if (cmd === 'open') return open(rest)
  throw new WrapError(USAGE)
})

function init (rest) {
  if (rest.length !== 1) throw new WrapError(USAGE)
  const file = join(rest[0], 'wrap-key')
  if (existsSync(file)) throw new WrapError('a wrapping key is already there: it is never overwritten (open the file with it, or delete it on purpose first)')
  try { mkdirSync(rest[0], { recursive: true, mode: 0o700 }) } catch { throw new WrapError('the directory cannot be made') }
  const { pub, priv } = newWrappingPair()
  try { writeFileSync(file, b64u(priv) + '\n', { mode: 0o600, flag: 'wx' }) } catch { throw new WrapError('the wrapping key cannot be written') }
  console.log(`public half: ${b64u(pub)}`)
  console.log(`fingerprint: ${fingerprint(pub)}`)
}

function open (rest) {
  let envFile
  const pos = []
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--env-file' || rest[i] === '--into') { if (envFile !== undefined || rest[i + 1] === undefined) throw new WrapError(USAGE); envFile = rest[++i] } else if (rest[i].startsWith('--')) throw new WrapError(USAGE)
    else pos.push(rest[i])
  }
  if (pos.length !== 2 || !envFile) throw new WrapError(USAGE)
  const [dir, file] = pos
  if (existsSync(envFile) && (statSync(envFile).mode & 0o077)) throw new WrapError('the env file can be read by someone other than its owner: make it readable only by its owner (chmod 600) and run this again; nothing was written')
  const wrapKey = join(dir, 'wrap-key')
  const privText = readText(wrapKey, 'the wrapping key (it is gone once a file has been opened)').trim()
  if (!/^[A-Za-z0-9_-]{43}$/.test(privText)) throw new WrapError('the wrapping key file is damaged')
  const seed = unwrapSeed(readText(file, 'the wrapped file'), Buffer.from(privText, 'base64url'))
  const did = keyDid(seed)
  let text = '', mode = 0o600
  if (existsSync(envFile)) { text = readText(envFile, 'the env file'); mode = statSync(envFile).mode & 0o777 }
  try {
    writeFileSync(envFile, withWorkspaceKey(text, seed), { mode })
    chmodSync(envFile, mode)
  } catch { throw new WrapError('the env file cannot be written') }
  console.log(`the key's public fingerprint: ${did}`)
  // Overwrite then unlink. An overwrite is not a guarantee on every filesystem (see shredFile).
  shredFile(file)
  shredFile(wrapKey)
  console.log('deleted the wrapped file and the wrapping key')
}
