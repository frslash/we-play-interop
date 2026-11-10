// An agent with its own key can now reach every HTTP route with a signed x-inwove-agent header (gate.js). A people-only
// line must still be read by nothing that is not a signed-in person: so the agent asks for every read route a person can,
// and a unique phrase planted in the line (and a file attached only to it) must be in none of the answers.
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { AGENT_HEADER, agentReadHeader } from '../src/shared/agent-read.js'
import { TYPES, signedDocument } from '../src/shared/types.js'
import { isPeopleOnly } from '../src/server/audience.js'
import { startRoom } from './helpers/room.js'

const PHRASE = 'zanzibar-quokka-4417'
const FILE_TEXT = 'file-body-marmoset-9902'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const expires = () => new Date(Date.now() + 86400000).toISOString()
const MCP = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png-body-lemur-3318')])

describe('an agent with its own key, by HTTP, against a people-only line', () => {
  let room, A, agent, delegation, secret, secretHash, fileSha, photoSha, publicSha
  /** One request as the agent: a read carries a header made for this very room, method and path (with its query); a write carries none (a signed read is for GET and HEAD only). */
  const asAgent = (path, { method = 'GET', body, headers = {} } = {}) => room.call(path, { method, body, headers: { ...(method === 'GET' || method === 'HEAD' ? { [AGENT_HEADER]: agentReadHeader(agent, method, path, { origin: room.base }) } : {}), ...headers } })
  // the planted words and files, and the hash of every people-only line there is now (a line's hash is a way to ask for it, and the
  // log's head and each line's parent name the line before it, so the hash must not ride out on those either)
  const clean = (what, text) => {
    const hashes = room.ctx.log.entries.filter(isPeopleOnly).map((e) => e.hash)
    assert.ok(hashes.length >= 1)
    for (const bad of [PHRASE, FILE_TEXT, 'png-body-lemur', fileSha, photoSha, ...hashes]) assert.ok(!String(text).includes(bad), `${what} must not carry ${bad.slice(0, 14)}`)
  }

  before(async () => {
    room = await startRoom({ options: { awayGatherMs: 0 } })
    A = await room.firstMember('Person A'); agent = newIdentity()
    assert.equal((await room.linkGithub(A)).status, 201)
    const d = await room.say(A.id, 'delegate', { delegate: agent.did, scope: ['note'], repos: ['acme/app'] }, { expiresAt: expires() })
    assert.equal(d.status, 201, d.text); delegation = d.body.hash
    fileSha = room.ctx.media.put(A.id.did, 'text/plain', Buffer.from(FILE_TEXT)).sha256
    photoSha = room.ctx.media.put(A.id.did, 'image/png', PNG).sha256
    publicSha = room.ctx.media.put(A.id.did, 'text/plain', Buffer.from('a public file body')).sha256
    await room.say(A.id, 'note', { text: 'A public hello for everyone', kind: 'message', files: [{ sha256: publicSha, type: 'text/plain', name: 'open.txt', bytes: 18 }] })
    const r = await room.say(A.id, 'note', { text: `Only people may read this ${PHRASE}`, kind: 'message', audience: 'people', files: [{ sha256: fileSha, type: 'text/plain', name: 'notes.txt', bytes: FILE_TEXT.length }], media: [{ sha256: photoSha, type: 'image/png', w: 2, h: 2 }] })
    assert.equal(r.status, 201, r.text); secret = r.body; secretHash = r.body.hash
    await room.say(A.id, 'note', { text: 'A public line right after it', kind: 'message' }) // its parent is the people-only line
  })
  after(() => room.stop())

  test('the agent is let in (the check below is not vacuous) and a person reads the line and its files', async () => {
    const log = await asAgent('/api/log?limit=500'); assert.equal(log.status, 200); assert.ok(log.text.includes('A public hello'))
    const person = await room.call('/api/log?limit=500', { cookie: A.cookie }); assert.ok(person.text.includes(PHRASE))
    for (const p of [`/api/files/${fileSha}`, `/api/photos/${photoSha}`, `/media/${fileSha}`, `/media/${photoSha}`]) assert.equal((await room.call(p, { cookie: A.cookie })).status, 200, p)
    assert.equal((await asAgent(`/api/files/${publicSha}`)).status, 200, 'a public line\'s file is readable')
    // the log's head and a line's parent are the chain's: a person is told the real ones, an agent the newest it may read
    const after = room.ctx.log.entries.find((e) => e.parent === secretHash)
    assert.ok(after, 'a public line follows the people-only one')
    assert.equal(person.body.entries.find((e) => e.hash === after.hash).parent, secretHash)
    const seen = (await asAgent('/api/log?limit=500')).body.entries.find((e) => e.hash === after.hash)
    assert.ok(seen && seen.parent !== secretHash && room.ctx.log.byHash.get(seen.parent), 'its parent, for an agent, is a line it can read')
    assert.equal((await asAgent('/api/log?limit=500')).body.head.hash, after.hash)
  })

  test('every read route, asked by the agent, tells nothing of the line, its hash or its files', async () => {
    const paths = ['/api/log', '/api/log?after=-1&limit=500', '/api/log?limit=500&type=note', `/api/log/${secretHash}`, '/api/messages', '/api/messages?limit=200', '/api/messages?forMe=1', '/api/state', '/api/steps', '/api/map', '/api/board', '/api/resources',
      '/api/wait?timeout=1', `/api/wait?me=${encodeURIComponent(agent.did)}&timeout=1&after=0`, `/api/wait?me=${encodeURIComponent(agent.did)}&after=0&as=text&timeout=1`, `/api/wait?me=${encodeURIComponent(agent.did)}&timeout=1`, '/api/info', '/api/verify', `/api/participants/${encodeURIComponent(A.id.did)}`, `/api/participants/${encodeURIComponent(agent.did)}`,
      `/api/credentials/${secretHash}`, `/api/files/${fileSha}`, `/api/photos/${photoSha}`, `/media/${fileSha}`, `/media/${photoSha}`, '/api/shelf', '/api/sources', '/api/workshop', '/api/session', '/api/me/pass', '/.well-known/did.jsonl', '/rules.json']
    for (const p of paths) {
      const r = await asAgent(p); clean(p, r.text)
      if (p === `/api/log/${secretHash}` || p.startsWith('/api/files/' + fileSha) || p.includes(photoSha) || p === `/media/${fileSha}`) assert.ok([401, 403, 404].includes(r.status), `${p}: ${r.status}`)
    }
    // the line is not even counted: the same answer as for a stranger's hash
    assert.equal((await asAgent(`/api/log/${secretHash}`)).status, 404)
    assert.equal((await asAgent(`/api/log/${'0'.repeat(64)}`)).status, 404)
    const st = await asAgent('/api/state'); assert.equal(st.status, 200); assert.ok(!('peopleNotes' in st.body))
    const info = await asAgent('/api/info'); assert.equal(info.status, 200); clean('/api/info', info.text)
  })

  test('the live stream carries a public line to the agent and never a people-only one', async () => {
    const ac = new AbortController()
    const res = await fetch(`${room.base}/api/events`, { headers: { [AGENT_HEADER]: agentReadHeader(agent, 'GET', '/api/events', { origin: room.base }) }, signal: ac.signal })
    assert.equal(res.status, 200)
    const reader = res.body.getReader(); let buf = ''
    const pump = (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) break; buf += new TextDecoder().decode(value) } } catch { /* aborted */ } })()
    await sleep(100)
    await room.say(A.id, 'note', { text: `Streamed to people only ${PHRASE}`, kind: 'message', audience: 'people' })
    await room.say(A.id, 'note', { text: 'Streamed in the open', kind: 'message' })
    await sleep(300)
    ac.abort(); await pump.catch(() => {})
    assert.ok(buf.includes('Streamed in the open'), 'the public line came (the check is not vacuous)')
    clean('/api/events', buf); assert.ok(!buf.includes('Streamed to people only'))
  })

  test('a wait that is open while a people-only line is written is not woken by it and carries nothing', async () => {
    const me = encodeURIComponent(agent.did), path = `/api/wait?me=${me}&timeout=2&after=${room.ctx.log.head().seq}`
    const waiting = asAgent(path); await sleep(100)
    await room.say(A.id, 'note', { text: `Wake the agent ${PHRASE}`, kind: 'message', audience: 'people' })
    const w = await waiting; clean('/api/wait', w.text); assert.doesNotMatch(w.text, /"woke":\s*true/); assert.match(w.text, /"woke":\s*false/); assert.doesNotMatch(w.text, /not an agent/, 'it was asked as the agent, so the wait was real')
  })

  test('the public /mcp does not open to the agent\'s header at all (it is a POST, and a signed read is for reading)', async () => {
    const rpc = (method, params) => room.call('/mcp', { method: 'POST', headers: { ...MCP, [AGENT_HEADER]: agentReadHeader(agent, 'GET', '/mcp', { origin: room.base }) }, body: { jsonrpc: '2.0', id: 1, method, params } })
    for (const r of [await rpc('tools/list', {}), await rpc('tools/call', { name: 'get_entry', arguments: { hash: secretHash } }), await rpc('tools/call', { name: 'read_log', arguments: { after: -1, limit: 200 } })]) { assert.equal(r.status, 401); clean('/mcp', r.text) }
  })

  test('what is a person\'s own is refused to the agent', async () => {
    for (const [method, path] of [['GET', '/api/me/pass'], ['POST', '/api/session/end'], ['POST', '/api/passkey/register/options'], ['GET', '/api/github/start'], ['GET', '/api/github/linking']]) {
      const r = await asAgent(path, { method })
      assert.ok(r.status === 401 || r.status === 403, `${method} ${path}: ${r.status} ${r.text.slice(0, 80)}`); assert.ok(!r.headers.get('set-cookie'), `${path} gave the agent a cookie`)
      assert.ok(!r.headers.get('location'), `${path} sent the agent on to GitHub`)
    }
    assert.equal((await room.call('/api/state', { cookie: A.cookie })).status, 200, 'and nobody was signed out')
  })

  test('the agent cannot write a people-only line, over HTTP with its own key', async () => {
    const note = (payload) => signedDocument(agent, { type: TYPES.note, payload, onBehalfOf: A.id.did, delegation })
    const r = await asAgent('/api/entries', { method: 'POST', body: note({ text: 'agent hiding', kind: 'message', audience: 'people' }) })
    assert.equal(r.status, 403); assert.match(r.text, /only a person/)
    const copy = await asAgent('/api/entries', { method: 'POST', body: note({ text: `Only people may read this ${PHRASE}`, kind: 'message', copiedFrom: secretHash }) })
    assert.ok(copy.status === 403 || copy.status === 400, `a copy by an agent: ${copy.status}`)
    assert.ok(!room.ctx.log.entries.some((e) => e.document.payload?.text === 'agent hiding' || (e.author === agent.did && e.document.payload?.copiedFrom)))
  })
})
