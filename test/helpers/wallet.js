// A wallet for tests: the approving side of a sign-in, sending the documents an OpenVTC wallet sends and checking
// what such a wallet checks. It proves the room's side is consistent with these shapes; it is not a real wallet.
// Each shape and check names the upstream file it was read from (OpenVTC at the commit the room builds from):
//   the link and its four names            vti-oob-server/src/util.rs:246-258, docs/05-design-notes/trigger-link-design.md
//   the DID document a wallet needs        vta-sdk/src/did_templates/sign_in_portal.rs:1-9, vtc-service/src/did_self_check.rs:1-18
//   claim, prove, respond and their order  vti-oob-server/tests/flow.rs:238-422, src/tasks.rs
//   what the person's key holder signs     vta-service/src/operations/vault/oob_sign_in.rs (identify: three members and no
//                                          others; grant: the members below, an https origin, an end in the future)
//   the service's answers are attestations vtc-service/tests/it/member_portal_oob.rs:377-390 (assertionMethod, by the service's DID)
import assert from 'node:assert/strict'
import { newIdentity } from '../../src/shared/did.js'
import { MATCH_NUMBER, OOB, REQUEST_ID, SIGN_IN_FLOW, contextDigest, isEd25519DidKey, readTriggerLink, rfc3339 } from '../../src/shared/signin.js'
import { HTTPS_SERVICE, classify, instant, sameDid, serviceEndpoint, signedTask, verifyTask } from '../../src/shared/trusttask.js'

/**
 * person: the identity that approves ({ did, seed, verificationMethod }). resolver: resolves the service's DID.
 * send(doc, base): posts one document to the service and returns its reply document. plainHttp: let the origin be
 * http (a room on this machine); a real key holder signs a grant only for an https origin.
 */
export function testWallet ({ person, resolver, send, now = Date.now, plainHttp = false }) {
  const w = { person, ka: null, from: null, base: null, requestId: null, step1: null, step2: null }
  const ask = async (identity, type, payload, extra = {}) => {
    const reply = await send(signedTask(identity, { type, recipient: w.from, payload, issuedAt: instant(now()), ...extra }), w.base)
    return { reply, ...classify(reply, type) }
  }
  /** The service signed this answer itself, as an attestation, with a key its DID lists for that. */
  const attested = async (reply, type) => {
    assert.equal(reply.type, `${type}#response`)
    assert.equal(reply.proof?.proofPurpose, 'assertionMethod', 'the service attests its answers: a wallet refuses one that is only authenticated')
    const v = await verifyTask(reply, { keyFor: resolver.keyFor, me: w.ka.did, purposes: ['assertionMethod'], now: now() })
    assert.deepEqual(v, { ok: true, signer: reply.issuer }, 'the service\'s signature verifies against its DID document')
    assert.ok(sameDid(reply.issuer, w.from), 'the answer is from the DID the link named')
  }
  return Object.assign(w, {
    /** Read the code, find where the service takes documents, and claim the request with a key made for this scan. */
    async scan (link, { base = null, ka = newIdentity(), claimOnly = false } = {}) {
      const l = readTriggerLink(link)
      assert.equal(l.ok, true, `a wallet reads the link (${l.why})`)
      assert.equal(l.flow, `https://${l.linkHost}${SIGN_IN_FLOW}`, 'the flow is sign-in')
      assert.ok(l.exp > Math.floor(now() / 1000), 'the code has not run out')
      assert.match(l.id, REQUEST_ID)
      Object.assign(w, { from: l.from, requestId: l.id, ka })
      if (base) w.base = base
      else if (!claimOnly) { // the endpoint comes from the service's DID document, never from the link
        const doc = await resolver.resolve(l.from)
        w.base = serviceEndpoint(doc, HTTPS_SERVICE); w.portal = serviceEndpoint(doc, 'SignInPortal')
        assert.ok(w.base, 'the service\'s DID document lists a TrustTaskHTTPS service (else: "This code can\'t be used")')
        assert.ok(w.portal, 'the service\'s DID document lists a SignInPortal service (else: "This code can\'t be used")')
      }
      const a = await ask(ka, OOB.claim, { requestId: l.id }, { parentThreadId: l.id }) // the first request of a link carries its handle as parentThreadId
      if (a.kind !== 'response') return a
      await attested(a.reply, OOB.claim)
      const s = a.payload
      assert.deepEqual(Object.keys(s).sort(), ['decisionClosesAt', 'origin', 'purpose', 'requestId', 'service'], 'step 1 says nothing about the browser')
      assert.equal(s.requestId, l.id); assert.equal(s.purpose, 'login'); assert.ok(sameDid(s.service.did, l.from)); assert.ok(s.service.name.length >= 1 && s.service.name.length <= 128)
      assert.match(s.origin, plainHttp ? /^https?:\/\/[^/?#\s]+$/ : /^https:\/\/[^/?#\s]+$/)
      if (w.portal) assert.equal(new URL(w.portal).origin, s.origin, 'the page the code was shown on is the service\'s SignInPortal')
      w.step1 = a.reply
      return a
    },
    /** The person's own statement: I am this DID, I hold the scan, and this is the number on the screen. */
    identify (number, over = {}, { purpose = 'authentication' } = {}) {
      return signedTask(person, { type: OOB.identify, recipient: w.from, issuedAt: instant(now()), payload: { requestId: w.requestId, approverKey: w.ka.did, enteredNumber: number, ...over } }, { purpose })
    },
    async prove (number, { identify = null, by = null } = {}) {
      if (!identify) assert.match(number, MATCH_NUMBER)
      const a = await ask(by ?? w.ka, OOB.prove, { identify: identify ?? w.identify(number) })
      if (a.kind !== 'response') return a
      await attested(a.reply, OOB.prove)
      const s1 = w.step1.payload, s2 = a.payload
      for (const k of Object.keys(s1)) assert.deepEqual(s2[k], s1[k], `step 2 repeats step 1's ${k}`)
      assert.equal(s2.identifiedAs, person.did); assert.ok(isEd25519DidKey(s2.sessionKey))
      assert.deepEqual(Object.keys(s2.requester).sort(), ['browser', 'createdAt', 'location', 'os', 'sameNetwork'])
      assert.ok([true, false, 'unknown'].includes(s2.requester.sameNetwork))
      w.step2 = a.reply
      return a
    },
    /** The person's decision: let this browser key act as me at this origin until then, having seen exactly this. */
    grant (decision = 'approve', over = {}, { purpose = 'assertionMethod', sessionSeconds = 600 } = {}) {
      const s2 = w.step2.payload
      const payload = { requestId: w.requestId, decision, sessionKey: s2.sessionKey, approverKey: w.ka.did, origin: s2.origin, contextDigest: contextDigest(w.step2), sessionEndsAt: rfc3339(Math.floor(now() / 1000) + sessionSeconds), ...(s2.signingScope ? { signingScope: s2.signingScope } : {}), ...over }
      for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k]
      return signedTask(person, { type: OOB.grant, recipient: w.from, issuedAt: instant(now()), payload }, { purpose })
    },
    async respond (decision = 'approve', { grant = null, by = null, sessionSeconds } = {}) {
      const a = await ask(by ?? w.ka, OOB.respond, { grant: grant ?? w.grant(decision, {}, { sessionSeconds }) })
      if (a.kind !== 'response') return a
      await attested(a.reply, OOB.respond)
      assert.deepEqual(Object.keys(a.payload), ['status'], 'the wallet is told the outcome and nothing a session could be made from')
      return a
    },
    async cancel () {
      const a = await ask(w.ka, OOB.cancel, { requestId: w.requestId })
      if (a.kind === 'response') await attested(a.reply, OOB.cancel)
      return a
    },
  })
}
