// Signing in with a wallet by scanning a code: what the page, the room and a wallet have to agree on.
//
// A wallet in the OpenVTC family does not scan a DIDComm invitation. It scans a "trigger link" and then runs the
// auth/oob Trust Tasks with whoever the link names: the browser makes a key for this one sign-in (K_b), the wallet
// claims the code with a throwaway key (K_a), the person's own DID proves the number on the screen and signs a grant
// naming K_b, and only K_b can turn that grant into anything. The page never holds the person's key.
//
// Every rule here was read from OpenVTC at the commit the room builds from:
//   vti-oob-server/src/util.rs (the link, the did:key rule, contextDigest), types.rs (which version of each task),
//   record.rs (the two windows), vtc-service/admin-ui/src/members/oob.ts (what a browser does), vtc-client/src/signin.rs.
// Shared by the page, the server and the tests' wallet: no Node-only and no browser-only APIs.
import { ed25519, fromBase58btc, multibase } from './crypto.js'
import { ed25519Multikey, newIdentity } from './did.js'
import { proofConfig, signingInput } from './proof.js'
import { classify, instant, multihashOf, taskDocument, typeUri } from './trusttask.js'

/** The one version of each task that is served (vti-oob-server/src/types.rs; pinned in vti-specs-core/trust-tasks.toml). */
export const OOB = {
  request: typeUri('auth/oob/request', '0.2'),
  claim: typeUri('auth/oob/claim', '0.2'),
  prove: typeUri('auth/oob/prove', '0.3'),
  respond: typeUri('auth/oob/respond', '0.3'),
  redeem: typeUri('auth/oob/redeem', '0.2'),
  cancel: typeUri('auth/oob/cancel', '0.1'),
  // never sent alone: identify rides inside prove, grant inside respond
  identify: typeUri('auth/oob/identify', '0.1'),
  grant: typeUri('auth/oob/grant', '0.3'),
}
/** The six a service answers; identify or grant sent alone is an unsupported type. */
export const SERVED = ['request', 'claim', 'prove', 'respond', 'redeem', 'cancel']

/** What a redeemed sign-in says about how the person proved themselves: a DID, on another device, with the wallet's own check of the person. */
export const AMR = ['did', 'oob', 'uv']
/** The member of `ext` an OpenVTC community uses to ask for one of its several sessions. The room has one, so it refuses it. */
export const SESSION_EXT = 'org.openvtc.session'

// The trigger link (OpenVTC's "contract C1"; util.rs:185-260).
/**
 * Which exchange the link starts, written as a path on the link's own host (https://link.trustoverip.org/vti/flow/sign-in/0.1).
 * It names the exchange, not the kind of service: the crate that defines the exchange has this one constant and is
 * written for any service to use, and a community's own GET /v1/member/sign-in/config answers it. ("vtc-sign-in"
 * appears only in made-up answers inside two client tests.) So the room, which is not a community, sends it too.
 */
export const SIGN_IN_FLOW = '/vti/flow/sign-in/0.1'
/** RLTP's cross-app connect uses the same link with this flow. The room does not answer it (see docs/wallet-sign-in.md). */
export const SHARED_CONNECT_FLOW = '/vti/flow/shared-connect/0.1'
export const DEFAULT_LINK_HOST = 'link.trustoverip.org'
// 251 bytes is what a QR code at error-correction level M holds while staying small enough for a phone to read off a
// screen (VTI-LNK-081). The room's own QR endpoint draws at level M, so the number and the need are the same thing here.
export const MAX_LINK_BYTES = 251
/** A reader gives up on anything longer than this many characters before looking inside (VTI-LNK-020). */
export const MAX_READ_CHARS = 1536

// The two clocks (record.rs:28-33). A code on a screen is good for two minutes: long enough to find a phone and scan,
// short enough that a photo of the screen is soon worthless. Scanning starts a second two minutes for the person to
// type the number and approve. The task's own schema allows up to three minutes for each.
export const CLAIM_SECONDS = 120
export const DECISION_SECONDS = 120

export const REQUEST_ID = /^[A-Za-z0-9_-]{22,43}$/ // 16 to 32 random bytes, base64url without padding
export const MATCH_NUMBER = /^[0-9]{2}$/
export const TASK_FAMILY = /^[a-z][a-z0-9]*(-[a-z0-9]+)*(\/[a-z][a-z0-9]*(-[a-z0-9]+)*)*$/
/** Families a grant can never let a browser key sign for, whatever it says: signing in, access and consent (delegation.rs:39). */
export const NEVER_DELEGATED = ['auth', 'acl', 'consent', 'task-consent', 'confirm']

/**
 * True for an Ed25519 did:key and nothing else. Both keys of the exchange must be one, and a service decides it from
 * the identifier alone, before it reads a proof or looks anything up (util.rs:31).
 */
export function isEd25519DidKey (did) {
  if (typeof did !== 'string' || !did.startsWith('did:key:z6Mk')) return false
  try { const b = fromBase58btc(did.slice('did:key:z'.length)); return b.length === 34 && b[0] === 0xed && b[1] === 0x01 } catch { return false }
}

/** Percent-encode & = # and %, and nothing else: the link's one encoding rule. */
export const encodeFrom = (did) => String(did).replace(/[&=#%]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())

/**
 * Why a link host cannot be used, or null. It must be a public DNS name in lower case (VTI-LNK-060), and it must not
 * be the page's own domain or under it (VTI-LNK-084): a link to the same domain as the page it is tapped on opens in
 * the browser, not in the wallet.
 */
export function checkLinkHost (linkHost, portalHost) {
  const host = String(linkHost ?? ''), labels = host.split('.')
  const labelOk = (l) => l.length > 0 && l.length <= 63 && !l.startsWith('-') && !l.endsWith('-') && /^[a-z0-9-]+$/.test(l)
  if (host.length > 253 || labels.length < 2 || !labels.every(labelOk) || /^[0-9]+$/.test(labels.at(-1)) || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.home.arpa')) return `the sign-in link host "${host}" is not a public DNS name`
  const portal = portalHost ? String(portalHost).toLowerCase() : ''
  const under = (a, b) => a === b || a.endsWith('.' + b)
  if (portal && (under(portal, host) || under(host, portal))) return `the sign-in link host "${host}" is on this site's own domain (${portal}): a link tapped there opens in the browser, not the wallet. Use a separate host, such as ${DEFAULT_LINK_HOST}`
  return null
}

/** The link as text, whatever its length. */
const linkText = ({ linkHost = DEFAULT_LINK_HOST, did, flow = SIGN_IN_FLOW }, requestId, claimDeadline) => `https://${linkHost}/t#_from=${encodeFrom(did)}&_id=${requestId}&_exp=${claimDeadline}&_type=${flow}`

/**
 * The trigger link for one request: https://<link host>/t#_from=<the service's DID>&_id=<the request>&_exp=<when the
 * code runs out, in seconds since 1970>&_type=<the flow>. Everything is in the fragment, which a browser never sends
 * to the link host. Throws when the link is not plain ASCII or is longer than a code can hold.
 */
export function triggerLink (about, requestId, claimDeadline) {
  const link = linkText(about, requestId, claimDeadline)
  // eslint-disable-next-line no-control-regex
  if (!/^[\x00-\x7f]*$/.test(link) || link.length > MAX_LINK_BYTES) throw new Error('this sign-in link is too long to show as a code')
  return link
}

/**
 * Whether a DID leaves room for a link, before any request is made: the link's length with a 22-character request id
 * and a ten-digit time. The rest of the link is fixed, so with the usual host and flow a DID may be 143 bytes.
 */
export function linkRoom (about) {
  const link = linkText(about, 'A'.repeat(22), 1_000_000_000)
  // eslint-disable-next-line no-control-regex
  const ascii = /^[\x00-\x7f]*$/.test(link)
  return { bytes: link.length, max: MAX_LINK_BYTES, fits: ascii && link.length <= MAX_LINK_BYTES, didMayBe: MAX_LINK_BYTES - (link.length - encodeFrom(about.did).length) }
}

/**
 * Read a trigger link the way a wallet's scanner does, as far as the sources here state the rules (the chapter that
 * defines them, VTI spec 07a, is not among them; these are from OpenVTC's design note on the link and from RLTP's
 * reader of the same link, trust-protocol lib/src/shared-connect.ts:414-448): https only, no port and no user in the
 * address, the four names in the fragment, none of them twice, and nothing fetched. Returns { ok: true, linkHost, from, id, exp, type, flow } or { ok: false, why } where why is
 * 'too-long', 'not-ours' (no reserved name: hand the text to another reader), 'query-form' or 'malformed'.
 */
export function readTriggerLink (text) {
  const s = String(text ?? '')
  if ([...s].length > MAX_READ_CHARS) return { ok: false, why: 'too-long' }
  let u; try { u = new URL(s) } catch { return { ok: false, why: 'not-ours' } }
  const names = ['_from', '_id', '_exp', '_type']
  const pairs = u.hash.slice(1).split('&').filter(Boolean).map((p) => { const i = p.indexOf('='); return i < 0 ? [p, ''] : [p.slice(0, i), p.slice(i + 1)] })
  const inFragment = pairs.filter(([k]) => names.includes(k))
  if (!inFragment.length) return { ok: false, why: names.some((n) => u.searchParams.has(n)) ? 'query-form' : 'not-ours' }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return { ok: false, why: 'malformed' }
  const got = {}
  for (const [k, v] of inFragment) { if (k in got) return { ok: false, why: 'malformed' }; got[k] = v }
  let from; try { from = decodeURIComponent(got._from ?? '') } catch { return { ok: false, why: 'malformed' } }
  if (!/^did:[a-z0-9]+:.+/.test(from) || !/^[1-9][0-9]{0,11}$/.test(got._exp ?? '') || !got._id || !got._type) return { ok: false, why: 'malformed' }
  // a flow written as a path is a page on the link's own host; flows are compared as whole addresses (VTI-LNK-041)
  const flow = got._type.startsWith('/') ? `https://${u.host}${got._type}` : got._type
  return { ok: true, linkHost: u.host, from, id: got._id, exp: Number(got._exp), type: got._type, flow }
}

/**
 * What a grant is bound to: "z" + base58btc(0x12 0x20 + SHA-256 of the canonical JSON) of the service's signed second
 * answer, its proof included. A grant made for one screen of facts cannot be used for another.
 */
export const contextDigest = (signedStep2) => multihashOf(signedStep2)
/** True when two digests name the same 34 bytes, spelled "z" (base58btc) or "u" (base64url); anything else is no match (util.rs:62). */
export function sameContextDigest (a, b) {
  const raw = (s) => {
    if (typeof s !== 'string' || s.length < 2) return null
    try {
      if (s[0] === 'z') return fromBase58btc(s.slice(1))
      if (s[0] === 'u' && /^[A-Za-z0-9_-]+$/.test(s.slice(1))) return Uint8Array.from(atob(s.slice(1).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
    } catch {}
    return null
  }
  const x = raw(a), y = raw(b)
  return Boolean(x && y && x.length === 34 && y.length === 34 && x.every((v, i) => v === y[i]))
}

/** An RFC 3339 time as whole seconds since 1970, or null (an integer is not one: the 0.2 tasks spell times as text). */
export function epochOf (v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(v)) return null
  const ms = Date.parse(v)
  return Number.isNaN(ms) ? null : Math.max(0, Math.floor(ms / 1000))
}
export const rfc3339 = (epochSeconds) => instant(epochSeconds * 1000)

/**
 * A key for one sign-in, made in the browser. Where the browser can, the private half is made by WebCrypto as a key
 * that cannot be read out: script can ask it to sign and nothing else, so nothing on the page (or injected into it)
 * can copy it. That needs a secure page (https or localhost) and a browser with Ed25519 in WebCrypto. Anywhere else
 * the key is an ordinary one held in this function's memory for the life of the page, and `kept` says which it is.
 * Either way it is never stored and never sent.
 */
export async function newSessionKey () {
  const subtle = globalThis.crypto?.subtle
  if (subtle) {
    try {
      const pair = await subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])
      if (pair.privateKey.extractable) throw new Error('refusing a sign-in key that can be read out')
      const mk = ed25519Multikey(new Uint8Array(await subtle.exportKey('raw', pair.publicKey))), did = `did:key:${mk}`
      return { did, verificationMethod: `${did}#${mk}`, kept: 'webcrypto', extractable: false, sign: async (bytes) => new Uint8Array(await subtle.sign({ name: 'Ed25519' }, pair.privateKey, bytes)) }
    } catch {} // no Ed25519 in this browser's WebCrypto: the plain key below
  }
  const id = newIdentity()
  return { did: id.did, verificationMethod: id.verificationMethod, kept: 'memory', extractable: true, sign: async (bytes) => ed25519.sign(bytes, id.seed) }
}

/** Sign a document with a session key: the same eddsa-jcs-2022 proof as everywhere else, made by whatever holds the key. */
export async function signWith (doc, key, purpose = 'authentication') {
  if (doc.issuer !== key.did) throw new Error('a document is signed by its issuer')
  const cfg = proofConfig({ verificationMethod: key.verificationMethod, created: doc.issuedAt, proofPurpose: purpose })
  return { ...doc, proof: { ...cfg, proofValue: multibase(await key.sign(signingInput(doc, cfg))) } }
}

/** A refusal's own name: "auth/oob/redeem:pending" is "pending". */
export const localCode = (code) => String(code ?? '').slice(String(code ?? '').lastIndexOf(':') + 1)

/**
 * The browser's side of a sign-in, without a page around it. `config` is what the room's GET /api/signin/config
 * answers; `send(doc)` posts one signed document to the room's Trust Task door and gives back the reply document.
 * Every poll is a new document with a new id: a door answers a repeated id with the answer it gave the first time.
 */
export function starter ({ config, key, send }) {
  const ask = async (type, payload) => {
    const reply = await send(await signWith(taskDocument({ type, issuer: key.did, recipient: config.serviceDid, payload }), key))
    return classify(reply, type)
  }
  return {
    key,
    /** Open a request. Returns { requestId, claimClosesAt, claimDeadline, link } or throws with the room's words. */
    async open () {
      const a = await ask(OOB.request, { purpose: 'login', mode: 'scan' })
      if (a.kind !== 'response') throw Object.assign(new Error(a.message || 'the room did not open a sign-in'), { code: a.code })
      const { requestId, claimClosesAt } = a.payload ?? {}, claimDeadline = epochOf(claimClosesAt)
      if (!REQUEST_ID.test(requestId ?? '') || claimDeadline === null) throw new Error('the room answered the sign-in request in a shape this page cannot read')
      return { requestId, claimClosesAt, claimDeadline, link: triggerLink({ linkHost: config.linkHost, did: config.serviceDid, flow: config.flow }, requestId, claimDeadline) }
    },
    /**
     * One poll. { state: 'waiting', stage, matchNumber? } while the wallet has not finished (stage is pending, claimed
     * or identified; the number is there once a wallet has scanned), { state: 'signed-in', subject, displayName,
     * sessionEndsAt, amr }, { state: 'declined', cancelled, reason? }, or { state: 'expired' }.
     */
    async redeem (requestId) {
      const a = await ask(OOB.redeem, { requestId })
      if (a.kind === 'response') return { state: 'signed-in', subject: String(a.payload?.subject ?? ''), displayName: typeof a.payload?.displayName === 'string' ? a.payload.displayName : null, sessionEndsAt: a.payload?.sessionEndsAt ?? null, amr: Array.isArray(a.payload?.amr) ? a.payload.amr : [] }
      const local = localCode(a.code), d = a.details ?? {}
      if (local === 'pending') return { state: 'waiting', stage: d.state ?? 'pending', ...(MATCH_NUMBER.test(d.matchNumber ?? '') ? { matchNumber: d.matchNumber } : {}) }
      if (local === 'declined') return { state: 'declined', cancelled: d.state === 'cancelled', ...(typeof d.reason === 'string' ? { reason: d.reason } : {}) }
      if (local === 'requestExpired' || local === 'expired') return { state: 'expired' }
      throw Object.assign(new Error(a.message || 'the room refused the sign-in'), { code: a.code })
    },
    /** Give the request up. It ends by its own clock anyway, so a failure here is not worth telling anyone. */
    async cancel (requestId) { try { await ask(OOB.cancel, { requestId }) } catch {} },
  }
}
