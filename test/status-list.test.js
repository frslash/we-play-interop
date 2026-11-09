// Reading a credential's status from the list its issuer signs (src/server/status-list.js), against the stand-in
// community in test/support/standin-community.js, which serves its lists the way OpenVTC's vtc-service does
// (routes/status_lists.rs, status_list/credential.rs). Every way the list can fail must end in "unknown", never "good".
import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { statusEntriesOf } from '../src/shared/dtg.js'
import { newIdentity } from '../src/shared/did.js'
import { sign } from '../src/shared/proof.js'
import { StatusLists, bitAt, decodeList } from '../src/server/status-list.js'
import { standInCommunity } from './support/standin-community.js'

const clock = { t: Date.parse('2026-11-09T20:00:00Z') }
const now = () => clock.t
const member = newIdentity(new Uint8Array(32).fill(2))
let c
before(async () => { c = await standInCommunity({ now }) })
after(async () => { await c.close() })
const reader = (opts) => new StatusLists({ keyFor: c.resolver.keyFor, fetch: c.fetch, now, ...opts })
const listHits = () => c.hits.filter((h) => h.includes('/status-lists/')).length
const fresh = () => { clock.t += 60_000; c.state.list = null; c.state.down = false } // past every cache window, the community back to normal

test('the encoded list is "u" + base64url of the gzip of the bits, first bit of a byte first', () => {
  const zeros = decodeList('u' + gzipSync(new Uint8Array(16_384)).toString('base64url')) // a new community's list: 131,072 clear bits
  assert.equal(zeros.length * 8, 131_072); assert.ok(zeros.every((b) => b === 0))
  assert.deepEqual(decodeList(gzipSync(new Uint8Array(4)).toString('base64url')), new Uint8Array(4), 'a list from before the standard settled, without the "u"')
  const bytes = new Uint8Array(16); bytes[0] = 0b1010_0000; bytes[1] = 0b0000_0001
  const back = decodeList('u' + gzipSync(bytes).toString('base64url'))
  assert.deepEqual([0, 1, 2, 7, 8, 15].map((i) => bitAt(back, i)), [true, false, true, false, false, true])
  assert.throws(() => decodeList('u!!!!!!!!!!!'), /base64url/); assert.throws(() => decodeList(undefined), /missing/)
  // a small download that unpacks into far more than any list: stopped while unpacking
  assert.throws(() => decodeList('u' + gzipSync(Buffer.alloc(8 * 1024 * 1024)).toString('base64url')))
})

test('a pass is good until its bit is set on the community\'s list; then it is revoked', async () => {
  fresh()
  const lists = reader()
  const { credential, slot } = c.issueVmc(member.did)
  const entries = statusEntriesOf(credential)
  assert.deepEqual(entries, [{ type: 'BitstringStatusListEntry', purpose: 'revocation', index: String(slot), list: c.listUrl('revocation') }])
  const good = await lists.statusOf(entries, { issuer: c.did })
  assert.equal(good.status, 'good'); assert.deepEqual(good.lists, [{ purpose: 'revocation', signedAt: '2026-11-09T20:01:00Z', cached: false }])
  c.revoke(slot)
  const before = listHits()
  assert.equal((await lists.statusOf(entries, { issuer: c.did })).status, 'good', 'inside the half minute a verified list is reused')
  assert.equal(listHits(), before, 'and the community was not asked again')
  clock.t += 31_000
  const gone = await lists.statusOf(entries, { issuer: c.did })
  assert.equal(gone.status, 'revoked', 'a pass revoked there shows here within 30 seconds')
  // the decoys OpenVTC sets from the start (places 0 to 3) read as set; a place never handed out reads clear
  assert.equal((await lists.read({ ...entries[0], index: '2' }, { issuer: c.did })).set, true)
  assert.equal((await lists.read({ ...entries[0], index: '9000' }, { issuer: c.did })).set, false)
})

test('a credential with no status entry cannot be withdrawn this way; one on the suspension list is suspended', async () => {
  fresh()
  const lists = reader()
  assert.deepEqual(await lists.statusOf([], { issuer: c.did }), { status: 'none', lists: [] })
  const { credential, slot } = c.issueVmc(member.did)
  const both = [...statusEntriesOf(credential), { type: 'BitstringStatusListEntry', purpose: 'suspension', index: String(slot), list: c.listUrl('suspension') }]
  assert.equal((await lists.statusOf(both, { issuer: c.did })).status, 'good')
  c.suspend(slot); clock.t += 31_000
  assert.equal((await lists.statusOf(both, { issuer: c.did })).status, 'suspended')
  c.revoke(slot); clock.t += 31_000
  assert.equal((await lists.statusOf(both, { issuer: c.did })).status, 'revoked', 'revoked outranks suspended')
  c.suspend(slot, false)
})

test('the list verifies whichever way the community wrote its proof: one or a set, with or without the @context copy', async () => {
  for (const opts of [{ set: true, context: true }, { set: false, context: true }, { set: true, context: false }, { set: false, context: false }]) {
    fresh(); c.state.list = (purpose) => c.listCredential(purpose, opts)
    const r = await reader().read({ type: 'BitstringStatusListEntry', purpose: 'revocation', index: '9000', list: c.listUrl('revocation') }, { issuer: c.did })
    assert.equal(r.ok, true, JSON.stringify(opts) + ' ' + r.reason); assert.equal(r.set, false)
  }
})

test('fail closed: a list that cannot be fetched, is not the issuer\'s, or does not reach the entry gives "unknown"', async () => {
  const { credential, slot } = c.issueVmc(member.did)
  const entries = statusEntriesOf(credential)
  const unknown = async (arrange, problem, re, ask = entries) => {
    fresh(); arrange()
    const r = await reader().statusOf(ask, { issuer: c.did })
    assert.equal(r.status, 'unknown', `expected unknown, got ${r.status}`); assert.equal(r.problem, problem); assert.match(r.reason, re)
  }
  const stranger = newIdentity(new Uint8Array(32).fill(66))
  await unknown(() => { c.state.down = true }, 'fetch', /answered 503/)
  await unknown(() => { c.state.list = (_p, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>maintenance</html>') } }, 'fetch', /could not be fetched or read/)
  await unknown(() => { c.state.list = (_p, res) => { res.destroy() } }, 'fetch', /could not be fetched or read/)
  await unknown(() => { c.state.list = () => ({ hello: 'world' }) }, 'list', /not a BitstringStatusListCredential/)
  // someone else's perfectly signed list at the community's address
  await unknown(() => { c.state.list = (p) => sign({ ...c.listCredential(p), issuer: stranger.did, proof: undefined }, { seed: stranger.seed, verificationMethod: stranger.verificationMethod, created: '2026-11-09T20:00:00Z', proofPurpose: 'assertionMethod' }) }, 'list', /not issued by the credential's issuer/)
  // names the community as issuer but is signed with another key
  await unknown(() => { c.state.list = (p) => c.listCredential(p, { seed: stranger.seed }) }, 'proof', /signature does not hold/)
  await unknown(() => { c.state.list = (p) => c.listCredential(p, { method: stranger.verificationMethod }) }, 'proof', /does not belong to the issuer/)
  // every bit cleared after signing: this is the change that would hide a revocation
  await unknown(() => { c.revoke(slot); c.state.list = (p) => { const l = c.listCredential(p); l.credentialSubject.encodedList = 'u' + gzipSync(new Uint8Array(16_384)).toString('base64url'); return l } }, 'proof', /signature does not hold/)
  await unknown(() => { c.state.list = (p) => { const { proof: _p, ...l } = c.listCredential(p); return l } }, 'proof', /not signed/)
  // the suspension list served where the revocation list should be
  await unknown(() => { c.state.list = () => c.listCredential('suspension') }, 'list', /is for suspension, not revocation/)
  await unknown(() => { c.state.list = (p) => c.signAs({ ...c.listCredential(p), proof: undefined, validUntil: '2026-11-01T00:00:00Z' }) }, 'list', /has run out/)
  await unknown(() => { c.state.list = (p) => c.signAs({ ...c.listCredential(p), proof: undefined, credentialSubject: { type: 'BitstringStatusList', statusPurpose: p, encodedList: 'u' + gzipSync(new Uint8Array(0)).toString('base64url') } }) }, 'range', /does not reach/)
  await unknown(() => {}, 'entry', /cannot read a status entry of type StatusList2021Entry/, [{ type: 'StatusList2021Entry', purpose: 'revocation', index: '5', list: c.listUrl('revocation') }])
  await unknown(() => {}, 'address', /not https/, [{ ...entries[0], list: 'http://vtc.example/v1/status-lists/revocation' }])
  await unknown(() => {}, 'entry', /one-bit status entries only/, [{ ...entries[0], size: 2 }])
  // and once the community is back, the same pass reads as what it is: revoked
  fresh()
  assert.equal((await reader().statusOf(entries, { issuer: c.did })).status, 'revoked')
})

test('a list for one issuer is never reused for another, and a failure is not asked for again at once', async () => {
  fresh()
  const lists = reader()
  const entry = { type: 'BitstringStatusListEntry', purpose: 'revocation', index: '5', list: c.listUrl('revocation') }
  assert.equal((await lists.read(entry, { issuer: c.did })).ok, true)
  const wrong = await lists.read(entry, { issuer: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH' })
  assert.deepEqual([wrong.ok, wrong.problem], [false, 'list'])
  assert.equal((await lists.read(entry, { issuer: c.did })).ok, true, 'the community\'s own verified copy is untouched')
  fresh(); c.state.down = true
  const l2 = reader(), before = listHits()
  await Promise.all([1, 2, 3, 4, 5].map(() => l2.read(entry, { issuer: c.did })))
  assert.equal(listHits(), before + 1, 'five checks at once are one request')
  await l2.read(entry, { issuer: c.did })
  assert.equal(listHits(), before + 1, 'a community that is down is not hammered through the room')
  c.state.down = false; clock.t += 11_000
  assert.equal((await l2.read(entry, { issuer: c.did })).ok, true, 'ten seconds later it is asked again')
  assert.deepEqual(l2.summary(), { fetched: 1, reused: 1, failed: { fetch: 1 }, held: 1 })
})

test('the cache holds a few lists, never a growing pile', async () => {
  fresh()
  const lists = reader({ maxLists: 2 })
  for (const purpose of ['revocation', 'suspension']) assert.equal((await lists.read({ type: 'BitstringStatusListEntry', purpose, index: '5', list: c.listUrl(purpose) }, { issuer: c.did })).ok, true)
  await lists.read({ type: 'BitstringStatusListEntry', purpose: 'revocation', index: '5', list: c.listUrl('nothing') }, { issuer: c.did })
  assert.equal(lists.cache.size, 2)
})
