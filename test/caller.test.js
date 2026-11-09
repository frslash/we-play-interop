// Who is calling (src/server/caller.js): which header may decide an address, and which never.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { config as baseConfig } from '../src/server/config.js'
import { callerOf } from '../src/server/caller.js'
import { createApp } from '../src/server/index.js'

const req = (headers = {}, socket = {}) => ({ headers, socket: { remoteAddress: '198.51.100.7', encrypted: false, ...socket } })
const FLY = { onFly: true, trustedClientIpHeader: '' }, NAMED = { onFly: false, trustedClientIpHeader: 'cf-connecting-ip' }, PLAIN = { onFly: false, trustedClientIpHeader: '' }

describe('callerOf', () => {
  test('on Fly: fly-client-ip and x-forwarded-proto, written by the platform proxy', () => {
    assert.deepEqual(callerOf(req({ 'fly-client-ip': '203.0.113.5', 'x-forwarded-proto': 'https' }), { env: FLY }), { ip: '203.0.113.5', https: true, trusted: true, source: 'fly' })
    assert.equal(callerOf(req({ 'fly-client-ip': '2001:db8::1', 'x-forwarded-proto': 'http' }), { env: FLY }).https, false)
  })
  test('on Fly, a forged x-forwarded-for / x-real-ip is ignored', () => {
    const c = callerOf(req({ 'fly-client-ip': '203.0.113.5', 'x-forwarded-for': '1.1.1.1, 2.2.2.2', 'x-real-ip': '3.3.3.3' }), { env: FLY })
    assert.equal(c.ip, '203.0.113.5'); assert.equal(c.trusted, true)
  })
  test('on Fly without fly-client-ip (the private network): the socket rules, and a forwarding header makes it untrusted', () => {
    assert.deepEqual(callerOf(req(), { env: FLY }), { ip: '198.51.100.7', https: false, trusted: true, source: 'socket' })
    const c = callerOf(req({ 'x-forwarded-for': '1.1.1.1', 'x-forwarded-proto': 'https' }), { env: FLY })
    assert.equal(c.ip, '198.51.100.7'); assert.equal(c.trusted, false); assert.equal(c.https, false)
    assert.equal(callerOf(req({ 'fly-client-ip': 'not an ip' }), { env: FLY }).trusted, false) // present but not an address: not believed
  })
  test('the named header: its value, https from the socket only, a list read from its end, a non-address is untrusted', () => {
    assert.deepEqual(callerOf(req({ 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-proto': 'https', 'x-forwarded-for': '9.9.9.9' }), { env: NAMED }), { ip: '203.0.113.9', https: false, trusted: true, source: 'header' })
    assert.equal(callerOf(req({ 'cf-connecting-ip': '203.0.113.9' }, { encrypted: true }), { env: NAMED }).https, true)
    assert.equal(callerOf(req({ 'cf-connecting-ip': '6.6.6.6, 203.0.113.10' }), { env: NAMED }).ip, '203.0.113.10')
    const bad = callerOf(req({ 'cf-connecting-ip': 'evil' }), { env: NAMED })
    assert.equal(bad.trusted, false); assert.equal(bad.source, 'header')
    assert.equal(callerOf(req(), { env: NAMED }).trusted, false) // the proxy's header missing: the socket's address is the proxy's
  })
  test('a header name that is not plain is ignored, with one console line', () => {
    const was = console.error, lines = []; console.error = (m) => lines.push(m)
    try { const c = callerOf(req({ 'x y': '1.2.3.4' }), { env: { onFly: false, trustedClientIpHeader: 'x y' } }); assert.equal(c.source, 'socket') } finally { console.error = was }
    assert.equal(lines.length <= 1, true)
  })
  test('no setting: the socket address; x-forwarded-for is never the answer; x-forwarded-proto is ignored', () => {
    assert.deepEqual(callerOf(req(), { env: PLAIN }), { ip: '198.51.100.7', https: false, trusted: true, source: 'socket' })
    assert.equal(callerOf(req({}, { encrypted: true }), { env: PLAIN }).https, true)
    for (const h of ['x-forwarded-for', 'forwarded', 'x-real-ip', 'fly-client-ip']) {
      const c = callerOf(req({ [h]: '1.1.1.1', 'x-forwarded-proto': 'https' }), { env: PLAIN })
      assert.equal(c.ip, '198.51.100.7', h); assert.equal(c.trusted, false, h); assert.equal(c.https, false, h)
    }
    assert.equal(callerOf(req({}, { remoteAddress: '::ffff:192.0.2.1' }), { env: PLAIN }).ip, '::ffff:192.0.2.1')
  })
})

describe('the door through createApp', () => {
  test('a forged x-forwarded-for does not choose the limit key: the socket address is limited', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wpi-caller-'))
    const config = { ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, githubToken: '', onFly: false, trustedClientIpHeader: '', weaverIntervalMinutes: 0, weaverQuietMinutes: 0, ratePerMinute: 1, publicUrl: 'https://interop.example', boardDataUrl: '', llm: { ...baseConfig.llm, apiKey: '' } }
    const ctx = await createApp(config, { awayGatherMs: 0, hostWelcomeMs: null })
    try {
      await new Promise((r) => ctx.server.listen(0, '127.0.0.1', r))
      const base = `http://127.0.0.1:${ctx.server.address().port}`
      const statuses = []
      for (let i = 0; i < 14; i++) statuses.push((await fetch(`${base}/trust-tasks`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `203.0.113.${i + 1}` }, body: '{}' })).status)
      assert.ok(statuses.includes(429), `limited by the socket address whatever the header says: ${statuses}`)
    } finally { await ctx.stop(); rmSync(dir, { recursive: true, force: true }) }
  })
})
