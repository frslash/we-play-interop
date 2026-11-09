#!/usr/bin/env node
// Mint a did:webvh for the room on a host: node agent/mint-room-did.js <host> [outdir]
// Writes did.jsonl (public: put it in the room's DATA_DIR) and update-key.txt (SECRET: the key that may change the DID).
// Test keys only until the people who will own the room hold the real ones; keep update-key.txt out of the repository.
import { createDID, prepareDataForSigning } from 'didwebvh-ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { newIdentity, ed25519Multikey } from '../src/shared/did.js'
import { ed25519, multibase, fromMultibase } from '../src/shared/crypto.js'

/** Mint the log: returns { did, log (jsonl text), seedHex }. `seed` is injectable for tests. */
export async function mintRoomDid (host, { seed, created } = {}) {
  const id = newIdentity(seed)
  const mk = ed25519Multikey(id.publicKey)
  const signer = {
    getVerificationMethodId: () => `did:key:${mk}#${mk}`,
    async sign ({ document, proof }) {
      const data = await prepareDataForSigning(document, proof)
      return { proofValue: multibase(ed25519.sign(data, id.seed)) }
    },
  }
  const verifier = { verify: async (sig, msg, pub) => ed25519.verify(sig, msg, pub) }
  const r = await createDID({
    address: host, signer, verifier, updateKeys: [mk], created,
    portable: true, // so the room can move hosts (the handover) and keep its DID
    didDocument: { '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'], id: '{DID}' },
  })
  return { did: r.did, log: r.log.map((e) => JSON.stringify(e)).join('\n') + '\n', seedHex: id.seedHex }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) {
  const [host, out = '.'] = process.argv.slice(2)
  if (!host) { console.error('usage: node agent/mint-room-did.js <host> [outdir]'); process.exit(2) }
  const m = await mintRoomDid(host)
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'did.jsonl'), m.log)
  writeFileSync(join(out, 'update-key.txt'), m.seedHex + '\n', { mode: 0o600 })
  console.log(m.did)
  console.error('did.jsonl is public. update-key.txt is secret: it can change this DID. Never commit it.')
}
