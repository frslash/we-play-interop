// The room's test host (community/): static checks of what its files say, against what the code they build was
// read to need. Nothing here starts a container: .github/workflows/community-stack.yml builds and boots the real
// thing. Each expectation names where it was read from in the pinned sources (see the projects shelf).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { handoffEntry, identity, jcs, signed } from '../community/vta/handoff.mjs'
import { canonicalize } from '../src/shared/crypto.js'
import { multikeyToEd25519, newIdentity, resolveDidKey } from '../src/shared/did.js'
import { verifySignature } from '../src/shared/proof.js'

const SHA = 'c6964c4612131089e1add0f47575894e1bd8a565'
const MEDIATOR = '34bbdea4717e3a8dd1fdb190ad9c2ad2b33a3316' // v0.50.0: what the pinned OpenVTC's own Cargo.toml says it goes with
const read = (p) => readFileSync(join('community', p), 'utf8')
const code = (t) => t.replace(/^\s*#.*$/gm, '') // without comment lines
const all = (dir = 'community') => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? all(p) : [p] })
const features = (f) => /^ARG FEATURES="([^"]*)"/m.exec(read(`${f}/Dockerfile`))[1].split(',')

test('every base image is pinned by digest', () => {
  for (const f of ['vta', 'vtc', 'mediator', 'proxy']) {
    const froms = read(`${f}/Dockerfile`).split('\n').filter((l) => l.startsWith('FROM '))
    assert.ok(froms.length > 0)
    for (const l of froms) assert.match(l, /@sha256:[0-9a-f]{64}/, `${f}: ${l}`)
  }
})

test('OpenVTC is fetched at the full pinned commit and the hash is checked', () => {
  for (const f of ['vta', 'vtc']) {
    const d = read(`${f}/Dockerfile`)
    assert.ok(d.includes(`ARG VTI_SHA=${SHA}`))
    assert.match(d, /rev-parse HEAD\)" = "\$VTI_SHA"/)
    assert.match(d, /cargo build --locked/)
  }
})

test('each service is built with features that exist, and the ones its binary and setup need', () => {
  // vta-service/Cargo.toml: [[bin]] name = "vta" has required-features = ["cli-synthesis"]; `setup` gives `vta setup`
  assert.deepEqual(features('vta').sort(), ['cli-synthesis', 'didcomm', 'rest', 'setup', 'tsp', 'webvh'])
  assert.match(code(read('vta/Dockerfile')), /--package vta-service --no-default-features/)
  // vtc-service/Cargo.toml: there is no feature called encrypted-file; without `setup` the binary cannot set itself up
  const known = ['vetting-pcs', 'voting', 'tsp', 'test-support', 'transport-harness', 'setup', 'bbs', 'website', 'admin-ui', 'keyring', 'config-secret', 'aws-secrets', 'gcp-secrets', 'azure-secrets', 'k8s-secrets', 'vault-secrets', 'tpm']
  for (const x of features('vtc')) assert.ok(known.includes(x), `vtc-service has no feature "${x}"`)
  assert.deepEqual(features('vtc').sort(), ['setup', 'tsp', 'website'])
  assert.match(code(read('vtc/Dockerfile')), /--package vtc-service --no-default-features/)
  for (const f of ['vta', 'vtc']) for (const no of ['keyring', 'admin-ui']) assert.ok(!features(f).includes(no), `${f}: ${no}`)
})

test('the mediator is pinned to the version the pinned OpenVTC goes with, keeps its default features and ships its setup tool', () => {
  const d = read('mediator/Dockerfile')
  assert.match(d, /test -n "\$MEDIATOR_SHA"/)
  assert.match(d, /NOT OpenVTC/)
  assert.ok(d.includes(`ARG MEDIATOR_SHA=${MEDIATOR}`))
  const c = code(d)
  assert.match(c, /cargo build --locked --release -p affinidi-messaging-mediator /) // default features: a store, DIDComm and TSP
  assert.ok(!/-p affinidi-messaging-mediator [^\n]*--no-default-features/.test(c), 'a mediator with no default features has no store and cannot start')
  assert.match(c, /-p affinidi-messaging-mediator-setup/)
  assert.match(c, /target\/release\/mediator \/usr\/local\/bin\/mediator/) // the binary is called mediator
  assert.match(c, /target\/release\/mediator-setup/)
})

test('the trust agent sets itself up with a DID of its own, an encrypted seed and a one-use helper for the hand-off', () => {
  const e = read('vta/entrypoint.sh')
  assert.match(e, /\[vta_did\]\nkind = "create_webvh"/) // docs/02-vta/non-interactive-setup.md: without a DID the agent refuses to start
  assert.match(e, /\[secrets\]\nbackend = "encrypted_file"\npath    = [^\n]*\nkek     = \{ source = "passphrase", file = /) // in a setup file the fields sit in [secrets]
  assert.ok(!/\[secrets\.encrypted_file\]/.test(code(e)))
  assert.match(e, /\[\[staff\]\]\ndid     = "\$BOOT_DID"\ncontext = "\$CONTEXT"/)
  assert.match(e, /vta setup --from /)
  assert.match(e, /exec \$AS vta --config "\$CONFIG"/)
  assert.match(e, /rm -f "\$DATA\/bootstrap\.json"/) // the helper's key does not outlive its one use
  assert.match(e, /public_url       = "\$REST_URL"/) // its REST door is the private address, never the proxy
})

test('the community runs the two-phase setup, keeps its first-run output off the logs, and names its config', () => {
  const e = read('vtc/entrypoint.sh')
  assert.match(e, /vtc setup --setup-key-out "\$KEY" --context "\$CONTEXT"/)
  assert.match(e, /vtc setup --from "\$CREDS\/vtc-setup\.toml" > "\$DATA\/first-run\.out" 2>\/dev\/null/)
  assert.match(e, /\[secrets\]\nbackend = "encrypted-file"\n\n\[secrets\.encrypted_file\]/) // the community's spelling differs from the agent's
  for (const k of ['config_path', 'base_url', 'vta_did', 'context', 'setup_key_file']) assert.match(e, new RegExp(`^${k}\\s+= `, 'm'), k)
  assert.match(e, /export VTC_CONFIG_PATH="\$CONFIG"/) // vtc-service/src/config.rs: --config, else VTC_CONFIG_PATH, else ./config.toml
  assert.match(e, /exec \$AS vtc --config "\$CONFIG"/)
})

test('the mediator makes its own identity once, on a volume, and its network mode is a stated choice', () => {
  const e = read('mediator/entrypoint.sh')
  for (const s of ['[deployment]', '[identity]', '[secrets]', '[security]', '[database]', '[output]', '[install]']) assert.ok(e.includes(s), s) // tools/mediator-setup/src/recipe.rs
  assert.match(e, /did_method = "did:webvh"/); assert.match(e, /use_vta = false/); assert.match(e, /enabled = false/)
  assert.match(e, /MODE="\$\{MEDIATOR_NETWORK_MODE:-closed\}"/)
  assert.match(e, /mediator-setup --from "\$T\/recipe\.toml" >\/dev\/null/)
  assert.match(e, /exec \$AS mediator -c "\$CONFIG"/)
  assert.match(read('setup/setup.sh'), /ensure_volume mediator \/var\/lib\/mediator/)
})

test('the proxy is default-deny, caps bodies, forwards the document door and has no console or made-up path', () => {
  const c = read('proxy/nginx.conf.template'), live = code(c)
  assert.equal((c.match(/location \/ \{ [^}]*return 404;/g) ?? []).length, 3)
  assert.match(read('proxy/common.inc'), /client_max_body_size 64k;/)
  assert.ok(!/admin/.test(live))
  assert.ok(!/location\s+~/.test(live.replace(/\^~/g, ''))) // no pattern matching: exact paths, or a named folder
  assert.match(live, /location = \/v1\/trust-tasks\s+\{ limit_except POST \{ deny all; \}/) // the community's one door for documents
  assert.ok(!/join-requests/.test(live), 'the community has no /v1/join-requests route: a join is a document sent to the door')
  assert.ok(!/did-witness/.test(live))
  for (const l of live.split('\n').filter((x) => /location \^~/.test(x))) assert.match(l, /limit_except GET( POST)? \{ deny all; \}/, l) // a folder is read-only, but for the member portal's own calls
  for (const l of live.split('\n').filter((x) => /location \^~ \/(members|fonts|room-dids|group-dids|v1\/status-lists|mediator\/v1\/list)\//.test(x))) assert.match(l, /limit_except GET \{ deny all; \}/, l)
  const vta = /server_name vta\.inwove\.org;([\s\S]*?)\n}/.exec(live)[1]
  assert.deepEqual(vta.match(/location [^{]+/g).map((x) => x.trim()), ['location = /.well-known/did.jsonl', 'location /']) // the agent: its DID log and nothing else
})

test('no key, seed, passphrase or claim URL is written in the repo or printed by an entrypoint', () => {
  for (const p of all()) {
    const t = readFileSync(p, 'utf8')
    assert.ok(!/(PRIVATE KEY|z3u2[1-9A-HJ-NP-Za-km-z]{20,}|SIGN_IN_URL=|https:\/\/[^\s]*claim)/.test(t), p)
  }
  for (const f of ['vta', 'vtc']) {
    const e = read(`${f}/entrypoint.sh`)
    assert.match(e, />\/dev\/null 2>&1/)
    assert.ok(!/echo[^\n]*(PASSPHRASE|SEED)\}?\s*["']?\s*$/m.test(e.replace(/\$\{[A-Z_]+:\?[^}]*\}/g, '')))
    assert.match(e, /umask 077/)
    assert.match(e, /env -u V(TA_SEED|TC_SECRETS)_PASSPHRASE setpriv --reuid=10001/)
  }
})

test('the hand-off helper signs what the trust agent checks: the same DID, canonical JSON and proof as the room\'s own code', () => {
  const seed = new Uint8Array(32).fill(7), me = identity(seed), room = newIdentity(seed)
  assert.equal(me.did, room.did); assert.equal(me.vm, room.verificationMethod)
  const subject = 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH'
  const doc = signed(me, { type: 'https://trusttasks.org/spec/acl/grant/0.2', recipient: 'did:webvh:QmTest:vta.example', payload: handoffEntry(subject, 'vtc', Date.parse('2026-11-09T12:00:00Z')) })
  assert.equal(jcs(doc), canonicalize(doc))
  assert.equal(verifySignature(doc, multikeyToEd25519(resolveDidKey(me.did).verificationMethod[0].publicKeyMultibase)).ok, true)
  assert.match(doc.issuedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/); assert.match(doc.id, /^urn:uuid:/); assert.equal(doc.proof.proofPurpose, 'authentication')
  // the entry the openvti starter kit sends (packages/vta-client/src/client.ts, grantHandoff): one context, one hour, marked as a hand-off
  assert.deepEqual(doc.payload, { entry: { subject, role: 'admin', act: { scope: 'contexts', contexts: ['vtc'] }, keys: { scope: 'all' }, capabilities: { scope: 'ceiling' }, label: 'vtc setup', expiresAt: '2026-11-09T13:00:00Z', ext: { 'org.openvtc.handoff': true } }, reason: 'VTC setup hand-off' })
})
