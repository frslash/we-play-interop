// A stand-in community (OpenVTC "VTC") on 127.0.0.1, join tasks only: what a person's bridge asks of a community to apply,
// follow the verdict and answer with their own membership credential (agent/community-join.js). It proves the bridge's side is
// self-consistent; it does not prove interop (test/live/community-join-live.test.js is the check against a real community).
//
// Each shape below was read from (OpenVTC at c6964c4):
//   the door             one route, POST /v1/trust-tasks (vtc-service/src/routes/mod.rs:1550,1688); the DID document it answers
//                        to lists a VTCRest service whose endpoint ends /v1 (vtc-service/src/member_portal/oob.rs:295)
//   manifest 0.4         vti-specs-vtc/trust-tasks/vtc/join-requests/manifest/0.4.bundle.json (closed payload, no proof needed,
//                        Response: communityDid, criteria[{id, admission, requirementsDigest}], requestedAttributes[{type, required, purpose}],
//                        branding); discovery closed: vtc-service/src/trust_tasks/mod.rs handle_manifest, discovery_refusal
//   submit 0.3           .../submit/0.3.bundle.json (payload: vp, criterion = a requirementsDigest, registryConsent, extensions, attributes;
//                        answer { requestId, verdict: { effect, with } }) and its error codes; a holder named in the VP must be the
//                        signer (vtc-service/src/join/orchestrate.rs check_presentation_holder); requestAlreadyOpen with
//                        details { requestId, status } (vtc-service/src/trust_tasks/mod.rs handle_submit, vta-sdk join_requests.rs:287)
//   status 0.1           .../status/0.1.bundle.json (requestId optional: the signer's open request; resendCredentials; answer status,
//                        credentialsDelivered, credentialResend; vtc-service/src/trust_tasks/mod.rs handle_status)
//   members/vmc 0.1      .../members/vmc/0.1.bundle.json and vtc-service/src/members/inbound_vmc.rs verify_member_vmc (issuer is the
//                        sender, DTG common structure, subject is the community, the issuer's proof), requestId checks, and
//                        check_acknowledgement_binding (digestMultibase must be the digest of the grant it issued)
//   the pass             a VMC (MembershipCredential, issuerScope public) and a role VAC (AuthorityCredential, authority { scope: the
//                        community, actions: ['role:<role>'], maxAttenuation: 0 }): docs/03-vtc/credentials.md
// Where it is NOT the real thing, on purpose:
//   - The real community PUSHES the pass to the holder (credential-exchange/issue over TSP, DIDComm or REST,
//     vtc-service/src/credentials/delivery.rs) and the person's trust agent puts it in the vault. Here `deliver(persona, [credentials])`
//     is called instead, and a test wires it to the person's trust agent's vault receive (test/helpers/fake-vti.js).
//   - There are no status lists, no vetting, no directory, and one community policy at a time.
import { createServer } from 'node:http'
import { keyFromDidDocument } from '../../src/shared/chain.js'
import { dtgDigest, DTG_CONTEXTS, VC_V2 } from '../../src/shared/dtg.js'
import { newIdentity, resolveDidKey } from '../../src/shared/did.js'
import { sign, verifySignature } from '../../src/shared/proof.js'
import { instant, multihashOf, parseType, refusalTo, responseTo, signTask, statusFor, verifyTask } from '../../src/shared/trusttask.js'
import { uuid } from '../../src/shared/types.js'

const DTG = Object.keys(DTG_CONTEXTS)[0]
class Refuse extends Error { constructor (code, message, details) { super(message); this.code = code; this.details = details } }
const no = (code, message, details) => { throw new Refuse(code, message, details) }
const only = (obj, members, what) => { for (const k of Object.keys(obj ?? {})) if (k !== 'ext' && !members.includes(k)) no('malformedRequest', `${what}: unknown member \`${k}\``) }

/**
 * Options: `policy` allow | refer | requestMore | deny; `discoveryOpen` (false: an unsigned manifest question is refused);
 * `requestedAttributes` (the manifest's list); `deliver(persona, credentials)` (the push); `deliverAfterPolls` (the pass
 * arrives only after this many status polls that found the request approved; default 0 = at the verdict).
 */
export async function startFakeVtc ({ policy = 'allow', discoveryOpen = true, requestedAttributes = [], deliver = async () => {}, deliverAfterPolls = 0, role = 'member' } = {}) {
  const id = newIdentity()
  const criterion = { id: 'open', admission: 'automatic', requirementsDigest: multihashOf({ criterion: 'open', v: 1 }) }
  const requests = new Map() // requestId -> { applicant, status, polls, delivered, grant }
  const grants = new Map() // applicant -> the VMC this community issued (what an acknowledgement is bound to)
  const fake = { did: id.did, criterion, policy, discoveryOpen, requestedAttributes, role, deliverAfterPolls, received: [], seen: {}, reciprocated: new Set(), delivered: 0, seenAttributes: [], seenConsent: [], stateOf: (rid) => requests.get(rid) }
  const doc = () => ({ ...resolveDidKey(id.did), service: [{ id: `${id.did}#vtc-rest`, type: 'VTCRest', serviceEndpoint: `${fake.url}/v1` }] })
  fake.resolver = { resolve: async (did) => (did === id.did ? doc() : resolveDidKey(did)) }
  const keyFor = async (did, vm, purpose) => keyFromDidDocument(await fake.resolver.resolve(did), did, vm, purpose)

  const credential = (subject, extra, days = 90) => sign({ '@context': [VC_V2, DTG], type: ['VerifiableCredential', 'DTGCredential', ...extra.type], id: `urn:uuid:${uuid()}`, issuer: id.did, issuerScope: 'public', validFrom: instant(Date.now() - 60_000), validUntil: instant(Date.now() + days * 86400_000), credentialSubject: { id: subject, ...extra.subject } }, { seed: id.seed, verificationMethod: id.verificationMethod, created: instant(), proofPurpose: 'assertionMethod' })
  const push = async (applicant, req) => {
    const vmc = credential(applicant, { type: ['MembershipCredential'], subject: {} })
    const vac = credential(applicant, { type: ['AuthorityCredential'], subject: { authority: { scope: id.did, actions: [`role:${fake.role}`], maxAttenuation: 0 } } })
    grants.set(applicant, vmc)
    await deliver(applicant, [vmc, vac]); req.delivered = true; fake.delivered++
  }

  const tasks = {
    'vtc/join-requests/manifest': (p, who) => {
      only(p, [], 'manifest')
      if (!fake.discoveryOpen && !who) no('permissionDenied', 'this community does not publish its join requirements to callers it cannot identify — ask over DIDComm, or with a signed Trust Task document')
      return { communityDid: id.did, criteria: [criterion], ...(fake.requestedAttributes.length ? { requestedAttributes: fake.requestedAttributes } : {}), branding: { displayName: 'A test community' } }
    },
    'vtc/join-requests/submit': async (p, who) => {
      only(p, ['vp', 'criterion', 'registryConsent', 'extensions', 'attributes'], 'submit')
      if (!p.vp || typeof p.vp !== 'object') no('malformedRequest', 'vp is required')
      if ('extensions' in p && (p.extensions === null || typeof p.extensions !== 'object')) no('malformedRequest', 'extensions is an object (omitted, never null)')
      const holder = typeof p.vp.holder === 'string' ? p.vp.holder : p.vp.holder?.id
      if (holder !== undefined && holder.split('#')[0] !== who) no('vtc/join-requests/submit:presentationInvalid', 'the presentation\'s holder is not the submitting applicant')
      const open = [...requests].find(([, r]) => r.applicant === who && ['pending', 'deferred'].includes(r.status))
      if (open) no('vtc/join-requests/submit:requestAlreadyOpen', 'this applicant already has an open request', { requestId: open[0], status: open[1].status })
      if (p.criterion !== undefined && p.criterion !== criterion.requirementsDigest) no('vtc/join-requests/submit:criterionUnknown', 'no such criterion', { criterion: p.criterion })
      const given = p.attributes ?? []
      const asked = fake.requestedAttributes
      const missing = asked.filter((a) => a.required !== false && !given.some((g) => g.type === a.type)).map((a) => a.type)
      if (missing.length) no('vtc/join-requests/submit:attributesMissing', 'required attributes were not answered', { types: missing })
      const extra = given.filter((g) => !asked.some((a) => a.type === g.type)).map((g) => g.type)
      if (extra.length) no('vtc/join-requests/submit:attributesUnrequested', 'attributes were given that the manifest does not request', { types: extra })
      fake.seenAttributes.push(given.map((g) => g.type)); fake.seenConsent.push(p.registryConsent)
      const requestId = uuid()
      const req = { applicant: who, status: 'pending', polls: 0, delivered: false }
      requests.set(requestId, req)
      if (fake.policy === 'allow') { req.status = 'approved'; if (!fake.deliverAfterPolls) await push(who, req); return { requestId, verdict: { effect: 'allow', with: { role: fake.role } } } }
      if (fake.policy === 'refer') return { requestId, verdict: { effect: 'refer', with: { queue: 'membership-review' } } }
      if (fake.policy === 'requestMore') { req.status = 'deferred'; return { requestId, verdict: { effect: 'requestMore', with: { needs: ['identity-vetting'] } } } }
      req.status = 'rejected'; return { requestId, verdict: { effect: 'deny', with: { code: 'notEligible', reason: 'this test community admits no one' } } }
    },
    'vtc/join-requests/status': async (p, who) => {
      only(p, ['requestId', 'resendCredentials'], 'status')
      const found = p.requestId !== undefined ? [p.requestId, requests.get(p.requestId)] : [...requests].filter(([, r]) => r.applicant === who).at(-1) ?? [undefined, undefined]
      const [requestId, req] = found
      if (!req || req.applicant !== who) no('vtc/join-requests/status:notFound', 'no join request with that id exists, or it does not belong to the proof signer')
      if (req.status === 'approved') {
        req.polls++
        if (!req.delivered && req.polls > fake.deliverAfterPolls) await push(who, req)
      }
      const out = { requestId, status: req.status, ...(req.status === 'approved' ? { credentialsDelivered: req.delivered } : {}), ...(req.status === 'rejected' ? { code: 'notEligible', reason: 'this test community admits no one', decidedAt: instant() } : {}), ...(req.status === 'deferred' ? { needs: ['identity-vetting'] } : {}) }
      if (p.resendCredentials && req.status === 'approved') { out.credentialResend = req.delivered ? 'notNeeded' : 'queued'; if (!req.delivered) { await push(who, req); out.credentialsDelivered = true } }
      return out
    },
    'vtc/members/vmc': (p, who) => {
      only(p, ['vc', 'requestId'], 'members/vmc')
      const vc = p.vc
      if (!vc || typeof vc !== 'object') no('malformedRequest', 'vc is required')
      const invalid = (m) => no('vtc/members/vmc:invalidCredential', m)
      const issuer = typeof vc.issuer === 'string' ? vc.issuer : vc.issuer?.id
      if (issuer !== who) invalid('member vmc issuer is not the member')
      if (vc['@context']?.[0] !== VC_V2 || vc['@context']?.[1] !== DTG) invalid('credential `@context` must carry the W3C context then the DTG v1 context')
      for (const t of ['VerifiableCredential', 'DTGCredential', 'MembershipCredential']) if (!vc.type?.includes(t)) invalid(`credential \`type\` must include \`${t}\``)
      if (!['pairwise', 'directed', 'public'].includes(vc.issuerScope)) invalid('credential `issuerScope` missing or not one of the three')
      if (vc.credentialSubject?.id !== id.did) no('vtc/members/vmc:subjectMismatch', 'member vmc subject is not this community')
      if (!vc.proof) invalid('member vmc has no issuer `proof`')
      try { if (!verifySignature(vc, keyFromDidDocumentSync(issuer, vc.proof)).ok) throw new Error() } catch { invalid('member vmc issuer proof did not verify') }
      if (typeof vc.id !== 'string') invalid('member vmc has no top-level `id`')
      const grant = grants.get(who)
      if (!grant) no('vtc/members/vmc:notAMember', 'the sender is not an active member of this community')
      if (vc.credentialSubject.digestMultibase !== undefined && vc.credentialSubject.digestMultibase !== dtgDigest(grant)) no('malformedRequest', 'member vmc `credentialSubject.digestMultibase` does not match the membership credential this community issued')
      if (p.requestId !== undefined) {
        const req = requests.get(p.requestId)
        if (!req) no('vtc/members/vmc:requestNotFound', 'join request not found')
        if (req.applicant !== who) no('vtc/members/vmc:requestApplicantMismatch', 'that join request does not belong to the delivering member')
        if (req.status !== 'approved') no('vtc/members/vmc:requestNotApproved', 'only an approved request has a membership to reciprocate')
        fake.reciprocated.add(p.requestId)
      }
      return { memberDid: who, vmcId: vc.id, status: 'stored', ...(p.requestId ? { requestId: p.requestId } : {}) }
    },
  }
  const keyFromDidDocumentSync = (did, proof) => keyFromDidDocument(resolveDidKey(did), did, proof.verificationMethod, 'assertionMethod') // a persona here is a did:key

  const server = createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (req.method !== 'POST' || req.url !== '/v1/trust-tasks') return send(404, { error: 'not found' })
    const chunks = []; for await (const c of req) chunks.push(c)
    const raw = Buffer.concat(chunks).toString('utf8'); fake.received.push(raw)
    let d
    try { d = JSON.parse(raw) } catch { return send(400, { error: 'not JSON' }) }
    fake.seen[d.type] = (fake.seen[d.type] ?? 0) + 1
    try {
      const t = parseType(d.type)
      if (!t || t.response || !tasks[t.family]) no('unsupportedType', `\`${d.type}\` is not served here`)
      let who = null
      if (d.proof) {
        const v = await verifyTask(d, { keyFor, me: id.did, purposes: ['authentication'] })
        if (!v.ok) no(v.code, v.message)
        who = v.signer
      } else {
        const basic = (await import('../../src/shared/trusttask.js')).checkTask(d, { me: id.did })
        if (!basic.ok) no(basic.code, basic.message)
        if (t.family !== 'vtc/join-requests/manifest') no('proofRequired', 'this document is not signed (proof is missing)')
      }
      const payload = await tasks[t.family](d.payload, who)
      send(200, signTask(responseTo(d, payload, id.did), id)) // the community signs what it answers
    } catch (e) {
      if (!(e instanceof Refuse)) return send(500, refusalTo(d, { code: 'internalError', message: e.message }, id.did))
      send(e.code.includes(':') ? 422 : statusFor(e.code), refusalTo(d, { code: e.code, message: e.message, details: e.details }, id.did))
    }
  })
  fake.url = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)))
  fake.close = () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve) })
  return fake
}
