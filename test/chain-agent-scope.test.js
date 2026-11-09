// The chain verifier must accept what the room accepts from an agent: a resource under its note scope
// (SCOPE_OF), and an approve under its vote scope where agents may approve. The live room's log failed the
// export gate on exactly these (seq 1202-1210 resource, 1710 and 1725 approve).
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { TYPES, signedDocument } from '../src/shared/types.js'
import { verifyChain } from '../src/shared/chain.js'
import { config as baseConfig } from '../src/server/config.js'
import { createApp } from '../src/server/index.js'

describe('the chain verifier checks an agent\'s scope the way the room does', () => {
  test('a resource under note and an approve under vote verify; a resource without note never got in', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wpi-scope-'))
    const ctx = await createApp({ ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, agentApprovals: true, weaverIntervalMinutes: 0, weaverQuietMinutes: 0, ratePerMinute: 1000, publicUrl: 'https://interop.example', boardDataUrl: '', llm: { ...baseConfig.llm, apiKey: '' } }, { awayGatherMs: 0, hostWelcomeMs: null })
    try {
      await new Promise((r) => ctx.server.listen(0, r))
      const base = `http://localhost:${ctx.server.address().port}`
      const post = async (doc) => { const r = await fetch(`${base}/api/entries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(doc) }); return { status: r.status, body: await r.json() } }
      const send = (id, name, payload, extra) => post(signedDocument(id, { type: TYPES[name], payload, ...extra }))
      const exp = new Date(Date.now() + 86400000).toISOString()
      const a = newIdentity(), b = newIdentity(), agent = newIdentity(), quiet = newIdentity()
      assert.equal((await send(a, 'join', { name: 'Person A' })).status, 201)
      assert.equal((await send(b, 'join', { name: 'Person B' })).status, 201)
      const d = (await send(b, 'delegate', { delegate: agent.did, scope: ['note', 'vote'], label: 'B agent' }, { expiresAt: exp })).body.hash
      const as = { onBehalfOf: b.did, delegation: d }
      assert.equal((await send(agent, 'resource', { url: 'https://example.org/spec', title: 'A spec' }, as)).status, 201, 'the room takes a resource under note')
      const prop = (await send(a, 'propose', { kind: 'workspace-change', title: 'A change', change: { pr: 1, sha: 'a'.repeat(40) } })).body.hash
      assert.equal((await send(agent, 'approve', { proposal: prop, sha: 'a'.repeat(40) }, as)).status, 201, 'the room takes an agent\'s approve under vote')
      const dq = (await send(b, 'delegate', { delegate: quiet.did, scope: ['vote'], label: 'B voter' }, { expiresAt: exp })).body.hash
      assert.equal((await send(quiet, 'resource', { url: 'https://example.org/other', title: 'Other' }, { onBehalfOf: b.did, delegation: dq })).status, 403, 'and refuses one without note')

      const report = await verifyChain(ctx.log.entries)
      assert.deepEqual(report.problems, [])
      assert.equal(report.ok, true)
      assert.equal(report.signaturesNotChecked, 0)
    } finally {
      await ctx.stop(); rmSync(dir, { recursive: true, force: true })
    }
  })
})
