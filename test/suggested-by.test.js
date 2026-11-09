// Step 41344731: the weaver's decision line names the person an agent acts for, and says "suggested" when that agent
// can't decide for the step's own person. Eli (Anton's agent) answering on Maximilian's step reads
// "Suggested by Eli (for Anton)", never "Decided by Eli for Maximilian"; the step keeps waiting.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { NAME_OF, TYPES, signedDocument } from '../src/shared/types.js'
import { config as baseConfig } from '../src/server/config.js'
import { branchOf } from '../src/server/builder.js'
import { byWhom, mayDecide } from '../src/server/facilitator.js'
import { createApp } from '../src/server/index.js'
import { createResolver } from '../src/server/resolver.js'
import { closeVotes } from '../src/server/votes.js'

const BOARD = { generated: new Date().toISOString().slice(0, 10), projects: [], scenarios: [], runs: [] }
const FIRE = 'https://api.anthropic.com/v1/claude_code/routines/trig_builder_1/fire'
const MIN = 60_000
const CARRIER = 'Which carrier the room tests first, TSP or DIDComm'

async function room () {
  const dir = mkdtempSync(join(tmpdir(), 'wpi-suggested-'))
  const pulls = []
  const gh = async (method, path) => (method === 'GET' && path.includes('/pulls?') ? pulls : {})
  const config = { ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, githubToken: '', weaverIntervalMinutes: 0, weaverQuietMinutes: 0, ratePerMinute: 1000, voteMinutes: 10, workspaceRepo: 'example/room', publicUrl: 'https://interop.example', boardDataUrl: 'data:application/json,' + encodeURIComponent(JSON.stringify(BOARD)), llm: { ...baseConfig.llm, provider: 'openai', apiKey: '' } }
  const ctx = await createApp(config, { resolver: createResolver(), hostWelcomeMs: null, wakeFetch: async () => ({ ok: true, status: 200 }), gh })
  await new Promise((r) => ctx.server.listen(0, r))
  const base = `http://localhost:${ctx.server.address().port}`
  await ctx.board.refresh()
  const send = async (id, name, payload, extra) => { const r = await fetch(`${base}/api/entries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signedDocument(id, { type: TYPES[name], payload, ...extra })) }); return { status: r.status, body: await r.json() } }
  const exp = new Date(Date.now() + 86400000).toISOString()
  const max = newIdentity(), anton = newIdentity(), cara = newIdentity(), eli = newIdentity(), maxAgent = newIdentity()
  await send(max, 'join', { name: 'Maximilian' }); await send(anton, 'join', { name: 'Anton' }); await send(cara, 'join', { name: 'Cara' })
  const eliDel = (await send(anton, 'delegate', { delegate: eli.did, scope: ['note', 'propose', 'vote'], label: 'Eli' }, { expiresAt: exp })).body.hash
  const maxDel = (await send(max, 'delegate', { delegate: maxAgent.did, scope: ['note', 'propose', 'vote'], label: 'Emrys' }, { expiresAt: exp })).body.hash
  // the builder is Maximilian's: a step it has is Maximilian's step
  const builder = (await send(max, 'host', { label: "Maximilian's builder" })).body.hosted.did
  await send(max, 'delegate', { delegate: builder, scope: ['note', 'propose'], label: "Maximilian's builder" }, { expiresAt: exp })
  await ctx.waker.set(builder, `${FIRE}#token=secret-token`, ['direct', 'mention'])
  const asEli = (name, payload, extra) => send(eli, name, payload, { onBehalfOf: anton.did, delegation: eliDel, ...extra })
  const asEmrys = (name, payload, extra) => send(maxAgent, name, payload, { onBehalfOf: max.did, delegation: maxDel, ...extra })
  await ctx.facilitator.tick()
  const at = (m) => Date.now() + m * MIN
  const st = () => ctx.log.state
  const said = (what) => ctx.log.entries.filter((e) => NAME_OF[e.type] === 'note' && e.document.payload.facilitator?.what === what).map((e) => e.document.payload.text)
  const stepFrom = (h) => [...st().steps.values(), ...st().stepsDone].find((s) => s.from === h)
  const stop = async () => { await ctx.stop(); rmSync(dir, { recursive: true, force: true }) }
  // an agreement for the builder (proposed by Eli, for Anton), blocked on an open choice
  const f = ctx.facilitator
  const pr = (await asEli('propose', { kind: 'other', title: 'Run the carrier test', body: "Owner: Maximilian's builder. Check: the Steps tab shows it." })).body.hash
  await send(cara, 'vote', { proposal: pr, choice: 'for' })
  await closeVotes(ctx, at(11), { max: 10 })
  await f.tick(at(11)); await f.tick(at(12))
  const s = stepFrom(pr)
  pulls.push({ number: 40, title: 'Blocked: Run the carrier test', body: `Needs: ${CARRIER}?\nWhy: it needs a choice.\nFrom: any agent here`, html_url: 'https://github.com/example/room/pull/40', head: { ref: branchOf(s), sha: 'e'.repeat(40) } })
  await f.tick(at(15)); await f.tick(at(16))
  return { ctx, f, st, said, stepFrom, pr, at, asEli, asEmrys, send, max, anton, cara, eli, maxAgent, builder, stop }
}

describe('the decision line names who an agent acts for', () => {
  test('byWhom: an agent with its person in brackets; a person by name, and for whom when someone else', async () => {
    const r = await room()
    try {
      assert.equal(byWhom(r.st(), r.eli.did, r.max.did), 'Eli (for Anton)', 'never "Eli for Maximilian"')
      assert.equal(byWhom(r.st(), r.cara.did, r.max.did), 'Cara for Maximilian')
      assert.equal(byWhom(r.st(), r.max.did, r.max.did), 'Maximilian')
    } finally { await r.stop() }
  })

  test('Eli’s line on Maximilian’s step shows as “suggested by Eli (for Anton)”, not “decided by Eli for Maximilian”; Maximilian’s own agent decides it', async () => {
    const r = await room()
    try {
      let s = r.stepFrom(r.pr)
      assert.equal(s.owner, r.builder); assert.ok(s.waitingOn); assert.equal(s.waitingOn.held, undefined)
      assert.equal(mayDecide(r.st(), r.eli.did, s), false, 'Eli acts for Anton, not for the step’s own person')
      await r.asEli('note', { text: 'TSP first, because RLTP already carries it.', kind: 'message' }, { threadId: s.thread })
      await r.f.tick(r.at(17))
      s = r.stepFrom(r.pr)
      assert.ok(s.waitingOn, 'still waiting: a suggestion settles nothing')
      assert.equal(r.said('decided').length, 0)
      const line = r.said('suggested').at(-1)
      assert.match(line, /^Suggested by Eli \(for Anton\)/)
      assert.match(line.toLowerCase(), /suggested by eli \(for anton\)/)
      assert.doesNotMatch(line, /decided by Eli/i); assert.doesNotMatch(line, /Eli for Maximilian/)
      assert.match(line, /Maximilian’s step/)
      // the same line is said back once, also when the round reads it again
      await r.f.tick(r.at(18))
      assert.equal(r.said('suggested').length, 1)
      // Maximilian's own agent decides it, provisionally, named with Maximilian
      await r.asEmrys('note', { text: 'TSP first, because RLTP already carries it.', kind: 'message' }, { threadId: s.thread })
      await r.f.tick(r.at(19))
      s = r.stepFrom(r.pr)
      assert.equal(s.waitingOn, undefined); assert.equal(s.decision.by, r.maxAgent.did)
      assert.match(r.said('decided').at(-1), /^Decided provisionally by Emrys \(for Maximilian\)/)
      assert.match(r.f.where(s), /Decided provisionally by Emrys \(for Maximilian\)/)
      assert.equal(r.f.view().steps.find((x) => x.id === s.id).decision.byLine, 'Emrys (for Maximilian)')
      for (const t of [...r.said('decided'), ...r.said('suggested')]) assert.doesNotMatch(t, /Eli for Maximilian/)
    } finally { await r.stop() }
  })
})
