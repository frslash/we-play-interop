// Every release's page code at its own address (src/server/index.js, releaseOf and versioned): Cloudflare kept the page's
// code in browsers for 4 hours whatever the room said, so a deploy looked missing until a hard refresh. Now the page
// (always re-checked) points at /r/<fingerprint>/, which changes exactly when the code does and may be cached for good.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { config as baseConfig } from '../src/server/config.js'
import { createApp, releaseOf } from '../src/server/index.js'

const BOARD = { generated: '2026-11-09', projects: [], scenarios: [], runs: [] }

describe('a new release reaches browsers at once', () => {
  test('the page points at this release, re-checks itself, and each file of the release may be kept for good', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wpi-fresh-'))
    const ctx = await createApp({ ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, githubToken: '', weaverIntervalMinutes: 0, boardDataUrl: 'data:application/json,' + encodeURIComponent(JSON.stringify(BOARD)), llm: { ...baseConfig.llm, provider: 'openai', apiKey: '' } }, { openRoom: true, hostWelcomeMs: null })
    await new Promise((r) => ctx.server.listen(0, '127.0.0.1', r))
    try {
      const base = `http://127.0.0.1:${ctx.server.address().port}`
      const page = await fetch(`${base}/`), html = await page.text()
      assert.equal(page.headers.get('cache-control'), 'no-cache', 'the page is always re-checked')
      const rel = /src="\/r\/([0-9a-f]{12})\/app\.js"/.exec(html)?.[1]
      assert.ok(rel, 'its code loads from this release’s address')
      assert.ok(html.includes(`href="/r/${rel}/style.css"`))
      const json = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html)[1], map = JSON.parse(json).imports
      assert.equal(map['/shared/'], `/r/${rel}/shared/`); assert.equal(map['/loom.js'], `/r/${rel}/loom.js`)
      assert.equal(map['@noble/ed25519'], `/r/${rel}/vendor/ed25519/index.js`); assert.equal(map['@noble/hashes/'], `/r/${rel}/vendor/hashes/`)
      assert.ok(page.headers.get('content-security-policy').includes(`'sha256-${createHash('sha256').update(json).digest('base64')}'`), 'the page’s own rules still allow its import map')
      for (const p of ['app.js', 'shared/did.js', 'vendor/ed25519/index.js', 'style.css']) {
        const r = await fetch(`${base}/r/${rel}/${p}`)
        assert.equal(r.status, 200, p); assert.equal(r.headers.get('cache-control'), 'public, max-age=31536000, immutable', p)
      }
      assert.equal(await (await fetch(`${base}/r/${rel}/app.js`)).text(), readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'))
      const old = await fetch(`${base}/r/000000000000/app.js`)
      assert.equal(old.status, 200); assert.equal(old.headers.get('cache-control'), 'no-cache', 'an older release’s address answers with today’s files, re-checked')
      assert.equal((await fetch(`${base}/app.js`)).headers.get('cache-control'), 'no-cache')
      assert.equal((await fetch(`${base}/r/${rel}/../../src/server/config.js`)).status, 404, 'nothing outside the page’s folders')
    } finally { await ctx.stop(); rmSync(dir, { recursive: true, force: true }) }
  })

  test('the fingerprint changes exactly when a file the browser loads changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wpi-rel-'))
    try {
      writeFileSync(join(dir, 'a.js'), 'one'); writeFileSync(join(dir, 'notes.txt'), 'x')
      const first = releaseOf([dir], dir)
      assert.match(first, /^[0-9a-f]{12}$/)
      assert.equal(releaseOf([dir], dir), first, 'the same files, the same fingerprint')
      writeFileSync(join(dir, 'notes.txt'), 'y')
      assert.equal(releaseOf([dir], dir), first, 'a file the browser never loads does not count')
      writeFileSync(join(dir, 'a.js'), 'two')
      assert.notEqual(releaseOf([dir], dir), first)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
