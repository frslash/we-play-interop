// DID resolution: did:key and did:peer:4 offline; did:webvh over https with the
// DIF reference library (it verifies the log's hash chain and signatures).
// Fetches for did:webvh go only to public https hosts, with a timeout and a size cap.
import { lookup } from 'node:dns/promises'
import https from 'node:https'
import { isIP } from 'node:net'
import { resolveDID as resolveWebvh } from 'didwebvh-ts'
import { resolveDidKey, resolveDidPeer4 } from '../shared/did.js'
import { keyFromDidDocument } from '../shared/chain.js'

const privateV4 = (ip) => {
  const [a, b] = ip.split('.').map(Number)
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
}
const privateV6 = (ip) => { const s = ip.toLowerCase(); return s === '::1' || s === '::' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe80') || s.startsWith('::ffff:') }

const MAX_BYTES = 1_000_000

/**
 * fetch for did:webvh and the room's outbound calls: public https only, port 443 only,
 * 8 s, 1 MB. The address that passes the public check is the address that is connected to
 * (pinned through the socket's `lookup`), so a server that answers differently the second
 * time (DNS rebinding) cannot steer the request to 127.0.0.1 or 169.254.169.254.
 */
export function createPublicFetch ({ lookup: dnsLookup = lookup, request = https.request, port: fixedPort = 443 } = {}) {
  return (input, init = {}) => doPublicFetch(input, init, { dnsLookup, request, fixedPort })
}

// `lookup`, `request` and `port` are injectable only so the tests can run a local server and a stub resolver.
async function doPublicFetch (input, init, { dnsLookup, request, fixedPort }) {
  const u = new URL(input)
  if (u.protocol !== 'https:') throw new Error('did:webvh: https only')
  if (u.port && u.port !== '443') throw new Error('did:webvh: port 443 only')
  if (u.username || u.password) throw new Error('did:webvh: no credentials in the address')
  const host = u.hostname.replace(/^\[|\]$/g, '')
  const addrs = isIP(host) ? [{ address: host, family: isIP(host) }] : await dnsLookup(host, { all: true })
  if (!addrs.length || addrs.some((a) => (a.family === 4 ? privateV4(a.address) : privateV6(a.address)))) throw new Error('did:webvh: host is not public')
  const pinned = addrs[0]
  const signal = init.signal ?? AbortSignal.timeout(8000)
  const headers = {}
  for (const [k, v] of new Headers(init.headers ?? {})) headers[k] = v
  const body = init.body == null ? undefined : (typeof init.body === 'string' || init.body instanceof Uint8Array ? init.body : String(init.body))
  return await new Promise((resolve, reject) => {
    const req = request({
      protocol: 'https:',
      host,
      port: fixedPort,
      path: u.pathname + u.search,
      method: init.method ?? 'GET',
      headers,
      servername: isIP(host) ? undefined : host,
      lookup: (_name, opts, cb) => (opts?.all ? cb(null, [{ address: pinned.address, family: pinned.family }]) : cb(null, pinned.address, pinned.family)),
      signal,
    }, (res) => {
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400) { res.destroy(); reject(new Error('did:webvh: redirects are not followed')); return }
      if (Number(res.headers['content-length'] || 0) > MAX_BYTES) { res.destroy(); reject(new Error('did:webvh: log too large')); return }
      const chunks = []
      let size = 0
      res.on('data', (c) => {
        size += c.length
        if (size > MAX_BYTES) { res.destroy(); reject(new Error('did:webvh: log too large')); return }
        chunks.push(c)
      })
      res.on('error', reject)
      res.on('end', () => {
        const h = new Headers()
        for (const [k, v] of Object.entries(res.headers)) for (const x of [].concat(v)) h.append(k, x)
        const noBody = status === 204 || status === 205 || status === 304
        resolve(new Response(noBody ? null : Buffer.concat(chunks), { status, headers: h }))
      })
    })
    req.on('error', reject)
    req.end(body)
  })
}

export const publicFetch = createPublicFetch()

export function createResolver ({ fetch = publicFetch, ttlMs = 5 * 60_000 } = {}) {
  const cache = new Map()
  async function resolve (did) {
    if (did.startsWith('did:key:')) return resolveDidKey(did)
    if (did.startsWith('did:peer:4')) return resolveDidPeer4(did).doc
    if (did.startsWith('did:webvh:')) {
      const hit = cache.get(did)
      if (hit && hit.at > Date.now() - ttlMs) return hit.doc
      const r = await resolveWebvh(did, { fetch })
      const m = r?.didResolutionMetadata
      if (!r?.didDocument || m?.error) throw new Error(`did:webvh did not resolve: ${m?.problemDetails?.title ?? m?.problemDetails?.detail ?? m?.error ?? 'no document'}`)
      if (r.didDocumentMetadata?.deactivated) throw new Error('did:webvh is deactivated')
      cache.set(did, { doc: r.didDocument, at: Date.now() })
      return r.didDocument
    }
    throw new Error('DID method not supported here (did:key, did:peer:4 and did:webvh are)')
  }
  return {
    resolve,
    /** The Ed25519 key that may sign for `purpose` as `did`. */
    async keyFor (did, vmRef, purpose) {
      return keyFromDidDocument(await resolve(did), did, vmRef, purpose)
    },
  }
}
