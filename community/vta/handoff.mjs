#!/usr/bin/env node
// The trust agent's first-boot helper. A community (VTC) cannot set itself up until the trust agent (VTA) has granted
// its one-time setup key a "hand-off" entry, and only a signed request from an admin can write that entry (the
// agent's offline `acl create` has no hand-off flag: vta-service/src/main.rs, `AclCommands::Create`, at the pinned
// commit). So on first boot this helper makes a throwaway key inside the agent's own container, the setup file names
// it admin of the one context the community lives in, and here it signs the grant and is then deleted. No admin key
// is ever stored in a variable, a repository or a job.
//
// The calls are the ones the openvti starter kit makes (packages/vta-client/src/client.ts: authenticate,
// grantHandoff), in the document form OpenVTC's door checks (vti-trust-task-server/src/spine.rs).
// Node 18 or later, no dependencies. Prints DIDs (public) and outcomes; never a key, a token or a reply body.
import { createHash, createPrivateKey, createPublicKey, randomBytes, randomUUID, sign as edSign } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const SPEC = 'https://trusttasks.org/spec/'
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
export function base58 (bytes) {
  let n = BigInt('0x' + (Buffer.from(bytes).toString('hex') || '0')), out = ''
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n }
  for (const b of bytes) { if (b === 0) out = '1' + out; else break }
  return out
}
/** RFC 8785 canonical JSON, for the plain values these documents hold (strings, whole numbers, booleans, lists, objects). */
export const jcs = (v) => v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(jcs).join(',')}]` : `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${jcs(v[k])}`).join(',')}}`
const PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex') // the fixed head of an Ed25519 private key in PKCS#8
export function identity (seed) {
  const key = createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.from(seed)]), format: 'der', type: 'pkcs8' })
  const pub = createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32)
  const mk = 'z' + base58(Buffer.concat([Buffer.from([0xed, 0x01]), pub]))
  return { did: `did:key:${mk}`, vm: `did:key:${mk}#${mk}`, key }
}
export const instant = (t = Date.now()) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z') // whole seconds: see src/shared/trusttask.js
/** A signed Trust Task document: eddsa-jcs-2022 over SHA-256(JCS(proof options)) ‖ SHA-256(JCS(document)). */
export function signed (me, { type, recipient, payload }) {
  const doc = { id: `urn:uuid:${randomUUID()}`, type, issuer: me.did, recipient, issuedAt: instant(), payload }
  const cfg = { type: 'DataIntegrityProof', cryptosuite: 'eddsa-jcs-2022', created: doc.issuedAt, verificationMethod: me.vm, proofPurpose: 'authentication' }
  const h = (x) => createHash('sha256').update(jcs(x)).digest()
  return { ...doc, proof: { ...cfg, proofValue: 'z' + base58(edSign(null, Buffer.concat([h(cfg), h(doc)]), me.key)) } }
}
/** The grant a community's setup key needs: admin of its one context, for an hour, marked as a one-time hand-off. */
export const handoffEntry = (subject, context, now = Date.now()) => ({
  entry: { subject, role: 'admin', act: { scope: 'contexts', contexts: [context] }, keys: { scope: 'all' }, capabilities: { scope: 'ceiling' }, label: `${context} setup`, expiresAt: instant(now + 3600_000), ext: { 'org.openvtc.handoff': true } },
  reason: 'VTC setup hand-off',
})

async function call (base, me, vtaDid, family, payload, bearer) {
  const type = SPEC + family
  const res = await fetch(`${base.replace(/\/+$/, '')}/trust-tasks`, { method: 'POST', headers: { 'content-type': 'application/json', 'trust-task': type, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(signed(me, { type, recipient: vtaDid, payload })), signal: AbortSignal.timeout(30_000) })
  const text = await res.text()
  let reply = null; try { reply = JSON.parse(text) } catch {}
  if (reply?.type === `${type}#response`) return reply.payload ?? {}
  const code = String(reply?.payload?.code ?? `http-${res.status}`), reason = String(reply?.payload?.details?.reason ?? '')
  throw Object.assign(new Error(`${family}: ${code}${reason ? ` (${reason})` : ''}`), { code, reason })
}
const DID_KEY = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{40,50}$/

async function main ([cmd, ...a]) {
  if (cmd === 'keygen') { // keygen <file>: a fresh key, kept 0600; prints its DID
    const seed = randomBytes(32)
    writeFileSync(a[0], JSON.stringify({ seed: seed.toString('hex') }), { mode: 0o600 })
    return console.log(identity(seed).did)
  }
  const load = (file) => identity(Buffer.from(JSON.parse(readFileSync(file, 'utf8')).seed, 'hex'))
  if (cmd === 'did') return console.log(load(a[0]).did)
  if (cmd === 'wait-did') { // wait-did <url> <seconds>: the community's setup DID, once it serves it on the private network
    const until = Date.now() + Number(a[1] ?? 3600) * 1000
    for (;;) {
      try { const did = (await (await fetch(a[0], { signal: AbortSignal.timeout(5000) })).text()).trim(); if (DID_KEY.test(did)) return console.log(did) } catch {}
      if (Date.now() > until) throw new Error('the community did not offer its setup DID in time')
      await new Promise((r) => setTimeout(r, 5000))
    }
  }
  if (cmd === 'grant') { // grant <key file> <agent base url> <agent DID> <setup DID> <context>
    const [file, base, vtaDid, subject, context] = a
    if (!DID_KEY.test(subject ?? '')) throw new Error('the setup DID must be an Ed25519 did:key')
    const me = load(file)
    const ch = await call(base, me, vtaDid, 'auth/challenge/0.1', { subject: me.did })
    const auth = await call(base, me, vtaDid, 'auth/authenticate/0.3', { challenge: ch.challenge, sessionId: ch.sessionId })
    const token = auth?.tokens?.accessToken
    if (!token) throw new Error('auth/authenticate/0.3: no access token in the answer')
    try { await call(base, me, vtaDid, 'acl/grant/0.2', handoffEntry(subject, context), token) } catch (e) { if (!/conflict|exists/i.test(`${e.code} ${e.reason}`)) throw e; return console.log('the setup DID already holds an entry') }
    return console.log('hand-off granted')
  }
  throw new Error('usage: handoff.mjs keygen <file> | did <file> | wait-did <url> [seconds] | grant <key file> <base> <agent DID> <setup DID> <context>')
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2)).catch((e) => { console.error(`handoff: ${e.message}`); process.exit(1) })
