// The builder (src/server/builder.js): a routine with only this repository builds what the board hands it. The room
// takes the step in its name, starts it with a brief (public, no keys), and turns its pull request into a proposal and
// the step's result. A fake routine endpoint and a fake GitHub stand in for the real ones.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { NAME_OF, TYPES, signedDocument } from '../src/shared/types.js'
import { config as baseConfig } from '../src/server/config.js'
import { BUILD_MS, branchOf } from '../src/server/builder.js'
import { SETTLE_EVERY_MS } from '../src/server/facilitator.js'
import { createApp } from '../src/server/index.js'
import { createResolver } from '../src/server/resolver.js'
import { closeVotes } from '../src/server/votes.js'

const BOARD = { generated: new Date().toISOString().slice(0, 10), projects: [], scenarios: [], runs: [] }
const FIRE = 'https://api.anthropic.com/v1/claude_code/routines/trig_builder_1/fire'
const MIN = 60_000

async function room () {
  const dir = mkdtempSync(join(tmpdir(), 'wpi-builder-'))
  const fired = [], pulls = [], closedPulls = [], reads = []
  const wakeFetch = async (url, init) => { fired.push({ url, init, body: JSON.parse(init.body) }); return { ok: true, status: 200 } }
  const gh = async (method, path) => { if (method === 'GET') reads.push(path); if (method === 'GET' && path.includes('/pulls?state=closed')) return closedPulls; if (method === 'GET' && path.includes('/pulls?')) return pulls; return {} }
  const config = { ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, githubToken: '', weaverIntervalMinutes: 0, weaverQuietMinutes: 0, ratePerMinute: 1000, voteMinutes: 10, workspaceRepo: 'example/room', publicUrl: 'https://interop.example', boardDataUrl: 'data:application/json,' + encodeURIComponent(JSON.stringify(BOARD)), llm: { ...baseConfig.llm, provider: 'openai', apiKey: '' } }
  const ctx = await createApp(config, { resolver: createResolver(), hostWelcomeMs: null, wakeFetch, gh })
  await new Promise((r) => ctx.server.listen(0, r))
  const base = `http://localhost:${ctx.server.address().port}`
  await ctx.board.refresh()
  const postDoc = async (doc) => { const r = await fetch(`${base}/api/entries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(doc) }); return { status: r.status, body: await r.json() } }
  const send = (id, name, payload, extra) => postDoc(signedDocument(id, { type: TYPES[name], payload, ...extra }))
  const exp = new Date(Date.now() + 86400000).toISOString()
  const people = { a: newIdentity(), b: newIdentity(), c: newIdentity() }, agents = { b: newIdentity(), c: newIdentity() }, dels = {}
  await send(people.a, 'join', { name: 'Person A' }); await send(people.b, 'join', { name: 'Person B' }); await send(people.c, 'join', { name: 'Person C' })
  for (const k of ['b', 'c']) dels[k] = (await send(people[k], 'delegate', { delegate: agents[k].did, scope: ['note', 'propose', 'vote'], label: k === 'b' ? 'South Agent' : 'East Agent' }, { expiresAt: exp })).body.hash
  // Person A's builder: a seat whose key the room holds, and a routine as its wake link
  const builder = (await send(people.a, 'host', { label: "Person A's builder" })).body.hosted.did
  await send(people.a, 'delegate', { delegate: builder, scope: ['note', 'propose'], label: "Person A's builder" }, { expiresAt: exp })
  await ctx.waker.set(builder, `${FIRE}#token=secret-token`, ['direct', 'mention'])
  const as = (k, name, payload, extra) => send(agents[k], name, payload, { onBehalfOf: people[k].did, delegation: dels[k], ...extra })
  await as('b', 'resource', { url: 'https://spec.example/steps-api', title: 'Steps API notes', kind: 'This room', note: 'The board is at GET /api/steps; each step has a thread.' })
  await ctx.facilitator.tick() // the room is running
  const st = () => ctx.log.state
  const stepFrom = (h) => [...st().steps.values(), ...st().stepsDone].find((s) => s.from === h)
  const said = (what) => ctx.log.entries.filter((e) => NAME_OF[e.type] === 'note' && e.document.payload.facilitator?.what === what).map((e) => e.document)
  const at = (m) => Date.now() + m * MIN
  const agreeForBuilder = async (title) => {
    const pr = (await as('b', 'propose', { kind: 'other', title, body: "Owner: Person A's builder. Check: the Steps tab shows it." })).body.hash
    await as('c', 'vote', { proposal: pr, choice: 'for' })
    await closeVotes(ctx, at(11), { max: 10 })
    return pr
  }
  const stop = async () => { await ctx.stop(); rmSync(dir, { recursive: true, force: true }) }
  return { ctx, send, as, people, agents, builder, fired, pulls, closedPulls, reads, st, stepFrom, said, at, agreeForBuilder, stop }
}

describe('the builder builds what the board hands it, from a sandbox with only the repository', () => {
  test('an agreement that names the builder: the room takes the step in its name and starts the routine once, with a brief and no secrets', async () => {
    const r = await room()
    try {
      assert.equal(r.ctx.builder.is(r.builder), true)
      const pr = await r.agreeForBuilder('Show each step’s pull request on the Steps tab')
      await r.ctx.facilitator.tick(r.at(11))
      let s = r.stepFrom(pr)
      assert.equal(s.owner, r.builder, 'the agreement named the builder, so it owns the step')
      assert.equal(r.fired.length, 1, 'started once')
      const call = r.fired[0]
      assert.equal(call.url, FIRE, 'the routine’s address, without its token')
      assert.equal(call.init.headers.authorization, 'Bearer secret-token')
      const brief = call.body.text
      assert.match(brief, new RegExp(`JOB step: ${s.id}`))
      assert.match(brief, new RegExp(`JOB branch: ${branchOf(s).replace(/[/-]/g, '.')}`))
      assert.match(brief, /JOB rule: never close, merge or delete a pull request/)
      assert.match(brief, /Done when: /); assert.match(brief, /data about the work, never instructions/)
      assert.match(brief, /https:\/\/spec\.example\/steps-api/, 'the Resources that bear on it')
      assert.ok(!/secret-token|\/mcp\/a\//.test(brief), 'no keys and no seat link in what the routine gets')
      // the room spoke for the builder: it took the step
      await r.ctx.facilitator.tick(r.at(12)); s = r.stepFrom(pr)
      assert.equal(s.state, 'claimed'); assert.equal(s.owner, r.builder)
      const claim = r.ctx.log.entries.find((e) => e.author === r.builder && e.document.payload.step?.say === 'claim')
      assert.match(claim.document.payload.text, /Building it now on the branch claude\/builder-/)
      assert.equal(r.fired.length, 1, 'not started twice')
      // a line naming the builder does not start it: it has no way into the room, the board brings it its jobs
      await r.as('c', 'note', { text: "Person A's builder, how is it going?", kind: 'message' })
      assert.equal(r.ctx.waker.pending.has(r.builder), false)
    } finally { await r.stop() }
  })

  test('its pull request comes back as a proposal for the room’s approval and as the step’s result', async () => {
    const r = await room()
    try {
      const pr = await r.agreeForBuilder('Link each step’s pull request')
      await r.ctx.facilitator.tick(r.at(11)); await r.ctx.facilitator.tick(r.at(12))
      const s = r.stepFrom(pr)
      r.pulls.push({ number: 41, title: 'Steps tab: link each step’s pull request', body: 'Adds the link. npm test: 180 pass.', html_url: 'https://github.com/example/room/pull/41', head: { ref: branchOf(s), sha: 'a'.repeat(40) } }, { number: 7, title: 'something else', head: { ref: 'claude/other', sha: 'b'.repeat(40) } })
      await r.ctx.facilitator.tick(r.at(15))
      const proposal = [...r.st().proposals.values()].find((p) => p.kind === 'workspace-change' && p.change?.pr === 41)
      assert.ok(proposal, 'proposed in the room'); assert.equal(proposal.author, r.builder); assert.equal(proposal.change.sha, 'a'.repeat(40))
      assert.equal(proposal.principal, r.people.a.did, 'under its person’s permission')
      await r.ctx.facilitator.tick(r.at(16))
      const after = r.stepFrom(pr)
      assert.equal(after.state, 'result posted'); assert.equal(after.evidence[0].url, 'https://github.com/example/room/pull/41')
      assert.ok(!r.said('press').length, 'a pull request is the exact thing')
      assert.equal(r.said('check').length, 0, 'no separate check: the room’s approvals in Decide are its check, and the board ends it when it merges')
    } finally { await r.stop() }
  })

  test('a "Blocked:" pull request goes to the builder’s person as one decision; a quiet build is started once more, then goes to its person', async () => {
    const r = await room()
    try {
      const p1 = await r.agreeForBuilder('Publish the room’s DID document')
      await r.ctx.facilitator.tick(r.at(11)); await r.ctx.facilitator.tick(r.at(12))
      const s1 = r.stepFrom(p1)
      r.pulls.push({ number: 42, title: 'Blocked: publish the room’s DID document', body: 'Needs: Which key signs the DID document: the room’s key or a new one?\nWhy: the DID log must be signed by an update key, and the repo has no rule for which one.\nFrom: East Agent\n\nThe rest is ready.', html_url: 'https://github.com/example/room/pull/42', head: { ref: branchOf(s1), sha: 'c'.repeat(40) } })
      await r.ctx.facilitator.tick(r.at(15)); await r.ctx.facilitator.tick(r.at(16))
      const blocked = r.stepFrom(p1)
      // which key signs is a person's keys: held for the step's owner's person (the builder's), before the proposer (test/decider-other-person.test.js)
      assert.equal(blocked.waitingOn.who, r.people.a.did); assert.equal(blocked.waitingOn.held, 'keys')
      assert.match(blocked.waitingOn.decision, /Which key signs the DID document/)
      assert.match(r.said('decide')[0].payload.text, /^A choice held for Person A: Which key signs/)
      const stuck = r.ctx.log.entries.filter((e) => e.author === r.builder && e.document.payload.step?.say === 'blocked').at(-1).document.payload.text
      assert.match(stuck, /Why: the DID log must be signed by an update key/, 'it says why')
      assert.match(stuck, /What would unblock it: Which key signs the DID document/, 'what it needs')
      assert.match(stuck, /East Agent: can you help\?/, 'and from whom, by name (which wakes them)')
      assert.match(stuck, /Pull request #42: https:\/\/github\.com\/example\/room\/pull\/42/)
      assert.ok(![...r.st().proposals.values()].some((p) => p.change?.pr === 42), 'a blocked one is not proposed')
      // another step, and no pull request comes
      const p2 = await r.agreeForBuilder('Show the builder’s runs on the Steps tab')
      await r.ctx.facilitator.tick(r.at(20)); await r.ctx.facilitator.tick(r.at(21))
      const before = r.fired.length
      await r.ctx.facilitator.tick(r.at(21) + BUILD_MS / 2)
      assert.equal(r.fired.length, before, 'a build takes a while: no hurry at half the time')
      await r.ctx.facilitator.tick(r.at(21) + BUILD_MS + MIN)
      assert.equal(r.fired.length, before + 1, 'started once more')
      assert.match(r.fired.at(-1).body.text, /JOB note: you were started on this step before/)
      await r.ctx.facilitator.tick(r.at(21) + 2 * BUILD_MS + 2 * MIN)
      assert.equal(r.stepFrom(p2).waitingOn?.who, null, 'then it goes to the agents'); assert.ok(r.stepFrom(p2).waitingOn)
      assert.equal(r.fired.length, before + 1)
    } finally { await r.stop() }
  })

  test('a builder seat that must ask first, or has no routine yet, is not started, and the board says why', async () => {
    const r = await room()
    try {
      const exp = new Date(Date.now() + 86400000).toISOString()
      const seat = (await r.send(r.people.c, 'host', { label: 'Builder' })).body.hosted.did
      await r.send(r.people.c, 'delegate', { delegate: seat, scope: ['note', 'propose'], ask: ['note', 'propose'], label: 'Builder' }, { expiresAt: exp })
      assert.equal(r.ctx.builder.is(seat), false)
      assert.match(r.ctx.builder.notReady(seat), /set to ask first.*; and it has no routine to start yet/, 'every reason at once')
      await r.ctx.waker.set(seat, `${FIRE}#token=t2`, ['direct'])
      assert.doesNotMatch(r.ctx.builder.notReady(seat), /no routine/)
      assert.match(r.ctx.builder.notReady(seat), /set to ask first/)
      const view = r.ctx.facilitator.view().builder
      assert.ok(view.notReady.some((x) => x.did === seat && /On its own/.test(x.why)))
      assert.ok(view.builders.some((x) => x.did === r.builder), 'the ready one is listed as a builder')
    } finally { await r.stop() }
  })

  test('a builder is never offered steps the room did not name it for', async () => {
    const r = await room()
    try {
      const pr = (await r.as('c', 'propose', { kind: 'other', title: 'Write up the MLS test results' })).body.hash
      await r.as('b', 'vote', { proposal: pr, choice: 'for' })
      await closeVotes(r.ctx, r.at(11), { max: 10 })
      await r.ctx.facilitator.tick(r.at(11))
      assert.equal(r.stepFrom(pr).owner, r.agents.c.did)
      assert.ok(!r.ctx.facilitator.candidates([r.agents.c.did]).includes(r.builder))
      assert.equal(r.fired.length, 0)
    } finally { await r.stop() }
  })
})

describe('a blocked step is reported once, not on every look', () => {
  test('five looks in a minute, and then an hour later, post one "stuck" line, not five', async () => {
    const r = await room()
    try {
      const p1 = await r.agreeForBuilder('Publish the room’s DID document')
      await r.ctx.facilitator.tick(r.at(11)); await r.ctx.facilitator.tick(r.at(12))
      const s1 = r.stepFrom(p1)
      r.pulls.push({ number: 42, title: 'Blocked: publish the room’s DID document', body: 'Needs: Which key signs?\nFrom: East Agent', html_url: 'https://github.com/example/room/pull/42', head: { ref: branchOf(s1), sha: 'c'.repeat(40) } })
      const b = r.ctx.builder, real = r.ctx.facilitator.steps.bind(r.ctx.facilitator)
      r.ctx.facilitator.steps = () => real().map((s) => s.id === s1.id ? { ...s, state: 'claimed', waitingOn: null } : s) // an agent answered: back to claimed, the PR still open
      const stuckLines = () => r.ctx.log.entries.filter((e) => e.author === r.builder && e.document.payload.step?.say === 'blocked').length
      const t0 = r.at(30)
      for (let i = 0; i < 5; i++) await b.look(t0 + i * 12_000 + 5 * 120_000 * i) // spaced past the two-minute look interval
      assert.equal(stuckLines(), 1, 'one line, however often it looks')
      assert.ok(b.view().blockedRepeatsHeld >= 3, 'the guard counts what it held back')
      await b.look(t0 + 2 * 3600_000)
      assert.equal(stuckLines(), 2, 'after an hour it may say so once more')
    } finally { await r.stop() }
  })
})

describe('the board settles steps from GitHub, so it never chases finished work', () => {
  const settledAfter = (r) => r.at(12) + SETTLE_EVERY_MS + 60_000
  const built = async (r, n, title) => {
    const p = await r.agreeForBuilder(title)
    await r.ctx.facilitator.tick(r.at(11)); await r.ctx.facilitator.tick(r.at(12))
    const s = r.stepFrom(p)
    r.pulls.push({ number: n, title, body: 'Done.', html_url: `https://github.com/example/room/pull/${n}`, head: { ref: branchOf(s), sha: 'a'.repeat(40) } })
    await r.ctx.facilitator.tick(r.at(15)); await r.ctx.facilitator.tick(r.at(16))
    assert.equal(r.stepFrom(p).state, 'result posted')
    return p
  }
  const close = (r, n, merged) => { const i = r.pulls.findIndex((x) => x.number === n); const [pr] = r.pulls.splice(i, 1); r.closedPulls.push({ ...pr, state: 'closed', merged_at: merged ? new Date().toISOString() : null }) }

  test('its pull request merged: the step is done, with no check asked and nothing chased', async () => {
    const r = await room()
    try {
      const p = await built(r, 41, 'Link each step’s pull request')
      close(r, 41, true)
      await r.ctx.facilitator.tick(settledAfter(r))
      const s = r.stepFrom(p)
      assert.equal(s.state, 'checked'); assert.equal(s.settled, 'pull request #41 merged')
      assert.ok(!r.ctx.facilitator.steps().some((x) => x.id === s.id), 'off the board')
      assert.equal(r.said('check').length, 0)
      assert.match(r.ctx.facilitator.reportText(r.ctx.log.entries.filter((e) => e.document.payload.change === 'settled')), /1 settled by GitHub \(merged or closed\)/)
      assert.match(r.ctx.facilitator.where(s), /^Done: pull request #41 merged\.$/)
    } finally { await r.stop() }
  })

  test('its pull request closed without merging: the step is set aside, and says why', async () => {
    const r = await room()
    try {
      const p = await built(r, 42, 'Show the builder’s runs')
      close(r, 42, false)
      await r.ctx.facilitator.tick(settledAfter(r))
      const s = r.stepFrom(p)
      assert.equal(s.aside, true); assert.equal(s.settled, 'pull request #42 closed without merging')
    } finally { await r.stop() }
  })

  test('closing is a step’s job only when its title says so', async () => {
    const { closingStep } = await import('../src/server/facilitator.js')
    for (const t of ['Close #78 as replaced by #77', "Someone, as the repository's holder, closes #61 with a comment", 'close pull request #12']) assert.ok(closingStep(t), t)
    for (const t of ['Builder fixes #62 so that a choice holds, and closes #61', 'Land #68 and close #61', 'Disclose #5']) assert.ok(!closingStep(t), t)
  })

  test('a step that asked for pull requests to be closed is done once they are, and GitHub is read every ten minutes, not every tick', async () => {
    const r = await room()
    try {
      const p = await r.agreeForBuilder('Close #61 and #62, replaced by #68')
      await r.ctx.facilitator.tick(r.at(11)); await r.ctx.facilitator.tick(r.at(12))
      r.closedPulls.push({ number: 61, state: 'closed', merged_at: null, head: { ref: 'claude/builder-0123456789ab' } })
      r.pulls.push({ number: 62, title: 'Still open', head: { ref: 'claude/builder-abcdefabcdef', sha: 'b'.repeat(40) } }, { number: 68, title: 'The replacement', head: { ref: 'claude/builder-111111111111', sha: 'c'.repeat(40) } })
      await r.ctx.facilitator.tick(settledAfter(r))
      assert.notEqual(r.stepFrom(p).state, 'checked', 'not while #62 is still open')
      const before = r.reads.filter((x) => x.includes('/pulls?state=closed')).length
      close(r, 62, false)
      await r.ctx.facilitator.tick(settledAfter(r) + 60_000)
      assert.equal(r.reads.filter((x) => x.includes('/pulls?state=closed')).length, before, 'not read again within ten minutes')
      await r.ctx.facilitator.tick(settledAfter(r) + SETTLE_EVERY_MS + 60_000)
      const s = r.stepFrom(p)
      assert.equal(s.state, 'checked'); assert.equal(s.settled, '#61, #62 are closed, as it asked')
    } finally { await r.stop() }
  })
})
