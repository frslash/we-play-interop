import { createHash } from 'node:crypto'
// A fake GitHub for the room's `githubFetch` option, shaped like the three calls github-link.js makes (the shapes are
// GitHub's documented OAuth web flow and REST API: POST https://github.com/login/oauth/access_token answers
// { access_token }, GET https://api.github.com/user answers { login }, GET /user/repos answers [ { full_name } ]).
// No network: a code is made with `grant`, trades for a token that is a planted value tests can search for.
export function fakeGithub () {
  const codes = new Map(), tokens = new Map(), calls = [], issued = new Set()
  let n = 0
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const fetch = async (url, init = {}) => {
    const u = new URL(url), auth = /^Bearer (.+)$/.exec(init.headers?.authorization ?? '')?.[1]
    calls.push({ method: init.method ?? 'GET', url: String(url), token: auth ?? null, body: init.body ?? null })
    if (u.origin === 'https://github.com' && u.pathname === '/login/oauth/access_token') {
      const b = JSON.parse(init.body ?? '{}'), who = codes.get(b.code)
      if (!who || b.client_id !== 'test-client-id' || b.client_secret !== 'test-client-secret') return json({ error: 'bad_verification_code' })
      // as GitHub does when the authorize request carried a challenge or a redirect: the trade must match them
      if (who.challenge && createHash('sha256').update(String(b.code_verifier ?? ''), 'ascii').digest('base64url') !== who.challenge) return json({ error: 'bad_verification_code' })
      if (who.redirect && b.redirect_uri !== who.redirect) return json({ error: 'redirect_uri_mismatch' })
      issued.add(b.code); codes.delete(b.code) // a code works once, as at GitHub
      const token = `gho_PLANTED_TOKEN_${++n}_${'x'.repeat(20)}`
      tokens.set(token, who)
      return json({ access_token: token, token_type: 'bearer', scope: '' })
    }
    const who = tokens.get(auth)
    if (u.origin !== 'https://api.github.com' || !who) return json({ message: 'Bad credentials' }, 401)
    if (u.pathname === '/user') return json({ login: who.login, id: 1 })
    if (u.pathname === '/user/repos' || u.pathname === `/users/${who.login}/repos`) return json(who.repos.map((full_name) => ({ full_name, private: false })))
    return json({ message: 'Not Found' }, 404)
  }
  return {
    fetch, calls,
    /** A code the browser would bring back for this GitHub person. */
    grant: (login, repos = [], { challenge, redirect } = {}) => { const code = `code_PLANTED_CODE_${++n}_${'y'.repeat(12)}`; codes.set(code, { login, repos, challenge, redirect }); return code },
    codesMade: () => [...codes.keys(), ...issued],
    tokensMade: () => [...tokens.keys()],
  }
}
