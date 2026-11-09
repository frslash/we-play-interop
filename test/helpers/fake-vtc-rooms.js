// A stand-in for a community's door (OpenVTC's VTC) as far as one encrypted room goes, on 127.0.0.1: the offers it makes
// to a member and the acceptance that admits them. Everything else a community's door serves for a room (rooms/info,
// rooms/epoch/commits, the record tasks) is the room host that test/helpers/fake-vti.js already stands in for: this
// door passes those documents on to it unchanged, which is what the real one is (the community IS the host of its rooms:
// vtc-service/src/trust_tasks/mod.rs `crate::rooms::handlers::serves`). The community's DID is that host's DID.
// It proves the bridge's side is self-consistent; it does not prove interop (test/live/community-room-live.test.js does).
//
// Each shape below was read from:
//   offers/list 0.4     vti-specs-vtc/trust-tasks/vtc/rooms/offers/list/0.4.bundle.json: request { cursor?, limit 1..100 }, answer
//                       { items: [OfferV2], nextCursor?, renewals? (first page only) }, OfferV2 and its three credential strings,
//                       error vtc/rooms/offers/list:notAMember; only 0.4 is served (vtc-service/src/trust_tasks/mod.rs)
//   offers/accept 0.1   .../offers/accept/0.1.bundle.json: request { roomId, keyPackage? }, answer { roomId, state: 'admitted',
//                       epoch >= 1, welcome?, ratchetTree? } and the nine error codes; a repeat with the KeyPackage first sent is
//                       answered with the Welcome kept (vtc-service/src/rooms/community.rs KeptWelcome: digest of the KeyPackage)
//   the credential strings  JSON text of the signed credential (vta-service/src/operations/room_issuance.rs sign_as_room)
//   the door            one route, POST /trust-tasks, a signed request: the signer is the member (vtc-service/src/trust_tasks/mod.rs)
// Where it is NOT the real thing, on purpose:
//   - The community's own trust agent is the fake trust agent's owner side (fake.advance, fake.welcomeFor): no MLS. It checks a
//     KeyPackage only for its shape (base64url of the 48 bytes the fake mints); that this trust agent MINTED it is enforced
//     where the real one enforces it, by rooms/keys/act on the member's side (room_act.rs complete_offer) and at the Welcome.
//   - The membership and authority credentials are look-alikes signed by a key of their own (the room's key is private to
//     fake-vti.js); the invitation is fake-vti's own, issued by the room. The vault checks each against its issuer's DID.
//   - Its answers are unsigned, like a community reached only by address.
import { createHash, randomUUID } from 'node:crypto'
import http from 'node:http'
import { keyFromDidDocument } from '../../src/shared/chain.js'
import { newIdentity, resolveDidKey } from '../../src/shared/did.js'
import { sign } from '../../src/shared/proof.js'
import { SPEC, checkTask, instant, parseType, refusalTo, responseTo, statusFor, verifyTask } from '../../src/shared/trusttask.js'

const OFFERS_LIST = `${SPEC}vtc/rooms/offers/list/0.4`
const OFFERS_ACCEPT = `${SPEC}vtc/rooms/offers/accept/0.1`
const code = (task, c) => `vtc/rooms/offers/${task}:${c}`
class Refuse extends Error { constructor (c, message) { super(message); this.code = c } }
const no = (c, message) => { throw new Refuse(c, message) }
const only = (obj, members, what) => { for (const k of Object.keys(obj ?? {})) if (k !== 'ext' && !members.includes(k)) no('malformedRequest', `${what}: unknown member \`${k}\``) }
const digest = (s) => createHash('sha256').update(String(s)).digest('hex')

/**
 * Start the community's door in front of a fake room host (`fake`, from startFakeVti). Options: `withRatchetTree` (the
 * answer to an acceptance carries one); `pending` (answer the first n acceptances admissionPending, admitting no one);
 * `pageSize` (offers per page, at most 100).
 */
export async function startFakeCommunity (fake, { withRatchetTree = false, pending = 0, pageSize = 50 } = {}) {
  const communityDid = fake.host.did
  const offers = [] // { member, roomId, visibility, actions, validUntil, offeredAt, label, credentials, state, kept: { digest, welcome, epoch } | null }
  const renewals = [] // { member, ... }: renewals of admissions already held
  const members = new Set() // the DIDs the community lists as members
  const authority = newIdentity() // signs the look-alike membership and authority credentials
  let pendingLeft = pending
  const community = { did: communityDid, received: [], seen: {}, accepts: [], offers, renewals, isCommunity: true }
  const serve = {
    [OFFERS_LIST]: (member, p) => {
      only(p, ['cursor', 'limit'], 'offers/list')
      if (p.limit !== undefined && !(Number.isInteger(p.limit) && p.limit >= 1 && p.limit <= 100)) no('malformedRequest', 'limit is 1..100')
      if (!members.has(member)) no(code('list', 'notAMember'), 'the caller is not an active member of this community')
      const mine = offers.filter((o) => o.member === member)
      const from = p.cursor === undefined ? 0 : (/^o\d+$/.test(p.cursor) ? Number(p.cursor.slice(1)) : no('malformedRequest', 'a cursor this community did not issue'))
      const size = Math.min(p.limit ?? pageSize, pageSize, 100), page = mine.slice(from, from + size)
      const wire = ({ member: _m, kept, ...o }) => ({ host: communityDid, ...o })
      const mineRenewals = renewals.filter((r) => r.member === member).map(({ member: _m, ...r }) => ({ host: communityDid, ...r }))
      return { items: page.map(wire), ...(from + size < mine.length ? { nextCursor: `o${from + size}` } : {}), ...(p.cursor === undefined && mineRenewals.length ? { renewals: mineRenewals } : {}) }
    },
    [OFFERS_ACCEPT]: (member, p) => {
      only(p, ['roomId', 'keyPackage'], 'offers/accept')
      if (typeof p.roomId !== 'string' || !p.roomId) no('malformedRequest', 'roomId is a string')
      if (!members.has(member)) no(code('accept', 'notAMember'), 'the caller is not an active member of this community')
      const o = offers.find((x) => x.member === member && x.roomId === p.roomId) ?? no(code('accept', 'notFound'), 'no open or recently accepted offer to this room is addressed to the caller')
      if (Date.parse(o.validUntil) <= Date.now()) no(code('accept', 'offerExpired'), 'the offer\'s validUntil has passed')
      community.accepts.push({ member, roomId: p.roomId, withKeyPackage: p.keyPackage !== undefined })
      if (o.visibility === 'open') {
        if (p.keyPackage !== undefined) no(code('accept', 'keyPackageNotExpected'), 'the room is open, which has no group')
        o.state = 'accepted'
        return { roomId: o.roomId, state: 'admitted', epoch: 1 } // an open room's epoch: a room made with fake.room starts at 1 and this door never moves it
      }
      if (p.keyPackage === undefined) no(code('accept', 'keyPackageRequired'), 'the room is attributed or private and the request carries no KeyPackage')
      if (typeof p.keyPackage !== 'string' || !/^[A-Za-z0-9_-]+$/.test(p.keyPackage) || Buffer.from(p.keyPackage, 'base64url').length !== 48) no(code('accept', 'keyPackageInvalid'), 'the KeyPackage did not validate')
      if (o.kept) { // a repeat: the same KeyPackage gets the Welcome kept; any other was admitted already with another
        if (o.kept.digest !== digest(p.keyPackage)) no(code('accept', 'alreadyAccepted'), 'the offer was accepted with a different KeyPackage')
        return { roomId: o.roomId, state: 'admitted', epoch: o.kept.epoch, welcome: o.kept.welcome, ...(withRatchetTree ? { ratchetTree: 'cmF0Y2hldC10cmVl' } : {}) }
      }
      if (pendingLeft > 0) { pendingLeft--; no(code('accept', 'admissionPending'), 'the community\'s trust agent did not answer yet') }
      const epoch = fake.advance(o.roomId) // the community, as the room's owner, adds the member: the room moves on one epoch
      const welcome = fake.welcomeFor(p.keyPackage) // built by the community's own trust agent for exactly this KeyPackage
      o.kept = { digest: digest(p.keyPackage), welcome, epoch }; o.state = 'accepted'
      return { roomId: o.roomId, state: 'admitted', epoch, welcome, ...(withRatchetTree ? { ratchetTree: 'cmF0Y2hldC10cmVl' } : {}) }
    }
  }

  const server = http.createServer(async (req, res) => {
    const send = (status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(body === null || body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)) }
    if (req.method !== 'POST' || req.url !== '/trust-tasks') return send(404, { error: 'not found' })
    const chunks = []; for await (const c of req) chunks.push(c)
    const raw = Buffer.concat(chunks).toString('utf8'); community.received.push(raw)
    let doc; try { doc = JSON.parse(raw) } catch { return send(400, { error: 'not a Trust Task document' }) }
    community.seen[doc?.type] = (community.seen[doc?.type] ?? 0) + 1
    const handler = serve[doc?.type]
    if (!handler) { // everything else a community's door serves for a room is the room host's: passed on, as it came, and answered as it answered
      const r = await fetch(`${fake.host.url}/trust-tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw })
      return send(r.status, await r.text(), r.headers.get('retry-after') ? { 'retry-after': r.headers.get('retry-after') } : {})
    }
    try {
      const basic = checkTask(doc, { me: communityDid, bytes: Buffer.byteLength(raw) })
      if (!basic.ok) no(basic.code, basic.message)
      const v = await verifyTask(doc, { keyFor: async (did, vm, purpose) => keyFromDidDocument(resolveDidKey(did), did, vm, purpose), me: communityDid, bytes: Buffer.byteLength(raw), purposes: ['authentication'] })
      if (!v.ok) no('permissionDenied', `request proof: ${v.message}`)
      const t = parseType(doc.type)
      if (t.response) no('unsupportedType', 'not a request')
      send(200, responseTo(doc, serve[doc.type](v.signer, doc.payload), communityDid))
    } catch (e) {
      if (!(e instanceof Refuse)) return send(500, refusalTo(doc, { code: 'internalError', message: e.message }, communityDid))
      send(statusFor(e.code), refusalTo(doc, { code: e.code, message: e.message, retryable: /admissionPending$/.test(e.code) }, communityDid))
    }
  })
  community.url = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)))
  community.close = async () => { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)) }

  // The community's DID document as a resolver reads it: the host's own key, and its door under VTCRest (the service a community lists).
  community.resolver = {
    resolve: async (did) => { const d = await fake.resolver.resolve(did); return did === communityDid ? { ...d, service: [{ id: `${did}#vtc-rest`, type: 'VTCRest', serviceEndpoint: community.url }] } : d },
    keyFor: fake.resolver.keyFor
  }

  /** The community lists `persona` as a member and offers it `roomId` (a room made with fake.room). Returns the offer as stored. */
  community.offer = (roomId, persona, { actions = ['read', 'write'], days = 30, visibility = 'attributed', label = 'Community room', validUntil } = {}) => {
    members.add(persona)
    const until = validUntil ?? instant(Date.now() + days * 86400_000)
    const cred = (type, extra) => JSON.stringify(sign({ '@context': ['https://www.w3.org/ns/credentials/v2'], type: ['VerifiableCredential', type], id: `urn:uuid:${randomUUID()}`, issuer: authority.did, validFrom: instant(Date.now() - 60_000), validUntil: until, credentialSubject: { id: persona, ...extra } }, { seed: authority.seed, verificationMethod: authority.verificationMethod, created: instant(), proofPurpose: 'assertionMethod' }))
    const o = { member: persona, roomId, label, visibility, actions, validUntil: until, offeredAt: instant(), state: 'open', credentials: { invitation: visibility === 'open' ? cred('InvitationCredential', {}) : fake.invite(roomId, persona), membership: cred('MembershipCredential', {}), authority: cred('AuthorityCredential', { authority: { scope: roomId, actions } }) }, kept: null }
    offers.push(o)
    return o
  }
  /** A renewal of an admission the member already holds (reported by the bridge, never acted on). */
  community.renewal = (roomId, persona, { days = 30 } = {}) => { members.add(persona); renewals.push({ member: persona, roomId, label: 'Community room', visibility: 'attributed', actions: ['read', 'write'], validUntil: instant(Date.now() + days * 86400_000), renewsAt: instant(Date.now() + 86400_000), issuedAt: instant(), credentials: { membership: '{}', authority: '{}' } }) }
  return community
}
