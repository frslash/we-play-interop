// The join desk (join.js) behind a live route, for the room's TEST COMMUNITY only. A visit's QR carries a ?_oob=
// DIDComm out-of-band invitation whose id is a one-time desk token (an invite made by the room's own key, which
// lives as long as the visit's code). A wallet answers it at /didcomm, where the desk checks the token (one use,
// runs out), a fresh nonce signed by the joiner's DID, and the rest of Security's P4 conditions. A good answer is
// a PENDING request in the test community, never membership: a test member's own signed tap admits it, and what it
// gets is a short test credential. Nothing here writes to the room's log or grants anything in the room itself.
// In memory only, like the visits: worth nothing after a restart.
import { INVITE_MAX_MS, JoinDesk, Refused, invitation as invitePresentation } from './join.js'
import { didcommEndpoint, roomDidStatus } from './roomdid.js'
import { VISIT_MS } from './visits.js'

const STATUS_MS = 30_000 // how long a read of the room's DID log is trusted before it is read again
const PLAIN_TYPES = ['application/json', 'application/didcomm-plain+json']

export class JoinRoute {
  /** identity: the room's key. testMembers: did:key DIDs who may tap yes in the test community (JOIN_TEST_MEMBERS). */
  constructor ({ identity, config, resolver, now = Date.now }) {
    Object.assign(this, { identity, config, resolver, now })
    this.testMembers = (config.joinTestMembers ?? []).filter((d) => /^did:key:z[1-9A-HJ-NP-Za-km-z]+$/.test(d))
    this.community = { name: `${config.workspaceName} test community`, test: true, note: 'Test members and test values only. Joining it is not joining the room: it grants nothing in the room and writes nothing to its log.' }
    this.status = { did: null, didcomm: null, at: -Infinity }
    this.#build(identity.did)
  }

  /** The DID the invitations come from: the room's did:webvh when it has a log, else its did:key. */
  get did () { return this.desk.room.did }

  #build (did) {
    const room = { did, seed: this.identity.seed, verificationMethod: did === this.identity.did ? this.identity.verificationMethod : `${did}#room` }
    let host = ''; try { host = new URL(this.config.publicUrl).host } catch {}
    this.desk = new JoinDesk({ room, host, resolver: this.resolver, now: this.now, inviteMs: Math.min(VISIT_MS, INVITE_MAX_MS) })
    this.desk.roomName = this.community.name
    this.desk.seed(this.identity.did) // the room's own key makes the invites; it never signs a yes
    for (const d of this.testMembers) this.desk.seed(d)
  }

  /** Re-reads the room's DID log at most every 30 s; a new DID (first mint) starts a fresh desk. */
  async refresh (force = false) {
    if (!force && this.now() - this.status.at < STATUS_MS) return this.status
    const s = await roomDidStatus({ dataDir: this.config.dataDir, file: this.config.didLogFile })
    this.status = { ...s, at: this.now() }
    const did = s.did ?? this.identity.did
    if (did !== this.desk.room.did) this.#build(did)
    return this.status
  }

  /** A one-time desk token for a visit's invitation, or null when the desk has too many open invites (P4.5). */
  mint () {
    try { return this.desk.invite(invitePresentation(this.identity, { room: this.desk.room.did, nonce: this.desk.challenge() })).token } catch (e) { if (e instanceof Refused) return null; throw e }
  }

  /** What the room reports about joining from Keyring, each part checked live. `oob`: this visit's QR carries ?_oob=. */
  readiness ({ oob = false } = {}) {
    const want = didcommEndpoint(this.config.publicUrl)
    const checks = {
      oobQr: Boolean(oob),
      route: Boolean(this.desk && want), // /didcomm answers, at the address the DID names
      didcommService: Boolean(want && this.status.did && this.status.did === this.desk.room.did && this.status.didcomm === want),
      testCommunityOnly: this.community.test === true,
      oneTimeCodeAndExpiry: this.desk.inviteMs > 0 && this.desk.inviteMs <= INVITE_MAX_MS,
    }
    return { ready: Object.values(checks).every(Boolean), checks, community: this.community, endpoint: want || null, did: this.desk.room.did }
  }

  /**
   * /didcomm and below. GET /didcomm/nonce (or POST): a fresh nonce to sign. POST /didcomm: a join request, as the
   * desk's message or a DIDComm plaintext message carrying it in `body`. POST /didcomm/approve: a test member's tap.
   * Returns false when the path isn't this route's.
   */
  async handle (req, res, path, readBody, send) {
    if (path !== '/didcomm' && !path.startsWith('/didcomm/')) return false
    const headers = { 'cache-control': 'no-store' }
    const out = (...a) => { send(...a); return true }
    if (path === '/didcomm/nonce') {
      if (req.method !== 'GET' && req.method !== 'POST') return out(res, 405, { error: 'GET or POST' }, { ...headers, allow: 'GET, POST' })
      try { return out(res, 200, { nonce: this.desk.challenge(), community: this.community }, headers) } catch (e) { return out(res, 429, { error: e.message }, headers) }
    }
    if (req.method !== 'POST') return out(res, 405, { error: 'POST a join request here', community: this.community }, { ...headers, allow: 'POST' })
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
    if (type && !PLAIN_TYPES.includes(type)) return out(res, 415, { error: 'This room reads DIDComm plaintext messages only for now (application/didcomm-plain+json). Encrypted and signed envelopes are not read here yet.' }, headers)
    let msg; try { msg = JSON.parse(await readBody(req)) } catch { return out(res, 400, { error: 'the body is JSON' }, headers) }
    if (msg && typeof msg === 'object' && ('ciphertext' in msg || 'protected' in msg || 'signatures' in msg)) return out(res, 415, { error: 'Encrypted and signed DIDComm envelopes are not read here yet; send the plaintext message.' }, headers)
    try {
      if (path === '/didcomm/approve') {
        const credential = this.desk.approve(String(msg?.requestId ?? ''), msg?.approval)
        return out(res, 200, { status: 'member of the test community', community: this.community, credential }, headers)
      }
      if (path !== '/didcomm') return out(res, 404, { error: 'no such path' }, headers)
      const inner = msg && typeof msg.body === 'object' && msg.body && !Array.isArray(msg.body) && !msg.proof ? { type: msg.type, ...msg.body } : msg
      const r = await this.desk.receive(inner)
      return out(res, 202, { ...r, community: this.community, next: 'A test member of this community has to say yes before you can read anything.' }, headers)
    } catch (e) {
      if (e instanceof Refused) return out(res, 403, { error: e.message }, headers)
      throw e
    }
  }
}
