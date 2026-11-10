// The room no longer serves /api/community (the room is for members; the route is gone, and test/access.test.js says
// so). The Community class is still in the repository, so tests of it mount it on a small server of their own and
// talk to it the way the room's route did: same handle(), same body cap, the same /api/info entry from summary().
import { createServer } from 'node:http'
import { newIdentity } from '../../src/shared/did.js'
import { Community } from '../../src/server/community.js'
import { createResolver } from '../../src/server/resolver.js'

const MAX_BODY = 64 * 1024
export const startCommunity = async (config, opts = {}) => {
  const identity = newIdentity()
  const ctx = { identity, join: { did: identity.did }, log: { entries: [], state: { participants: new Map() } } }
  ctx.community = new Community({ config, resolver: opts.resolver ?? createResolver(), identity, room: () => identity, ...(opts.communityFetch ? { fetch: opts.communityFetch } : {}) })
  const send = (res, status, body, headers = {}) => { const json = typeof body !== 'string'; res.writeHead(status, { 'content-type': json ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', ...headers }); res.end(json ? JSON.stringify(body) : body) }
  const readBody = (req) => new Promise((resolve, reject) => {
    let size = 0, over = false; const chunks = []
    req.on('data', (c) => { size += c.length; if (over) return; if (size > MAX_BODY) { over = true; reject(new Error('too big')) } else chunks.push(c) })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))); req.on('error', reject)
  })
  ctx.server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://local').pathname
    if (await ctx.community.handle(req, res, path, readBody, send)) return
    if (path === '/api/info' || path === '/api/state') return send(res, 200, { community: ctx.community.summary() })
    send(res, 404, 'not found')
  })
  ctx.stop = async () => { ctx.server.closeAllConnections?.(); await new Promise((r) => ctx.server.close(r)) }
  await new Promise((r) => ctx.server.listen(0, '127.0.0.1', r))
  return { ctx, base: `http://127.0.0.1:${ctx.server.address().port}` }
}
