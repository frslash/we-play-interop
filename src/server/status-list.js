// Has a credential been withdrawn? A credential that can be says where to look: its credentialStatus names a list
// (a W3C Bitstring Status List) and one position in it. The list is itself a credential the issuer signs: a long
// string of bits, one per credential, where a set bit means "revoked" (or "suspended", on the suspension list).
// This file fetches such a list, checks it is the issuer's own, and reads the one bit.
//
// Read from OpenVTC at the commit the room builds from: vtc-service/src/status_list/credential.rs (what a community
// publishes at GET {public_url}/v1/status-lists/{revocation|suspension}), storage.rs (131,072 bits, the first bit of
// each byte is the lowest position), and recognition/verify.rs (how it reads another community's list: the proof
// first, the list's issuer must be the credential's issuer, then the bit).
//
// It fails closed. A list that cannot be fetched, is not signed by the credential's issuer, has run out, or does not
// reach the position asked for gives "unknown", never "good". That protects the room from two things: someone who
// can stand between the room and the community (or take the community's server down) making a revoked pass look
// current by hiding the list, and anyone who can serve the list's address forging one. Callers say "unknown" in
// their answer; they do not call the credential good.
import { gunzipSync } from 'node:zlib'
import { STATUS_ENTRY, VC_V2, instantOf, compareInstants, issuerOf, verifyIssuerProof } from '../shared/dtg.js'
import { publicFetch } from './resolver.js'

export const LIST_TYPE = 'BitstringStatusListCredential'
// What each limit protects:
// the standard asks for at least this many positions in a list, so one holder cannot be told from the crowd by its position
export const MIN_ENTRIES = 131_072
// a list unpacks to 16 KiB at that size; this is 256 of those. A small download can unpack into gigabytes, and this is where that stops
const MAX_LIST_BYTES = 4 * 1024 * 1024
// A verified list is reused for half a minute. Anyone may ask the room to check a pass, and without this each
// ask would be a request to the community's server; with it, a pass revoked there shows here within 30 seconds.
const TTL_MS = 30_000
// a list that failed is not asked for again for ten seconds, so a community that is down is not hammered through the room
const FAIL_TTL_MS = 10_000
// the room names one community, which has two lists; the rest is room for a list whose address moved
const MAX_LISTS = 16

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)
const fail = (problem, reason) => ({ ok: false, problem, reason })
const nowInstant = (ms) => instantOf(new Date(ms).toISOString())

/** The bits of an encodedList: multibase "u" (base64url, no padding) of the gzip of the bit string. */
export function decodeList (encoded) {
  if (typeof encoded !== 'string' || encoded.length < 8) throw new Error('encodedList is missing')
  const b64 = encoded[0] === 'u' ? encoded.slice(1) : encoded // lists made before the standard settled left the "u" off
  if (!/^[A-Za-z0-9_-]+$/.test(b64)) throw new Error('encodedList is not base64url')
  return new Uint8Array(gunzipSync(Buffer.from(b64, 'base64url'), { maxOutputLength: MAX_LIST_BYTES }))
}
/** Bit `index` of a list, counted from the first bit of the first byte, as the standard and OpenVTC do. */
export const bitAt = (bytes, index) => ((bytes[index >> 3] >> (7 - (index & 7))) & 1) === 1

export class StatusLists {
  /** keyFor: the room's resolver (the issuer's key). fetch: one that refuses private addresses (the list's address comes from a credential). */
  constructor ({ keyFor, fetch = publicFetch, now = Date.now, ttlMs = TTL_MS, failTtlMs = FAIL_TTL_MS, maxLists = MAX_LISTS } = {}) {
    Object.assign(this, { keyFor, fetch, now, ttlMs, failTtlMs, maxLists })
    this.cache = new Map() // list address -> { at, until, value }  (value: a verified list, or why it could not be used)
    this.pending = new Map() // list address -> the fetch under way, so ten checks at once are one request
    this.counts = { fetched: 0, reused: 0, failed: {} } // counts and reasons only: no address, no DID, no position
  }

  /** Fetch one list and check it is a status list signed by `issuer`. Returns { ok: true, bytes, purposes, signedAt, validUntil, short } or { ok: false, problem, reason }. */
  async #load (url, issuer) {
    let u; try { u = new URL(url) } catch { return fail('address', 'the list\'s address is not a URL') }
    if (u.protocol !== 'https:') return fail('address', 'the list\'s address is not https')
    let list
    try {
      const res = await this.fetch(u.href, { headers: { accept: 'application/json, application/vc+ld+json;q=0.9' } })
      if (res.status !== 200) return fail('fetch', `the list's address answered ${res.status}`)
      list = JSON.parse(await res.text())
    } catch (err) { return fail('fetch', `the list could not be fetched or read (${String(err?.message ?? err).slice(0, 120)})`) }
    if (!isObj(list) || !Array.isArray(list['@context']) || list['@context'][0] !== VC_V2 || !Array.isArray(list.type) || !list.type.includes('VerifiableCredential') || !list.type.includes(LIST_TYPE)) return fail('list', `what the address holds is not a ${LIST_TYPE}`)
    // signed by the credential's own issuer, or it is someone else's list put in its place
    if (issuerOf(list) !== issuer) return fail('list', 'the list is not issued by the credential\'s issuer')
    const proof = await verifyIssuerProof(list, issuer, { keyFor: this.keyFor })
    if (!proof.ok) return fail('proof', `the list's signature does not hold: ${proof.reason}`)
    if (!proof.checked) return fail('proof', 'the list\'s signature could not be checked here')
    const t = nowInstant(this.now())
    const from = list.validFrom === undefined ? null : instantOf(list.validFrom), until = list.validUntil === undefined ? null : instantOf(list.validUntil)
    if ((list.validFrom !== undefined && !from) || (list.validUntil !== undefined && !until)) return fail('list', 'the list\'s dates cannot be read')
    if (from && compareInstants(from, nowInstant(this.now() + 60_000)) > 0) return fail('list', 'the list is dated in the future')
    if (until && compareInstants(until, t) <= 0) return fail('list', 'the list has run out (its validUntil has passed)')
    const s = list.credentialSubject
    if (!isObj(s) || s.type !== 'BitstringStatusList') return fail('list', 'the list has no BitstringStatusList in it')
    const purposes = (Array.isArray(s.statusPurpose) ? s.statusPurpose : [s.statusPurpose]).filter((p) => typeof p === 'string')
    let bytes; try { bytes = decodeList(s.encodedList) } catch (err) { return fail('list', `the list's bits cannot be read (${String(err?.message ?? err).slice(0, 80)})`) }
    return { ok: true, bytes, purposes, signedAt: list.validFrom ?? null, validUntil: list.validUntil ?? null, short: bytes.length * 8 < MIN_ENTRIES, ttl: Number.isFinite(s.ttl) && s.ttl > 0 ? s.ttl : null }
  }

  /** The verified list at `url`, from the cache when it is fresh. */
  async list (url, issuer) {
    const key = `${issuer} ${url}`, t = this.now(), hit = this.cache.get(key)
    if (hit && hit.until > t) { this.counts.reused++; return { ...hit.value, cached: true } }
    if (this.pending.has(key)) return { ...(await this.pending.get(key)), cached: true }
    const p = this.#load(url, issuer).then((value) => {
      if (value.ok) this.counts.fetched++; else this.counts.failed[value.problem] = (this.counts.failed[value.problem] ?? 0) + 1
      this.cache.delete(key)
      while (this.cache.size >= this.maxLists) this.cache.delete(this.cache.keys().next().value) // the oldest goes first
      this.cache.set(key, { at: this.now(), until: this.now() + (value.ok ? Math.min(this.ttlMs, value.ttl ?? Infinity) : this.failTtlMs), value })
      return value
    }).finally(() => this.pending.delete(key))
    this.pending.set(key, p)
    return { ...(await p), cached: false }
  }

  /** One entry of a credential's credentialStatus ({ type, purpose, index, list }, as statusEntriesOf gives it) read against its list. */
  async read (entry, { issuer }) {
    if (entry?.type !== STATUS_ENTRY) return fail('entry', `this room cannot read a status entry of type ${String(entry?.type).slice(0, 60)}`)
    if (entry.size !== undefined && entry.size !== 1) return fail('entry', 'this room reads one-bit status entries only')
    const index = Number(entry.index)
    if (!Number.isSafeInteger(index) || index < 0) return fail('entry', 'the entry\'s position is not a whole number')
    const l = await this.list(entry.list, issuer)
    if (!l.ok) return l
    if (!l.purposes.includes(entry.purpose)) return fail('list', `the list is for ${l.purposes.join(', ') || 'no stated purpose'}, not ${entry.purpose}`)
    if (index >= l.bytes.length * 8) return fail('range', 'the list does not reach the entry\'s position')
    return { ok: true, set: bitAt(l.bytes, index), purpose: entry.purpose, signedAt: l.signedAt, cached: l.cached, short: l.short }
  }

  /**
   * The status of a credential from all its entries: 'none' (it names no list: it cannot be withdrawn this way),
   * 'good', 'revoked', 'suspended', or 'unknown' with the reason. One entry that cannot be read makes the whole
   * answer unknown, unless another already says revoked.
   */
  async statusOf (entries, { issuer }) {
    if (!entries?.length) return { status: 'none', lists: [] }
    const lists = []; let unknown = null, state = 'good'
    for (const e of entries.slice(0, 4)) { // a credential has one entry per list its issuer keeps: revocation, perhaps suspension
      const r = await this.read(e, { issuer })
      if (!r.ok) { unknown ??= r; continue }
      lists.push({ purpose: r.purpose, signedAt: r.signedAt, cached: r.cached, ...(r.short ? { short: true } : {}) })
      // a set bit on a list kept for another purpose (a refresh notice, a message) does not withdraw anything
      if (r.set && r.purpose === 'revocation') state = 'revoked'
      else if (r.set && r.purpose === 'suspension' && state !== 'revoked') state = 'suspended'
    }
    if (entries.length > 4) unknown ??= fail('entry', 'it names more status lists than this room reads')
    if (state === 'revoked' || !unknown) return { status: state, lists }
    return { status: 'unknown', problem: unknown.problem, reason: unknown.reason, lists }
  }

  /** For /api/info: how reading lists has gone. Counts and reasons, nothing that names anyone. */
  summary () { return { fetched: this.counts.fetched, reused: this.counts.reused, failed: { ...this.counts.failed }, held: this.cache.size } }
}
