// A stand-in trust community for the tests: a local server that answers the way OpenVTC's vtc-service does, for
// the parts the room reads. It proves the room's side is consistent with these shapes; it does not prove a real
// community answers this way (test/live/community-live.test.js checks that against one).
// Each shape below names the upstream file it was read from, at the commit the room builds from.
import http from 'node:http'
import { gzipSync } from 'node:zlib'
import { createDID, prepareDataForSigning } from 'didwebvh-ts'
import { ed25519, multibase } from '../../src/shared/crypto.js'
import { ed25519Multikey, newIdentity } from '../../src/shared/did.js'
import { VC_V2 } from '../../src/shared/dtg.js'
import { proofConfig, signingInput } from '../../src/shared/proof.js'
import { instant } from '../../src/shared/trusttask.js'
import { createPublicFetch, createResolver } from '../../src/server/resolver.js'

const DTG_V1 = 'https://registry.trustoverip.org/dtg/context/v1'
const PUBLIC = '203.0.113.7' // documentation range: passes the room's "is this a public address" check
const BITS = 131_072 // vtc-service/src/status_list/mod.rs: "capacity 131,072 bits each"

/** The room's own public fetch, with name lookup and the connection pointed at a local server (as test/resolver.test.js does). */
export function fetchTo (port) {
  const request = (opts, cb) => http.request({ ...opts, protocol: 'http:', servername: undefined, lookup: (_n, o, c) => (o?.all ? c(null, [{ address: '127.0.0.1', family: 4 }]) : c(null, '127.0.0.1', 4)) }, cb)
  return createPublicFetch({ lookup: async () => [{ address: PUBLIC, family: 4 }], request, port })
}

export async function standInCommunity ({ host = 'vtc.example', name = 'Stand-in community', seed = new Uint8Array(32).fill(71), now = Date.now, proofSet = true, proofContext = true } = {}) {
  const key = newIdentity(seed), url = `https://${host}`
  // Its did:webvh, from the document OpenVTC mints for a community (vta-sdk/templates/vtc-host.json): the signing key
  // is #key-0, listed for assertionMethod and authentication; #key-2 is the post-quantum signing key (ML-DSA-44; here
  // a placeholder, since nothing in the room can check it); the services are VTCRest, VTCStatusList, TrustTaskHTTPS
  // and SignInPortal. (#key-1, its key agreement key, is left out: the room does not read it.)
  const mk = ed25519Multikey(key.publicKey)
  const signer = { getVerificationMethodId: () => `did:key:${mk}#${mk}`, async sign ({ document, proof }) { return { proofValue: multibase(ed25519.sign(await prepareDataForSigning(document, proof), key.seed)) } } }
  const made = await createDID({
    address: host, signer, verifier: { verify: async (sig, msg, pub) => ed25519.verify(sig, msg, pub) }, updateKeys: [mk],
    didDocument: {
      '@context': ['https://www.w3.org/ns/did/v1', 'https://www.w3.org/ns/cid/v1', 'https://w3id.org/security/multikey/v1'], id: '{DID}',
      verificationMethod: [{ id: '{DID}#key-0', type: 'Multikey', controller: '{DID}', publicKeyMultibase: mk }, { id: '{DID}#key-2', type: 'Multikey', controller: '{DID}', publicKeyMultibase: 'z' + 'A'.repeat(60) }],
      assertionMethod: ['{DID}#key-0', '{DID}#key-2'], authentication: ['{DID}#key-0'],
      service: [
        { id: '{DID}#vtc-rest', type: 'VTCRest', serviceEndpoint: `${url}/v1` },
        { id: '{DID}#vtc-status-list', type: 'VTCStatusList', serviceEndpoint: `${url}/v1/status-lists` },
        { id: '{DID}#trust-tasks', type: 'TrustTaskHTTPS', serviceEndpoint: `${url}/v1` },
        { id: '{DID}#sign-in-portal', type: 'SignInPortal', serviceEndpoint: `${url}/members/` },
      ],
    },
  })
  const did = made.did, vm = `${did}#key-0`
  const log = made.log.map((e) => JSON.stringify(e)).join('\n') + '\n'

  /**
   * Sign as the community (vtc-service/src/credentials/signer.rs): eddsa-jcs-2022 with #key-0 for assertionMethod.
   * A community with a post-quantum key signs once per key, so `proof` is a list of two (one key: a bare object).
   * Whether its Ed25519 proof carries a copy of the credential's @context could not be read (the signing library is
   * not in the sources), so the stand-in can do either: `proofContext`.
   */
  const signAs = (doc, { set = proofSet, context = proofContext, seed: s = key.seed, method = vm } = {}) => {
    const created = instant(now())
    const cfg = proofConfig({ verificationMethod: method, created, proofPurpose: 'assertionMethod', ...(context ? { context: doc['@context'] } : {}) })
    const proof = { ...cfg, proofValue: multibase(ed25519.sign(signingInput(doc, cfg), s)) }
    const pq = { type: 'DataIntegrityProof', cryptosuite: 'mldsa44-jcs-2024', created, verificationMethod: `${did}#key-2`, proofPurpose: 'assertionMethod', proofValue: 'z' + 'B'.repeat(80) }
    return JSON.parse(JSON.stringify({ ...doc, proof: set ? [proof, pq] : proof }))
  }

  // Its two status lists (vtc-service/src/status_list/): one bit per credential, the first bit of a byte is the
  // lowest position; positions 0 to 3 are set from the start as decoys and never handed out (docs/03-vtc/credentials.md).
  const lists = { revocation: new Uint8Array(BITS / 8), suspension: new Uint8Array(BITS / 8) }
  const set = (purpose, index, on = true) => { const b = lists[purpose]; if (on) b[index >> 3] |= 0x80 >> (index & 7); else b[index >> 3] &= ~(0x80 >> (index & 7)) }
  for (const p of ['revocation', 'suspension']) for (let i = 0; i < 4; i++) set(p, i)
  let nextSlot = 4
  const listUrl = (purpose) => `${url}/v1/status-lists/${purpose}`
  /** The list as GET /v1/status-lists/{purpose} serves it, signed afresh on every request (status_list/credential.rs; routes/status_lists.rs). */
  const listCredential = (purpose, opts) => signAs({
    '@context': [VC_V2], id: listUrl(purpose), type: ['VerifiableCredential', 'BitstringStatusListCredential'], issuer: did, validFrom: instant(now()),
    credentialSubject: { id: `${listUrl(purpose)}#list`, type: 'BitstringStatusList', statusPurpose: purpose, encodedList: 'u' + gzipSync(lists[purpose]).toString('base64url') },
  }, opts)

  /** A membership credential as the community mints one (vtc-service/src/credentials/dtg.rs issue_membership; docs/03-vtc/credentials.md "VMC details"): thirty days, one place on the revocation list. */
  const issueVmc = (subject, { days = 30, personhood = false, slot = nextSlot++, status = true, change = (v) => v, ...opts } = {}) => {
    const t = now()
    const body = change({
      '@context': [VC_V2, DTG_V1], id: `urn:uuid:00000000-0000-4000-8000-${String(slot).padStart(12, '0')}`,
      type: ['VerifiableCredential', 'DTGCredential', 'MembershipCredential', ...(personhood ? ['PersonhoodCredential'] : [])],
      issuer: did, issuerScope: 'public', validFrom: instant(t), validUntil: instant(t + days * 86_400_000), credentialSubject: { id: subject },
      ...(status ? { credentialStatus: { id: `${listUrl('revocation')}#${slot}`, type: 'BitstringStatusListEntry', statusPurpose: 'revocation', statusListIndex: String(slot), statusListCredential: listUrl('revocation') } } : {}),
    })
    return { credential: signAs(body, opts), slot }
  }

  const state = { down: false, list: null } // `list`: a function that changes what the list route answers, for the failure tests
  const hits = []
  const server = http.createServer((req, res) => {
    const path = new URL(req.url, url).pathname
    hits.push(`${req.method} ${req.url}`)
    const json = (status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)) }
    if (state.down) { res.writeHead(503); return res.end() }
    if (path === '/.well-known/did.jsonl') { res.writeHead(200, { 'content-type': 'text/jsonl' }); return res.end(log) } // the community serves its own DID log here
    // routes/community/profile.rs PublicCommunityProfile (camelCase), no sign-in
    if (path === '/v1/community/public-profile') return json(200, { communityDid: did, name, description: 'A community that exists only in the room\'s tests.', logoUrl: null, publicUrl: url, contactEmail: null, language: 'en', createdAt: '2026-11-01T00:00:00Z', personhood: {}, mediatorDid: null, transports: [{ protocol: 'rest', advertised: true, serviceable: true, endpoint: `${url}/v1` }] })
    // routes/community/did_qr.rs: the bare DID as an SVG QR code
    if (path === '/v1/community/did-qr.svg') { res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=300', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'" }); return res.end('<svg xmlns="http://www.w3.org/2000/svg"/>') }
    // the member portal; /members/?join is the join page (vtc-service/CLAUDE.md "Join page")
    if (path === '/members/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end('<!doctype html><title>Members</title>') }
    // routes/status_lists.rs: 200 with the signed list, no-store; 404 for any other purpose
    const m = /^\/v1\/status-lists\/([a-z]+)$/.exec(path)
    if (m) {
      if (!lists[m[1]]) return json(404, { error: `unknown status-list purpose '${m[1]}' (expected 'revocation' or 'suspension')` })
      const out = state.list ? state.list(m[1], res) : listCredential(m[1])
      return out === undefined ? undefined : json(200, out, { 'cache-control': 'no-store' })
    }
    json(404, { error: 'not found' })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const fetch = fetchTo(server.address().port)
  return {
    did, url, name, key, hits, state, lists, fetch, resolver: createResolver({ fetch }),
    signAs, issueVmc, listCredential, listUrl,
    revoke: (slot) => set('revocation', slot), suspend: (slot, on = true) => set('suspension', slot, on),
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) }),
  }
}
