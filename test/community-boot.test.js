// Runs community/vta/entrypoint.sh and community/vtc/entrypoint.sh side by side with stand-in
// binaries (vta, vtc, curl, busybox), to check the boot-script hand-off the room chose: the VTC
// shows its setup DID, the VTA grants exactly that DID before it starts, the VTC then runs phase 2,
// and no planted passphrase or claim code reaches any output. Needs root, setpriv and a tmpfs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'

const can = (() => {
  try {
    if (process.getuid?.() !== 0) return false
    execFileSync('sh', ['-c', 'command -v setpriv && command -v jq && [ "$(stat -f -c %T /dev/shm)" = tmpfs ]'], { stdio: 'ignore' })
    return true
  } catch { return false }
})()

const SETUP_DID = 'did:key:z6MkTestTestTestTestTestTestTestTestTestTestTestTe'
const VTA_DID = 'did:webvh:QmTestScid:vta.inwove.org'

function stubs(W) {
  const bin = join(W, 'bin'); mkdirSync(bin); mkdirSync(join(W, 'srv')); chmodSync(join(W, 'srv'), 0o777)
  const put = (name, body) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755) }
  // Each stand-in records how it was called, as which uid, and whether a passphrase was in its env.
  const rec = `echo "$(basename "$0") $* uid=$(id -u) envhit=$(env | grep -c PASSPHRASE || true)" >> "${W}/seen"`
  put('vta', `${rec}
case "$*" in
  *"setup --from"*) cfg=$(sed -n 's/^config_path *= *"\\(.*\\)"/\\1/p' "$3"); echo "[secrets]" > "$cfg"; echo "SEEDSECRET-noise" ;;
  *"contexts create"*) echo "$*" > "${W}/srv/granted" ;;
  *) touch "${W}/srv/vta-running" ;;
esac`)
  put('vtc', `${rec}
case "$*" in
  *"--setup-key-out"*) printf '{"did":"${SETUP_DID}","private_key_mb":"zPRIVATE"}' > "$3" ;;
  *"setup --from"*) grep -q 'vta_did *= *"${VTA_DID}"' "$3" || exit 9
     printf 'vtc_did=did:webvh:QmCommunity:vtc.inwove.org\\nadmin_did=did:key:z6MkAdmin\\ninstall_url=https://vtc.inwove.org/install/CLAIMSECRET\\nclaim_code=CLAIMSECRET\\n' ;;
  *) touch "${W}/srv/vtc-running" ;;
esac`)
  // busybox httpd: "serve" by copying the file where the curl stand-in looks for it.
  put('busybox', `${rec}
dir=$(echo "$*" | sed -n 's/.*-h \\([^ ]*\\).*/\\1/p'); cp "$dir/setup-did" "${W}/srv/served-setup-did"; exec sleep 60`)
  put('curl', `url=$(for a in "$@"; do :; done; echo "$a")
case "$url" in
  */setup-did) [ -f "${W}/srv/served-setup-did" ] && cat "${W}/srv/served-setup-did" || exit 7 ;;
  */health) [ -f "${W}/srv/vta-running" ] || exit 7 ;;
  */did.jsonl) echo '{"versionId":"1","state":{"id":"${VTA_DID}"}}' ;;
  *) exit 7 ;;
esac`)
  return bin
}

function run(script, env) {
  return new Promise((res) => {
    const p = spawn('sh', [script], { env })
    let out = ''
    p.stdout.on('data', (d) => { out += d }); p.stderr.on('data', (d) => { out += d })
    p.on('close', (code) => res({ code, out }))
  })
}

test('boot scripts: the VTC shows its setup DID, the VTA grants it, phase 2 runs, nothing secret is printed', { skip: !can && 'needs root, setpriv, jq and a tmpfs /dev/shm' }, async () => {
  const W = mkdtempSync(join(tmpdir(), 'wpi-boot-')); chmodSync(W, 0o755)
  const tag = randomBytes(4).toString('hex')
  const creds = { vta: `/dev/shm/t-vta-${tag}`, vtc: `/dev/shm/t-vtc-${tag}` }
  try {
    const bin = stubs(W)
    writeFileSync(join(W, 'seen'), ''); chmodSync(join(W, 'seen'), 0o666)
    for (const d of ['vta', 'vtc']) mkdirSync(join(W, d))
    const FAKE_VTA = 'PLANTED-' + randomBytes(16).toString('hex'), FAKE_VTC = 'PLANTED-' + randomBytes(16).toString('hex')
    const base = {
      PATH: `${bin}:/usr/sbin:/usr/bin:/sbin:/bin`, VTA_WAIT_SECONDS: '60', VTC_WAIT_SECONDS: '60',
      VTA_DATA_DIR: join(W, 'vta'), VTA_CREDS_DIR: creds.vta, VTC_DATA_DIR: join(W, 'vtc'), VTC_CREDS_DIR: creds.vtc,
    }
    const [vtc, vta] = await Promise.all([
      run(resolve('community/vtc/entrypoint.sh'), { ...base, VTC_SECRETS_PASSPHRASE: FAKE_VTC }),
      run(resolve('community/vta/entrypoint.sh'), { ...base, VTA_SEED_PASSPHRASE: FAKE_VTA }),
    ])
    assert.equal(vta.code, 0, vta.out); assert.equal(vtc.code, 0, vtc.out)

    const granted = readFileSync(join(W, "srv", "granted"), 'utf8')
    assert.match(granted, new RegExp(`contexts create --id community .*--admin-did ${SETUP_DID} .*--admin-expires 1h --admin-handoff`))
    assert.ok(existsSync(join(W, "srv", "vta-running")) && existsSync(join(W, "srv", "vtc-running")))
    assert.match(vtc.out, /test community DID did:webvh:QmCommunity:vtc\.inwove\.org/)

    const seen = readFileSync(join(W, 'seen'), 'utf8').trim().split('\n')
    for (const line of seen) assert.match(line, /uid=10001 envhit=0$/, line)

    for (const o of [vta.out, vtc.out]) {
      for (const s of [FAKE_VTA, FAKE_VTC, 'CLAIMSECRET', 'SEEDSECRET', 'zPRIVATE']) assert.ok(!o.includes(s), `${s} printed`)
    }
    const files = (d) => readdirSync(d, { recursive: true }).map((f) => join(d, f))
    for (const f of [...files(join(W, 'vta')), ...files(join(W, 'vtc'))]) {
      try { const t = readFileSync(f, 'utf8'); assert.ok(!t.includes(FAKE_VTA) && !t.includes(FAKE_VTC), `passphrase on the volume: ${f}`) } catch (e) { if (e.code !== 'EISDIR') throw e }
    }
    assert.ok(!existsSync(join(W, 'vtc', 'setup-key.json')), 'the spent setup key is deleted')
    assert.match(readFileSync(join(W, 'vtc', 'install.out'), 'utf8'), /claim_code=CLAIMSECRET/)
    assert.ok(existsSync(join(W, 'vtc', '.initialised')) && existsSync(join(W, 'vta', '.granted')))
  } finally {
    try { execFileSync('pkill', ['-f', '^sleep 60$']) } catch {}
    rmSync(W, { recursive: true, force: true }); for (const c of Object.values(creds)) rmSync(c, { recursive: true, force: true })
  }
})

test('the VTA refuses anything but an Ed25519 did:key from the private network', { skip: !can && 'needs root, setpriv, jq and a tmpfs /dev/shm' }, async () => {
  const W = mkdtempSync(join(tmpdir(), 'wpi-boot-')); chmodSync(W, 0o755)
  const c = `/dev/shm/t-vta-${randomBytes(4).toString('hex')}`
  try {
    const bin = stubs(W)
    writeFileSync(join(W, 'seen'), ''); chmodSync(join(W, 'seen'), 0o666); mkdirSync(join(W, 'vta'))
    writeFileSync(join(W, "srv", "served-setup-did"), 'did:web:attacker.example\n')
    const r = await run(resolve('community/vta/entrypoint.sh'), {
      PATH: `${bin}:/usr/sbin:/usr/bin:/sbin:/bin`, VTA_WAIT_SECONDS: '5', VTA_DATA_DIR: join(W, 'vta'), VTA_CREDS_DIR: c,
      VTA_SEED_PASSPHRASE: 'PLANTED-' + randomBytes(16).toString('hex'),
    })
    assert.notEqual(r.code, 0)
    assert.match(r.out, /no valid setup did:key/)
    assert.ok(!existsSync(join(W, "srv", "granted")) && !existsSync(join(W, "srv", "vta-running")))
  } finally { rmSync(W, { recursive: true, force: true }); rmSync(c, { recursive: true, force: true }) }
})
