// The gate: the first thing every request meets, in front of every route. InWove is for members, so what is not on
// the open list below needs a session, and the open list is short and written out here, not scattered over the routes.
//
//   open        the page and its files, the sign-in and invite calls, POST /api/entries (a signed line proves itself: a
//               newcomer's only line is a join, and log.js asks it for an invite), the hosted agents' links (the secret
//               in the link is the credential), and four plain reads for people who check on the room (healthz, the
//               rules, the room's DID log)
//   everything  else needs a cookie that is a current member's session: 401 { error: 'Sign in first.' } for /api, /mcp,
//               /media and /patches; 303 to / for a page path
//   gone        ActivityPub (unless ACTIVITYPUB=1), the Trust Task door, wallet sign-in and /api/community: 404 for all
//
// The gate sets req.inwoveViewer: { kind: 'human', did } for a signed-in member, { kind: 'agent', did } on an agent's link,
// and leaves it undefined for anyone else. Code that reads it treats undefined as "nobody", never as a person.
// (createApp's test-only openRoom option sets { kind: 'human', did: null } on every request and lets everything through;
// no environment variable or file can turn it on.)
import { tokenFromCookie } from './session.js'

const PAGE_PATHS = new Set(['/', '/index.html', '/healthz', '/rules.json', '/.well-known/did.jsonl'])
const PLAIN_READS = new Set(['/healthz', '/rules.json', '/.well-known/did.jsonl']) // read from any origin, as before: they say nothing about the room's people
const OPEN_API = new Map([
  ['GET /api/session', 1], ['POST /api/session/key/challenge', 1], ['POST /api/session/key', 1],
  ['POST /api/session/passkey/options', 1], ['POST /api/session/passkey', 1], ['POST /api/entries', 1],
])

/** A route that is switched off for good: the room answers 404 whoever asks. */
export function isGone (path, { activitypub = false } = {}) {
  if (path === '/trust-tasks' || path === '/v1/trust-tasks') return true
  if (path === '/api/signin' || path.startsWith('/api/signin/') || path.endsWith('/member/sign-in/config')) return true
  if (path === '/api/community' || path.startsWith('/api/community/')) return true
  if (!activitypub && (path === '/.well-known/webfinger' || path === '/ap' || path.startsWith('/ap/'))) return true
  return false
}

/** Whether a request needs no session. `isStatic(path)` says whether the page has a file at that path. */
export function isOpen (method, path, { isStatic = () => false, activitypub = false } = {}) {
  if (method === 'OPTIONS') return true // answers with no cross-origin permission at all
  const read = method === 'GET' || method === 'HEAD'
  if (path.startsWith('/mcp/a/')) return true // a hosted agent's link: its secret is the credential
  if (read && (PAGE_PATHS.has(path) || path.startsWith('/i/') || path.startsWith('/r/') || path.startsWith('/shared/') || path.startsWith('/vendor/'))) return true
  if (read && isStatic(path)) return true
  if (OPEN_API.has(`${method} ${path}`)) return true
  if (method === 'GET' && /^\/api\/invite\/[A-Za-z0-9_-]{1,80}$/.test(path)) return true
  if (activitypub && (path === '/.well-known/webfinger' || path.startsWith('/ap/'))) return true
  return false
}

const needsJson = (path) => /^\/(api|mcp|media|patches)(\/|$)/.test(path) // a caller that reads JSON; a browser asking for a page is sent to the front door instead

/**
 * The gate itself. gate(req, res) → true to go on to the routes, false when it has answered. It never reads a body.
 * sessions: session.js. members: () => the log's State. hosted: hosted.js (for an agent's link).
 */
export function createGate ({ sessions, members, hosted, config, openRoom = false, isStatic }) {
  return function gate (req, res) {
    const url = new URL(req.url, 'http://local'), path = url.pathname
    if (isGone(path, config)) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('not found'); return false }
    if (openRoom) { req.inwoveViewer = { kind: 'human', did: null }; return true }
    if (PLAIN_READS.has(path) || (config.activitypub && (path === '/.well-known/webfinger' || path.startsWith('/ap/')))) res.inwoveCors = true
    // who is asking
    if (path.startsWith('/mcp/a/')) {
      let token = ''
      try { token = decodeURIComponent(path.slice(7).split('/')[0]) } catch { /* not a link */ }
      const agent = token ? hosted.byToken(token) : null
      if (agent) req.inwoveViewer = { kind: 'agent', did: agent.did }
    } else {
      const token = tokenFromCookie(req.headers.cookie), s = token ? sessions.lookup(token) : null
      if (s) {
        if (members().isCurrentMember(s.did)) req.inwoveViewer = { kind: 'human', did: s.did }
        else sessions.end(token).catch(() => {}) // a person who left or was replaced: the cookie is no good any more
      }
    }
    if (req.inwoveViewer || isOpen(req.method, path, { isStatic, activitypub: config.activitypub })) return true
    if (needsJson(path)) { res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify({ error: 'Sign in first.' })) } else { res.writeHead(303, { location: '/', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); res.end() }
    return false
  }
}
