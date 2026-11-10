// The export gate (P0.5), as the room agreed its pass test: export, import into an empty instance,
// then ok, equal count, equal head (seq and hash) and signaturesNotChecked === 0, with authors on
// every DID method the room accepts (did:key, did:peer:4, did:webvh). An unresolvable author is a fail.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { createDID, defaultVerifier } from 'didwebvh-ts'
import { ed25519, multibase } from '../src/shared/crypto.js'
import { didPeer4FromDocument, ed25519Multikey, newIdentity } from '../src/shared/did.js'
import { signingInput } from '../src/shared/proof.js'
import { TYPES, signedDocument } from '../src/shared/types.js'
import { config as baseConfig } from '../src/server/config.js'
import { createApp } from '../src/server/index.js'
import { createResolver } from '../src/server/resolver.js'
import { openDb } from '../src/server/db.js'
import { checkExport, importExport, makeExport } from '../src/server/export.js'

async function makeWebvh () {
  const update = newIdentity(), key = newIdentity()
  const mk = ed25519Multikey(update.publicKey)
  const signer = {
    getVerificationMethodId: () => `did:key:${mk}#${mk}`,
    sign: async ({ document, proof }) => ({ proofValue: multibase(ed25519.sign(signingInput(document, proof), update.seed)) }),
  }
  const vk = ed25519Multikey(key.publicKey)
  const { did, log } = await createDID({
    address: 'interop.example', signer, verifier: defaultVerifier, updateKeys: [mk],
    didDocument: { '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'], id: '{DID}', verificationMethod: [{ id: '{DID}#key-1', type: 'Multikey', controller: '{DID}', publicKeyMultibase: vk }], authentication: ['{DID}#key-1'], assertionMethod: ['{DID}#key-1'] },
  })
  const jsonl = log.map((e) => JSON.stringify(e)).join('\n') + '\n'
  const fetch = async (url) => (String(url).endsWith('/did.jsonl') ? new Response(jsonl, { status: 200 }) : new Response('not found', { status: 404 }))
  return { key: { ...key, did, verificationMethod: `${did}#key-1` }, fetch }
}

describe('export gate: every author DID method must be checkable', () => {
  test('a room with did:key, did:peer:4 and did:webvh authors passes the agreed test', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wpi-gate-')), dir2 = mkdtempSync(join(tmpdir(), 'wpi-gate2-'))
    const webvh = await makeWebvh()
    const resolver = createResolver({ fetch: webvh.fetch })
    const ctx = await createApp({ ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, weaverIntervalMinutes: 0, weaverQuietMinutes: 0, ratePerMinute: 1000, publicUrl: 'https://interop.example', boardDataUrl: '', llm: { ...baseConfig.llm, apiKey: '' } }, { resolver, awayGatherMs: 0, hostWelcomeMs: null })
    await new Promise((r) => ctx.server.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${ctx.server.address().port}`
    const peerKey = newIdentity()
    const { long } = didPeer4FromDocument({ verificationMethod: [{ id: '#key-1', type: 'Multikey', publicKeyMultibase: ed25519Multikey(peerKey.publicKey) }], authentication: ['#key-1'] })
    const people = [newIdentity(), webvh.key, { ...peerKey, did: long, verificationMethod: `${long}#key-1` }]
    for (const [i, p] of people.entries()) {
      const res = await fetch(`${base}/api/entries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signedDocument(p, { type: TYPES.join, payload: { name: `Person ${i}` } })) })
      assert.equal(res.status, 201)
    }
    const doc = makeExport(ctx.log.entries)
    await ctx.stop(); rmSync(dir, { recursive: true, force: true })

    const keyFor = (d, v, p) => resolver.keyFor(d, v, p)
    const db = await openDb({ databaseUrl: '', dataDir: dir2 })
    const r = await importExport(db, JSON.parse(JSON.stringify(doc)), { keyFor })
    assert.equal(r.entries, doc.count)
    assert.deepEqual(r.head, doc.head)
    assert.equal(r.signaturesNotChecked, 0)
    await db.close(); rmSync(dir2, { recursive: true, force: true })

    // Without a resolver that knows the methods, the same export FAILS (it does not pass with skipped signatures).
    const blind = await checkExport(JSON.parse(JSON.stringify(doc)))
    assert.equal(blind.ok, false)
    assert.match(blind.problem, /could not be checked/)
  })
})
