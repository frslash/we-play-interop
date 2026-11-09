// The check against a real community: does its door answer the room's signed join-requirements request
// (manifest 0.4) in a shape the room can read? Not part of `npm test` (it reaches the network). Run it with:
//
//   LIVE_COMMUNITY_DID=did:webvh:…  node --test test/live/community-manifest-live.test.js
//
// It reads only: the community's DID log and one signed manifest request, signed by a throwaway key made here (the
// room's own key is not used). It sends no application and holds no real key. Use a test community.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Community } from '../../src/server/community.js'
import { createResolver } from '../../src/server/resolver.js'
import { newIdentity } from '../../src/shared/did.js'

const DID = process.env.LIVE_COMMUNITY_DID
const skip = DID ? false : 'set LIVE_COMMUNITY_DID to a community\'s did:webvh'

test('the community answers the manifest and the room reads it', { skip, timeout: 60_000 }, async () => {
  const me = newIdentity()
  const c = new Community({ config: { communityDid: DID }, resolver: createResolver(), identity: me, room: () => me })
  const { join } = await c.describe()
  console.log('join link:', join.url, '| criteria:', join.criteria.length, '| problem:', join.problem ?? 'none')
  // A refusal is a real answer too (a community with public discovery off refuses a caller it cannot identify; the
  // room's throwaway key is unknown to it): what must not happen is an unreadable answer.
  assert.ok(!join.problem || !['malformedResponse', 'unavailable'].includes(join.problemCode), `the door did not answer a manifest: ${join.problem}`)
  if (!join.problem) for (const k of join.criteria) { assert.ok(k.id); assert.ok(['automatic', 'review'].includes(k.admission)) }
})
