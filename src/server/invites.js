// Invites: how a newcomer gets in. A member makes one with a `member:invite` line (the log holds only the SHA-256 of
// the code, so reading the log never gives a way in); the link is <PUBLIC_URL>/i/<code>, and joining with the code
// uses it up (state.js, log.js). A room with no members yet makes one for itself at start-up.
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'

export const INVITE_DAYS_MAX = 14 // the longest an invite may live (types.js holds the line)
export const FIRST_INVITE_HOURS = 24 // the room's own invite is for its first member, who is waiting for it: a day, not a week
export const FIRST_INVITE_FILE = 'first-invite.txt'

/** 16 random bytes as 22 base64url characters. */
export const newCode = () => randomBytes(16).toString('base64url')
export const hashOf = (code) => createHash('sha256').update(String(code), 'utf8').digest('hex')

/** Where the first invite is written: on the data volume, next to the room's other private files. */
export const firstInviteFile = (config) => join(config.dataDir, FIRST_INVITE_FILE)

/**
 * While the room has no people, write an invite of its own (24 hours, one use) at every start. A new one replaces the
 * last (state.js: the old code stops working), so a restart never leaves two. The link goes to a file on the data
 * volume (mode 0600), never to standard output, which is where the host's logs go: `print` gets one line with the
 * file's path. Once a member is in, the invite is dead and the file is removed.
 * Returns the code (for tests; the room never prints it), or null when nothing was needed.
 */
export async function ensureFirstInvite (ctx, { print = console.log, now = Date.now() } = {}) {
  const { log, config } = ctx, st = log.state, file = firstInviteFile(config)
  if (ctx.openRoom) return null
  if (st.humanCount() > 0) { rmSync(file, { force: true }); return null }
  const code = newCode(), expiresAt = new Date(now + FIRST_INVITE_HOURS * 3600_000).toISOString()
  await log.appendAsWorkspace('invite', { codeHash: hashOf(code), expiresAt })
  mkdirSync(config.dataDir, { recursive: true })
  writeFileSync(file, `${config.publicUrl || `http://localhost:${config.port}`}/i/${code}\n`, { mode: 0o600 })
  chmodSync(file, 0o600) // a file that already existed keeps its old mode through writeFileSync
  print(`First invite written to ${file} (valid 24 hours, one use). Read the link there once, give it to the first member, then delete the file.`)
  return code
}

/** The first member is in: the file's link no longer opens anything, so it goes. */
export const clearFirstInvite = (config) => { const f = firstInviteFile(config); if (existsSync(f)) rmSync(f, { force: true }) }
