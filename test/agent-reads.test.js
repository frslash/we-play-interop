// An agent with its own key reads the closed room with a signed header (src/server/agent-read.js): fresh, single use,
// for that request only, by an agent with a live permission. The public /mcp takes a session or that header and nothing
// else. The real bridge (agent/bridge.js) is run end to end against the room, through an MCP client over stdio.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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
  const sign = (who, method, path, opts = {}) => agentReadHeader(who, method, path, { origin: room.base, ...opts })
  const read = (path, header, extra = {}) => room.call(path, { headers: { [AGENT_HEADER]: header ?? sign(agent, extra.method ?? 'GET', path) }, ...extra })
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
    const h = sign(agent, 'GET', '/api/state')
    assert.equal((await read('/api/state', h)).status, 200)
    const again = await read('/api/state', h); assert.equal(again.status, 401); assert.match(again.body.agent, /already used/)
  })

  test('a read signed more than 60 seconds ago (or that far ahead) is refused as stale', async () => {
    for (const ms of [-90_000, 90_000]) {
      const r = await read('/api/state', sign(agent, 'GET', '/api/state', { issuedAt: new Date(Date.now() + ms).toISOString() }))
      assert.equal(r.status, 401); assert.match(r.body.agent, /older than 60 seconds/)
    }
    assert.equal((await read('/api/state', sign(agent, 'GET', '/api/state', { issuedAt: new Date(Date.now() - 50_000).toISOString() }))).status, 200, 'fifty seconds is still fine')
  })

  test('the same nonce in a freshly signed document is refused too (the nonce is single use, not only the document)', async () => {
    const n = 'nonce_used_once_0123456789'
    assert.equal((await read('/api/state', sign(agent, 'GET', '/api/state', { nonce: n }))).status, 200)
    const again = await read('/api/state', sign(agent, 'GET', '/api/state', { nonce: n })); assert.equal(again.status, 401); assert.match(again.body.agent, /already used/)
  })

  test('a signed read is for reading: a valid header on a POST, PUT or DELETE is a 401, and so is a header signed for one', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const r = await room.call('/api/state', { method, headers: { [AGENT_HEADER]: sign(agent, 'GET', '/api/state') } })
      assert.equal(r.status, 401, method); assert.match(r.body.agent, /GET and HEAD only/)
      const r2 = await room.call('/api/draft', { method, headers: { [AGENT_HEADER]: sign(agent, method, '/api/draft') }, body: {} })
      assert.equal(r2.status, 401, method)
    }
    const post = await room.call('/api/draft', { method: 'POST', headers: { [AGENT_HEADER]: sign(agent, 'POST', '/api/draft') }, body: {} })
    assert.equal(post.status, 401); assert.match(post.body.agent, /GET and HEAD only/)
    assert.equal((await read('/api/state', sign(agent, 'GET', '/api/state'), { method: 'HEAD' })).status, 401, 'a GET signature is not a HEAD signature')
    assert.equal((await read('/api/state', sign(agent, 'HEAD', '/api/state'), { method: 'HEAD' })).status, 200, 'HEAD signed for HEAD is let in')
  })

  test('a read is for one room: a header signed for another origin is refused', async () => {
    for (const origin of ['https://other.example', room.base.replace('127.0.0.1', 'localhost'), room.base.replace('http:', 'https:')]) {
      const r = await read('/api/state', sign(agent, 'GET', '/api/state', { origin })); assert.equal(r.status, 401, origin); assert.match(r.body.agent, /different room, method or path/)
    }
  })

  test('the wrong signer: a person, a stranger, or a header whose issuer is not the key that signed it', async () => {
    for (const who of [a.id, newIdentity()]) assert.equal((await read('/api/state', sign(who, 'GET', '/api/state'))).status, 401)
    const forged = JSON.parse(Buffer.from(sign(newIdentity(), 'GET', '/api/state'), 'base64url').toString())
    forged.issuer = agent.did // the agent's name on someone else's signature
    const r = await read('/api/state', Buffer.from(JSON.stringify(forged)).toString('base64url')); assert.equal(r.status, 401); assert.match(r.body.agent, /signature/)
  })

  test('rubbish in the header is refused, and a header does not open what is open anyway for a person\'s cookie', async () => {
    for (const h of ['not-base64-json', Buffer.from('{}').toString('base64url'), 'a'.repeat(5000)]) assert.equal((await read('/api/state', h)).status, 401)
    assert.equal((await room.call('/api/state', { cookie: a.cookie, headers: { [AGENT_HEADER]: 'junk' } })).status, 200, 'a person with a session is a person, whatever else they send')
  })

  test('the public /mcp takes a person\'s session and nothing else: a signed read is not for a POST', async () => {
    assert.equal((await room.call('/mcp', { method: 'POST', headers: MCP, body: listTools })).status, 401)
    assert.equal((await room.call('/mcp', { method: 'POST', headers: { ...MCP, 'x-inwove-agent': 'junk' }, body: listTools })).status, 401)
    const stranger = await room.call('/mcp', { method: 'POST', headers: { ...MCP, [AGENT_HEADER]: sign(newIdentity(), 'POST', '/mcp') }, body: listTools }); assert.equal(stranger.status, 401)
    const person = await room.call('/mcp', { method: 'POST', cookie: a.cookie, headers: MCP, body: listTools }); assert.equal(person.status, 200)
    assert.ok(person.text.includes('overview'))
    const viaAgent = await room.call('/mcp', { method: 'POST', headers: { ...MCP, [AGENT_HEADER]: sign(agent, 'POST', '/mcp') }, body: listTools }); assert.equal(viaAgent.status, 401, 'MCP is a POST: an agent that holds its own key uses the bridge, which reads signed and writes signed lines')
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

describe('a hosted agent\'s link', () => {
  let room, a
  before(async () => { room = await startRoom(); a = await room.firstMember('Person A'); assert.equal((await room.linkGithub(a)).status, 201) })
  after(() => room.stop())

  test('a hosted agent\'s link: every answer under it says no-referrer, the token is kept only as a hash, and removing the agent stops the link', async () => {
    const made = await room.say(a.id, 'host', { label: 'Linked', repos: ['acme/app'] })
    assert.equal(made.status, 201, made.text)
    const link = new URL(made.body.hosted.connector).pathname, token = link.split('/').pop(), did = made.body.hosted.did
    // every response on the link, whatever it is: the guide, a tool list, a tool call, an unknown tool, a wrong method, the MCP seat, an unknown link
    const answers = [
      await room.call(link), await room.call(link + '/tools'), await room.call(link + '/call/whoami'), await room.call(link + '/call/nothing'),
      await room.call(link + '/call/say'), await room.call(link, { method: 'POST', headers: MCP, body: listTools }),
      await room.call('/mcp/a/not-a-real-link/tools'), await room.call('/mcp/a/'), await room.call('/mcp/a/' + token + 'x', { method: 'POST', headers: MCP, body: listTools }),
    ]
    for (const r of answers) assert.equal(r.headers.get('referrer-policy'), 'no-referrer', `${r.status} ${r.url}`)
    assert.equal(answers[1].status, 200)
    // hash only at rest: the secret is in no table, and the stored value is its hash
    const { rows: tables } = await room.ctx.db.query("select table_name from information_schema.tables where table_schema = 'public'")
    for (const { table_name: t } of tables) assert.ok(!JSON.stringify((await room.ctx.db.query(`select * from "${t}"`)).rows).includes(token), `the link's secret is not in ${t}`)
    const row = (await room.ctx.db.query('select token_hash from hosted_agents where did = $1', [did])).rows[0]
    assert.equal(row.token_hash, createHash('sha256').update(token).digest('hex'))
    assert.ok(!JSON.stringify(room.ctx.hosted.byTokenHash.values().next().value).includes(token) && ![...room.ctx.hosted.byTokenHash.keys()].includes(token), 'nor in memory, as a key')
    // removing the agent stops the link
    assert.equal((await room.say(a.id, 'delegate', { delegate: did, scope: ['note'], repos: ['acme/app'] }, { expiresAt: new Date(Date.now() + 86400000).toISOString() })).status, 201, 'its person switches it on')
    assert.equal((await room.call(link + '/tools')).status, 200)
    const rm = await room.say(a.id, 'remove', { agent: did }); assert.equal(rm.status, 201, rm.text)
    for (const r of [await room.call(link + '/tools'), await room.call(link), await room.call(link, { method: 'POST', headers: MCP, body: listTools })]) { assert.equal(r.status, 404); assert.equal(r.headers.get('referrer-policy'), 'no-referrer') }
    assert.equal((await room.ctx.db.query('select 1 from hosted_agents where did = $1', [did])).rows.length, 0)
  })
})
