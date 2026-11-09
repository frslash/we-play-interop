// The referee's GitHub login: a GitHub App's installation token, made fresh on every run from the app's private key.
// The key is a secret of the repository's "referee" environment, which only workflows running from main may use, so
// no person and no host holds it, and no pull request's own code can reach it.
import { createSign } from 'node:crypto'

const b64url = (b) => Buffer.from(b).toString('base64url')

/** A JSON Web Token proving the app's identity to GitHub for nine minutes (GitHub allows ten at most). */
export function appJwt (appId, privateKeyPem, now = Date.now()) {
  const iat = Math.floor(now / 1000) - 60 // GitHub allows for a minute of clock drift backwards
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })), body = b64url(JSON.stringify({ iat, exp: iat + 540, iss: String(appId) }))
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKeyPem)
  return `${head}.${body}.${b64url(sig)}`
}

/** An installation token limited to one repository; the app must be installed on it. */
export async function installationToken ({ appId, privateKey, repo, fetchImpl = fetch, now = Date.now() }) {
  const jwt = appJwt(appId, privateKey, now)
  const call = async (method, path, body) => {
    const res = await fetchImpl(`https://api.github.com${path}`, { method, headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${jwt}`, 'x-github-api-version': '2022-11-28', 'user-agent': 'we-play-interop-referee', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) })
    const json = await res.json().catch(() => null)
    if (!res.ok) throw new Error(`GitHub ${method} ${path}: ${res.status} ${json?.message ?? ''}`.trim())
    return json
  }
  const inst = await call('GET', `/repos/${repo}/installation`)
  const tok = await call('POST', `/app/installations/${inst.id}/access_tokens`, { repositories: [repo.split('/')[1]] })
  return { token: tok.token, expiresAt: tok.expires_at ?? null, installation: inst.id, app: inst.app_slug ?? null }
}
