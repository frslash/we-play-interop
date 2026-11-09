// The member calls against a REAL trust agent: the check the stand-in cannot give. Skipped unless both are set:
//   VTA_CREDENTIAL (or VTA_CREDENTIAL_FILE)   the one line the person's trust agent hands an app. It must be registered
//                                              with write scope: sign-document needs it, and a write-capable credential can sign as
//                                              the person within the trust agent's own policy and daily quota.
//   LIVE_PERSONA_DID                           a DID this trust agent holds a key for (listed under assertionMethod)
// Optional: VTA_URL (when the credential carries no address).
// It signs one small test document and verifies the proof against the persona's DID document. Nothing else is written.
// Run:  node --test test/live/vta-member-live.test.js
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { Vta, readCredential } from '../../agent/vta.js'
import { createResolver } from '../../src/server/resolver.js'
import { keyFromDidDocument } from '../../src/shared/chain.js'
import { verifySignature } from '../../src/shared/proof.js'

const env = process.env
const ready = Boolean((env.VTA_CREDENTIAL || env.VTA_CREDENTIAL_FILE) && env.LIVE_PERSONA_DID)

describe('the trust agent signs as the persona', { skip: ready ? false : 'set VTA_CREDENTIAL (or VTA_CREDENTIAL_FILE) and LIVE_PERSONA_DID to run this against a real trust agent' }, () => {
  test('a small test document gets a proof that verifies against the persona\'s own DID document', async (t) => {
    const resolver = createResolver()
    const vta = new Vta({ credential: readCredential(env), url: env.VTA_URL, resolver })
    const r = await vta.signDocument({ issuer: env.LIVE_PERSONA_DID, type: ['TestDocument'], note: 'inwove live check' })
    const doc = await resolver.resolve(env.LIVE_PERSONA_DID)
    const key = keyFromDidDocument(doc, env.LIVE_PERSONA_DID, r.proof.verificationMethod, 'assertionMethod')
    assert.ok(verifySignature(r.document, key).ok)
    t.diagnostic(`signed as ${r.signerDid} with key ${r.keyId}; counts ${JSON.stringify(vta.counts)}`)
  })
})
