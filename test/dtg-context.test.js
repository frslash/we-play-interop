// One DTG context address: the room reads all three in use (registry, RLTP membership's
// firstperson.network one, TrustStackers') and writes only the registry one.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { didKeyOnly } from '../src/shared/chain.js'
import { VC_V2, permissionCredential, signPermissionCredential, verifyPermissionCredential } from '../src/shared/credential.js'
import { newIdentity } from '../src/shared/did.js'
import { DTG_CONTEXT, DTG_CONTEXTS, dtgContextOf, dtgContextProblem } from '../src/shared/dtg-context.js'
import { sign } from '../src/shared/proof.js'
import { issueCredential, present, verifyWith } from '../src/shared/sealed.js'
import { SealedHost } from '../src/server/sealed-host.js'

const REGISTRY = 'https://registry.trustoverip.org/dtg/context/v1'
const FIRSTPERSON = 'https://firstperson.network/credentials/dtg/v1' // RLTP membership: lib/src/membership.ts line 28 at 48c5efb
const TRUSTSTACKERS = 'https://trustoverip.org/dtg/credentials/v1'
const THREE = [[REGISTRY, 'registry-v1'], [FIRSTPERSON, 'firstperson-wd01'], [TRUSTSTACKERS, 'trustoverip-v1']]
const ROOM = newIdentity().did
const window = () => ({ validFrom: new Date().toISOString(), validUntil: new Date(Date.now() + 86400000).toISOString() })

/** A permission credential signed by its issuer under the given @context, as another project's code would. */
function signedUnder (ctx) {
  const person = newIdentity(), agent = newIdentity()
  const c = { ...permissionCredential({ person: person.did, agent: agent.did, room: ROOM, scope: ['note'], ...window() }), '@context': ctx }
  return sign(c, { seed: person.seed, verificationMethod: person.verificationMethod, created: c.validFrom, proofPurpose: 'assertionMethod' })
}

describe('DTG context addresses', () => {
  test('the room knows exactly the three addresses, and the registry one is the one it writes', () => {
    assert.equal(DTG_CONTEXT, REGISTRY)
    assert.deepEqual(Object.entries(DTG_CONTEXTS), THREE)
  })

  for (const [address, name] of THREE) {
    test(`a credential under ${name} (${address}) verifies`, async () => {
      const c = signedUnder([VC_V2, address])
      const r = await verifyPermissionCredential(c, { keyFor: didKeyOnly })
      assert.equal(r.ok, true, r.reason); assert.equal(r.checked, true)
      assert.equal(r.claims.context, name)
      assert.deepEqual(dtgContextOf(c['@context']), { address, name, current: address === REGISTRY })
    })
  }

  test('a credential with no DTG address still verifies (those signed before this change)', async () => {
    const r = await verifyPermissionCredential(signedUnder([VC_V2]), { keyFor: didKeyOnly })
    assert.equal(r.ok, true); assert.equal(r.claims.context, null)
  })

  test('an unknown DTG address, or two of them, is refused', async () => {
    const odd = await verifyPermissionCredential(signedUnder([VC_V2, 'https://example.org/dtg/context/v9']), { keyFor: didKeyOnly })
    assert.equal(odd.ok, false); assert.equal(odd.problem, 'shape'); assert.match(odd.reason, /not a DTG context address the room reads/)
    const two = await verifyPermissionCredential(signedUnder([VC_V2, REGISTRY, FIRSTPERSON]), { keyFor: didKeyOnly })
    assert.equal(two.ok, false); assert.match(two.reason, /one DTG context address at most/)
    assert.equal(dtgContextProblem([VC_V2, 'https://www.w3.org/ns/credentials/examples/v2']), null)
  })

  test('the address is signed: moving a credential to another DTG address breaks its proof', async () => {
    const c = signedUnder([VC_V2, FIRSTPERSON])
    const moved = { ...c, '@context': [VC_V2, REGISTRY], proof: { ...c.proof, '@context': [VC_V2, REGISTRY] } }
    assert.equal((await verifyPermissionCredential(moved, { keyFor: didKeyOnly })).problem, 'proof')
  })
})

describe('every credential the room writes carries only the registry address', () => {
  const onlyRegistry = (ctx) => {
    assert.ok(ctx.includes(REGISTRY))
    assert.equal(ctx.filter((x) => Object.hasOwn(DTG_CONTEXTS, x) || /\/dtg\//.test(x)).length, 1)
    assert.ok(!ctx.includes(FIRSTPERSON) && !ctx.includes(TRUSTSTACKERS))
  }

  test('the permission credential (page and agent check both sign it with signPermissionCredential)', async () => {
    const person = newIdentity(), agent = newIdentity()
    const c = signPermissionCredential(person, { agent: agent.did, room: ROOM, scope: ['note'], ...window() })
    assert.deepEqual(c['@context'], [VC_V2, REGISTRY]); onlyRegistry(c['@context']); onlyRegistry(c.proof['@context'])
    const r = await verifyPermissionCredential(c, { keyFor: didKeyOnly })
    assert.equal(r.ok, true); assert.equal(r.claims.context, 'registry-v1')
  })

  test('the unsigned permission credential', () => {
    const c = permissionCredential({ person: newIdentity().did, agent: newIdentity().did, room: ROOM, scope: ['note'], ...window() })
    assert.deepEqual(c['@context'], [VC_V2, REGISTRY])
  })

  test('the room\'s member and agent credentials (sealed notebooks), which its host still accepts', () => {
    const room = newIdentity(), member = newIdentity()
    const m = issueCredential(room, { subject: member.did, role: 'member', scopes: ['notes:read', 'notes:write'], ttlMs: 3600e3 })
    const a = issueCredential(room, { subject: newIdentity().did, role: 'agent', scopes: ['notes:read'], ttlMs: 3600e3, delegatedBy: member.did })
    for (const c of [m, a]) { assert.deepEqual(c['@context'], [VC_V2, REGISTRY]); onlyRegistry(c.proof['@context']); assert.equal(verifyWith(c, room.did, 'assertionMethod'), true) }
  })
})

describe('the sealed host reads the room\'s credentials under any of the three addresses', () => {
  const memberUnder = (room, member, ctx) => {
    const c = issueCredential(room, { subject: member.did, role: 'member', scopes: ['notes:read', 'notes:write'], ttlMs: 3600e3 })
    const { proof, ...doc } = c
    return sign({ ...doc, '@context': ctx }, { seed: room.seed, verificationMethod: room.verificationMethod, proofPurpose: 'assertionMethod' })
  }
  const list = (host, room, member, cred) => host.call(present(member, cred, { room: room.did, nonce: host.challenge(), op: 'list', host: host.host }), {})

  for (const [address, name] of THREE) {
    test(`a member credential under ${name} is accepted`, () => {
      const host = new SealedHost(); const room = newIdentity(); host.createRoom(room.did); const member = newIdentity()
      assert.doesNotThrow(() => list(host, room, member, memberUnder(room, member, [VC_V2, address])))
    })
  }

  test('one written by the room as it is now is accepted; an unknown DTG address is refused', () => {
    const host = new SealedHost(); const room = newIdentity(); host.createRoom(room.did); const member = newIdentity()
    const fresh = issueCredential(room, { subject: member.did, role: 'member', scopes: ['notes:read'], ttlMs: 3600e3 })
    assert.doesNotThrow(() => list(host, room, member, fresh))
    assert.throws(() => list(host, room, member, memberUnder(room, member, [VC_V2, 'https://example.org/dtg/context/v9'])), /DTG context address the room does not read/)
  })
})
