// The routes of members-only access: who is signed in, signing in (with the person's key, or with a passkey),
// registering a passkey, signing out, an invite's page lookup, and the membership pass. The gate (gate.js) decides
// which of them need a session; this file does what each one does. Nothing here writes to the log, and nothing it
// answers or prints carries a cookie, a challenge, a code, a wrapped seed (except to the passkey that opens it) or a key.
import { servePass } from './pass.js'
import { TaskError } from './log.js'
import { PasskeyError, Passkeys, prfSaltOf, rpOf, userHandleOf, verifyRegistration, verifySignIn } from './passkey.js'
import { Challenges, Limiter, Sessions, setCookie, tokenFromCookie } from './session.js'

const ALGS = [-7, -8, -257]
const REASONS = { 'inviter gone': 'inviter-left' }

export async function createAccess (ctx, { send: sendIt, readBody, refuse: refuseIt, ipOf }) {
  const { config, log, db } = ctx
  const sessions = ctx.sessions = new Sessions({ db }); await sessions.load()
  const passkeys = ctx.passkeys = new Passkeys({ db }); await passkeys.load()
  const challenges = ctx.challenges = new Challenges()
  const calls = new Limiter({ max: config.signInPerMinute ?? 60 }) // sign-in calls per address per minute: a person signs in a few times a day, and each sign-in is two calls
  const lookups = new Limiter({ max: config.signInPerMinute ?? 60 }) // invite lookups per address per minute: a code is 128 random bits, this only keeps the room quiet
  // every answer here returns true: the request is handled (the room's own send and refuse return nothing)
  const send = (...a) => { sendIt(...a); return true }
  const refuse = (...a) => { refuseIt(...a); return true }
  const st = () => log.state
  const nameOf = (did) => st().participants.get(did)?.name ?? ''
  const tooMany = (res) => send(res, 429, { error: 'Too many tries; wait a minute.' }, { 'retry-after': '60' })
  const json = async (req) => { try { return JSON.parse((await readBody(req)) || '{}') } catch (err) { if (err instanceof TaskError) throw err; throw new PasskeyError('the body is JSON') } }
  const rp = () => rpOf(config.publicUrl)

  /** A new session for a member, as a cookie. */
  async function begin (res, did, body) {
    const { token } = await sessions.create(did)
    return send(res, 200, body, { 'set-cookie': setCookie(token), 'cache-control': 'no-store' })
  }

  /** Handles one request; false when the path is not this module's. */
  async function handle (req, res, path) {
    const viewer = req.inwoveViewer, me = viewer?.kind === 'human' ? viewer.did : null, post = req.method === 'POST'
    try {
      if (path === '/api/session' && req.method === 'GET') {
        const token = tokenFromCookie(req.headers.cookie), s = me && token ? sessions.lookup(token) : null
        const room = { name: config.workspaceName }
        return send(res, 200, s ? { signedIn: true, did: me, name: nameOf(me), passkeys: passkeys.count(me), expiresAt: s.expiresAt, room } : { signedIn: false, room }, { 'cache-control': 'no-store' })
      }
      if (path === '/api/session/key/challenge' && post) {
        if (!calls.hit(ipOf(req))) return tooMany(res)
        const c = challenges.issue('key'); if (!c) return tooMany(res)
        return send(res, 200, c, { 'cache-control': 'no-store' })
      }
      if (path === '/api/session/key' && post) {
        if (!calls.hit(ipOf(req))) return tooMany(res)
        let doc
        try {
          doc = await log.verifyPrivate((await json(req)).document, 'sessionKey')
          if (doc.onBehalfOf !== undefined || doc.delegation !== undefined) throw new TaskError('permissionDenied', 'a person signs in as themselves, not for someone else', { status: 403 })
          if (!st().isCurrentMember(doc.issuer)) throw new TaskError('permissionDenied', 'this key belongs to no member of this room (an invite link brings a newcomer in)', { status: 403 })
          if (!challenges.take(doc.payload.challenge, 'key')) throw new TaskError('expired', 'that sign-in is not current (it was used, or is older than two minutes): ask for a new challenge')
          return await begin(res, doc.issuer, { did: doc.issuer, name: nameOf(doc.issuer) })
        } catch (err) { return refuse(res, err, doc) }
      }
      if (path === '/api/session/passkey/options' && post) {
        if (!calls.hit(ipOf(req))) return tooMany(res)
        const r = rp(), c = challenges.issue('signin'); if (!c) return tooMany(res)
        return send(res, 200, { challenge: c.challenge, rpId: r.id, timeout: 120000, userVerification: 'preferred', prfSalt: prfSaltOf(r.id) }, { 'cache-control': 'no-store' })
      }
      if (path === '/api/session/passkey' && post) {
        if (!calls.hit(ipOf(req))) return tooMany(res)
        const body = await json(req)
        const { credential, counter, uv } = verifySignIn(body, { rp: rp(), challenges, find: (id) => passkeys.find(id) })
        if (!st().isCurrentMember(credential.did)) return send(res, 403, { error: 'This passkey belongs to someone who is no longer a member of this room.' })
        await passkeys.used(credential.id, counter, uv)
        return await begin(res, credential.did, { did: credential.did, name: nameOf(credential.did), wrappedSeed: credential.wrappedSeed })
      }
      if (path === '/api/invite' || path.startsWith('/api/invite/')) {
        if (req.method !== 'GET') return send(res, 405, { error: 'GET only' })
        if (!lookups.hit(ipOf(req))) return tooMany(res)
        const r = st().inviteFor(path.slice(12))
        if (!r.ok) return send(res, 200, { valid: false, reason: REASONS[r.reason] ?? r.reason }, { 'cache-control': 'no-store' })
        return send(res, 200, { valid: true, invitedBy: { name: r.invite.by === st().workspace ? config.workspaceName : nameOf(r.invite.by) }, expiresAt: r.invite.expiresAt }, { 'cache-control': 'no-store' })
      }

      // from here a person's own session is needed (the gate has already seen to it; an agent's link or an open room has no person)
      const mine = path === '/api/session/end' || path === '/api/passkey/register/options' || path === '/api/passkey/register' || path === '/api/me/pass'
      if (!mine) return false
      if (!me) return send(res, 401, { error: 'Sign in first.' })
      if (path === '/api/session/end' && post) {
        await sessions.deleteFor(me) // signing out ends the person's sessions
        return send(res, 200, { ok: true }, { 'set-cookie': setCookie(null), 'cache-control': 'no-store' })
      }
      if (path === '/api/passkey/register/options' && post) {
        const r = rp(), c = challenges.issue('register', { did: me }); if (!c) return tooMany(res)
        return send(res, 200, {
          rp: { id: r.id, name: config.workspaceName },
          user: { id: userHandleOf(me), name: nameOf(me) || me, displayName: nameOf(me) || me },
          challenge: c.challenge, pubKeyCredParams: ALGS.map((alg) => ({ type: 'public-key', alg })), timeout: 120000, attestation: 'none',
          authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
          excludeCredentials: passkeys.list(me).map((p) => ({ type: 'public-key', id: p.id })), prfSalt: prfSaltOf(r.id),
        }, { 'cache-control': 'no-store' })
      }
      if (path === '/api/passkey/register' && post) {
        const rec = verifyRegistration(await json(req), { did: me, rp: rp(), challenges })
        await passkeys.add(rec)
        return send(res, 200, { ok: true, id: rec.id }, { 'cache-control': 'no-store' })
      }
      if (path === '/api/me/pass' && req.method === 'GET') { await servePass(ctx, req, res); return true } // pass.js: the room signs a DTG membership credential for a current member
      return send(res, 405, { error: 'method not allowed' })
    } catch (err) {
      if (err instanceof PasskeyError) return send(res, err.status, { error: err.message }, { 'cache-control': 'no-store' })
      return refuse(res, err)
    }
  }

  /** A person left or was replaced: what the room holds for signing in goes with them. */
  async function forget (did) { await sessions.deleteFor(did); await passkeys.deleteFor(did) }

  return { handle, forget, sessions, passkeys, challenges }
}
