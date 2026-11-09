// Joining a community against a REAL one: the check the stand-in cannot give. Use a TEST member on a TEST community only:
// the second test makes a real join request in the community's own records, which its people then see.
// Skipped unless all of these are set:
//   LIVE_COMMUNITY_DID                         the community's DID (did:webvh); its DID document must list a VTCRest service
//   VTA_CREDENTIAL (or VTA_CREDENTIAL_FILE)    the one line the person's trust agent hands an app (registered with write scope)
//   LIVE_PERSONA_DID                           a DID this trust agent holds keys for (listed under authentication and assertionMethod)
// Optional: VTA_URL (when the credential carries no address); COMMUNITY_URL (the community's door, when its DID names none).
// By default it reads the community's manifest only (signed as the persona). With LIVE_JOIN=yes it also submits under the first
// criterion with no attributes and reports the verdict (and nothing else: it does not wait for a pass or send a member credential).
// Run:  node --test test/live/community-join-live.test.js
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { CommunityJoin } from '../../agent/community-join.js'
import { Vta, readCredential } from '../../agent/vta.js'

const env = process.env
const ready = Boolean(env.LIVE_COMMUNITY_DID && (env.VTA_CREDENTIAL || env.VTA_CREDENTIAL_FILE) && env.LIVE_PERSONA_DID)
const make = () => new CommunityJoin({ vta: new Vta({ credential: readCredential(env), url: env.VTA_URL }), communityDid: env.LIVE_COMMUNITY_DID, persona: env.LIVE_PERSONA_DID, url: env.COMMUNITY_URL })

describe('a real community', { skip: ready ? false : 'set LIVE_COMMUNITY_DID, VTA_CREDENTIAL (or VTA_CREDENTIAL_FILE) and LIVE_PERSONA_DID to run this against a real community' }, () => {
  test('its manifest is read, signed as the persona', async (t) => {
    const join = make()
    const m = await join.manifest()
    assert.equal(m.communityDid, env.LIVE_COMMUNITY_DID)
    t.diagnostic(`${m.criteria.length} criteria (${m.criteria.map((c) => c.id).join(', ')}); asks for ${(m.requestedAttributes ?? []).map((a) => `${a.type}${a.required === false ? '?' : ''}`).join(', ') || 'no attributes'}; counts ${JSON.stringify(join.state.counts)}`)
  })
  test('a test join request is submitted under the first criterion (LIVE_JOIN=yes only)', { skip: env.LIVE_JOIN === 'yes' ? false : 'set LIVE_JOIN=yes to make a real join request (test member, test community only)' }, async (t) => {
    const join = make()
    await join.manifest()
    const out = await join.submit({ criterion: join.chooseCriterion(), attributes: [], registryConsent: false })
    t.diagnostic(`verdict ${out.verdict.effect}${out.verdict.with?.code ? ` (${out.verdict.with.code})` : ''}; counts ${JSON.stringify(join.state.counts)}`)
    assert.ok(['allow', 'deny', 'refer', 'requestMore'].includes(out.verdict.effect))
  })
})
