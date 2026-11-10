#!/usr/bin/env node
// Run on the OLD server, once. Wraps the room's WORKSPACE_KEY to the public half that `import-workspace-key.js init` printed on the
// new server, and writes only ciphertext. HANDOVER.md has the whole sequence.
//
//   node agent/export-workspace-key.js <public half> <out file> [--env-file <path>] [--recovery <public half>]
//
// The key comes from the environment (WORKSPACE_KEY), or from the one WORKSPACE_KEY line of the file --env-file names. It is never
// an argument. Prints the file name, the wrapping key's fingerprint and the key's public fingerprint (its did:key), and nothing else.
// The wrapping fingerprint it prints is that of the public half it was given: the person here compares it, by voice on a call, with what the new host showed.
// With --recovery, a second file, <out file>.recovery, is wrapped to the recovery public half. Do not write a recovery file anywhere
// until the 2-of-3 recovery sitting exists and has proved it opens (the sitting itself is not built here).
import { existsSync, writeFileSync } from 'node:fs'
import { WrapError, fingerprint, keyDid, readText, refuseKeyInArguments, run, workspaceKeyLine, wrapSeed } from './workspace-key-wrap.js'

const USAGE = 'usage: export-workspace-key.js <public half> <out file> [--env-file <path>] [--recovery <public half>]\n  --recovery: do not write a recovery file anywhere until the 2-of-3 recovery sitting exists and has proved it opens'

function parse (argv) {
  const pos = []
  const opt = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--env-file' || argv[i] === '--recovery') {
      if (argv[i + 1] === undefined || opt[argv[i]] !== undefined) throw new WrapError(USAGE)
      opt[argv[i]] = argv[++i]
    } else if (argv[i].startsWith('--')) throw new WrapError(USAGE)
    else pos.push(argv[i])
  }
  if (pos.length !== 2) throw new WrapError(USAGE)
  return { pub: pos[0], out: pos[1], envFile: opt['--env-file'], recovery: opt['--recovery'] }
}

const publicHalf = (s) => {
  const b = /^[A-Za-z0-9_-]{43}$/.test(s) ? Buffer.from(s, 'base64url') : null
  if (!b || b.length !== 32) throw new WrapError('that is not a public half made by import-workspace-key.js init')
  return b
}

function writeNew (path, text) {
  if (existsSync(path)) throw new WrapError('the output file already exists: it is never overwritten')
  try { writeFileSync(path, text, { mode: 0o600, flag: 'wx' }) } catch { throw new WrapError('the output file cannot be written') }
}

run(() => {
  refuseKeyInArguments(process.argv.slice(2))
  const { pub, out, envFile, recovery } = parse(process.argv.slice(2))
  const to = publicHalf(pub)
  const recoveryTo = recovery === undefined ? null : publicHalf(recovery)
  const seed = (envFile ? workspaceKeyLine(readText(envFile, 'the env file')) : process.env.WORKSPACE_KEY)?.trim()
  if (!seed) throw new WrapError('WORKSPACE_KEY is not set (in the environment, or on a WORKSPACE_KEY= line of the --env-file)')
  const did = keyDid(seed) // throws a fixed sentence when the key is not 64 hex
  const files = [[out, to]]
  if (recoveryTo) files.push([out + '.recovery', recoveryTo])
  for (const [f] of files) if (existsSync(f)) throw new WrapError('the output file already exists: it is never overwritten')
  for (const [f, p] of files) {
    writeNew(f, wrapSeed(seed, p))
    console.log(`wrote ${f}, wrapped to ${fingerprint(p)}`)
  }
  console.log(`the key's public fingerprint: ${did}`)
})
