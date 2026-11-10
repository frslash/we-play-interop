// An agent with its own key reads the closed room with a signed header (src/server/agent-read.js): fresh, single use,
// for that request only, by an agent with a live permission. The public /mcp takes a session or that header and nothing
// else. The real bridge (agent/bridge.js) is run end to end against the room, through an MCP client over stdio.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { after, before, describe, test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { newIdentity } from '../src/shared/did.js'
import { AGENT_HEADER, agentReadHeader } from '../src/shared/agent-read.js'
import { TYPES, signedDocument } from '../src/shared/types.js'
import { startRoom } from './helpers/room.js'

const MCP = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
const listTools = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }

describe('an agent with its own key reads with a signed header', () => {
  let room, a, agent, delegation
  const read = (path, header, extra = {}) => room.call(path, { headers: { [AGENT_HEADER]: header ?? agentReadHeader(agent, extra.method ?? 'GET', path) }, ...extra })
  before(async () => {
    room = await startRoom(); a = await room.firstMember('Person A'); agent = newIdentity()
    assert.equal((await room.linkGithub(a)).status, 201)
    const before = await read('/api/state'); assert.equal(before.status, 401, 'before its person signs a permission, the agent is nobody')
    assert.match(before.body.agent, /no live permission/)
    const d = await room.say(a.id, 'delegate', { delegate: agent.did, scope: ['note'], repos: ['acme/app'] }, { expiresAt: new Date(Date.now() + 86400000).toISOString() })
    assert.equal(d.status, 201, d.text); delegation = d.body.hash
  })
  after(() => room.stop())

  test('a fresh signed read of the request is let in, with its query, and counted', async () => {
    assert.equal((await read('/api/state')).status, 200)
    assert.equal((await read('/api/log?after=-1&limit=2')).status, 200)
    const info = (await room.call('/api/info', { cookie: a.cookie })).body.agentReads
    assert.ok(info.allowed >= 2 && info.refused['no live permission'] >= 1, JSON.stringify(info))
  })

  test('the same header twice: the second is refused as already used', async () => {
    const h = agentReadHeader(agent, 'GET', '/api/state')
    assert.equal((await read('/api/state', h)).status, 200)
    const again = await read('/api/state', h); assert.equal(again.status, 401); assert.match(again.body.agent, /already used/)
  })

  test('a read signed more than two minutes ago (or that far ahead) is refused as stale', async () => {
    for (const ms of [-3 * 60_000, 3 * 60_000]) {
      const r = await read('/api/state', agentReadHeader(agent, 'GET', '/api/state', { issuedAt: new Date(Date.now() + ms).toISOString() }))
      assert.equal(r.status, 401); assert.match(r.body.agent, /older than two minutes/)
    }
    assert.equal((await read('/api/state', agentReadHeader(agent, 'GET', '/api/state', { issuedAt: new Date(Date.now() - 100_000).toISOString() }))).status, 200, 'a minute and a half is still fine')
  })

  test('a read is for one request: another path or method gets nothing', async () => {
    const h = agentReadHeader(agent, 'GET', '/api/state')
    const r = await read('/api/log', h); assert.equal(r.status, 401); assert.match(r.body.agent, /different method or path/)
    assert.equal((await read('/api/state', agentReadHeader(agent, 'POST', '/api/state'))).status, 401)
  })

  test('the wrong signer: a person, a stranger, or a header whose issuer is not the key that signed it', async () => {
    for (const who of [a.id, newIdentity()]) assert.equal((await read('/api/state', agentReadHeader(who, 'GET', '/api/state'))).status, 401)
    const forged = JSON.parse(Buffer.from(agentReadHeader(newIdentity(), 'GET', '/api/state'), 'base64url').toString())
    forged.issuer = agent.did // the agent's name on someone else's signature
    const r = await read('/api/state', Buffer.from(JSON.stringify(forged)).toString('base64url')); assert.equal(r.status, 401); assert.match(r.body.agent, /signature/)
  })

  test('rubbish in the header is refused, and a header does not open what is open anyway for a person\'s cookie', async () => {
    for (const h of ['not-base64-json', Buffer.from('{}').toString('base64url'), 'a'.repeat(5000)]) assert.equal((await read('/api/state', h)).status, 401)
    assert.equal((await room.call('/api/state', { cookie: a.cookie, headers: { [AGENT_HEADER]: 'junk' } })).status, 200, 'a person with a session is a person, whatever else they send')
  })

  test('the public /mcp takes a person\'s session or the header, and nothing else is let in', async () => {
    assert.equal((await room.call('/mcp', { method: 'POST', headers: MCP, body: listTools })).status, 401)
    assert.equal((await room.call('/mcp', { method: 'POST', headers: { ...MCP, 'x-inwove-agent': 'junk' }, body: listTools })).status, 401)
    const stranger = await room.call('/mcp', { method: 'POST', headers: { ...MCP, [AGENT_HEADER]: agentReadHeader(newIdentity(), 'POST', '/mcp') }, body: listTools }); assert.equal(stranger.status, 401)
    const person = await room.call('/mcp', { method: 'POST', cookie: a.cookie, headers: MCP, body: listTools }); assert.equal(person.status, 200)
    assert.ok(person.text.includes('overview'))
    const viaAgent = await room.call('/mcp', { method: 'POST', headers: { ...MCP, [AGENT_HEADER]: agentReadHeader(agent, 'POST', '/mcp') }, body: listTools }); assert.equal(viaAgent.status, 200); assert.ok(viaAgent.text.includes('overview'))
  })

  test('a hosted agent keeps its link: the secret in it is the credential, no header and no session', async () => {
    const made = await room.say(a.id, 'host', { label: 'Hosted', repos: ['acme/app'] })
    assert.equal(made.status, 201)
    const link = new URL(made.body.hosted.connector).pathname
    assert.equal((await room.call(link + '/tools')).status, 200)
    assert.equal((await room.call(link.slice(0, -3) + 'xxx/tools')).status, 404)
  })

  test('stopping the agent stops its reads: a revoked permission lets nothing in', async () => {
    assert.equal((await read('/api/state')).status, 200)
    assert.equal((await room.say(a.id, 'revoke', { delegation })).status, 201)
    const r = await read('/api/state'); assert.equal(r.status, 401); assert.match(r.body.agent, /no live permission/)
    assert.equal((await read('/api/log')).status, 401)
  })
})

describe('the bridge itself, end to end', () => {
  let room, a, dir
  before(async () => { room = await startRoom(); a = await room.firstMember('Person A'); dir = mkdtempSync(join(tmpdir(), 'wpi-bridge-')) })
  after(async () => { await room.stop(); rmSync(dir, { recursive: true, force: true }) })

  test('it reads the room by signing every call, and says so plainly until its person gives it a permission', async () => {
    const agent = newIdentity()
    const client = new Client({ name: 'test', version: '1' })
    const transport = new StdioClientTransport({ command: process.execPath, args: ['agent/bridge.js'], env: { PATH: process.env.PATH, WPI_URL: room.base, WPI_AGENT_KEY: agent.seedHex }, stderr: 'pipe' })
    let said = ''; transport.stderr?.on('data', (c) => { said += c })
    await client.connect(transport)
    try {
      const no = await client.callTool({ name: 'overview', arguments: {} })
      assert.ok(no.isError); assert.match(JSON.stringify(no), /no live permission/)
      assert.equal((await room.call('/api/participants/' + encodeURIComponent(agent.did), { cookie: a.cookie })).status, 404, 'the room has never heard of it')
      assert.equal((await room.linkGithub(a)).status, 201)
      assert.equal((await room.say(a.id, 'delegate', { delegate: agent.did, scope: ['note'], repos: ['acme/app'] }, { expiresAt: new Date(Date.now() + 86400000).toISOString() })).status, 201)
      const yes = await client.callTool({ name: 'overview', arguments: {} })
      assert.ok(!yes.isError, JSON.stringify(yes).slice(0, 300)); 
      const who = await client.callTool({ name: 'whoami', arguments: {} }); assert.ok(!who.isError); assert.ok(JSON.stringify(who).includes(agent.did))
      assert.ok(room.ctx.agentReads.stats.allowed >= 2)
    } finally { await client.close() }
    void said
  })
})
