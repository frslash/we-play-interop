// Ask once (room line 2329): the board asks a choice once and stays quiet about it for a full day unless the step
// changes; a parked step (or one held for its person) is never listed under "the agents decide now"; and a seat whose
// agent has a line waiting for its person's OK (Ask me first) shows as awake, waiting for its person.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { NAME_OF, TYPES, signedDocument } from '../src/shared/types.js'
import { WAITING_FOR_PERSON, waitsForPerson } from '../src/shared/presence.js'
import { config as baseConfig } from '../src/server/config.js'
import { branchOf } from '../src/server/builder.js'
import { ASK_ONCE_MS, Facilitator, askKey, askedAlready, parkedForNow, stateKey } from '../src/server/facilitator.js'
import { createApp } from '../src/server/index.js'
import { createResolver } from '../src/server/resolver.js'
import { closeVotes } from '../src/server/votes.js'

const BOARD = { generated: new Date().toISOString().slice(0, 10), projects: [], scenarios: [], runs: [] }
const FIRE = 'https://api.anthropic.com/v1/claude_code/routines/trig_builder_1/fire'
const MIN = 60_000

async function room () {
  const dir = mkdtempSync(join(tmpdir(), 'wpi-askonce-'))
  const pulls = []
  const wakeFetch = async () => ({ ok: true, status: 200 })
  const gh = async (method, path) => (method === 'GET' && path.includes('/pulls?') ? pulls : {})
  const config = { ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, githubToken: '', weaverIntervalMinutes: 0, weaverQuietMinutes: 0, ratePerMinute: 1000, voteMinutes: 10, workspaceRepo: 'example/room', publicUrl: 'https://interop.example', boardDataUrl: 'data:application/json,' + encodeURIComponent(JSON.stringify(BOARD)), llm: { ...baseConfig.llm, provider: 'openai', apiKey: '' } }
  const ctx = await createApp(config, { openRoom: true, resolver: createResolver(), hostWelcomeMs: null, wakeFetch, gh })
  await new Promise((r) => ctx.server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${ctx.server.address().port}`
  await ctx.board.refresh()
  const send = async (id, name, payload, extra) => { const r = await fetch(`${base}/api/entries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signedDocument(id, { type: TYPES[name], payload, ...extra })) }); return { status: r.status, body: await r.json() } }
  const exp = new Date(Date.now() + 86400000).toISOString()
  const people = { a: newIdentity(), b: newIdentity(), c: newIdentity() }, agents = { b: newIdentity(), c: newIdentity() }, dels = {}
  for (const k of ['a', 'b', 'c']) await send(people[k], 'join', { name: `Person ${k.toUpperCase()}` })
  for (const k of ['b', 'c']) dels[k] = (await send(people[k], 'delegate', { delegate: agents[k].did, scope: ['note', 'propose', 'vote'], label: k === 'b' ? 'South Agent' : 'East Agent' }, { expiresAt: exp })).body.hash
  const builder = (await send(people.a, 'host', { label: "Person A's builder" })).body.hosted.did
  await send(people.a, 'delegate', { delegate: builder, scope: ['note', 'propose'], label: "Person A's builder" }, { expiresAt: exp })
  await ctx.waker.set(builder, `${FIRE}#token=secret-token`, ['direct', 'mention'])
  const as = (k, name, payload, extra) => send(agents[k], name, payload, { onBehalfOf: people[k].did, delegation: dels[k], ...extra })
  await ctx.facilitator.tick()
  const st = () => ctx.log.state
  const stepFrom = (h) => [...st().steps.values(), ...st().stepsDone].find((s) => s.from === h)
  const said = (what) => ctx.log.entries.filter((e) => NAME_OF[e.type] === 'note' && e.document.payload.facilitator?.what === what).map((e) => e.document)
  const stuckLines = () => ctx.log.entries.filter((e) => e.author === builder && e.document.payload.step?.say === 'blocked').length
  const at = (m) => Date.now() + m * MIN
  const agreeForBuilder = async (title) => {
    const pr = (await as('b', 'propose', { kind: 'other', title, body: "Owner: Person A's builder. Check: the Steps tab shows it." })).body.hash
    await as('c', 'vote', { proposal: pr, choice: 'for' })
    await closeVotes(ctx, at(11), { max: 10 })
    return pr
  }
  const stop = async () => { await ctx.stop(); rmSync(dir, { recursive: true, force: true }) }
  return { ctx, base, send, as, people, agents, builder, pulls, st, stepFrom, said, stuckLines, at, agreeForBuilder, stop }
}

const blockOn = async (r, title, needs) => {
  const f = r.ctx.facilitator, p = await r.agreeForBuilder(title)
  await f.tick(r.at(11)); await f.tick(r.at(12))
  const s = r.stepFrom(p)
  r.pulls.push({ number: 40 + r.pulls.length, title: `Blocked: ${title}`, body: `Needs: ${needs}\nWhy: it needs a choice.\nFrom: any agent here`, html_url: 'https://github.com/example/room/pull/40', head: { ref: branchOf(s), sha: 'e'.repeat(40) } })
  await f.tick(r.at(15)); await f.tick(r.at(16))
  return p
}
const later = async (ms, fn) => { const real = Date.now, t = real() + ms; Date.now = () => t; try { return await fn() } finally { Date.now = real } }
const CHOICE = 'Which carrier the room tests first, TSP or DIDComm'
const asks = (r, s) => r.said('decide').filter((d) => d.payload.facilitator.steps.includes(s.id)).length

describe('asked once per open item', () => {
  test('the rule, on a step as it stands', () => {
    const s = { state: 'open', owner: 'did:key:z1', askedAt: new Date().toISOString() }
    s.askedKey = askKey(s, `${CHOICE}?`)
    assert.ok(askedAlready(s, CHOICE), 'the same question, however it ends')
    assert.ok(askedAlready(s, CHOICE, null, Date.now() + ASK_ONCE_MS - 60_000), 'quiet for the whole day')
    assert.ok(!askedAlready(s, CHOICE, null, Date.now() + ASK_ONCE_MS + 60_000), 'after a full day it may ask again')
    assert.ok(!askedAlready({ ...s, state: 'in progress' }, CHOICE), 'the step changed: a new ask')
    assert.ok(!askedAlready(s, 'Which domain the room uses'), 'another question: a new ask')
    assert.ok(!askedAlready(s, CHOICE, { who: 'did:key:zperson', held: 'keys' }), 'now held for a person: a new ask')
    assert.ok(!askedAlready({ ...s, askedKey: undefined }, CHOICE), 'an older line with no key is not counted')
  })

  test('a choice is not asked again for a day, and is asked again as soon as its step changes', async () => {
    const r = await room()
    try {
      const f = r.ctx.facilitator
      const p = await blockOn(r, 'Run the carrier test', `${CHOICE}?`)
      let s = r.stepFrom(p)
      assert.equal(asks(r, s), 1, 'asked once')
      assert.equal(s.waitingOn.decision, CHOICE)
      // the same question comes back (a re-posted "blocked", the builder again): quiet, past the old ten minutes and all day
      for (const ms of [11 * 60_000, 3 * 3600_000, ASK_ONCE_MS - 5 * 60_000]) await later(ms, () => f.escalate(r.stepFrom(p), null, `${CHOICE}?`))
      assert.equal(asks(r, r.stepFrom(p)), 1, 'not re-asked within the day')
      assert.ok(f.roundContext().steps.find((x) => x.id === s.id).askedAlready, 'the round is told it was asked')
      // a full day later, it may ask once more
      await later(ASK_ONCE_MS + 60_000, () => f.escalate(r.stepFrom(p), null, `${CHOICE}?`))
      assert.equal(asks(r, r.stepFrom(p)), 2, 'asked again after a full day')
      // the step's state changes: the question is new for it, asked at once, and then once only
      s = r.stepFrom(p)
      s = await f.write(s, { state: 'in progress' }, 'update', null)
      await f.escalate(s, null, `${CHOICE}?`); await f.escalate(r.stepFrom(p), null, `${CHOICE}?`)
      assert.equal(asks(r, r.stepFrom(p)), 3, 'asked once after the change')
      assert.equal(stateKey(r.stepFrom(p)).startsWith('in progress'), true)
    } finally { await r.stop() }
  })
})

describe('"the agents decide now" never lists a parked step', () => {
  test('after a restart: parked and held steps stay off the list; an open one is listed once, and not after the next restart', async () => {
    const r = await room()
    try {
      const f = r.ctx.facilitator
      const pParked = await blockOn(r, 'Buy the permanent domain', 'Which domain the room moves to?')
      const pOpen = await blockOn(r, 'Run the carrier test', `${CHOICE}?`)
      // the older shape: choices put to a person by name. One of them is parked for that person (like #68)
      let parked = r.stepFrom(pParked)
      parked = await f.write(parked, { waitingOn: { who: r.people.a.did, decision: 'Which domain the room moves to' }, decision: { choice: 'parked', parked: true, why: 'until Person A is back', by: r.people.a.did, at: new Date().toISOString(), stateKey: stateKey(parked) } }, 'answered', null)
      assert.ok(parkedForNow(parked))
      let open = r.stepFrom(pOpen)
      open = await f.write(open, { waitingOn: { who: r.people.a.did, decision: CHOICE }, askedAt: null, askedKey: null }, 'waiting', null)
      const before = r.said('decide').length
      r.ctx.facilitator = new Facilitator({ ctx: r.ctx }); await r.ctx.facilitator.tick(r.at(20))
      const lists = r.said('decide').slice(before).filter((d) => /The agents decide them now/.test(d.payload.text))
      assert.equal(lists.length, 1)
      assert.ok(!lists[0].payload.facilitator.steps.includes(parked.id), 'the parked step is not listed')
      assert.ok(!/domain/i.test(lists[0].payload.text), 'nor named')
      assert.ok(lists[0].payload.facilitator.steps.includes(open.id), 'the open one is')
      assert.equal(r.stepFrom(pParked).waitingOn.who, r.people.a.did, 'the parked step is left as it was')
      assert.equal(r.stepFrom(pOpen).waitingOn.who, null, 'the open one is the agents’ now')
      // asked once: the next ask of the same choice, and the next restart, stay quiet
      const n = r.said('decide').length
      await later(11 * 60_000, () => r.ctx.facilitator.escalate(r.stepFrom(pOpen), null, CHOICE))
      r.ctx.facilitator = new Facilitator({ ctx: r.ctx }); await r.ctx.facilitator.tick(r.at(21))
      assert.equal(r.said('decide').length, n, 'not asked again')
    } finally { await r.stop() }
  })

  test('a step already asked today moves to the agents without being listed again', async () => {
    const r = await room()
    try {
      const f = r.ctx.facilitator
      const p = await blockOn(r, 'Run the carrier test', `${CHOICE}?`)
      let s = r.stepFrom(p)
      s = await f.write(s, { waitingOn: { who: r.people.a.did, decision: CHOICE } }, 'waiting', null) // asked today, then put to a person by an older line
      const before = r.said('decide').length
      r.ctx.facilitator = new Facilitator({ ctx: r.ctx }); await r.ctx.facilitator.tick(r.at(20))
      assert.equal(r.said('decide').length, before, 'no new list')
      assert.equal(r.stepFrom(p).waitingOn.who, null, 'but it is the agents’ to decide')
    } finally { await r.stop() }
  })
})

describe('a seat waiting for its person', () => {
  test('the rule', () => {
    assert.equal(WAITING_FOR_PERSON, 'awake, waiting for its person')
    assert.ok(waitsForPerson({ kind: 'agent', waiting: 1 }))
    assert.ok(!waitsForPerson({ kind: 'agent', waiting: 0 }))
    assert.ok(!waitsForPerson({ kind: 'human', waiting: 2 }))
    assert.ok(!waitsForPerson({ kind: 'agent', waiting: 1, removed: true }))
  })

  test('an agent on "Ask me first" with a line waiting shows the waiting state, on its card and beside its lines', async () => {
    const r = await room()
    try {
      const state = async () => (await (await fetch(`${r.base}/api/state`)).json())
      const call = (link, name, args) => fetch(link, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }).then((x) => x.json())
      const made = (await r.send(r.people.c, 'host', { label: 'Careful Cat' })).body.hosted
      const link = made.connector.replace(/^https?:\/\/[^/]+/, r.base)
      await r.send(r.people.c, 'delegate', { delegate: made.did, scope: ['note', 'vote'], ask: ['note'], label: 'Careful Cat' }, { expiresAt: new Date(Date.now() + 86400000).toISOString() })
      const cat = async () => (await state()).people.find((p) => p.did === made.did)
      assert.ok(!waitsForPerson(await cat()), 'nothing waiting yet')
      const said = JSON.parse((await call(link, 'say', { text: 'Hello, I am Careful Cat.' })).result.content[0].text)
      assert.equal(said.waiting, true)
      const seat = await cat()
      assert.deepEqual(seat.ask, ['note']); assert.equal(seat.waiting, true, 'a yes/no only: every member reads the state')
      assert.ok(waitsForPerson(seat), 'awake, waiting for its person')
      // the page draws it: on its card (Your agents), beside its lines, and on the loom
      const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
      assert.match(app, /import \{[^}]*\bwaitsForPerson\b[^}]*\} from '\/shared\/presence\.js'/)
      assert.match(app, /h\('strong', null, a\.name\), waitsForPerson\(a\) \? \[' ', waitingBadge\(a\.did\)\]/)
      assert.match(app, /listenDot\(e\.author\) : null, agent( && !weaver)? \? waitingBadge\(e\.author\)/) // beside an agent's lines (the weaver's are notices, with no badge)
      // its person drops the line: the seat no longer waits
      const { TYPES: T, signedDocument: sd } = await import('../src/shared/types.js')
      const priv = async (payload) => (await (await fetch(`${r.base}/api/drafts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sd(r.people.c, { type: T.draft, payload })) })).json())
      const [d] = (await priv({ agent: made.did, op: 'list' })).drafts
      await priv({ agent: made.did, op: 'drop', id: d.id })
      assert.ok(!waitsForPerson(await cat()), 'nothing waits once its person has answered')
    } finally { await r.stop() }
  })
})
