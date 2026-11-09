// The room's test host (community/): static checks of what its files say, against what the code they build was
// read to need. Nothing here starts a container: .github/workflows/community-images.yml builds and boots the real
// thing. The mediator's entrypoint is also run here, with stand-in binaries, under every shell on the machine.
// Each expectation names where it was read from in the pinned sources (see the projects shelf).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
  // vta-service/Cargo.toml: [[bin]] name = "vta" has required-features = ["cli-synthesis"]; `setup` gives `vta setup`.
  // These are pull request #117's lines, proven by a real build. No `tsp`, so the setup file must say tsp = false.
  assert.deepEqual(features('vta').sort(), ['cli-synthesis', 'didcomm', 'rest', 'setup', 'webvh'])
  assert.match(code(read('vta/Dockerfile')), /--bin vta --no-default-features/)
  assert.ok(!/^tsp\s+= true/m.test(read('vta/entrypoint.sh')), 'setup refuses tsp = true on a build without the feature')
  // vtc-service/Cargo.toml: there is no feature called encrypted-file; without `setup` the binary cannot set itself up
  const known = ['vetting-pcs', 'voting', 'tsp', 'test-support', 'transport-harness', 'setup', 'bbs', 'website', 'admin-ui', 'keyring', 'config-secret', 'aws-secrets', 'gcp-secrets', 'azure-secrets', 'k8s-secrets', 'vault-secrets', 'tpm']
  for (const x of features('vtc')) assert.ok(known.includes(x), `vtc-service has no feature "${x}"`)
  assert.deepEqual(features('vtc').sort(), ['setup', 'tsp', 'website'])
  assert.match(code(read('vtc/Dockerfile')), /-p vtc-service --bin vtc --no-default-features/)
  for (const f of ['vta', 'vtc']) for (const no of ['keyring', 'admin-ui']) assert.ok(!features(f).includes(no), `${f}: ${no}`)
})

test('the mediator is pinned to the version the pinned OpenVTC goes with, keeps its default features and ships its setup tool', () => {
  const d = read('mediator/Dockerfile')
  assert.match(d, /grep -Eqx '\[0-9a-f\]\{40\}'/) // a full 40-character commit, or the build stops
  assert.match(d, /NOT OpenVTC/)
  assert.ok(d.includes(`ARG MEDIATOR_SHA=${MEDIATOR}`))
  const c = code(d)
  assert.match(c, /cargo build --locked --release -p affinidi-messaging-mediator /) // default features: a store, DIDComm and TSP
  assert.ok(!/-p affinidi-messaging-mediator [^\n]*--no-default-features/.test(c), 'a mediator with no default features has no store and cannot start')
  assert.match(c, /-p affinidi-messaging-mediator-setup --no-default-features --features secrets-aws,publish-aws/) // upstream's own docker/mediator.Dockerfile
  assert.match(c, /build-essential/) // jemalloc, a default feature, builds with make and cc
  assert.ok(!/^USER /m.test(c), 'the entrypoint starts as root to fix the volume, then drops itself')
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

test('the mediator makes its own identity once, on a volume, and runs closed only', () => {
  const e = read('mediator/entrypoint.sh')
  for (const x of ['[deployment]', '[identity]', '[secrets]', '[security]', '[database]', '[output]', '[install]']) assert.ok(e.includes(x), x) // tools/mediator-setup/src/recipe.rs
  assert.match(e, /did_method = "did:webvh"/); assert.match(e, /use_vta = false/); assert.match(e, /enabled = false/)
  assert.match(e, /network_mode = "closed"/) // config_writer.rs:254-270: anything else, a typo included, writes ALLOW_ALL
  assert.match(e, /mediator-setup --from "\$T\/recipe\.toml" >\/dev\/null/) // its stdout carries the admin's private key
  assert.match(e, /exec \$AS mediator -c "\$CONFIG"/)
  // the four explicit values, each exported with a comment saying why (env.rs: the environment wins over the file)
  for (const v of ['MEDIATOR_ACL_MODE=explicit_allow', 'GLOBAL_DEFAULT_ACL=DENY_ALL,LOCAL,SEND_MESSAGES,RECEIVE_MESSAGES', 'ENABLE_INTER_MEDIATOR_RELAY=false', 'TRUST_TASK_VERIFICATION=enforce']) assert.match(e, new RegExp(`#[^\n]*\nexport ${v}\n`), v)
  assert.match(read('setup/setup.sh'), /ensure_volume mediator \/var\/lib\/mediator/)
})

// The mediator's entrypoint, run for real with stand-ins for the root-only tools and the two binaries. The stand-ins
// write what the setup tool writes at v0.50.0 (config_writer.rs: the [security] trio for `closed`, and
// trust_task_verification = "enforce"; main.rs: did.jsonl and admin-monitor.json beside the config).
const shells = ['sh', 'bash', 'dash'].filter((x) => spawnSync('sh', ['-c', `command -v ${x}`]).status === 0)
function mediatorRun (shell, env = {}, { plant = '' } = {}) {
  const w = mkdtempSync(join(tmpdir(), 'inwove-med-')), bin = join(w, 'bin'), data = join(w, 'data')
  spawnSync('mkdir', ['-p', bin, data])
  const stub = (name, body) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755) }
  stub('id', 'echo 0'); stub('chown', 'true')
  stub('setpriv', 'while [ $# -gt 0 ]; do case "$1" in --*) shift ;; *) break ;; esac; done; exec "$@"')
  stub('mediator-setup', `cfg=$(sed -n 's/^config_path = "\\(.*\\)"$/\\1/p' "$2"); d=$(dirname "$cfg")
printf '[server]\\nadmin_did = "did://did:key:z6MkGenerated"\\n# did_web_self_hosted = "file://./conf/did.jsonl"\\n[security]\\nmediator_acl_mode = "explicit_allow"\\nglobal_acl_default = "DENY_ALL,LOCAL,SEND_MESSAGES,RECEIVE_MESSAGES"\\ntrust_task_verification = "enforce"\\n# global_acl_default = "ALLOW_ALL" is what open writes\\n${plant}' > "$cfg"
echo '{"state":{"id":"did:webvh:QmTest:mediator.example.test"}}' > "$d/did.jsonl"; echo '{}' > "$d/admin-monitor.json"; echo '{}' > "$d/mediator-secrets.json"; echo '--' > "$d/atm-functions.lua"; echo 'private key on stdout'`)
  stub('mediator', 'echo "ran acl=$MEDIATOR_ACL_MODE default=$GLOBAL_DEFAULT_ACL relay=$ENABLE_INTER_MEDIATOR_RELAY tt=$TRUST_TASK_VERIFICATION admin=${ADMIN_DID-unset} self=$DID_WEB_SELF_HOSTED at=$LOCAL_ENDPOINTS args=$*"')
  const r = spawnSync(shell, ['community/mediator/entrypoint.sh'], { encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, MEDIATOR_DATA_DIR: data, DATABASE_URL: 'redis://redis.test:6379/', MEDIATOR_PUBLIC_URL: 'https://mediator.example.test', ...env } })
  const left = { adminProfile: existsSync(join(data, 'admin-monitor.json')), config: existsSync(join(data, 'mediator.toml')) }
  rmSync(w, { recursive: true, force: true })
  return { ...r, ...left }
}

test('the mediator starts closed, with the four values exported, under every shell here', { skip: shells.length ? false : 'no POSIX shell' }, () => {
  for (const sh of shells) {
    const r = mediatorRun(sh)
    assert.equal(r.status, 0, `${sh}: ${r.stderr}`)
    assert.match(r.stdout, /^ran acl=explicit_allow default=DENY_ALL,LOCAL,SEND_MESSAGES,RECEIVE_MESSAGES relay=false tt=enforce admin=unset self=file:\/\/[^ ]+\/did\.jsonl at=https:\/\/mediator\.example\.test args=-c [^ ]+mediator\.toml$/m, sh)
    assert.ok(!/private key/.test(r.stdout + r.stderr), `${sh}: the setup tool's stdout reached the output`)
    assert.equal(r.adminProfile, false, `${sh}: the admin profile (a copy of the admin key) was left on the volume`)
    assert.match(r.stderr, /mediator: closed \(acl_mode=explicit_allow [^)]*\); admin: generated at first boot/, sh) // the one line its log shows
  }
})

test('an admin made elsewhere is named by its DID only, and goes in through the mediator\'s own ADMIN_DID override', { skip: shells.length ? false : 'no POSIX shell' }, () => {
  const did = 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH'
  for (const sh of shells) {
    const r = mediatorRun(sh, { MEDIATOR_ADMIN_DID: did, ADMIN_DID: 'did://did:key:z6MkSomeoneElse' })
    assert.equal(r.status, 0, `${sh}: ${r.stderr}`)
    assert.match(r.stdout, new RegExp(`admin=did://${did} `), sh) // env.rs:67; src/server.rs:1424-1460 makes it the root admin each boot
    assert.match(r.stderr, new RegExp(`admin: ${did} \\(from MEDIATOR_ADMIN_DID`), sh)
    const plain = mediatorRun(sh, { ADMIN_DID: 'did://did:key:z6MkSomeoneElse' }) // a stray ADMIN_DID is not taken
    assert.match(plain.stdout, /admin=unset /, sh)
  }
})

test('the mediator refuses to start on every value that would open it, in the environment or the file', { skip: shells.length ? false : 'no POSIX shell' }, () => {
  const cases = [
    [{ MEDIATOR_NETWORK_MODE: 'open' }, /MEDIATOR_NETWORK_MODE=open writes global_acl_default = "ALLOW_ALL"/],
    [{ MEDIATOR_NETWORK_MODE: 'opne' }, /must be closed/],
    [{ GLOBAL_DEFAULT_ACL: 'ALLOW_ALL' }, /GLOBAL_DEFAULT_ACL is set to something other/],
    [{ GLOBAL_DEFAULT_ACL: 'DENY_ALL,LOCAL,SEND_MESSAGES,RECEIVE_MESSAGES,SEND_FORWARDED' }, /GLOBAL_DEFAULT_ACL is set to something other/],
    [{ MEDIATOR_ACL_MODE: 'explicit_deny' }, /MEDIATOR_ACL_MODE is set/],
    [{ ENABLE_INTER_MEDIATOR_RELAY: 'true' }, /ENABLE_INTER_MEDIATOR_RELAY is set/],
    [{ TRUST_TASK_VERIFICATION: 'warn' }, /TRUST_TASK_VERIFICATION is set/],
    [{ SOME_OTHER_SETTING: 'ALLOW_ALL' }, /environment grants ALLOW_ALL or SEND_FORWARDED/],
    [{ DIDCOMM_V1_ALLOW_UNAUTHENTICATED_FORWARDS: 'true' }, /allow_unauthenticated_forwards is on in the environment/],
    [{ MEDIATOR_ADMIN_DID: 'z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH' }, /must be a DID/],
    [{ MEDIATOR_ADMIN_DID: 'did:key:z6Mk with spaces' }, /must be a DID/],
    [{ MEDIATOR_ADMIN_DID: `did:key:z${'a'.repeat(600)}` }, /too long/],
    [{}, /allow_unauthenticated_forwards is on in/, '[didcomm_v1]\\nenabled = true\\nallow_unauthenticated_forwards = true\\n'],
    [{}, /grants ALLOW_ALL or SEND_FORWARDED/, '[processors.forwarding]\\nrelay_acl = "DENY_ALL,SEND_FORWARDED"\\n'],
  ]
  for (const sh of shells) {
    for (const [env, why, plant] of cases) {
      const r = mediatorRun(sh, env, { plant })
      const what = `${sh} ${JSON.stringify(env).slice(0, 80)} ${plant ?? ''}`
      assert.equal(r.status, 78, `${what}: exit ${r.status} ${r.stderr}`)
      assert.match(r.stderr, /mediator: refusing to start: /, what); assert.match(r.stderr, why, what)
      assert.ok(!/^ran /m.test(r.stdout), `${what}: the mediator ran`)
    }
  }
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
  assert.ok(!/location [=^~ ]+\/members/.test(live), 'no /members: the portal comes only with admin-ui (vtc-service/src/routes/mod.rs:1471-1477)')
  for (const l of live.split('\n').filter((x) => /location \^~/.test(x))) assert.match(l, /limit_except GET( POST)? \{ deny all; \}/, l) // a folder is read-only, but for the member sign-in calls
  for (const l of live.split('\n').filter((x) => /location \^~ \/(fonts|room-dids|group-dids|v1\/status-lists|mediator\/v1\/list)\//.test(x))) assert.match(l, /limit_except GET \{ deny all; \}/, l)
  const vta = /server_name vta\.inwove\.org;([\s\S]*?)\n}/.exec(live)[1]
  assert.deepEqual(vta.match(/location [^{]+/g).map((x) => x.trim()), ['location = /.well-known/did.jsonl', 'location /']) // the agent: its DID log and nothing else
})

test('Security\'s conditions on the mediator\'s address hold (block 11114)', () => {
  const live = code(read('proxy/nginx.conf.template'))
  const med = /server_name mediator\.inwove\.org;([\s\S]*?)\n}/.exec(live)[1]
  const line = (p) => med.split('\n').find((l) => l.includes(`location = ${p} `)) ?? ''
  assert.match(line('/mediator/v1/inbound'), /limit_except POST \{ deny all; \} client_max_body_size 96k; limit_req zone=mediator_in burst=5 nodelay;/)
  assert.match(line('/mediator/v1/ws'), /limit_except GET \{ deny all; \} limit_req zone=mediator_in burst=5 nodelay; limit_conn mediator_ws 5;/)
  assert.match(live, /limit_req_zone\s+\$binary_remote_addr zone=mediator_in:10m rate=2r\/s;/)
  assert.ok(!/^\s*client_max_body_size/m.test(med), 'no wider body cap for the whole mediator host than common.inc\'s 64k')
  for (const l of med.split('\n').filter((x) => /location /.test(x) && !/location \//.test(x))) assert.match(l, /limit_except (GET|POST|DELETE) \{ deny all; \}/, l) // one method per path
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
