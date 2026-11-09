import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { newIdentity } from '../src/shared/did.js'
import { AGENT_SCOPES, TYPES, signedDocument } from '../src/shared/types.js'
import { config as baseConfig } from '../src/server/config.js'
import { createApp } from '../src/server/index.js'

// A local agent (the bridge, holding its own key on its person's machine) hands the room a change with
// submit_change: the diff goes to POST /api/changes with its signed room:change line, and the room tests
// it and opens the pull request itself. Nothing on the agent's side needs a GitHub token.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PATCH = 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-# We Play Interop\n+# We Play Interop, from a local agent\n'
const sha = (t) => createHash('sha256').update(t).digest('hex')

describe('a change from a local agent', () => {
  let ctx, base, dir
  const person = newIdentity(), agent = newIdentity(), stranger = newIdentity()
  const send = async (id, name, payload, extra) => { const r = await fetch(`${base}/api/entries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signedDocument(id, { type: TYPES[name], payload, ...extra })) }); return { status: r.status, body: await r.json() } }
  let delegation
  const changeDoc = (id, payload, extra = { onBehalfOf: person.did, delegation }) => signedDocument(id, { type: TYPES.change, payload, ...extra })
  const hand = (doc, body) => fetch(`${base}/api/changes`, { method: 'POST', headers: { 'content-type': 'text/x-diff', 'x-wpi-change': JSON.stringify(doc) }, body })
  const queued = (h) => existsSync(join(dir, 'patches', 'queue', `${h}.json`))
  const kept = (h) => existsSync(join(dir, 'patches', `${h}.diff`))

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wpi-local-change-'))
    const board = { generated: new Date().toISOString().slice(0, 10), projects: [], credentialProfiles: { profiles: {} }, runs: [] }
    ctx = await createApp({ ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, githubToken: '', weaverIntervalMinutes: 0, weaverQuietMinutes: 0, ratePerMinute: 1000, publicUrl: 'https://interop.example', boardDataUrl: 'data:application/json,' + encodeURIComponent(JSON.stringify(board)), llm: { ...baseConfig.llm, apiKey: '', anthropicKey: '', provider: 'openai' } })
    await new Promise((r) => ctx.server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${ctx.server.address().port}`
    assert.equal((await send(person, 'join', { name: 'Person K' })).status, 201)
    assert.equal((await send(stranger, 'join', { name: 'Person S' })).status, 201)
    const d = await send(person, 'delegate', { delegate: agent.did, scope: AGENT_SCOPES, label: 'Local agent' }, { expiresAt: new Date(Date.now() + 86400000).toISOString() })
    assert.equal(d.status, 201, JSON.stringify(d.body))
    delegation = d.body.hash
  })
  after(async () => { await ctx.stop(); rmSync(dir, { recursive: true, force: true }) })

  test('a signed change with its diff is kept by its hash and queued for the keeper, crediting the agent and its person', async () => {
    const r = await hand(changeDoc(agent, { title: 'A brighter title', why: 'Agreed in the room.', sha256: sha(PATCH), bytes: Buffer.byteLength(PATCH) }), PATCH)
    assert.equal(r.status, 201, await r.clone().text())
    const out = await r.json()
    assert.equal(out.sha256, sha(PATCH))
    assert.equal(await (await fetch(`${base}/patches/${out.sha256}`)).text(), PATCH, 'anyone can read it before approving')
    const job = JSON.parse(readFileSync(join(dir, 'patches', 'queue', `${out.sha256}.json`), 'utf8'))
    assert.equal(job.agent, agent.did); assert.equal(job.person, person.did); assert.equal(job.entry, out.hash)
  })

  test('a diff that does not match what was signed is refused, and nothing is kept', async () => {
    const other = PATCH.replace('local agent', 'local agent!')
    const r = await hand(changeDoc(agent, { title: 'Swapped', sha256: sha(PATCH), bytes: Buffer.byteLength(PATCH) }), other)
    assert.equal(r.status, 400); assert.match((await r.json()).payload.message, /does not match/)
    assert.ok(!kept(sha(other)))
  })

  test('without a valid signature or a permission, nothing is kept or queued', async () => {
    const p = PATCH.replace('local agent', 'stranger'), payload = { title: 'Unsigned', sha256: sha(p), bytes: Buffer.byteLength(p) }
    const forged = { ...changeDoc(agent, payload), payload: { ...payload, title: 'Changed after signing' } }
    assert.equal((await hand(forged, p)).status >= 400, true)
    const noPermission = await hand(changeDoc(newIdentity(), payload, { onBehalfOf: person.did, delegation }), p)
    assert.equal(noPermission.status, 403)
    assert.ok(!kept(sha(p)) && !queued(sha(p)))
  })

  test('the room\'s rules for diffs hold here too: dependencies go through a person', async () => {
    const p = 'diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n@@ -1 +1 @@\n-{\n+{ \n'
    const r = await hand(changeDoc(agent, { title: 'Add a package', sha256: sha(p), bytes: Buffer.byteLength(p) }), p)
    assert.equal(r.status, 400); assert.match((await r.json()).payload.message, /go through a person/)
    assert.ok(!kept(sha(p)))
  })

  test('through the bridge: submit_change from a local agent with no GitHub token in its environment', async () => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/token|github|secret/i.test(k)))
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(ROOT, 'agent', 'bridge.js')], cwd: ROOT, env: { ...env, WPI_URL: base, WPI_AGENT_KEY: agent.seedHex }, stderr: 'ignore' })
    const client = new Client({ name: 'local-change-test', version: '0' })
    await client.connect(transport)
    try {
      const p = PATCH.replace('local agent', 'local agent, through the bridge')
      const res = await client.callTool({ name: 'submit_change', arguments: { title: 'From the bridge', why: 'Tested on my machine.', patch: p } })
      const out = JSON.parse(res.content[0].text)
      assert.equal(out.accepted, true, res.content[0].text)
      assert.equal(out.sha256, sha(p))
      assert.match(out.next, /No GitHub token/)
      assert.ok(queued(sha(p)), 'queued for the keeper')
      const line = ctx.log.byHash.get(out.id)
      assert.equal(line.author, agent.did); assert.equal(line.onBehalfOf, person.did)
    } finally { await client.close() }
  })
})
