// DID resolution: did:key and did:peer:4 offline; did:webvh over https with the
// DIF reference library (it verifies the log's hash chain and signatures).
// Fetches for did:webvh go only to public https hosts, with a timeout and a size cap.
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { resolveDID as resolveWebvh } from 'didwebvh-ts'
import { resolveDidKey, resolveDidPeer4 } from '../shared/did.js'
import { keyFromDidDocument } from '../shared/chain.js'

const privateV4 = (ip) => {
  const [a, b] = ip.split('.').map(Number)
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
}
const privateV6 = (ip) => { const s = ip.toLowerCase(); return s === '::1' || s === '::' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe80') || s.startsWith('::ffff:') }

/** fetch for did:webvh: public https only, 8 s, 1 MB. */
export async function publicFetch (input, init = {}) {
  const u = new URL(input)
  if (u.protocol !== 'https:') throw new Error('did:webvh: https only')
  const host = u.hostname.replace(/^\[|\]$/g, '')
  const addrs = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true })
  if (!addrs.length || addrs.some((a) => (a.family === 4 ? privateV4(a.address) : privateV6(a.address)))) throw new Error('did:webvh: host is not public')
  const res = await fetch(u, { ...init, redirect: 'error', signal: AbortSignal.timeout(8000) })
  const len = Number(res.headers.get('content-length') || 0)
  if (len > 1_000_000) throw new Error('did:webvh: log too large')
  const body = await res.text()
  if (body.length > 1_000_000) throw new Error('did:webvh: log too large')
  return new Response(body, { status: res.status, headers: res.headers })
}

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
