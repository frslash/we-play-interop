// The room's membership pass: a W3C Verifiable Credential in the DTG format (a MembershipCredential), signed by the
// room, that a member downloads (GET /api/me/pass). It says one thing: "this room says this DID is a member", for
// 30 days. It has no credentialStatus: the room's own record (the log) is the status, as for agent permissions, so
// a pass someone left with is still in date but the room no longer answers "member" for them: anyone checking it must
// ask the room, because once a person leaves the room stops vouching but the paper still looks valid.
// The room signs with its own key as its DID's `#room` method (assertionMethod), the same key and DID it speaks as
// elsewhere (ctx.join.room: its did:webvh when it has a log, else its did:key). Nothing here holds a person's key.
import { DTG_CONTEXT } from '../shared/dtg-context.js'
import { VC_V2 } from '../shared/dtg.js'
import { sign } from '../shared/proof.js'
import { uuid } from '../shared/types.js'

export const PASS_DAYS = 30 // short on purpose: the paper outlives the membership it vouched for, so it should not outlive it for long
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The signed pass. room: { did, seed, verificationMethod } (ctx.join.room). memberDid: the member's DID.
 * name: the member's name in the room, optional (DTG readers ignore subject fields they do not know). now: ms.
 * issuerScope is 'public': the room's DID is known to everyone it speaks to (DTG says who an issuer's DID is known to).
 */
export function issueMembershipPass ({ room, memberDid, name, now = Date.now() }) {
  const validFrom = new Date(now).toISOString()
  const validUntil = new Date(now + PASS_DAYS * DAY_MS).toISOString()
  const unsigned = {
    '@context': [VC_V2, DTG_CONTEXT],
    id: 'urn:uuid:' + uuid(),
    type: ['VerifiableCredential', 'DTGCredential', 'MembershipCredential'],
    issuer: room.did,
    issuerScope: 'public',
    validFrom,
    validUntil,
    credentialSubject: { id: memberDid, ...(typeof name === 'string' && name ? { name } : {}) },
  }
  return sign(unsigned, { seed: room.seed, verificationMethod: room.verificationMethod, created: validFrom, proofPurpose: 'assertionMethod' })
}

/** A current member: joined, has not left, and has not been replaced by a new key. */
export function isCurrentMember (state, did) {
  const p = typeof did === 'string' ? state.participants.get(did) : null
  return !!p && p.kind === 'human' && !p.left && !p.replacedBy
}

/**
 * GET /api/me/pass. Only for req.inwoveViewer = { kind: 'human', did } of a current member (the gate sets it; this
 * never reads anything else to learn who is asking). Writes its own response: no access-control-allow-origin, never cached.
 */
export async function servePass (ctx, req, res, now = Date.now()) {
  const v = req.inwoveViewer
  const out = (status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }); res.end(JSON.stringify(body, null, 2)) }
  if (!v || v.kind !== 'human' || !isCurrentMember(ctx.log.state, v.did)) return out(401, { error: 'Sign in first.' })
  await ctx.join.refresh()
  const pass = issueMembershipPass({ room: ctx.join.room, memberDid: v.did, name: ctx.log.state.nameOf(v.did), now })
  out(200, pass, { 'content-disposition': 'attachment; filename="inwove-pass.json"' })
}
