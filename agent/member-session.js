// How the command-line tools read a members-only room. The room answers 401 to anyone without a member's session,
// so a tool that reads it over HTTP signs in with the member's own key first and sends the session cookie after.
//
//   WPI_MEMBER_KEY        the member's key, 64 hex characters
//   WPI_MEMBER_KEY_FILE   or a file holding it (make it with umask 077, delete it when done)
//
// The key never comes from a command-line argument (it would show in the process list and the shell's history).
// Nothing here prints, logs or writes the key or the cookie; every error below is a fixed sentence.
// A member reads people-only lines too, so what a member's tool reads is the whole record.
import { readFileSync } from 'node:fs'
import { identityFromSeedHex } from '../src/shared/did.js'
import { TYPES, signInPayload, signedDocument } from '../src/shared/types.js'

export const NEED_KEY = 'this room is for members: set WPI_MEMBER_KEY_FILE to a file holding your key (or WPI_MEMBER_KEY), and run again'

/** A failure to read the room that has one plain sentence to show. */
export class RoomReadError extends Error {}

/** The member's identity from the environment, or null when no key is given. Throws a RoomReadError with a fixed sentence when it is unusable. */
export function memberIdentity (env = process.env) {
  let hex = env.WPI_MEMBER_KEY_FILE ? undefined : env.WPI_MEMBER_KEY
  if (env.WPI_MEMBER_KEY_FILE) {
    try { hex = readFileSync(env.WPI_MEMBER_KEY_FILE, 'utf8') } catch { throw new RoomReadError('WPI_MEMBER_KEY_FILE names a file that cannot be read') }
  }
  if (hex === undefined || !String(hex).trim()) return null
  if (!/^[0-9a-fA-F]{64}$/.test(String(hex).trim())) throw new RoomReadError('the member key must be 64 hex characters (32 bytes)')
  return identityFromSeedHex(String(hex).trim())
}

const SIGN_IN = { 403: 'that key belongs to no member of this room', 429: 'the room is limiting sign-ins: wait a minute and run again' }

/**
 * A fetch for reading the room at `base`. With a key it signs in lazily (and again if the session is refused), and sends the
 * cookie on every call to that room. Without one it is plain fetch, except that a 401 becomes a RoomReadError saying what to set.
 * @param {string} base the room's address
 * @param {{ env?: object, fetch?: Function }} [opts]
 */
export function roomFetch (base, { env = process.env, fetch: doFetch = fetch } = {}) {
  const room = base.replace(/\/$/, '')
  let me, read = false, cookie = null // the key is read on the first call, so a bad one is reported where the tool reports its other errors
  async function signIn () {
    let ch
    try { ch = await doFetch(`${room}/api/session/key/challenge`, { method: 'POST', signal: AbortSignal.timeout(20_000) }) } catch { throw new RoomReadError('could not reach the room to sign in') }
    if (!ch.ok) throw new RoomReadError(SIGN_IN[ch.status] ?? `the room would not start a sign-in (HTTP ${ch.status})`)
    const { challenge } = await ch.json()
    const document = signedDocument(me, { type: TYPES.sessionKey, payload: signInPayload(new URL(room).origin, challenge) })
    const r = await doFetch(`${room}/api/session/key`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ document }), signal: AbortSignal.timeout(20_000) })
    if (!r.ok) throw new RoomReadError(SIGN_IN[r.status] ?? `the room refused the sign-in (HTTP ${r.status})`)
    const m = /__Host-inwove_session=([^;]+)/.exec(r.headers.get('set-cookie') ?? '')
    if (!m) throw new RoomReadError('the room signed the key in but sent no session')
    cookie = `__Host-inwove_session=${m[1]}`
  }
  const ask = (url, init) => doFetch(url, { ...init, headers: { ...init?.headers, ...(cookie ? { cookie } : {}) } })
  return async function get (url, init = {}) {
    if (!read) { me = memberIdentity(env); read = true }
    if (!me) {
      const r = await doFetch(url, init)
      if (r.status === 401) throw new RoomReadError(NEED_KEY)
      return r
    }
    if (!cookie) await signIn()
    let r = await ask(url, init)
    if (r.status === 401) { cookie = null; await signIn(); r = await ask(url, init) } // the session ended: sign in once more
    return r
  }
}

/** Every entry of the room's log, read page by page with `get` (from roomFetch). */
export async function readWholeLog (room, get, { timeoutMs = 20_000 } = {}) {
  const base = room.replace(/\/$/, ''), entries = []
  for (let after = -1; ;) {
    const res = await get(`${base}/api/log?after=${after}&limit=500`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) throw new RoomReadError(`could not read ${base}/api/log: HTTP ${res.status}`)
    const page = (await res.json()).entries
    entries.push(...page)
    if (page.length < 500) return entries
    after = entries.at(-1).seq
  }
}

/** For a tool's top level: say the one line and exit 2 when the failure is a RoomReadError; anything else is thrown on. */
export function oneLine (err) {
  if (!(err instanceof RoomReadError)) throw err
  console.error(err.message)
  process.exit(2)
}
