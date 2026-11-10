// Linking a person's GitHub: the room asks GitHub who this person is and which public repositories they have, so an
// agent can join only for repositories its person really works on. It never holds a GitHub token and never writes one
// anywhere: the token lives in one function, for as long as the two reads take.
//
//   GET /api/github/start      (a member) a random single-use state bound to their session, then 302 to GitHub's
//                              authorize page with NO scope (a public login and public repositories need none, so
//                              the token can read nothing private), a PKCE S256 challenge and the exact redirect URI
//   GET /api/github/callback   (open: GitHub sends the browser back here) checks the state, trades the code (with the PKCE
//                              verifier and the same redirect URI) for a token,
//                              reads the login and the public repositories, throws the token away, keeps
//                              { did, login, repos } for ten minutes, and sends the browser to the You tab
//   GET /api/github/linking    (a member) whether linking is set up on this server, the pending login and repositories
//                              for the page's picker, and what the person has already linked
//
// What the person picks goes into the log as a member:repos line (types.js); log.js accepts it only against the
// verification kept here (githubVerification), and only marks "verified" the repositories GitHub listed.
//
// Linking dies with the session: when a person's sessions end (sign out, leaving, replacement) forget(did) drops their
// pending states and their pending verification, so a callback that arrives after is a 'state' failure.
// Neither the code, the verifier nor the token is ever logged, put in an error or shown on a page: gh() answers null on
// any failure and never carries a message.
//
// The session cookie is SameSite=Strict, so a browser coming back from GitHub (another site) does not send it. The state
// is therefore what carries the person: it was bound to their session when they pressed the button. If a cookie does
// arrive with the callback it must be that same session's; a state started in one person's session never links anything
// for another.
//
// The measurement (build rule 9): `stats` counts every start, every linking and every way one did not finish, with
// the reason and no content; the linking route shows the totals to any member.
import { createHash, randomBytes } from 'node:crypto'
import { REPO_RE, GITHUB_LOGIN_RE } from '../shared/types.js'
import { Limiter, tokenFromCookie } from './session.js'

export const STATE_MS = 10 * 60_000 // GitHub's round trip takes a minute at most; ten is the window the page's picker and the log's check share
const MAX_PENDING = 2000 // starts waiting for a callback: far more than a room's people press in ten minutes; past it, the oldest lapsed ones go first, then new starts are refused
const REPOS_SEEN = 100 // one page of GitHub's answer, the most recently pushed: what one person's picker can sensibly show
const CALL_MS = 10_000 // a GitHub call that takes longer is a failed one: the person is waiting at a page
const GH_AUTHORIZE = 'https://github.com/login/oauth/authorize'
const GH_TOKEN = 'https://github.com/login/oauth/access_token'
const GH_API = 'https://api.github.com'

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex')
const challengeOf = (verifier) => createHash('sha256').update(verifier, 'ascii').digest('base64url') // PKCE S256

export function createGithubLink (ctx, { send, ipOf, fetch: fetchIt = globalThis.fetch, now = () => Date.now() }) {
  const { config } = ctx
  const enabled = Boolean(config.githubOauthClientId && config.githubOauthClientSecret)
  const states = new Map() // state -> { did, session (sha of the cookie), verifier (PKCE), redirect (the exact URI sent to GitHub), until }
  const pending = new Map() // did -> { login, repos: [owner/name], set: Set (lowercase), until }
  const calls = new Limiter({ max: 20 })
  const stats = { started: 0, linked: 0, failed: { state: 0, denied: 0, exchange: 0, read: 0 } }

  if (!enabled) console.warn('GitHub linking is off: GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET are not both set, so nobody can add an agent yet (docs/hosting.md says how to make the GitHub OAuth App).')

  /** What the log may rely on for a person: the login GitHub gave and the repositories it listed, for ten minutes. */
  function verification (did) {
    const v = pending.get(did)
    if (!v) return null
    if (v.until <= now()) { pending.delete(did); return null }
    return { login: v.login, repos: v.set }
  }
  ctx.log.githubVerification = verification

  /** A person's sessions ended: nothing of their linking outlives them. */
  function forget (did) {
    for (const [k, v] of states) if (v.did === did) states.delete(k)
    pending.delete(did)
  }

  const lapse = () => { const t = now(); for (const [k, v] of states) if (v.until <= t) states.delete(k); for (const [k, v] of pending) if (v.until <= t) pending.delete(k) }
  const back = (res, why) => { res.writeHead(303, { location: why ? `/#tab=you&github=0&why=${why}` : '/#tab=you&github=1', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); res.end() }
  const fail = (res, why) => { stats.failed[why]++; return back(res, why) }

  /** One GitHub call; the answer's JSON, or null on any failure (never a message that could carry a secret). */
  async function gh (url, { token, method = 'GET', body } = {}) {
    try {
      const r = await fetchIt(url, { method, signal: AbortSignal.timeout(CALL_MS), headers: { accept: 'application/json', 'user-agent': 'inwove-room', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
      return r.ok ? await r.json() : null
    } catch { return null }
  }

  /** Trade the code and read who this is. The token exists only inside this function. */
  async function readGithub (code, { verifier, redirect }) {
    let token = null
    try {
      const got = await gh(GH_TOKEN, { method: 'POST', body: { client_id: config.githubOauthClientId, client_secret: config.githubOauthClientSecret, code, redirect_uri: redirect, code_verifier: verifier } })
      token = typeof got?.access_token === 'string' ? got.access_token : null
      if (!token) return { why: 'exchange' }
      const user = await gh(`${GH_API}/user`, { token })
      if (typeof user?.login !== 'string' || !GITHUB_LOGIN_RE.test(user.login)) return { why: 'read' }
      // the public ones: all a token with no scope can see. /user/repos also lists organisations' public repositories the person belongs to.
      const list = (await gh(`${GH_API}/user/repos?visibility=public&per_page=${REPOS_SEEN}&sort=pushed`, { token })) ?? (await gh(`${GH_API}/users/${encodeURIComponent(user.login)}/repos?per_page=${REPOS_SEEN}&sort=pushed`, { token }))
      if (!Array.isArray(list)) return { why: 'read' }
      const repos = []
      for (const r of list) if (typeof r?.full_name === 'string' && REPO_RE.test(r.full_name) && !repos.some((x) => x.toLowerCase() === r.full_name.toLowerCase())) repos.push(r.full_name)
      return { login: user.login, repos }
    } finally { token = null }
  }

  async function handle (req, res, path) {
    if (!path.startsWith('/api/github/')) return false
    const viewer = req.inwoveViewer, me = viewer?.kind === 'human' ? viewer.did : null
    if (req.method !== 'GET') { send(res, 405, { error: 'GET only' }); return true }

    if (path === '/api/github/callback') {
      lapse()
      if (!calls.hit(ipOf(req))) { send(res, 429, { error: 'Too many tries; wait a minute.' }, { 'retry-after': '60' }); return true }
      const q = new URL(req.url, 'http://local').searchParams, state = q.get('state') ?? ''
      const held = states.get(state)
      states.delete(state) // single use, whatever happens next
      if (!held || held.until <= now()) { fail(res, 'state'); return true }
      const cookie = tokenFromCookie(req.headers.cookie)
      if (cookie && sha(cookie) !== held.session) { fail(res, 'state'); return true } // a cookie that is somebody else's: this state is not theirs to use
      if (q.get('error') || !q.get('code')) { fail(res, 'denied'); return true } // they pressed Cancel at GitHub
      const got = await readGithub(q.get('code'), held)
      if (got.why) { fail(res, got.why); return true }
      pending.set(held.did, { login: got.login, repos: got.repos, set: new Set(got.repos.map((r) => r.toLowerCase())), until: now() + STATE_MS })
      stats.linked++
      back(res)
      return true
    }

    if (!me) { send(res, 401, { error: 'Sign in first.' }); return true }
    const mine = ctx.log.state.participants.get(me)

    if (path === '/api/github/linking') {
      const v = verification(me), p = v && pending.get(me)
      send(res, 200, {
        enabled,
        ...(enabled ? {} : { note: 'This server has not set up GitHub linking yet: its host has to create a GitHub OAuth App (docs/hosting.md, "Linking GitHub").' }),
        pending: p ? { login: p.login, repos: p.repos, expiresAt: new Date(p.until).toISOString() } : null,
        linked: mine?.github ? { github: mine.github, repos: mine.repos ?? [] } : null,
        room: { started: stats.started, linked: stats.linked, failed: { ...stats.failed } },
      }, { 'cache-control': 'no-store' })
      return true
    }

    if (path === '/api/github/start') {
      if (!enabled) { send(res, 503, { error: 'This server has not set up GitHub linking yet: its host has to create a GitHub OAuth App (docs/hosting.md, "Linking GitHub").' }); return true }
      lapse()
      if (!calls.hit('did:' + me) || states.size >= MAX_PENDING) { send(res, 429, { error: 'Too many tries; wait a minute.' }, { 'retry-after': '60' }); return true }
      const token = tokenFromCookie(req.headers.cookie)
      if (!token) { send(res, 401, { error: 'Sign in first.' }); return true }
      const state = randomBytes(32).toString('base64url')
      const verifier = randomBytes(48).toString('base64url') // 64 characters, inside PKCE's 43-128
      const redirect = `${config.publicUrl || `http://${req.headers.host}`}/api/github/callback` // PUBLIC_URL's, the same string at GitHub's authorize page and at its token trade
      states.set(state, { did: me, session: sha(token), verifier, redirect, until: now() + STATE_MS })
      stats.started++
      const to = `${GH_AUTHORIZE}?${new URLSearchParams({ client_id: config.githubOauthClientId, redirect_uri: redirect, state, code_challenge: challengeOf(verifier), code_challenge_method: 'S256', allow_signup: 'false' })}`
      res.writeHead(302, { location: to, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); res.end()
      return true
    }
    send(res, 404, { error: 'not found' })
    return true
  }

  return { handle, verification, forget, stats, enabled }
}
