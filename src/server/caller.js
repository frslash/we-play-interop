// Who is calling: the one place that decides a request's address and whether it came over https.
// What rides on it: every per-address limit (the door's 240 a minute and its limiter's cap on distinct addresses,
// sign-in's per-address caps on open codes and held polls) and sign-in's "same network" hint, which is the only warning
// a person gets against a relayed request. A header the caller can set may not decide any of these, so a header is
// believed only where something the room trusts wrote it: Fly's proxy (the platform sets FLY_APP_NAME), or the one
// header the host names in TRUSTED_CLIENT_IP_HEADER. Anywhere else the answer is the socket's own address.
import { isIP } from 'node:net'
import { config } from './config.js'

const HEADER_NAME = /^[a-z0-9-]{1,64}$/
const FORWARDING = ['x-forwarded-for', 'forwarded', 'x-real-ip', 'fly-client-ip'] // a request carrying one of these may have come through a proxy the room was not told about
const one = (v) => String(Array.isArray(v) ? v[0] : v ?? '').trim()
let warned = false

/** The named header, lower-cased, when it is a plain header name; else '' (and one console line, once). */
export function clientIpHeader (name) {
  const h = String(name ?? '').trim().toLowerCase()
  if (!h) return ''
  if (HEADER_NAME.test(h)) return h
  if (!warned) { warned = true; console.error('caller: TRUSTED_CLIENT_IP_HEADER is not a plain header name (letters, digits, dashes); ignored') }
  return ''
}

/**
 * { ip, https, trusted, source } for a request.
 * - source 'fly': ip from fly-client-ip and https from x-forwarded-proto, both written by Fly's proxy (fly.toml forces https).
 *   Without fly-client-ip (a call on Fly's private network, which skips the proxy) the socket rules below apply.
 * - source 'header': ip from the one header the host named, and only from it. https comes from the socket: the room
 *   does not trust x-forwarded-proto outside Fly, so behind a proxy that ends TLS set PUBLIC_URL to the https address,
 *   which is what the room's own address is taken from.
 * - source 'socket': the socket's address, never any forwarding header. `trusted` is true only when the request carries
 *   none of them: one that does may have come through a proxy the room was not told about, whose address everyone
 *   behind it would share (and the header itself is the caller's to set).
 * `trusted` false means: use the address as a limit key if you must, but it says nothing about the caller's network.
 */
export function callerOf (req, { env = config } = {}) {
  const h = req.headers ?? {}, sock = req.socket ?? {}
  if (env.onFly) {
    const ip = one(h['fly-client-ip'])
    if (isIP(ip)) return { ip, https: one(h['x-forwarded-proto']) === 'https', trusted: true, source: 'fly' }
  } else {
    const name = clientIpHeader(env.trustedClientIpHeader)
    if (name) {
      // a list ("a, b") is read from its end: the last entry is the one the nearest proxy, the trusted one, wrote; earlier ones came from the caller
      const ip = one(h[name]).split(',').pop().trim()
      return { ip, https: Boolean(sock.encrypted), trusted: isIP(ip) !== 0, source: 'header' }
    }
  }
  return { ip: String(sock.remoteAddress ?? ''), https: Boolean(sock.encrypted), trusted: !FORWARDING.some((k) => k in h), source: 'socket' }
}
