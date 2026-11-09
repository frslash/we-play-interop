// The chain verifier must accept what the room accepts from an agent, and nothing more: a resource under the
// agent's note scope (SCOPE_OF), and an approve under its vote scope only where the room lets agents approve
// (src/server/log.js). The live room's log failed the export gate on exactly these entries (resources and two
// agents' approves), because the verifier checked the literal type name.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { sign } from '../src/shared/proof.js'
import { TYPES, signedDocument } from '../src/shared/types.js'
import { hashCore, verifyChain } from '../src/shared/chain.js'
import { config as baseConfig } from '../src/server/config.js'
import { checkExport, makeExport } from '../src/server/export.js'
import { createApp } from '../src/server/index.js'

const exp = () => new Date(Date.now() + 86400000).toISOString()

// A hand-built chain, witnessed by a workspace key, so the verifier can be shown entries the room would refuse.
function forge () {
  const ws = newIdentity(), entries = []
  const add = (document) => {
    const prev = entries.at(-1)
    const core = { seq: entries.length, parent: prev ? prev.hash : null, timestamp: new Date().toISOString(), author: document.issuer, onBehalfOf: document.onBehalfOf ?? document.issuer, ...(document.delegation ? { delegation: document.delegation } : {}), type: document.type, document }
    const witness = sign(core, { seed: ws.seed, verificationMethod: ws.verificationMethod, created: core.timestamp, proofPurpose: 'assertionMethod' }).proof
    const entry = { ...core, hash: hashCore(core), witness }
    entries.push(entry)
    return entry
  }
  add(signedDocument(ws, { type: TYPES.genesis, payload: { name: 'Forged room' } }))
  return { entries, add }
}

describe('the chain verifier checks an agent\'s scope the way the room does', () => {
  test('a room that lets agents approve: its resource and approve verify only when the verifier is told so', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wpi-scope-'))
    const ctx = await createApp({ ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, agentApprovals: true, weaverIntervalMinutes: 0, weaverQuietMinutes: 0, ratePerMinute: 1000, publicUrl: 'https://interop.example', boardDataUrl: '', llm: { ...baseConfig.llm, apiKey: '' } }, { awayGatherMs: 0, hostWelcomeMs: null })
    try {
      await new Promise((r) => ctx.server.listen(0, r))
      const base = `http://localhost:${ctx.server.address().port}`
      const post = async (doc) => { const r = await fetch(`${base}/api/entries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(doc) }); return { status: r.status, body: await r.json() } }
      const send = (id, name, payload, extra) => post(signedDocument(id, { type: TYPES[name], payload, ...extra }))
      const a = newIdentity(), b = newIdentity(), agent = newIdentity(), quiet = newIdentity()
      assert.equal((await send(a, 'join', { name: 'Person A' })).status, 201)
      assert.equal((await send(b, 'join', { name: 'Person B' })).status, 201)
      const d = (await send(b, 'delegate', { delegate: agent.did, scope: ['note', 'vote'], label: 'B agent' }, { expiresAt: exp() })).body.hash
      const as = { onBehalfOf: b.did, delegation: d }
      assert.equal((await send(agent, 'resource', { url: 'https://example.org/spec', title: 'A spec' }, as)).status, 201, 'the room takes a resource under note')
      const prop = (await send(a, 'propose', { kind: 'workspace-change', title: 'A change', change: { pr: 1, sha: 'a'.repeat(40) } })).body.hash
      const approve = await send(agent, 'approve', { proposal: prop, sha: 'a'.repeat(40) }, as)
      assert.equal(approve.status, 201, 'the room takes an agent\'s approve under vote')
      const dq = (await send(b, 'delegate', { delegate: quiet.did, scope: ['vote'], label: 'B voter' }, { expiresAt: exp() })).body.hash
      assert.equal((await send(quiet, 'resource', { url: 'https://example.org/other', title: 'Other' }, { onBehalfOf: b.did, delegation: dq })).status, 403, 'and refuses one without note')

      const yes = await verifyChain(ctx.log.entries, { agentsMayApprove: true })
      assert.deepEqual(yes.problems, [])
      assert.equal(yes.ok, true)
      assert.equal(yes.signaturesNotChecked, 0)
      assert.equal((await ctx.log.verify()).ok, true, 'the room verifies its own log with its own setting')

      // The same log, read by a verifier that was not told agents may approve: the approve fails, the resource does not.
      const no = await verifyChain(ctx.log.entries)
      assert.equal(no.ok, false)
      assert.deepEqual(no.problems.map((p) => p.seq), [approve.body.seq])
      assert.match(no.problems[0].problem, /does not let agents approve/)

      // The export gate follows the same switch.
      const doc = makeExport(ctx.log.entries)
      assert.equal((await checkExport(JSON.parse(JSON.stringify(doc)))).ok, false)
      assert.equal((await checkExport(JSON.parse(JSON.stringify(doc)), { agentsMayApprove: true })).ok, true)
    } finally {
      await ctx.stop(); rmSync(dir, { recursive: true, force: true })
    }
  })

  test('entries the room would refuse still fail: a resource without note, an approve without vote', async () => {
    const { entries, add } = forge()
    const b = newIdentity(), agent = newIdentity()
    add(signedDocument(b, { type: TYPES.join, payload: { name: 'Person B' } }))
    const onlyVote = add(signedDocument(b, { type: TYPES.delegate, payload: { delegate: agent.did, scope: ['vote'], label: 'voter' }, expiresAt: exp() }))
    const onlyNote = add(signedDocument(b, { type: TYPES.delegate, payload: { delegate: agent.did, scope: ['note', 'approve'], label: 'noter' }, expiresAt: exp() }))
    const res = add(signedDocument(agent, { type: TYPES.resource, payload: { url: 'https://example.org/x', title: 'X' }, onBehalfOf: b.did, delegation: onlyVote.hash }))
    const appr = add(signedDocument(agent, { type: TYPES.approve, payload: { proposal: 'f'.repeat(64), sha: 'a'.repeat(40) }, onBehalfOf: b.did, delegation: onlyNote.hash }))
    const ok = add(signedDocument(agent, { type: TYPES.resource, payload: { url: 'https://example.org/y', title: 'Y' }, onBehalfOf: b.did, delegation: onlyNote.hash }))

    const r = await verifyChain(entries, { agentsMayApprove: true })
    assert.equal(r.ok, false)
    const bySeq = Object.fromEntries(r.problems.map((p) => [p.seq, p.problem]))
    assert.match(bySeq[res.seq], /does not cover resource/, 'a resource needs note; vote does not cover it')
    assert.match(bySeq[appr.seq], /does not cover approve/, 'where agents may approve, an approve needs vote, not a scope named approve')
    assert.equal(bySeq[ok.seq], undefined, 'a resource under note verifies')
    assert.equal(r.problems.length, 2)

    const strict = Object.fromEntries((await verifyChain(entries)).problems.map((p) => [p.seq, p.problem]))
    assert.match(strict[res.seq], /does not cover resource/, 'with the switch off too')
    assert.match(strict[appr.seq], /does not let agents approve/, 'and with it off, no scope lets an agent approve')
  })
})
