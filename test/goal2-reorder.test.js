// Goal 2's done-test, reworded and reordered as the room agreed (room lines 1283-1301): checks (1), (2) and (5) first
// with the new words, (3), (4) and (6) shown as later. A new room is seeded that way; a room seeded before is moved once.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { NAME_OF, TYPES, signedDocument } from '../src/shared/types.js'
import { config as baseConfig } from '../src/server/config.js'
import { SEED_TESTS } from '../src/server/facilitator.js'
import { createApp } from '../src/server/index.js'
import { createResolver } from '../src/server/resolver.js'

const BOARD = { generated: new Date().toISOString().slice(0, 10), projects: [{ slug: 'alpha', name: 'Alpha' }], scenarios: [], runs: [] }
const V1 = [
  { text: 'Private notebooks live in sealed rooms on a host the room doesn’t run, with no plaintext on the room’s server.' },
  { text: 'A wallet joins by QR, end to end.' },
  { text: 'A Geb member and a Keyring member read each other in one MLS group.' },
  { text: 'The public log verifies with the room’s server off.' },
  { text: 'The room’s DID is on a permanent domain.', needs: 'which permanent domain the room’s DID lives on, and buying it if it costs money' },
  { text: 'Agents keep working a full day with all of it in use.' },
]

async function room () {
  const dir = mkdtempSync(join(tmpdir(), 'wpi-goal2-'))
  const config = { ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, githubToken: '', weaverIntervalMinutes: 0, weaverQuietMinutes: 0, ratePerMinute: 1000, voteMinutes: 10, publicUrl: 'https://interop.example', boardDataUrl: 'data:application/json,' + encodeURIComponent(JSON.stringify(BOARD)), llm: { ...baseConfig.llm, provider: 'openai', apiKey: '' } }
  const ctx = await createApp(config, { resolver: createResolver(), hostWelcomeMs: null })
  await new Promise((r) => ctx.server.listen(0, r))
  const base = `http://localhost:${ctx.server.address().port}`
  await ctx.board.refresh()
  ctx.weaver.llm = { configured: false }
  const send = async (id, name, payload) => { const r = await fetch(`${base}/api/entries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signedDocument(id, { type: TYPES[name], payload })) }); return { status: r.status, body: await r.json() } }
  const a = newIdentity()
  assert.equal((await send(a, 'join', { name: 'Person A' })).status, 201)
  const goal = (await send(a, 'propose', { kind: 'goal', title: 'Goal 2: the room moves onto encrypted spaces its people hold' })).body.hash
  await send(a, 'vote', { proposal: goal, choice: 'for' })
  const said = (what) => ctx.log.entries.filter((e) => NAME_OF[e.type] === 'note' && e.document.payload.facilitator?.what === what).map((e) => e.document.payload)
  const stop = async () => { await ctx.stop(); rmSync(dir, { recursive: true, force: true }) }
  return { ctx, goal, a, said, stop, f: ctx.facilitator }
}

describe('Goal 2’s done-test: reworded, with (1), (2) and (5) first and (3), (4) and (6) later', () => {
  test('a new room is seeded in the agreed order and words', async () => {
    const r = await room()
    try {
      await r.f.tick()
      const t = r.f.testOf(r.goal)
      assert.deepEqual(t.map((s) => s.test.n), [1, 2, 5, 3, 4, 6])
      assert.deepEqual(t.map((s) => Boolean(s.test.later)), [false, false, false, true, true, true])
      assert.match(t[0].title, /shared talk lives in an encrypted community room/)
      assert.match(t[1].title, /real person signs up from Keyring with keys they hold, gets a membership pass and enters the encrypted room/)
      assert.match(t[2].title, /permanent domain/)
      const view = r.f.view().goals.find((g) => g.hash === r.goal)
      assert.deepEqual(view.test.map((s) => [s.test.n, Boolean(s.test.later)]), [[1, false], [2, false], [5, false], [3, true], [4, true], [6, true]])
      assert.match(r.f.reportText(), /\(3\) A Geb member.*\(later\)/)
      await r.f.tick()
      assert.equal(r.said('reworded').length, 0, 'nothing to reword in a room seeded with the current words')
    } finally { await r.stop() }
  })

  test('a room seeded with the old words is moved once, keeping each step and what was done on it', async () => {
    const r = await room()
    try {
      const old = await r.f.openTest(r.ctx.log.state.proposals.get(r.goal), V1, { seed: { id: 'data-room', version: 1 } })
      assert.deepEqual(r.f.testOf(r.goal).map((s) => s.test.n), [1, 2, 3, 4, 5, 6])
      await r.f.tick()
      const t = r.f.testOf(r.goal)
      assert.deepEqual(t.map((s) => s.test.n), [1, 2, 5, 3, 4, 6])
      assert.deepEqual(new Set(t.map((s) => s.id)), new Set(old.map((s) => s.id)), 'the same steps, not new ones')
      assert.equal(t[0].title, SEED_TESTS[0].checks[0].text)
      assert.equal(t[1].title, SEED_TESTS[0].checks[1].text)
      assert.ok(t[2].waitingOn, 'check (5) still waits on its choice'); assert.deepEqual(t[2].waitingOn.personal, ['money'], 'which is a person’s alone: it costs money')
      assert.ok(t.slice(3).every((s) => s.test.later && s.title === V1[s.test.n - 1].text), 'the later checks keep their words')
      const note = r.said('reworded')
      assert.equal(note.length, 1)
      assert.match(note[0].text, /For now:\n\(1\)[^\n]*\n\(2\)[^\n]*\n\(5\)[^\n]*\nLater:\n\(3\)/)
      await r.f.tick()
      assert.equal(r.said('reworded').length, 1, 'once')
    } finally { await r.stop() }
  })

  test('a done-test its own person has revised since is left as it is', async () => {
    const r = await room()
    try {
      await r.f.openTest(r.ctx.log.state.proposals.get(r.goal), V1, { seed: { id: 'data-room', version: 1 } })
      const s = r.f.testOf(r.goal)[0]
      await r.f.write(null, { goal: r.goal, title: 'Something its person wrote', done: 'x', state: 'open', test: { goal: r.goal, n: 7, revised: true } }, 'opened', null)
      await r.f.tick()
      assert.equal(r.f.find(s.id).title, V1[0].text)
      assert.equal(r.said('reworded').length, 0)
    } finally { await r.stop() }
  })
})
