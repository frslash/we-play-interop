import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const read = (p) => readFileSync(p, 'utf8')
const HASH = 'a'.repeat(64)

// Runs an entrypoint far enough to hit its first-run checks. They come before any root-only step,
// so a refusal here proves no admin key could have been made.
function start (svc, env, setup) {
  const dir = mkdtempSync(join(tmpdir(), `wpi-${svc}-`))
  try {
    if (setup !== undefined) writeFileSync(join(dir, 'setup.toml'), setup)
    const pass = 'x'.repeat(32)
    const r = spawnSync('sh', [`community/${svc}/entrypoint.sh`], {
      env: { PATH: process.env.PATH, VTA_SEED_PASSPHRASE: pass, VTC_SECRETS_PASSPHRASE: pass, VTA_DATA_DIR: dir, VTC_DATA_DIR: dir, VTA_CREDS_DIR: join(dir, 'creds'), VTC_CREDS_DIR: join(dir, 'creds'), ...env },
      encoding: 'utf8'
    })
    return { code: r.status, err: r.stderr }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
const GOOD = 'vtc_name = "We Play Interop community (TEST, test keys)"\nvtc_description = "A test community. Its keys are test keys."\n'

test('no first admin on either service without the access line in the log', () => {
  for (const svc of ['vta', 'vtc']) {
    for (const v of [undefined, '', 'not-a-hash', 'A'.repeat(64)]) {
      const r = start(svc, v === undefined ? {} : { ROOM_ACCESS_LINE: v }, GOOD)
      assert.equal(r.code, 78, `${svc} with ${v}`)
      assert.match(r.err, /ROOM_ACCESS_LINE/)
    }
  }
})

test('the VTC refuses a first setup that does not call itself a test on test keys', () => {
  const env = { ROOM_ACCESS_LINE: HASH }
  assert.match(start('vtc', env, 'vtc_name = "We Play Interop"\nvtc_description = "test keys"\n').err, /vtc_name must say TEST/)
  assert.match(start('vtc', env, 'vtc_name = "X (TEST)"\nvtc_description = "A community."\n').err, /test keys/)
  assert.match(start('vtc', env, undefined).err, /no .*setup\.toml/)
})

test('with the access line and the test name, the checks pass on to the next step', () => {
  // As a non-root user the next step refuses for want of root; as root it fails on the tmpfs or the
  // missing binary. Either way it is past the marking checks.
  for (const svc of ['vta', 'vtc']) {
    const r = start(svc, { ROOM_ACCESS_LINE: HASH, VTA_ADMIN_DID: 'did:key:zTEST' }, svc === 'vtc' ? GOOD : undefined)
    assert.doesNotMatch(r.err, /ROOM_ACCESS_LINE|must say/, svc)
  }
})

test('the VTA names itself a test', () => {
  assert.match(read('community/vta/entrypoint.sh'), /^vta_name\s+= "[^"]*TEST, test keys\)"$/m)
})

test('the join page and every answer say it is a test community', () => {
  const conf = read('community/proxy/nginx.conf.template')
  const members = conf.match(/location = \/members\/\s+\{[\s\S]*?\n  \}/)[0]
  assert.match(members, /sub_filter '<\/head>' '<style>[^']*TEST community on test keys/)
  assert.match(members, /limit_except GET \{ deny all; \}/)
  // a location-level proxy_set_header drops the inherited ones, so Host and X-Forwarded-For are repeated
  assert.match(members, /proxy_set_header Host \$host;/)
  assert.match(members, /proxy_set_header X-Forwarded-For \$remote_addr;/)
  assert.match(read('community/proxy/common.inc'), /^add_header X-Community-Status "test community, test keys" always;$/m)
  assert.ok(!/add_header/.test(conf), 'no location add_header that would drop the shared one')
})

test('no names are written into the access list', () => {
  const doc = read('docs/community-test-marking.md')
  assert.match(doc, /No names\s+are written here/)
  assert.match(doc, /c6964c4612131089e1add0f47575894e1bd8a565/)
})
