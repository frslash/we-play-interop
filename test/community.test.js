import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SHA = 'c6964c4612131089e1add0f47575894e1bd8a565'
const read = (p) => readFileSync(join('community', p), 'utf8')
const all = (dir = 'community') => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? all(p) : [p] })

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
  assert.ok(!read('vtc/Dockerfile').match(/features[^\n]*(keyring|admin-ui)/))
})

test('the mediator build refuses an empty or short commit and is labelled not OpenVTC', () => {
  const d = read('mediator/Dockerfile')
  assert.match(d, /test -n "\$MEDIATOR_SHA"/)
  assert.match(d, /NOT OpenVTC/)
})

test('the proxy is default-deny, caps bodies at 64 KB, and has no /admin or wildcard join path', () => {
  const c = read('proxy/nginx.conf.template')
  assert.equal((c.match(/location \/ \{ [^}]*return 404;/g) ?? []).length, 3)
  assert.match(read('proxy/common.inc'), /client_max_body_size 64k;/)
  assert.ok(!/admin/.test(c.replace(/#.*$/gm, '')))
  assert.ok(!/join-requests\*|members\/\*/.test(c))
  assert.ok(!/location\s+(~|\/members\/\s)/.test(c.replace(/\^~/g, '')))
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
  }
})

test('every Rust build uses 1.95 or newer (OpenVTC and the mediator ask for 1.95)', () => {
  for (const f of ['vta', 'vtc', 'mediator']) {
    const m = read(`${f}/Dockerfile`).match(/^FROM rust:1\.(\d+)/m)
    assert.ok(m && Number(m[1]) >= 95, f)
  }
})

test('features are ones the crates have at c6964c4, with no keyring, admin-ui or a made-up encrypted-file feature', () => {
  assert.match(read('vta/Dockerfile'), /ARG FEATURES="setup,rest,webvh"/)
  assert.match(read('vtc/Dockerfile'), /ARG FEATURES="setup,website"/)
  for (const f of ['vta', 'vtc']) assert.match(read(`${f}/Dockerfile`), /--no-default-features/)
})

test('the VTA seed store uses the flat encrypted_file shape and the VTC the encrypted-file table, both from a file', () => {
  const vta = read('vta/entrypoint.sh'), vtc = read('vtc/entrypoint.sh')
  assert.match(vta, /backend = "encrypted_file"\npath {4}= "\$DATA\/seed.enc"\nkek {5}= \{ source = "passphrase", file = /)
  assert.match(vtc, /backend = "encrypted-file"\n\n\[secrets.encrypted_file\]/)
  assert.ok(!/admin_did\s*=/.test(vta), 'no super-admin is seeded by the VTA')
})

test('the community is labelled a test, and names no person', () => {
  for (const p of all()) {
    const t = readFileSync(p, 'utf8')
    assert.ok(!/\b(Faolan|Emrys|Hyphy|Maximilian)\b/.test(t), p)
  }
  assert.match(read('README.md'), /test community on test keys/i)
  for (const f of ['vta', 'vtc']) assert.match(read(`${f}/Dockerfile`), /TEST COMMUNITY/)
})
