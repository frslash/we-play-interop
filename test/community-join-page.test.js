// "Join from the room's page" (src/server/community.js, GET /api/community `join`): the room asks the community what
// it requires (manifest 0.4), shows that, and sends the person to the community's own page. The community is played
// by a small stand-in in this file. Shapes it follows:
//   the door: POST {VTCRest base}/trust-tasks, recipient = the community DID (vtc-service/src/routes/mod.rs:1550,1688);
//   the manifest: vti-specs-vtc/trust-tasks/vtc/join-requests/manifest/0.4.bundle.json (empty request; the answer is
//     { communityDid, criteria[{ id, description?, admission, invitationRequired?, vetting?, requirementsDigest }],
//       requestedAttributes?[{ type, required, purpose }], branding?, directoryDisclosure? });
//   closed discovery: an unidentified caller gets permissionDenied (vtc-service/src/trust_tasks/mod.rs:4080-4120,
//     discovery_refusal); here a request with no proof stands for "unidentified".
// It proves the room's side is self-consistent; test/live/community-manifest-live.test.js is the check against a real one.
import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before, describe, test } from 'node:test'
import { Community } from '../src/server/community.js'
import { newIdentity } from '../src/shared/did.js'
import { ERROR_PREFIX, refusalTo, responseTo, serviceEndpoint } from '../src/shared/trusttask.js'

const DID = 'did:webvh:QmExampleExampleExampleExampleExampleExampleEx:vtc.example'
const MANIFEST = 'https://trusttasks.org/spec/vtc/join-requests/manifest/0.4'
const standIn = newIdentity(new Uint8Array(32).fill(61))
const criteria = [
  { id: 'open', description: 'Anyone who asks', admission: 'automatic', requirementsDigest: 'zQmOpen' },
  { id: 'vouched', description: 'Someone two members know', admission: 'review', invitationRequired: false, requirementsDigest: 'zQmVouched', vetting: { version: '1.0', statementType: 'https://example.org/s', minStatements: 2, acceptedMethods: ['in-person', 'video'], minByMethod: { 'in-person': 1 }, eligibleVetters: { role: 'member' } } },
]

let server, port, requests, closed
before(async () => {
  requests = []; closed = false
  server = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c }); req.on('end', () => {
      const doc = body ? JSON.parse(body) : {}; if (req.method === 'POST') requests.push({ url: req.url, doc, header: req.headers['trust-task'] }) // only manifest requests are POSTs; the look's reads are GETs
      const send = (d) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(d)) }
      if (req.url !== '/v1/trust-tasks' || doc.type !== MANIFEST || doc.recipient !== DID) return res.writeHead(404).end()
      if (closed && !doc.proof) return send(refusalTo(doc, { code: 'permissionDenied', message: 'ask signed' }, DID))
      send(responseTo(doc, { communityDid: DID, criteria, requestedAttributes: [{ type: 'name.legal', required: true, purpose: 'so members know you' }, { type: 'phone.mobile', required: false }], branding: { displayName: 'Stand-in' }, directoryDisclosure: { fields: [] } }, DID))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); port = server.address().port
})
after(() => server.close())

// the room's fetch, with the community's https address pointed at the local server (nothing leaves this machine)
const fetchTo = (url, init) => fetch(String(url).replace('https://vtc.example', `http://127.0.0.1:${port}`), init)
const didDoc = { id: DID, service: [{ id: `${DID}#vtc-rest`, type: 'VTCRest', serviceEndpoint: 'https://vtc.example/v1' }, { id: `${DID}#trust-tasks`, type: 'TrustTaskHTTPS', serviceEndpoint: 'https://vtc.example/v1' }] }
const make = ({ now, resolve = async () => didDoc, config = {} } = {}) => {
  const room = newIdentity(new Uint8Array(32).fill(62))
  return new Community({ config: { communityDid: DID, ...config }, resolver: { resolve, keyFor: async () => null }, identity: room, room: () => room, fetch: fetchTo, ...(now ? { now } : {}) })
}
const reset = () => { requests.length = 0; closed = false }

describe('the join part of /api/community', () => {
  test('shows the criteria in the shape the page uses, and asks signed, as the room', async () => {
    reset(); const c = make(), d = await c.describe()
    assert.equal(requests.length, 1)
    assert.equal(requests[0].header, MANIFEST); assert.deepEqual(requests[0].doc.payload, {}); assert.equal(requests[0].doc.recipient, DID)
    assert.equal(requests[0].doc.proof?.proofPurpose, 'authentication', 'signed, as the room itself')
    assert.equal(requests[0].doc.issuer, c.room().did)
    assert.equal(d.join.criteria.length, 2)
    assert.deepEqual(d.join.criteria[1], { id: 'vouched', description: 'Someone two members know', admission: 'review', invitationRequired: false, requirementsDigest: 'zQmVouched', vetting: { minStatements: 2, acceptedMethods: ['in-person', 'video'], minByMethod: { 'in-person': 1 } } })
    assert.deepEqual(d.join.attributes, [{ type: 'name.legal', required: true, purpose: 'so members know you' }, { type: 'phone.mobile', required: false }])
    assert.deepEqual(d.join.directoryDisclosure, { fields: [] })
    assert.equal(d.join.problem, undefined); assert.match(d.join.fetchedAt, /^\d{4}-.*Z$/)
    assert.equal(d.join.url, 'https://vtc.example/members/?join', 'derived from the origin of the community\'s API address')
  })

  test('a community that answers only a signed request still answers the room', async () => {
    reset(); closed = true
    const d = await make().describe()
    assert.equal(d.join.problem, undefined); assert.equal(d.join.criteria.length, 2)
  })

  test('with the community down it says so in words and the rest still renders', async () => {
    reset()
    const c = make(); const down = new Community({ config: { communityDid: DID }, resolver: { resolve: async () => didDoc, keyFor: async () => null }, identity: c.identity, room: () => c.identity, fetch: async () => { throw new Error('connect ECONNREFUSED 10.0.0.9:443 secret-host') } })
    const d = await down.describe()
    assert.equal(d.set, true); assert.deepEqual(d.join.criteria, []); assert.equal(d.join.problemCode, 'unavailable')
    assert.match(d.join.problem, /could not be read right now \(unavailable\)/); assert.doesNotMatch(JSON.stringify(d.join), /ECONNREFUSED|10\.0\.0\.9|secret-host/)
    assert.equal(d.join.url, 'https://vtc.example/members/?join'); assert.equal(down.summary().join.manifestRefused.unavailable, 1)
  })

  test('a refusal is said with its shared code, and counted', async () => {
    reset()
    const c = make(); c.fetch = async (url, init) => (String(url).endsWith('/trust-tasks') ? new Response(JSON.stringify(refusalTo(JSON.parse(init.body), { code: 'permissionDenied', message: 'x' }, DID)), { status: 403 }) : new Response('', { status: 404 }))
    const d = await c.describe()
    assert.equal(d.join.problemCode, 'permissionDenied'); assert.match(d.join.problem, /\(permissionDenied\)/)
    assert.deepEqual(c.summary().join, { manifestReads: 1, manifestRefused: { permissionDenied: 1 }, cacheHits: 0 })
    assert.ok(ERROR_PREFIX)
  })

  test('two page loads inside ten minutes make one manifest request; the read is renewed after', async () => {
    reset(); let t = 1_700_000_000_000; const c = make({ now: () => t })
    await Promise.all([c.describe(), c.describe(), c.describe()]) // at once: still one request in flight
    assert.equal(requests.length, 1)
    t += 70_000; await c.describe() // the look is renewed after a minute; the manifest is not
    assert.equal(requests.length, 1); t += 9 * 60_000 + 1; await c.describe()
    assert.equal(requests.length, 2)
    const j = c.summary().join; assert.equal(j.manifestReads, 2); assert.ok(j.cacheHits >= 1)
  })

  test('COMMUNITY_JOIN_URL overrides the derived link; one that is not https is ignored', async () => {
    reset()
    assert.equal((await make({ config: { communityJoinUrl: 'https://join.example/members/' } }).describe()).join.url, 'https://join.example/members/')
    assert.equal((await make({ config: { communityJoinUrl: 'http://join.example/' } }).describe()).join.url, 'https://vtc.example/members/?join')
    process.env.COMMUNITY_JOIN_URL = 'https://env.example/join'
    try { assert.equal((await make().describe()).join.url, 'https://env.example/join') } finally { delete process.env.COMMUNITY_JOIN_URL }
  })

  test('the community\'s own sign-in portal (named in its DID document) is the link when no setting is given', async () => {
    const doc = { ...didDoc, service: [...didDoc.service, { id: `${DID}#sign-in-portal`, type: 'SignInPortal', serviceEndpoint: 'https://portal.example/members/' }] }
    assert.equal(serviceEndpoint(doc, 'SignInPortal'), 'https://portal.example/members/')
    reset(); assert.equal((await make({ resolve: async () => doc }).describe()).join.url, 'https://portal.example/members/?join')
  })

  test('a manifest for another community, or with hostile sizes, shows nothing it should not', async () => {
    reset()
    const c = make(); c.fetch = async (url, init) => (String(url).endsWith('/trust-tasks') ? new Response(JSON.stringify(responseTo(JSON.parse(init.body), { communityDid: 'did:webvh:QmOther:other.example', criteria }, DID))) : new Response('', { status: 404 }))
    assert.equal((await c.describe()).join.problemCode, 'malformedResponse')
    const big = make(); big.fetch = async (url, init) => (String(url).endsWith('/trust-tasks') ? new Response(JSON.stringify(responseTo(JSON.parse(init.body), { communityDid: DID, criteria: Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, description: 'x'.repeat(5000), admission: 'review' })), directoryDisclosure: { pad: 'y'.repeat(20000) } }, DID))) : new Response('', { status: 404 }))
    const j = (await big.describe()).join
    assert.equal(j.criteria.length, 16); assert.equal(j.criteria[0].description.length, 300); assert.equal(j.directoryDisclosure, undefined)
  })
})
