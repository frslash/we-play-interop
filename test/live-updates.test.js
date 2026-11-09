import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { STATE_GAP_MS, pacer, refetchFor, take } from '../src/shared/live.js'
import { TYPES, signedDocument } from '../src/shared/types.js'
import { config as baseConfig } from '../src/server/config.js'
import { createApp } from '../src/server/index.js'

// The room's page shows a new line from what the live stream carries, and fetches the room's whole state again only
// when the line changes it, at most once every few seconds (a busy room sent every viewer the whole state for every
// line, and phones and the projector felt it). These tests hold that, and count the bytes one viewer downloads.

const line = (type, author, payload = {}, extra = {}) => ({ type: TYPES[type], author, onBehalfOf: author, seq: extra.seq ?? 10, hash: extra.hash ?? `h${Math.random()}`, timestamp: '2026-11-08T12:00:00.000Z', document: { payload } })

// a clock and timers a test moves by hand
const fakeTime = () => {
  let now = 0; const due = []
  const timers = { setTimeout: (fn, ms) => { const t = { at: now + ms, fn }; due.push(t); return t }, clearTimeout: (t) => { const i = due.indexOf(t); if (i >= 0) due.splice(i, 1) } }
  const until = async (t) => { for (;;) { due.sort((a, b) => a.at - b.at); if (!due.length || due[0].at > t) break; const d = due.shift(); now = d.at; d.fn(); await new Promise(setImmediate) } now = t }
  return { clock: { now: () => now }, timers, until }
}

describe('what a new line changes on the page', () => {
  const room = 'did:key:zRoom', ada = 'did:key:zAda', helper = 'did:key:zHelper', fresh = 'did:key:zNew'
  const copy = () => ({ workspace: room, head: { seq: 9, hash: 'h9' }, counts: { note: 3, join: 1 }, people: [{ did: ada, kind: 'human', name: 'Ada' }, { did: helper, kind: 'agent', name: 'Helper', principal: ada, firstSaid: '2026-11-08T11:00:00.000Z' }, { did: fresh, kind: 'agent', name: 'New', principal: ada }] })

  test('a plain note from someone the page knows needs nothing more', () => {
    const S = copy()
    for (const who of [ada, helper, room]) assert.deepEqual(refetchFor(S, line('note', who, { text: 'hi', kind: 'message' })), { state: false, map: false }, who)
    assert.deepEqual(refetchFor(S, line('note', helper, { text: 'away', kind: 'message', auto: true, tech: 'x' })), { state: false, map: false })
  })

  test('anything else asks for the state, and the map when it can change it', () => {
    const S = copy()
    assert.deepEqual(refetchFor(S, line('note', fresh, { text: 'hello', kind: 'message' })), { state: true, map: true }, 'a new agent heard for the first time')
    assert.deepEqual(refetchFor(S, line('note', 'did:key:zStranger', { text: 'hi', kind: 'message' })), { state: true, map: true }, 'someone the page has not met')
    assert.deepEqual(refetchFor(S, line('note', room, { text: 'a closer look', kind: 'question', dive: { key: 'k' } })), { state: true, map: false }, 'a note carrying a record')
    assert.deepEqual(refetchFor(S, line('note', helper, { text: 'I will take it', kind: 'message', step: { of: 'x', say: 'claim' } })), { state: true, map: false }, 'a line about a step')
    for (const t of ['vote', 'propose', 'approve', 'veto', 'result', 'mode', 'revoke']) assert.deepEqual(refetchFor(S, line(t, ada)), { state: true, map: false }, t)
    for (const t of ['join', 'delegate', 'card', 'project', 'way', 'run', 'round', 'score', 'leave', 'remove', 'replace']) assert.deepEqual(refetchFor(S, line(t, ada)), { state: true, map: true }, t)
    assert.deepEqual(refetchFor(S, { ...line('note', ada), type: 'https://example.org/a-type-added-later' }), { state: true, map: true }, 'a type the page does not know')
  })

  test('the page applies a line to its copy once: head, counts, when an agent spoke', () => {
    const S = copy()
    assert.equal(take(S, line('note', helper, { text: 'x', kind: 'message' }, { seq: 10, hash: 'h10' })), true)
    assert.deepEqual(S.head, { seq: 10, hash: 'h10' }); assert.equal(S.counts.note, 4)
    assert.equal(S.people[1].lastSaid, '2026-11-08T12:00:00.000Z'); assert.equal(S.people[1].firstSaid, '2026-11-08T11:00:00.000Z', 'first stays first')
    assert.equal(take(S, line('note', helper, {}, { seq: 10, hash: 'h10' })), false, 'heard twice, counted once')
    assert.equal(take(S, line('note', ada, {}, { seq: 7 })), false, 'a line the fetched copy already holds')
    assert.equal(S.counts.note, 4)
    take(S, line('note', fresh, {}, { seq: 12, hash: 'h12' })); assert.equal(S.people[2].firstSaid, '2026-11-08T12:00:00.000Z', 'heard now')
    assert.equal(take(S, line('vote', ada, {}, { seq: 11, hash: 'h11' })), true, 'a line that comes after the next one still counts')
    assert.deepEqual(S.head, { seq: 12, hash: 'h12' }); assert.equal(S.counts.vote, 1)
    assert.equal(JSON.stringify(S).includes('h11'), false, 'what the page keeps for this stays off the copy itself')
  })

  test('lines that keep coming share one fetch every few seconds, and none is left out', async () => {
    const time = fakeTime(), fetches = []
    const pace = pacer((map) => fetches.push({ at: time.clock.now(), map }), { clock: time.clock, timers: time.timers })
    pace.soon(false); await time.until(1000)
    assert.deepEqual(fetches, [{ at: 250, map: false }], 'the first a moment after the line')
    for (let t = 1000; t < 21_000; t += 500) { pace.soon(t === 9000); await time.until(t + 500) } // a line every half second for 20 s
    await time.until(40_000)
    const gaps = fetches.slice(1).map((f, i) => f.at - fetches[i].at)
    assert.ok(gaps.every((g) => g >= STATE_GAP_MS), `at most one every ${STATE_GAP_MS} ms: ${gaps}`)
    assert.ok(fetches.length <= 2 + Math.ceil(20_000 / STATE_GAP_MS), `${fetches.length} fetches for 40 lines`)
    assert.ok(fetches.at(-1).at >= 20_500, 'the last line is covered by a fetch after it')
    assert.equal(fetches.filter((f) => f.map).length, 1, 'the map once, with the fetch after the line that wanted it')
  })

  test('your own step is fetched at once, and a fetch on its way is handed back', async () => {
    const time = fakeTime(); let n = 0, release
    const pace = pacer(() => { n++; return new Promise((r) => { release = r }) }, { clock: time.clock, timers: time.timers })
    pace.soon(true); assert.equal(pace.waiting, true)
    const first = pace.now(); assert.equal(pace.waiting, false); await new Promise(setImmediate); assert.equal(n, 1)
    assert.equal(pace.now(), first, 'the same fetch, not a second one')
    release(); await first; assert.equal(pace.now(), null)
  })
})

describe('bytes one viewer downloads per new line', () => {
  let ctx, base, dir, stream
  const people = [], agents = [], proposals = []
  const send = async (id, name, payload, extra) => { const r = await fetch(`${base}/api/entries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signedDocument(id, { type: TYPES[name], payload, ...extra })) }); const body = await r.json(); assert.ok(r.ok, JSON.stringify(body)); return body }
  const words = (n, i) => `Line ${i}: ` + 'we tried the credential exchange again and the verifier accepted the presentation this time; '.repeat(n).slice(0, 60 * n)
  const asAgent = (k, name, payload, extra = {}) => send(agents[k].id, name, payload, { onBehalfOf: people[k].did, delegation: agents[k].delegation, ...extra })
  const sizeOf = async (path) => (await (await fetch(base + path)).arrayBuffer()).byteLength

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wpi-live-'))
    const board = { generated: new Date().toISOString().slice(0, 10), projects: [], credentialProfiles: { profiles: {} }, runs: [] }
    ctx = await createApp({ ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, githubToken: '', weaverIntervalMinutes: 0, weaverQuietMinutes: 0, ratePerMinute: 100_000, publicUrl: 'https://interop.example', boardDataUrl: 'data:application/json,' + encodeURIComponent(JSON.stringify(board)), llm: { ...baseConfig.llm, apiKey: '' } }, { awayGatherMs: 0, hostWelcomeMs: null })
    await new Promise((r) => ctx.server.listen(0, r))
    base = `http://localhost:${ctx.server.address().port}`
    // a room with some history: people with agents, proposals everyone voted on, rounds, and a lot of talk
    for (let k = 0; k < 10; k++) {
      const id = newIdentity(); people.push(id); await send(id, 'join', { name: `Person ${k + 1}`, about: words(2, k) })
      const a = newIdentity(), d = await send(id, 'delegate', { delegate: a.did, scope: ['note', 'vote', 'propose'], label: `Agent ${k + 1}` }, { expiresAt: new Date(Date.now() + 86_400_000).toISOString() })
      agents.push({ id: a, delegation: d.hash }); await asAgent(k, 'note', { text: `Hello, I am here for Person ${k + 1}.`, kind: 'message' })
    }
    for (let i = 0; i < 16; i++) proposals.push((await send(people[i % 10], 'propose', { kind: i % 3 ? 'other' : 'goal', title: `Proposal ${i}: run the presentation exchange between two more projects`, body: words(6, i) })).hash)
    for (const pr of proposals) for (let k = 0; k < 10; k++) await asAgent(k, 'vote', { proposal: pr, choice: k % 4 ? 'for' : 'against', reason: words(1, k) })
    for (let r = 0; r < 20; r++) {
      const inputs = ctx.log.entries.slice(-30).map((e) => e.hash)
      await ctx.log.appendAsWorkspace('round', { round: r + 1, mode: 'weave', lastSeq: ctx.log.head().seq, inputs, next: [{ kind: 'ask', action: words(1, r), why: words(2, r), holds: [] }], connections: [{ between: [agents[r % 10].id.did, agents[(r + 3) % 10].id.did], why: words(1, r) }] })
    }
    for (let i = 0; i < 120; i++) await asAgent(i % 10, 'note', { text: words(3, i), kind: 'message' })
    // the viewer: the page's live stream, read the way the browser does
    const res = await fetch(`${base}/api/events`), reader = res.body.getReader(), dec = new TextDecoder()
    stream = { bytes: 0, events: [], buf: '' }
    ;(async () => {
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ done: true })); if (done) return
        stream.bytes += value.byteLength; stream.buf += dec.decode(value, { stream: true })
        let i; while ((i = stream.buf.indexOf('\n\n')) >= 0) { const block = stream.buf.slice(0, i + 2); stream.buf = stream.buf.slice(i + 2); if (block.startsWith('event: entry')) stream.events.push({ bytes: Buffer.byteLength(block), entry: JSON.parse(block.split('\ndata: ')[1]) }) }
      }
    })()
    stream.reader = reader
  })
  after(async () => { await stream?.reader.cancel().catch(() => {}); await ctx.stop(); rmSync(dir, { recursive: true, force: true }) })

  const heard = async (hash) => { for (let i = 0; i < 200; i++) { const ev = stream.events.find((x) => x.entry.hash === hash); if (ev) return ev; await new Promise((r) => setTimeout(r, 10)) } throw new Error('the stream never brought it') }

  test('a plain line costs the line, not the room; the page\'s copy stays the server\'s', async (t) => {
    const S = await (await fetch(`${base}/api/state`)).json()
    const state = await sizeOf('/api/state'), map = await sizeOf('/api/map')
    const cost = {}
    const one = async (label, post) => {
      const e = await post(), ev = await heard(e.hash), need = refetchFor(S, ev.entry)
      take(S, ev.entry)
      cost[label] = { before: ev.bytes + state + map, after: ev.bytes + (need.state ? state : 0) + (need.map ? map : 0) }
      return need
    }
    assert.deepEqual(await one('a plain note from an agent', () => asAgent(2, 'note', { text: words(3, 900), kind: 'message' })), { state: false, map: false })
    assert.deepEqual(await one('a plain note from a person', () => send(people[4], 'note', { text: 'Agreed, let us run it tomorrow.', kind: 'message' })), { state: false, map: false })
    assert.deepEqual(await one('a vote', () => asAgent(5, 'vote', { proposal: proposals[3], choice: 'for', reason: 'it passed' })), { state: true, map: false })
    assert.deepEqual(await one('a new person joins', () => send(newIdentity(), 'join', { name: 'Person New' })), { state: true, map: true })

    // what the page patched in for the plain lines is what the server's own state says now (the vote and the join
    // were fetched again, so only the head and counts the page kept itself are compared)
    const now = await (await fetch(`${base}/api/state`)).json()
    assert.deepEqual(S.head, now.head); assert.deepEqual(S.counts, now.counts)
    for (const p of now.people.filter((x) => x.kind === 'agent')) assert.equal(S.people.find((x) => x.did === p.did)?.lastSaid, p.lastSaid, p.name)

    // a busy minute, a line a second: mostly talk, some votes, a proposal and a round. Before: the state and the map
    // after every line (lines came more than 250 ms apart). After: what the pacer actually fetches.
    const minute = Array.from({ length: 60 }, (_, i) => (i % 7 === 3 ? 'vote' : i === 30 ? 'propose' : i === 45 ? 'round' : 'note'))
    const sse = cost['a plain note from an agent'].after, fetched = [], time = fakeTime()
    const pace = pacer((m) => fetched.push(m), { clock: time.clock, timers: time.timers })
    for (const [s, kind] of minute.entries()) {
      await time.until(s * 1000)
      if (kind !== 'note') pace.soon(refetchFor(S, line(kind, kind === 'round' ? S.workspace : people[0].did)).map)
    }
    await time.until(70_000)
    cost['a busy minute (60 lines)'] = { before: 60 * (sse + state + map), after: 60 * sse + fetched.length * state + fetched.filter(Boolean).length * map }

    const kb = (n) => `${(n / 1024).toFixed(1)} KB`
    t.diagnostic(`this room: state ${kb(state)}, map ${kb(map)}, one line on the stream ${kb(sse)}`)
    for (const [label, c] of Object.entries(cost)) t.diagnostic(`${label.padEnd(30)} before ${kb(c.before).padStart(9)}   after ${kb(c.after).padStart(9)}   (${Math.round(100 * c.after / c.before)}%)`)
    assert.ok(state > 50_000, `the room is big enough to show it (${kb(state)})`)
    for (const label of ['a plain note from an agent', 'a plain note from a person']) assert.ok(cost[label].after < 0.05 * cost[label].before && cost[label].after < 8_000, `${label}: ${kb(cost[label].after)}`)
    assert.ok(cost['a busy minute (60 lines)'].after < 0.3 * cost['a busy minute (60 lines)'].before, kb(cost['a busy minute (60 lines)'].after))
  })
})
