// Invites: how a newcomer gets in. A member makes one with a `member:invite` line (the log holds only the SHA-256 of
// the code, so reading the log never gives a way in); the link is <PUBLIC_URL>/i/<code>, and joining with the code
// uses it up (state.js, log.js). A room with no members yet makes one for itself at start-up.
import { createHash, randomBytes } from 'node:crypto'

export const INVITE_DAYS_MAX = 14 // the longest an invite may live (types.js holds the line)
export const FIRST_INVITE_DAYS = 7

/** 16 random bytes as 22 base64url characters. */
export const newCode = () => randomBytes(16).toString('base64url')
export const hashOf = (code) => createHash('sha256').update(String(code), 'utf8').digest('hex')

/**
 * While the room has no people and no room invite is still good, write one and say it once on `print`:
 *   First invite (give it to the first member): <PUBLIC_URL>/i/<code>
 * Returns the code, or null when nothing was needed. Only the hash is kept, so a restart cannot say it again: if the
 * line was missed, the invite runs out in a week and the next start makes another.
 */
export async function ensureFirstInvite (ctx, { print = console.log, now = Date.now() } = {}) {
  const { log, config } = ctx, st = log.state
  if (ctx.openRoom || st.humanCount() > 0) return null
  for (const inv of st.invites.values()) if (inv.by === st.workspace && !inv.usedBy && Date.parse(inv.expiresAt) > now) return null
  const code = newCode()
  await log.appendAsWorkspace('invite', { codeHash: hashOf(code), expiresAt: new Date(now + FIRST_INVITE_DAYS * 86400_000).toISOString() })
  print(`First invite (give it to the first member): ${config.publicUrl || `http://localhost:${config.port}`}/i/${code}`)
  return code
}
