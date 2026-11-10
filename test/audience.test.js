// A people-only line (a note with audience: 'people') is read by signed-in people and by nothing else: no agent by any
// door, and none of the room's own AI. A unique phrase goes into one, and the tests look everywhere an agent or the
// room's AI can read for it. The room is started the way production starts it (closed, behind the gate).
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { NAME_OF, TYPES, signedDocument } from '../src/shared/types.js'
import * as views from '../src/server/views.js'
import { canSee, forAgents, isPeopleOnly, isPerson } from '../src/server/audience.js'
import { startRoom } from './helpers/room.js'

const PHRASE = 'zanzibar-quokka-7731'
const HASH = 'f'.repeat(64)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const expires = () => new Date(Date.now() + 86400000).toISOString()

describe('people-only lines', () => {
  let room, A, B, agent, token, secret, secretHash, ctx
  const asPerson = (m, name, payload, extra = {}) => room.say(m.id, name, payload, extra)
  const rpc = async (path, method, params, cookie) => {
    const r = await room.call(path, { method: 'POST', cookie, headers: { accept: 'application/json, text/event-stream' }, body: { jsonrpc: '2.0', id: 1, method, params } })
    return { status: r.status, text: r.text }
  }
  const noPhrase = (what, text) => { assert.ok(!String(text).includes(PHRASE), `${what} must not carry the phrase`); assert.ok(!String(text).includes(secretHash), `${what} must not carry the line's hash`) }

  before(async () => {
    room = await startRoom({ options: { awayGatherMs: 0 } }); ctx = room.ctx
    A = await room.firstMember('Person A'); B = await room.newMember(A.id, 'Person B')
    assert.equal((await room.linkGithub(A)).status, 201) // an agent is made only after its person has linked repositories
    const made = (await asPerson(A, 'host', { label: 'Helper', repos: ['acme/app'] })).body.hosted
    assert.ok(made?.connector, 'an agent was made')
    agent = made.did; token = made.connector.split('/mcp/a/')[1]
    await asPerson(A, 'delegate', { delegate: agent, scope: ['note', 'propose', 'vote'], label: 'Helper', repos: ['acme/app'] }, { expiresAt: expires() })
    // something public first, so there is a conversation to compare with
    await asPerson(A, 'note', { text: 'A public hello for everyone', kind: 'message' })
    const r = await asPerson(A, 'note', { text: `Only people may read this ${PHRASE}?`, kind: 'message', audience: 'people' })
    assert.equal(r.status, 201, r.text)
    secret = r.body; secretHash = r.body.hash
  })
  after(() => room.stop())

  test('the rule is one function: only a person sees a people-only line, and the safe default is the agents\' view', () => {
    assert.ok(isPeopleOnly(secret))
    assert.ok(!isPeopleOnly(ctx.log.entries.find((e) => NAME_OF[e.type] === 'join')))
    assert.ok(isPerson({ kind: 'human', did: null }))
    for (const viewer of [undefined, null, {}, { kind: 'agent', did: agent }, { kind: 'robot' }]) { assert.ok(!canSee(viewer, secret), JSON.stringify(viewer)); assert.ok(canSee(viewer, ctx.log.entries[0])) }
    assert.ok(canSee({ kind: 'human', did: A.id.did }, secret))
    assert.ok(!forAgents(secret))
  })

  test('a person signed in sees it: the log, one entry, the messages and the live stream', async () => {
    for (const m of [A, B]) {
      const log = await room.call('/api/log?limit=500', { cookie: m.cookie })
      assert.ok(log.text.includes(PHRASE), 'the log')
      assert.equal((await room.call(`/api/log/${secretHash}`, { cookie: m.cookie })).status, 200)
      assert.ok((await room.call('/api/messages?limit=100', { cookie: m.cookie })).text.includes(PHRASE), 'messages')
    }
    const ac = new AbortController()
    const res = await fetch(`${room.base}/api/events`, { headers: { cookie: B.cookie }, signal: ac.signal })
    const reader = res.body.getReader(); let buf = ''
    const pump = (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) break; buf += new TextDecoder().decode(value); } } catch { /* aborted */ } })()
    await sleep(50)
    await asPerson(A, 'note', { text: `And another one ${PHRASE}`, kind: 'message', audience: 'people' })
    await sleep(150)
    ac.abort(); await pump.catch(() => {})
    assert.ok(buf.includes(`And another one ${PHRASE}`), 'a person\'s stream carries a people-only line')
  })

  test('with no session every read route is a 401 and tells nothing; the functions behind them give an agent nothing', async () => {
    for (const path of ['/api/log', `/api/log/${secretHash}`, '/api/messages', '/api/state', '/api/events', '/api/wait?timeout=0', '/api/verify', `/api/files/${HASH}`, `/api/photos/${HASH}`, `/media/${HASH}`]) {
      const r = await room.call(path)
      assert.equal(r.status, 401, path); noPhrase(path, r.text)
    }
    // what the routes call, with the agents' view (no viewer, or an agent)
    for (const viewer of [undefined, { kind: 'agent', did: agent }]) {
      noPhrase('entries', JSON.stringify(views.entries(ctx, { limit: 500 }, viewer)))
      noPhrase('messages', JSON.stringify(views.messages(ctx, { limit: 100, me: agent }, viewer)))
      noPhrase('messages forMe', JSON.stringify(views.messages(ctx, { limit: 100, me: agent, forMe: '1' }, viewer)))
      assert.equal(views.entry(ctx, secretHash, viewer), null)
      assert.equal(views.message(ctx, secret, agent, viewer), null)
    }
    assert.ok(JSON.stringify(views.entries(ctx, { limit: 500 }, { kind: 'human', did: A.id.did })).includes(PHRASE))
  })

  test('the room\'s state makes no task, count or summary from it', async () => {
    const st = ctx.log.state
    const publicNotes = ctx.log.entries.filter((e) => NAME_OF[e.type] === 'note' && !isPeopleOnly(e)).length
    assert.equal(st.counts.note, publicNotes, 'the note count is of public lines only')
    const before = JSON.stringify({ counts: st.counts, tasks: [...st.tasks.keys()] })
    // a task cannot ride on one (it would show on the list agents read)
    const t = await asPerson(A, 'note', { text: `Do the thing ${PHRASE}`, kind: 'message', audience: 'people', task: { for: B.id.did } })
    assert.equal(t.status, 400); assert.match(t.body.payload.message, /plain words/)
    assert.equal(JSON.stringify({ counts: ctx.log.state.counts, tasks: [...ctx.log.state.tasks.keys()] }), before)
    assert.ok(ctx.log.state.peopleNotes >= 2)
    noPhrase('state', JSON.stringify(views.state(ctx)))
    const withSession = await room.call('/api/state', { cookie: A.cookie }); noPhrase('/api/state', withSession.text)
    assert.ok(!('peopleNotes' in views.state(ctx)))
  })

  test('every MCP tool, over the public /mcp and over an agent\'s own link, leaves it out', async () => {
    // the public /mcp (a session is needed to reach it; its answers are the agents' view whoever asks)
    const list = await rpc('/mcp', 'tools/list', {}, A.cookie)
    const tools = [...list.text.matchAll(/"name":\s*"([a-z_]+)"/g)].map((m) => m[1])
    assert.ok(tools.includes('read_log') && tools.includes('get_entry') && tools.includes('overview'))
    const args = { read_log: { after: -1, limit: 200 }, get_entry: { hash: secretHash }, participant: { did: A.id.did }, resources: {}, proposals: {}, overview: {}, map: {}, verify_log: {} }
    for (const [name, a] of Object.entries(args)) { const r = await rpc('/mcp', 'tools/call', { name, arguments: a }, A.cookie); assert.equal(r.status, 200, name); noPhrase(`/mcp ${name}`, r.text) }
    assert.match((await rpc('/mcp', 'tools/call', { name: 'get_entry', arguments: { hash: secretHash } }, A.cookie)).text, /no entry with that hash/)
    // an agent's own link: the plain /call routes and the MCP seat
    const link = `/mcp/a/${token}`
    const tl = await room.call(`${link}/tools`); const names = JSON.parse(tl.text).map((t) => t.name)
    assert.ok(names.includes('listen') && names.includes('inbox') && names.includes('read_file'))
    const got = {}
    for (const name of ['whoami', 'who_is_here', 'listen', 'inbox', 'overview', 'map', 'resources', 'steps']) { const r = await room.call(`${link}/call/${name}`); got[name] = r.text; noPhrase(`call/${name}`, r.text) }
    assert.ok(got.listen.includes('A public hello'), 'the public line is there (the check is not vacuous)')
    for (const name of ['read_file', 'see_photo']) { const r = await room.call(`${link}/call/${name}`, { method: 'POST', body: name === 'read_file' ? { file: HASH } : { photo: HASH, sha256: HASH } }); noPhrase(`call/${name}`, r.text) }
    const seat = await rpc(link, 'tools/list', {}); assert.equal(seat.status, 200)
    for (const name of ['listen', 'inbox', 'overview', 'whoami']) { const r = await rpc(link, 'tools/call', { name, arguments: {} }); noPhrase(`seat ${name}`, r.text) }
    // reading the line itself by its hash, through the tool built for that
    const byHash = await room.call(`${link}/call/say`, { method: 'POST', body: { text: 'replying to something I cannot see', reply_to: secretHash } }); noPhrase('say reply_to', byHash.text)
    assert.ok(!ctx.log.entries.some((e) => e.document.threadId === secret.document.id), 'no line was made in reply to it')
  })

  test('a wait and a wake notice never carry it, and a people-only question wakes no one', async () => {
    const notices = []
    ctx.waker.post = async (a, hook, body) => { notices.push(body) }
    await ctx.waker.set(agent, 'https://wake.example/hook', ['direct', 'room', 'any', 'mention'])
    // the plain way to wait: held open, then answered at the timeout
    const link = `/mcp/a/${token}`
    const waiting = room.call(`${link}/call/wait`, { method: 'POST', body: { seconds: 2, since: ctx.log.head().seq } })
    await sleep(100)
    const asked = await asPerson(A, 'note', { text: `Helper, are you there ${PHRASE}?`, kind: 'message', audience: 'people' })
    assert.equal(asked.status, 201)
    const w = await waiting; noPhrase('wait', w.text)
    assert.match(w.text, /"woke":\s*false/, 'a people-only question did not wake the waiting agent')
    await sleep(100); assert.equal(notices.length, 0, 'and sent no wake notice')
    // a plain wait (as=text) over the plain route
    const text = await room.call(`${link}/call/wait`, { method: 'POST', body: { seconds: 1, since: asked.body.seq - 1 } }); noPhrase('wait after the line', text.text); assert.doesNotMatch(text.text, /"woke":\s*true/)
    // the same question in the open does wake it (the check works)
    const again = room.call(`${link}/call/wait`, { method: 'POST', body: { seconds: 3, since: ctx.log.head().seq } })
    await sleep(100)
    await asPerson(A, 'note', { text: 'Helper, are you there in the open?', kind: 'message' }, { recipient: agent })
    const w2 = await again; assert.match(w2.text, /"woke":\s*true/)
    await sleep(100); assert.ok(notices.length >= 1, 'a public line sends a notice'); for (const n of notices) noPhrase('notice', JSON.stringify(n))
    // and a wake preview is the line's first 280 characters: a people-only line has none
    const long = `Helper ${PHRASE} ` + 'x'.repeat(300)
    await asPerson(A, 'note', { text: long, kind: 'message', audience: 'people' }); await sleep(100)
    for (const n of notices) noPhrase('notice after', JSON.stringify(n))
  })

  test('the weaver, the facilitator and away answers are never given it', async () => {
    const sent = []
    const llm = { configured: true, model: 'test/model', route: () => ({}), chat: async (messages) => { sent.push(JSON.stringify(messages)); return { model: 'test/model', latencyMs: 1, usage: { total_tokens: 1 }, finishReason: 'stop', jsonMode: true, content: '{"reply": null, "remember": null, "heard": [], "threads": [], "agreements": [], "conflicts": [], "connections": [], "next": []}' } } }
    ctx.llm = llm; ctx.weaver.llm = llm
    // the weaver hears new lines: its inputs, its context and the prompt it would send
    await asPerson(B, 'note', { text: 'Alpha and Beta should try an MLS run together', kind: 'intention' })
    const inputs = ctx.weaver.newInputs()
    assert.ok(inputs.some((e) => e.document.payload.text?.includes('MLS')), 'it hears public lines')
    assert.ok(!inputs.some(isPeopleOnly), 'but not people-only ones')
    noPhrase('weaver context', JSON.stringify(ctx.weaver.context(inputs))); noPhrase('weaver intentions/connections', JSON.stringify([ctx.weaver.intentions({ map: { projects: [{ slug: 'phrase', name: PHRASE }] } }), ctx.weaver.connections({ map: { projects: [{ slug: 'quokka', name: 'quokka' }], ways: [] } })]))
    for (const mode of ['weave', 'facilitate']) {
      ctx.log.state.mode = { mode, by: A.id.did, seq: 0, reason: '' }
      sent.length = 0; await ctx.weaver.round(); await ctx.facilitator.tick(Date.now() + 120_000)
      assert.ok(sent.length >= 1, `${mode}: the model was asked something`)
      for (const s of sent) noPhrase(`${mode} model input`, s)
      assert.ok(sent.some((s) => s.includes('MLS')), `${mode}: and it was given the public lines`)
    }
    // the facilitator's reading of a thread, and its board
    noPhrase('facilitator thread', JSON.stringify(ctx.facilitator.threadText(secret.document.id))); noPhrase('facilitator view', JSON.stringify(ctx.facilitator.view()))
    // away: set up, then a public line to the agent; the model sees the recent public notes and none of ours
    await asPerson(A, 'away', { agent, enabled: true, on: ['direct'], perHour: 20, model: 'fast' })
    sent.length = 0
    await asPerson(A, 'note', { text: `Only people ${PHRASE} again`, kind: 'message', audience: 'people' })
    await asPerson(B, 'note', { text: 'Helper, what does your person think of MLS?', kind: 'message' }, { recipient: agent })
    for (let i = 0; i < 30 && !sent.length; i++) await sleep(50)
    assert.ok(sent.length, 'away answered the public line to it'); for (const s of sent) noPhrase('away model input', s)
    assert.ok(sent.some((s) => s.includes('what does your person think')), 'and its input held the public line')
    // a people-only line is never a trigger and never in an away answer's view of the room
    sent.length = 0
    await asPerson(A, 'note', { text: `Is anyone there ${PHRASE}?`, kind: 'message', audience: 'people' }); await sleep(150)
    assert.equal(sent.length, 0, 'a people-only line makes no away answer')
  })

  test('the room check and the host read nothing of it: it only ever reads as an agent would', async () => {
    // the check walks the newcomer's path through the connector and /api/wait, both of which are the agents' view; its own
    // fixed lines are not people-only; the host's welcome is built from names, not lines
    assert.ok(!ctx.log.entries.filter((e) => ctx.check.dids().includes(e.author)).some(isPeopleOnly))
    const hostSource = ctx.host.guides(B.id.did)
    noPhrase('the host\'s guides', JSON.stringify(hostSource))
  })

  test('who may write it, and how a line is shared', async () => {
    // an agent cannot write one (the room would have to let AIs write what AIs cannot read)
    const del = ctx.log.state.activeDelegation(agent)
    const viaAgent = await room.call(`/mcp/a/${token}/call/say`, { method: 'POST', body: { text: 'trying to hide something', audience: 'people' } })
    assert.ok(!ctx.log.entries.some((e) => e.document.payload?.text === 'trying to hide something' && isPeopleOnly(e)), 'the hosted say tool made no people-only line')
    void viaAgent
    const direct = await ctx.log.accept(signedDocument(ctx.hosted.identityOf(agent), { type: TYPES.note, payload: { text: 'agent hiding', kind: 'message', audience: 'people' }, onBehalfOf: del.issuer, delegation: del.hash }), { approved: true }).catch((e) => e)
    assert.equal(direct.status, 403, 'an agent\'s people-only line is refused'); assert.match(direct.message, /only a person/)
    // the room itself cannot either
    await assert.rejects(ctx.log.appendAsWorkspace('note', { text: 'x', kind: 'message', audience: 'sometimes' }).then((e) => { if (e) throw new Error('appended') }), /./).catch(() => {})
    // only the value 'people'
    const bad = await asPerson(A, 'note', { text: 'hello', kind: 'message', audience: 'friends' }); assert.equal(bad.status, 400); assert.match(bad.body.payload.message, /audience/)
    // no reply, recipient, task or step on a people-only line: nothing ties it to what AIs read
    const reply = await asPerson(A, 'note', { text: 'a reply', kind: 'message', audience: 'people' }, { threadId: ctx.log.entries.find((e) => e.document.payload?.text === 'A public hello for everyone').document.id })
    assert.equal(reply.status, 400)
    assert.equal((await asPerson(A, 'note', { text: 'to the agent', kind: 'message', audience: 'people' }, { recipient: agent })).status, 400)
    assert.equal((await asPerson(A, 'note', { text: 'step', kind: 'message', audience: 'people', step: { goal: 'x' } })).status, 400)

    // copying
    const copyOf = (id, from, text, extra = {}) => room.say(id, 'note', { text: text ?? from.document.payload.text, kind: 'message', copiedFrom: from.hash, ...extra })
    // someone else's line is refused
    const others = await copyOf(B.id, secret); assert.equal(others.status, 403); assert.match(others.body.payload.message, /your own/)
    // a copy of a line that does not exist, or of a public line, is refused
    assert.equal((await room.say(A.id, 'note', { text: 'x', kind: 'message', copiedFrom: HASH })).status, 400)
    const pub = ctx.log.entries.find((e) => e.document.payload?.text === 'A public hello for everyone')
    assert.equal((await copyOf(A.id, pub)).status, 400)
    // a copy says what the original says, and is not itself people-only
    assert.equal((await copyOf(A.id, secret, 'something else')).status, 400)
    assert.equal((await copyOf(A.id, secret, undefined, { audience: 'people' })).status, 400)
    // an agent cannot copy
    const viaAgentCopy = await ctx.log.accept(signedDocument(ctx.hosted.identityOf(agent), { type: TYPES.note, payload: { text: secret.document.payload.text, kind: 'message', copiedFrom: secret.hash }, onBehalfOf: del.issuer, delegation: del.hash }), { approved: true }).catch((e) => e)
    assert.ok(viaAgentCopy.status === 403 || viaAgentCopy.status === 400, 'an agent cannot copy a people-only line')
    // the person's own copy goes through, once (two at the same moment: one wins)
    const [one, two] = await Promise.all([copyOf(A.id, secret), copyOf(A.id, secret)])
    assert.deepEqual([one.status, two.status].sort(), [201, 403], 'a line is copied once, even when asked twice at once')
    const copy = [one, two].find((r) => r.status === 201).body
    assert.equal(copy.document.payload.copiedFrom, secret.hash)
    assert.ok(!isPeopleOnly(copy), 'the copy is an ordinary line')
    assert.equal((await copyOf(A.id, secret)).status, 403)
    // the copy is public; the original still is not
    const seat = await room.call(`/mcp/a/${token}/call/listen`)
    assert.ok(seat.text.includes(PHRASE), 'what the person shared is now readable by the agent')
    assert.ok(!seat.text.includes(secretHash), 'the original is still not there, by hash or otherwise')
    // and the rule survives a restart's replay (the copy is remembered from the log)
    assert.equal(ctx.log.copied.get(secret.hash), copy.hash)
  })

  test('files and photos on a people-only line are not handed to an agent', async () => {
    const sha = 'ab'.repeat(32), shared = 'cd'.repeat(32)
    const r = await asPerson(A, 'note', { text: 'a file for people', kind: 'message', audience: 'people', files: [{ sha256: sha, type: 'text/plain', name: 'notes.txt', bytes: 12 }] })
    assert.equal(r.status, 201, r.text)
    await asPerson(A, 'note', { text: 'a file for everyone', kind: 'message', files: [{ sha256: shared, type: 'text/plain', name: 'open.txt', bytes: 12 }] })
    for (const viewer of [undefined, { kind: 'agent', did: agent }]) {
      assert.equal(await views.fileText(ctx, sha, {}, viewer), null, 'no file for an agent')
      assert.equal(views.photo(ctx, sha, viewer), null)
      const seen = JSON.stringify(views.messages(ctx, { limit: 200 }, viewer))
      assert.ok(!seen.includes(sha) && !seen.includes('a file for people'), 'the line and its hash are not in what an agent hears'); assert.ok(seen.includes(shared), 'a public line\'s file is')
    }
    assert.ok(!(await room.call(`/mcp/a/${token}/call/listen`)).text.includes(sha))
    // a hash a public line also carries is public
    const both = await asPerson(A, 'note', { text: 'people file again', kind: 'message', audience: 'people', files: [{ sha256: shared, type: 'text/plain', name: 'open.txt', bytes: 12 }] })
    assert.equal(both.status, 201)
    assert.equal(views.photo(ctx, shared, undefined), null, 'it is a document, not a photo') // and fileText gets as far as the media store (nothing stored here)
    const hidden = await import('../src/server/audience.js'); assert.equal(hidden.hiddenFromAgents(ctx.log, shared), false); assert.equal(hidden.hiddenFromAgents(ctx.log, sha), true)
  })
})
