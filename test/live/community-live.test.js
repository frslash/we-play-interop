// The check against a real community, which the stand-in in test/support cannot give: does a live OpenVTC trust
// community answer the way the room expects? Not part of `npm test` (it reaches the network). Run it with:
//
//   LIVE_COMMUNITY_DID=did:webvh:…  node --test test/live/community-live.test.js
//
// and, to check a real pass too, a file holding a membership credential that community issued (the holder exports
// it from their wallet; it is a signed public statement, not a key):
//
//   LIVE_COMMUNITY_DID=did:webvh:… LIVE_MEMBERSHIP_CREDENTIAL=./my-vmc.json node --test test/live/community-live.test.js
//
// It reads only: the community's DID log, its public profile, join page, DID QR code and revocation list.
// It sends nothing to the community and holds no key. The last step of a real check, the holder signing the
// request to the room (passCheck), needs the holder's wallet and is not done here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Community } from '../../src/server/community.js'
import { createResolver, publicFetch } from '../../src/server/resolver.js'
import { MIN_ENTRIES, StatusLists, bitAt } from '../../src/server/status-list.js'
import { newIdentity } from '../../src/shared/did.js'
import { statusEntriesOf, verifyDtgCredential, withDidPeer2 } from '../../src/shared/dtg.js'

const DID = process.env.LIVE_COMMUNITY_DID, FILE = process.env.LIVE_MEMBERSHIP_CREDENTIAL
const skip = DID ? false : 'set LIVE_COMMUNITY_DID to a community\'s did:webvh'
const resolver = createResolver(), keyFor = withDidPeer2(resolver.keyFor)
const room = newIdentity() // a throwaway DID to stand for the room in this run

test('the community\'s DID resolves and names its services by type', { skip }, async () => {
  const doc = await resolver.resolve(DID)
  const types = (doc.service ?? []).flatMap((s) => s.type)
  console.log('services:', types.join(', '))
  for (const t of ['TrustTaskHTTPS', 'SignInPortal']) assert.ok(types.includes(t), `its DID document lists no ${t} service`)
  assert.ok((doc.assertionMethod ?? []).length > 0, 'it lists a key for assertionMethod (the key that signs credentials)')
})

test('every part the room shows people answers', { skip }, async () => {
  const c = new Community({ config: { communityDid: DID }, resolver, identity: room, room: () => room })
  const seen = await c.describe()
  console.log(JSON.stringify({ name: seen.name, services: seen.services, profile: seen.profile, joinPage: seen.joinPage, didQr: seen.didQr, statusList: seen.statusList }, null, 2))
  assert.equal(seen.resolves, true)
  assert.equal(seen.profile?.answers, true, `public profile: ${seen.profile?.why}`)
  assert.ok(seen.name, 'the public profile gives a name')
  assert.equal(seen.joinPage?.answers, true, `join page: ${seen.joinPage?.why}`)
  assert.equal(seen.didQr?.answers, true, `DID QR code: ${seen.didQr?.why}`)
  assert.equal(seen.statusList?.verifies, true, `revocation list: ${seen.statusList?.why}`)
})

test('its revocation list is signed by the community and reads as a W3C Bitstring Status List', { skip }, async () => {
  const doc = await resolver.resolve(DID)
  const base = (doc.service ?? []).find((s) => [s.type].flat().includes('VTCStatusList'))?.serviceEndpoint ?? `${(doc.service ?? []).find((s) => [s.type].flat().includes('TrustTaskHTTPS'))?.serviceEndpoint}/status-lists`
  const lists = new StatusLists({ keyFor, fetch: publicFetch })
  const l = await lists.list(`${String(base).replace(/\/+$/, '')}/revocation`, DID)
  assert.equal(l.ok, true, l.reason)
  console.log(`revocation list: ${l.bytes.length * 8} places, signed at ${l.signedAt}, purposes ${l.purposes.join(', ')}`)
  assert.ok(l.purposes.includes('revocation'))
  assert.ok(l.bytes.length * 8 >= MIN_ENTRIES, 'at least 131,072 places')
  console.log('places 0 to 3 (OpenVTC sets them as decoys):', [0, 1, 2, 3].map((i) => (bitAt(l.bytes, i) ? 1 : 0)).join(''))
})

test('a real membership pass from it verifies, and its place on the list reads', { skip: skip || (FILE ? false : 'set LIVE_MEMBERSHIP_CREDENTIAL to a file holding a membership credential this community issued') }, async () => {
  const vc = JSON.parse(readFileSync(FILE, 'utf8'))
  const r = await verifyDtgCredential(vc, { keyFor, kinds: ['membership'] })
  console.log(JSON.stringify({ ok: r.ok, checked: r.checked, problem: r.problem, reason: r.reason, context: r.context?.name, notes: r.notes, unchecked: r.unchecked, proofHasContext: [vc.proof].flat().map((p) => p?.['@context'] !== undefined) }, null, 2))
  assert.equal(r.ok, true, r.reason); assert.equal(r.checked, true, 'the community\'s signature was checked')
  assert.equal(r.claims.issuer, DID, 'issued by this community')
  const tampered = structuredClone(vc); tampered.credentialSubject.id = room.did
  assert.equal((await verifyDtgCredential(tampered, { keyFor })).ok, false, 'a changed copy is refused')
  const status = await new StatusLists({ keyFor, fetch: publicFetch }).statusOf(statusEntriesOf(vc), { issuer: DID })
  console.log('status:', JSON.stringify(status))
  assert.notEqual(status.status, 'unknown', status.reason)
})
