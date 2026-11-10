// A room started the way production starts it: no openRoom, so every route is behind the gate. Helpers to join with an
// invite and to sign in with a key, and to call the room over HTTP with a cookie.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newIdentity } from '../../src/shared/did.js'
import { TYPES, signedDocument } from '../../src/shared/types.js'
import { config as baseConfig } from '../../src/server/config.js'
import { createApp } from '../../src/server/index.js'

export async function startRoom ({ extra = {}, options = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wpi-access-'))
  const config = { ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: newIdentity().seedHex, production: true, githubToken: '', weaverIntervalMinutes: 0, weaverQuietMinutes: 0, ratePerMinute: 1000, publicUrl: 'https://room.example', boardDataUrl: '', checkEveryMinutes: 0, activitypub: false, signInPerMinute: 100000, llm: { ...baseConfig.llm, apiKey: '' }, ...extra }
  const ctx = await createApp(config, { awayGatherMs: 0, hostWelcomeMs: null, ...options })
  await new Promise((r) => ctx.server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${ctx.server.address().port}`
  if (!extra.publicUrl) config.publicUrl = base // the room's public address: the origin and rpId a passkey must name
  /** fetch with an optional cookie and a JSON body; answers { status, headers, body (parsed when JSON), text }. */
  const call = async (path, { method = 'GET', cookie, body, headers = {} } = {}) => {
    const r = await fetch(base + path, { method, redirect: 'manual', headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers }, ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) })
    const text = await r.text(); let parsed = null; try { parsed = JSON.parse(text) } catch { /* not JSON */ }
    return { status: r.status, headers: r.headers, body: parsed, text }
  }
  const cookieOf = (r) => { const m = /inwove_session=([^;]*)/.exec(r.headers.get('set-cookie') ?? ''); return m ? `inwove_session=${m[1]}` : null }
  const say = (id, name, payload, extra = {}) => call('/api/entries', { method: 'POST', body: signedDocument(id, { type: TYPES[name], payload, ...extra }) })
  /** A signed line from someone already in (the signature is the credential, so no cookie). */
  /** Sign in with the person's key: the challenge, then a signed sessionKey document. Answers the response (its cookie is cookieOf(r)). */
  const signInWithKey = async (id) => {
    const { body: ch } = await call('/api/session/key/challenge', { method: 'POST' })
    return call('/api/session/key', { method: 'POST', body: { document: signedDocument(id, { type: TYPES.sessionKey, payload: { challenge: ch.challenge } }) } })
  }
  /** The first member, through the room's own first invite. Answers { id, cookie, code }. */
  const firstMember = async (name = 'Person A') => {
    const printed = []; const code = await ctx.ensureFirstInvite({ print: (l) => printed.push(l) })
    const id = newIdentity(); const r = await say(id, 'join', { name, invite: code })
    if (r.status !== 201) throw new Error(`first join: ${r.status} ${r.text}`)
    return { id, code, printed, cookie: cookieOf(await signInWithKey(id)) }
  }
  /** A member invites a newcomer, who joins and signs in. */
  const invite = async (inviter, { days = 1 } = {}) => {
    const { newCode, hashOf } = await import('../../src/server/invites.js'); const code = newCode()
    const r = await say(inviter, 'invite', { codeHash: hashOf(code), expiresAt: new Date(Date.now() + days * 86400000).toISOString() })
    if (r.status !== 201) throw new Error(`invite: ${r.status} ${r.text}`)
    return code
  }
  const newMember = async (inviter, name = 'Person B') => {
    const code = await invite(inviter), id = newIdentity(), r = await say(id, 'join', { name, invite: code })
    if (r.status !== 201) throw new Error(`join: ${r.status} ${r.text}`)
    return { id, cookie: cookieOf(await signInWithKey(id)) }
  }
  return { ctx, config, base, call, cookieOf, say, signInWithKey, firstMember, invite, newMember, stop: async () => { await ctx.stop(); rmSync(dir, { recursive: true, force: true }) } }
}
