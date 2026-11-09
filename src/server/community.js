// The community whose membership pass this room takes. A room can name one (COMMUNITY_DID, a did:webvh). From
// that DID's own document the room reads where the community lives, shows people where to join it, and answers one
// question for anyone who asks: "is this a current member's pass?" It issues nothing, admits no one and writes
// nothing to the room's log; the community decides who its members are, and its own list says who no longer is.
// With COMMUNITY_DID empty all of this is off, and the page and /api/info say so.
//
// The community's side was read from OpenVTC's trust community (vtc-service) at the commit the room builds from:
//   its DID document's services, matched by type (vta-sdk/src/did_templates/tests.rs): TrustTaskHTTPS and VTCRest at
//     {public_url}/v1, SignInPortal at {public_url}/members/, VTCStatusList at {public_url}/v1/status-lists;
//   GET {base}/community/public-profile (routes/community/profile.rs: communityDid, name, …) and
//   GET {base}/community/did-qr.svg (routes/community/did_qr.rs: the bare DID as a QR code), no sign-in needed;
//   the join page is the member portal with ?join (vtc-service/CLAUDE.md, "Join page");
//   the pass is its membership credential (credentials/dtg.rs), revoked by a bit on its list (status_list/).
import { PASS_CHECK_TYPE, checkDtgCredential, describeDtg, issuerOf, openCredential, verifyDtgCredential, withDidPeer2 } from '../shared/dtg.js'
import { instant, postTask, refusalTo, responseTo, sameDid, serviceEndpoint, signTask, signedTask, statusFor, typeUri, verifyTask } from '../shared/trusttask.js'
import { DID_RE } from '../shared/types.js'
import { publicFetch } from './resolver.js'
import { StatusLists } from './status-list.js'

// What each limit protects:
// what the room learned about the community is kept for a minute, so a page open on fifty screens is one look, not fifty
const LOOK_MS = 60_000
// A check may make this server fetch the presenter's DID and the community's list. One a second on average is more
// than a room of people showing passes needs, and keeps the check from being a way to send requests through the room.
export const MAX_CHECKS_PER_MINUTE = 60
// The community's join requirements (manifest 0.4) are asked for at most once in ten minutes: they change when the
// community's people change them, and the community's door should not see one request per page view. A manifest that
// could not be read is remembered for a minute, for the same reason.
const MANIFEST_MS = 10 * 60_000
const MANIFEST_RETRY_MS = 60_000
const MAX_CRITERIA = 16 // what a page can show a person without a wall of text (the schema sets none)
const MAX_DISCLOSURE_CHARS = 16_000 // the community's own statement of what its directory shows: kept whole up to a page of text, else left to the community's page
const MAX_NAME = 120 // a community's name on the page: a line, not a paragraph

const httpsOnly = (u) => { try { const x = String(u ?? '').trim(); return x && new URL(x).protocol === 'https:' ? new URL(x).href : null } catch { return null } }
const text = (v, max) => (typeof v === 'string' && v.trim() ? [...v.trim()].slice(0, max).join('') : undefined)
const an = (w) => (/^[aeiou]/i.test(w) ? 'an ' : 'a ') + w

export class Community {
  /**
   * config.communityDid: the community's did:webvh, or ''. resolver: the room's (resolve, keyFor). room: () => the
   * identity the room answers as (its did:webvh when it has one, else its did:key). identity: the room's did:key,
   * also accepted as the address of a request. fetch: one that refuses private addresses.
   */
  constructor ({ config, resolver, room, identity, fetch = publicFetch, now = Date.now }) {
    Object.assign(this, { resolver, room, identity, fetch, now })
    const did = String(config.communityDid ?? '').trim()
    this.did = /^did:webvh:/.test(did) && DID_RE.test(did) ? did : ''
    this.problem = did && !this.did ? 'COMMUNITY_DID is set but is not a did:webvh, so no community is in use' : null // said out loud, never silently off
    this.keyFor = withDidPeer2((d, vm, purpose) => resolver.keyFor(d, vm, purpose))
    this.lists = new StatusLists({ keyFor: this.keyFor, fetch, now })
    this.seen = null // { at, value }: the last look at the community
    this.looking = null
    this.recent = [] // times of recent checks, for the cap
    // counts and reasons only: no DID, no credential, nothing a pass said
    this.counts = { asked: 0, current: 0, notCurrent: {}, refused: {} }
    // where a person is sent to join: COMMUNITY_JOIN_URL (https) when set, else derived from the community's own DID document
    this.joinUrl = httpsOnly(config.communityJoinUrl ?? process.env.COMMUNITY_JOIN_URL)
    this.manifestSeen = null // { at, value }: the last read of the join requirements (criteria only, nothing about members)
    this.reading = null
    this.joinCounts = { manifestReads: 0, manifestRefused: {}, cacheHits: 0 } // counts and codes only
  }

  get set () { return Boolean(this.did) }

  async #probe (url, type) {
    try {
      const res = await this.fetch(url, { headers: { accept: type ?? '*/*' } })
      const ok = res.status === 200 && (!type || String(res.headers.get('content-type') ?? '').toLowerCase().includes(type))
      return { url, answers: ok, ...(ok ? {} : { why: res.status === 200 ? 'it answered with something else' : `it answered ${res.status}` }), res: ok ? res : null }
    } catch (err) { return { url, answers: false, why: String(err?.message ?? err).slice(0, 120) } }
  }

  async #look () {
    const out = { set: true, did: this.did, name: null, resolves: false, services: {}, profile: null, joinPage: null, didQr: null, statusList: null, checkedAt: instant(this.now()) }
    let doc
    try { doc = await this.resolver.resolve(this.did) } catch (err) { return { ...out, why: `its DID did not resolve (${String(err?.message ?? err).slice(0, 120)})` } }
    out.resolves = true
    // only https addresses are read from the document: they end up as links on the room's page and as requests from its server
    const https = (u) => { try { return new URL(u).protocol === 'https:' ? u : null } catch { return null } }
    const s = { trustTasks: https(serviceEndpoint(doc, 'TrustTaskHTTPS')), signInPortal: https(serviceEndpoint(doc, 'SignInPortal')), rest: https(serviceEndpoint(doc, 'VTCRest')), statusLists: https(serviceEndpoint(doc, 'VTCStatusList')) }
    out.services = s
    // The API base is {public_url}/v1. TrustTaskHTTPS is defined as exactly that; VTCRest is too today, and was the bare public URL in older documents.
    const trim = (u) => String(u).replace(/\/+$/, '')
    const bases = [...new Set([s.trustTasks, s.rest, s.rest && !/\/v\d+$/.test(trim(s.rest)) ? trim(s.rest) + '/v1' : null].filter(Boolean).map(trim))]
    const join = (() => { try { return s.signInPortal ? new URL('?join', s.signInPortal).href : null } catch { return null } })()
    const pick = async (path, type) => { let last = null; for (const b of bases) { last = await this.#probe(b + path, type); if (last.answers) break } return last }
    const listUrl = s.statusLists || bases[0] ? `${trim(s.statusLists ?? bases[0] + '/status-lists')}/revocation` : null
    const [profile, qr, page, list] = await Promise.all([
      pick('/community/public-profile', 'application/json'),
      pick('/community/did-qr.svg', 'image/svg+xml'),
      join ? this.#probe(join, 'text/html') : null,
      listUrl ? this.lists.list(listUrl, this.did) : null,
    ])
    if (profile) {
      let body = null; try { body = profile.res ? JSON.parse(await profile.res.text()) : null } catch {}
      // the name is taken only from a profile that says it is this community's
      const mine = body?.communityDid === this.did
      if (mine && typeof body.name === 'string' && body.name.trim()) out.name = body.name.trim().slice(0, MAX_NAME)
      out.profile = { url: profile.url, answers: profile.answers && mine, ...(profile.answers && !mine ? { why: 'the profile there is for another DID' } : profile.why ? { why: profile.why } : {}) }
    }
    if (qr) out.didQr = { url: qr.url, answers: qr.answers, ...(qr.why ? { why: qr.why } : {}), local: `/api/qr.svg?text=${encodeURIComponent(this.did)}` } // `local`: the same code (the bare DID) drawn by the room, for a page that may not load another site's images
    if (page) out.joinPage = { url: page.url, answers: page.answers, ...(page.why ? { why: page.why } : {}) }
    if (list) out.statusList = { url: listUrl, answers: list.ok || !['fetch', 'address'].includes(list.problem), verifies: list.ok, ...(list.ok ? {} : { why: list.reason }) }
    return out
  }

  /** GET /api/community: who the community is, where to join it, and whether each part answers right now. */
  async describe () {
    if (!this.did) return { set: false, ...(this.problem ? { problem: this.problem } : {}), words: 'No community is set for this room, so it takes no membership pass.' }
    if (!this.seen || this.now() - this.seen.at > LOOK_MS) {
      this.looking ??= this.#look().then((value) => { this.seen = { at: this.now(), value } }).finally(() => { this.looking = null })
      await this.looking
    }
    const me = this.room()
    return { ...this.seen.value, join: await this.#join(), pass: { check: '/api/community/pass', type: PASS_CHECK_TYPE, recipient: me.did, payload: '{ membership: the membership credential the community issued to you }', words: 'To check a pass, its holder signs one Trust Task document addressed to this room and sends it there. The room keeps nothing.' } }
  }

  /**
   * The signed manifest request to the community's door (https://trusttasks.org/spec/vtc/join-requests/manifest/0.4:
   * an empty payload; a community that turned public discovery off refuses a caller it cannot identify with
   * permissionDenied, trust_tasks/mod.rs discovery_refusal, so the room asks signed, as itself). Returns the criteria
   * as { ok: true, ... } or { ok: false, code }. Only what the page shows is kept, each piece cut to a size; nothing
   * about members is asked for or kept (the manifest holds none).
   */
  async #readManifest (base) {
    this.joinCounts.manifestReads++
    const refused = (code) => { const k = /^[A-Za-z][A-Za-z0-9]{0,40}(:[A-Za-z0-9]{1,40})?$/.test(String(code)) ? String(code) : 'other'; const b = this.joinCounts.manifestRefused; this.#count(b, k in b || Object.keys(b).length < 24 ? k : 'other'); return { ok: false, code: k } } // few distinct codes are counted: a hostile door cannot grow the counter
    let out
    try { out = await postTask(base, signedTask(this.room(), { type: typeUri('vtc/join-requests/manifest', '0.4'), recipient: this.did, payload: {} }), { fetch: this.fetch, timeoutMs: 15_000 }) } catch { return refused('unavailable') }
    if (out.kind === 'error') return refused(out.code)
    const p = out.kind === 'response' ? out.payload : null
    if (!p || typeof p !== 'object' || p.communityDid !== this.did || !Array.isArray(p.criteria)) return refused('malformedResponse')
    const num = (v) => (Number.isInteger(v) && v >= 0 && v < 1_000_000 ? v : undefined)
    const criteria = p.criteria.slice(0, MAX_CRITERIA).filter((c) => c && typeof c === 'object' && text(c.id, 128)).map((c) => {
      const v = c.vetting && typeof c.vetting === 'object' ? c.vetting : null
      const byMethod = v?.minByMethod && typeof v.minByMethod === 'object' ? Object.fromEntries(Object.entries(v.minByMethod).slice(0, 10).filter(([, n]) => num(n) !== undefined).map(([m, n]) => [String(m).slice(0, 40), n])) : undefined
      return {
        id: text(c.id, 128), ...(text(c.description, 300) ? { description: text(c.description, 300) } : {}),
        admission: c.admission === 'automatic' ? 'automatic' : 'review', ...(typeof c.invitationRequired === 'boolean' ? { invitationRequired: c.invitationRequired } : {}),
        ...(text(c.requirementsDigest, 100) ? { requirementsDigest: text(c.requirementsDigest, 100) } : {}),
        ...(c.presentationDefinition ? { asksForCredentials: true } : {}),
        ...(v ? { vetting: { ...(num(v.minStatements) !== undefined ? { minStatements: v.minStatements } : {}), acceptedMethods: (Array.isArray(v.acceptedMethods) ? v.acceptedMethods : []).slice(0, 10).map((m) => text(m, 40)).filter(Boolean), ...(byMethod && Object.keys(byMethod).length ? { minByMethod: byMethod } : {}), ...(['required', 'optional', 'none'].includes(v.invitation) ? { invitation: v.invitation } : {}) } } : {}),
      }
    })
    // the attributes a person is asked for sit at the top of the manifest, not under each criterion (the bundle's Response)
    const attributes = (Array.isArray(p.requestedAttributes) ? p.requestedAttributes : []).slice(0, 32).filter((a) => text(a?.type, 128)).map((a) => ({ type: text(a.type, 128), required: a.required !== false, ...(text(a.purpose, 256) ? { purpose: text(a.purpose, 256) } : {}) }))
    let disclosure = null; try { if (p.directoryDisclosure && typeof p.directoryDisclosure === 'object' && JSON.stringify(p.directoryDisclosure).length <= MAX_DISCLOSURE_CHARS) disclosure = p.directoryDisclosure } catch {}
    return { ok: true, criteria, attributes, directoryDisclosure: disclosure }
  }

  /** The "join" part of GET /api/community: where to go, what is asked there, and, in words, why it could not be read. */
  async #join () {
    const look = this.seen.value
    const s = look.services ?? {}
    // The link: the setting when given; else the community's own sign-in portal (its DID document names it, and the
    // page is the member portal with ?join); else /members/ on the origin of its API address (vtc-service serves it
    // there when run with its website; not confirmed for every community, which is why the setting exists).
    let url = this.joinUrl ?? look.joinPage?.url ?? null
    if (!url) { try { const o = s.rest ?? s.trustTasks; if (o) url = new URL('/members/?join', o).href } catch {} }
    const out = { url, criteria: [], attributes: [], fetchedAt: null }
    const base = s.trustTasks ?? (s.rest && !/\/v\d+$/.test(s.rest.replace(/\/+$/, '')) ? s.rest.replace(/\/+$/, '') + '/v1' : s.rest)
    if (!look.resolves || !base) return { ...out, problemCode: 'unavailable', problem: look.resolves ? 'The community\'s DID names no address this room can ask what it requires (unavailable).' : 'The community\'s DID did not resolve, so what it requires could not be read (unavailable).' }
    const m =this.manifestSeen
    if (m && this.now() - m.at < (m.value.ok ? MANIFEST_MS : MANIFEST_RETRY_MS)) this.joinCounts.cacheHits++
    else {
      this.reading ??= this.#readManifest(base).then((value) => { this.manifestSeen = { at: this.now(), value } }).finally(() => { this.reading = null }) // one request in flight, however many pages ask
      await this.reading
    }
    const v = this.manifestSeen.value, at = instant(this.manifestSeen.at)
    if (!v.ok) return { ...out, fetchedAt: at, problemCode: v.code, problem: `The community's requirements could not be read right now (${v.code}). You can still follow the link and read them there.` }
    return { ...out, criteria: v.criteria, attributes: v.attributes, ...(v.directoryDisclosure ? { directoryDisclosure: v.directoryDisclosure } : {}), fetchedAt: at }
  }

  #count (bucket, reason) { bucket[reason] = (bucket[reason] ?? 0) + 1 }

  /** The answer to a pass: is it a current member's? Every "no" says why. Reads only; changes nothing. */
  async #judge (membership, presenter) {
    const base = { community: this.did, checkedAt: instant(this.now()) }
    const noo = (problem, reason, extra = {}) => ({ member: false, problem, reason, ...base, ...extra })
    const vc = openCredential(membership)
    if (!vc) return noo('shape', 'payload.membership: the membership credential (the object, its JSON, or base64url of its JSON)')
    const bad = checkDtgCredential(vc)
    if (bad) return noo('shape', bad)
    const d = describeDtg(vc)
    if (d.kind !== 'membership') return noo('kind', `this is ${an(d.kind === 'other' ? String(d.subtype) : d.kind + ' credential')}; a membership credential is needed here`)
    // who issued it and who it is about are settled before anything is fetched, so only the named community's key and list are ever asked for
    const issuer = issuerOf(vc), subject = vc.credentialSubject.id
    if (issuer !== this.did) return noo('issuer', issuer === presenter && subject === this.did ? 'this is your own half of the pair (issued by you, about the community); show the one the community issued to you' : 'this pass was not issued by the community this room names')
    if (subject !== presenter) return noo('presenter', 'this pass is about someone else: the one showing it must be the one it was issued to')
    const r = await verifyDtgCredential(vc, { keyFor: this.keyFor, now: this.now(), kinds: ['membership'] })
    if (!r.ok) return noo(r.problem, r.reason)
    if (!r.checked) return noo('key', 'the community\'s key could not be read, so its signature was not checked')
    if (!r.claims.validUntil) return noo('dates', 'a pass says when it ends (validUntil); this one does not')
    const st = await this.lists.statusOf(r.claims.status, { issuer: this.did })
    const about = { validUntil: r.claims.validUntil, status: st.status, lists: st.lists }
    if (st.status === 'revoked') return noo('revoked', 'the community has revoked this pass', about)
    if (st.status === 'suspended') return noo('suspended', 'the community has suspended this pass for now', about)
    // fail closed: a list the room could not read is "not confirmed", never "fine"
    if (st.status === 'unknown') return noo('status-unknown', `the community's list of revoked passes could not be read (${st.reason}), so this pass is not confirmed. Try again shortly.`, about)
    const notes = [...r.notes]
    if (st.status === 'none') notes.push('it names no revocation list, so it holds until it runs out')
    if (st.lists.some((l) => l.short)) notes.push('the community\'s list is shorter than the 131,072 places the standard asks for, which makes one holder easier to tell from the rest')
    return { member: true, ...base, subject, validFrom: r.claims.validFrom, ...about, personhood: r.claims.personhood, context: r.context.name, notes }
  }

  /**
   * POST /api/community/pass: one signed Trust Task document (PASS_CHECK_TYPE) from the pass's holder. Returns
   * { status, body, headers? } where body is the room's signed answer: the task's "#response" with
   * { member: true | false, problem?, reason?, … }, or a refusal when the request itself could not be taken.
   */
  async check (text) {
    this.counts.asked++
    const mine = this.room()
    const refuse = (request, who, code, message, details, headers) => {
      this.#count(this.counts.refused, code)
      return { status: statusFor(code), headers, body: signTask(refusalTo(request, { code, message, details }, who.did), who) }
    }
    let doc; try { doc = JSON.parse(text) } catch { return refuse(null, mine, 'malformedRequest', 'the body is one signed Trust Task document, as JSON') }
    const who = [mine, this.identity].find((i) => i && sameDid(doc?.recipient, i.did)) ?? mine
    if (!this.did) return refuse(doc, who, 'unsupportedType', 'this room takes no membership pass: no community is set')
    if (doc?.type !== PASS_CHECK_TYPE) return refuse(doc, who, 'unsupportedType', `this address takes one task: ${PASS_CHECK_TYPE}`)
    const t = this.now()
    this.recent = this.recent.filter((x) => t - x < 60_000)
    if (this.recent.length >= MAX_CHECKS_PER_MINUTE) return refuse(doc, who, 'unavailable', 'too many passes are being checked right now; try again in a minute', undefined, { 'retry-after': '60' })
    // a request, so signed for authentication, by the one presenting; addressed to this room by name; fresh
    const v = await verifyTask(doc, { keyFor: this.keyFor, me: who.did, now: t, bytes: Buffer.byteLength(text), purposes: ['authentication'] })
    if (!v.ok) return refuse(doc, who, v.code, v.message, v.details)
    // A place in the minute's budget is taken only now, once the signature holds: the budget is for the community's
    // list that a real check reads, so posts nobody signed must not fill it and shut real holders out.
    this.recent = this.recent.filter((x) => t - x < 60_000)
    if (this.recent.length >= MAX_CHECKS_PER_MINUTE) return refuse(doc, who, 'unavailable', 'too many passes are being checked right now; try again in a minute', undefined, { 'retry-after': '60' })
    this.recent.push(t)
    const answer = await this.#judge(doc.payload?.membership, v.signer)
    if (answer.member) this.counts.current++; else this.#count(this.counts.notCurrent, answer.problem)
    return { status: 200, body: signTask(responseTo(doc, answer, who.did), who) }
  }

  /** For /api/info and /api/state: set or not, what answered at the last look, and how checks have gone. No DID of anyone, no address. */
  summary () {
    if (!this.did) return { set: false, ...(this.problem ? { problem: this.problem } : {}) }
    if (!this.looking && (!this.seen || this.now() - this.seen.at > LOOK_MS)) this.describe().catch(() => {}) // looked at in the background; this answer never waits on another server
    const s = this.seen?.value
    return {
      set: true,
      answered: s ? { did: s.resolves, profile: Boolean(s.profile?.answers), joinPage: Boolean(s.joinPage?.answers), didQr: Boolean(s.didQr?.answers), statusList: Boolean(s.statusList?.verifies) } : null,
      lookedAt: s?.checkedAt ?? null,
      passes: { asked: this.counts.asked, current: this.counts.current, notCurrent: { ...this.counts.notCurrent }, refused: { ...this.counts.refused } },
      statusLists: this.lists.summary(),
      join: { manifestReads: this.joinCounts.manifestReads, manifestRefused: { ...this.joinCounts.manifestRefused }, cacheHits: this.joinCounts.cacheHits },
      details: '/api/community',
    }
  }

  /** /api/community and /api/community/pass. Returns false when the path isn't this module's. */
  async handle (req, res, path, readBody, send) {
    if (path !== '/api/community' && path !== '/api/community/pass') return false
    if (path === '/api/community') {
      if (req.method !== 'GET') { send(res, 405, { error: 'GET' }, { allow: 'GET' }); return true }
      send(res, 200, await this.describe(), { 'cache-control': 'public, max-age=30' })
      return true
    }
    if (req.method !== 'POST') { send(res, 405, { error: `POST a signed ${PASS_CHECK_TYPE} document here` }, { allow: 'POST' }); return true }
    let text; try { text = await readBody(req) } catch { send(res, 413, { error: 'a document is at most 64 KB' }, { 'cache-control': 'no-store' }); return true }
    const out = await this.check(text)
    send(res, out.status, out.body, { 'cache-control': 'no-store', ...out.headers })
    return true
  }
}
