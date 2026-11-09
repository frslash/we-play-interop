// A person's task list (public/app.js "Your tasks"): a line that asks a person to do something becomes a task on
// their list. A person or an agent aims one with task: { for }, or the weaver spots the ask in its round and writes
// the task line itself, naming who asked. Only the person it is for (or their agent) says it is done, once.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { NAME_OF, TYPES, signedDocument } from '../src/shared/types.js'
import { config as baseConfig } from '../src/server/config.js'
import { createApp } from '../src/server/index.js'
import { createResolver } from '../src/server/resolver.js'
import { registerAgentTools } from '../src/agent-tools.js'

const BOARD = { generated: new Date().toISOString().slice(0, 10), projects: [], scenarios: [], runs: [] }

async function room () {
  const dir = mkdtempSync(join(tmpdir(), 'wpi-tasks-'))
  const config = { ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, githubToken: '', weaverIntervalMinutes: 0, weaverQuietMinutes: 0, ratePerMinute: 1000, voteMinutes: 10, publicUrl: 'https://interop.example', boardDataUrl: 'data:application/json,' + encodeURIComponent(JSON.stringify(BOARD)), llm: { ...baseConfig.llm, provider: 'openai', apiKey: '' } }
  const ctx = await createApp(config, { resolver: createResolver(), hostWelcomeMs: null })
  await new Promise((r) => ctx.server.listen(0, r))
  const base = `http://localhost:${ctx.server.address().port}`
  await ctx.board.refresh()
  ctx.weaver.llm = { configured: false }
  const send = async (id, name, payload, extra) => { const r = await fetch(`${base}/api/entries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signedDocument(id, { type: TYPES[name], payload, ...extra })) }); return { status: r.status, body: await r.json() } }
  const people = {}, agents = {}, dels = {}
  const exp = new Date(Date.now() + 86400000).toISOString()
  for (const [key, name, label] of [['a', 'Person A', 'North Agent'], ['b', 'Person B', 'South Agent']]) {
    people[key] = newIdentity(); agents[key] = newIdentity()
    assert.equal((await send(people[key], 'join', { name })).status, 201)
    dels[key] = (await send(people[key], 'delegate', { delegate: agents[key].did, scope: ['note', 'propose', 'vote'], label }, { expiresAt: exp })).body.hash
  }
  const as = (k, name, payload, extra) => send(agents[k], name, payload, { onBehalfOf: people[k].did, delegation: dels[k], ...extra })
  const tasks = async () => (await (await fetch(`${base}/api/state`)).json()).tasks
  await ctx.facilitator.tick()
  const stop = async () => { await ctx.stop(); rmSync(dir, { recursive: true, force: true }) }
  return { ctx, base, send, as, people, agents, tasks, st: () => ctx.log.state, stop }
}

describe('a person’s task list', () => {
  test('a line aimed at a person is a task on their list; never at an agent, and who asked is the one who said it', async () => {
    const r = await room()
    try {
      const ask = await r.send(r.people.a, 'note', { text: 'Can you sign the partner form today?', kind: 'message', task: { for: r.people.b.did } })
      assert.equal(ask.status, 201)
      const [t] = await r.tasks()
      assert.deepEqual({ for: t.for, forName: t.forName, by: t.by, byName: t.byName, text: t.text, doneAt: t.doneAt }, { for: r.people.b.did, forName: 'Person B', by: r.people.a.did, byName: 'Person A', text: 'Can you sign the partner form today?', doneAt: null })
      assert.equal(t.thread, r.ctx.log.byHash.get(ask.body.hash).document.id, 'its thread is the asking line’s own')
      // an agent aims one at a person too
      assert.equal((await r.as('a', 'note', { text: 'Person B, the key for the test community is yours to make', kind: 'message', task: { for: r.people.b.did } })).status, 201)
      assert.equal((await r.tasks()).length, 2)
      // never at an agent: agents get steps
      const atAgent = await r.send(r.people.a, 'note', { text: 'do it', kind: 'message', task: { for: r.agents.b.did } })
      assert.equal(atAgent.status, 400); assert.match(atAgent.body.payload.message, /tasks are for people/)
      // who asked, and the line it came from, are the weaver's to fill: nobody writes a task as asked by someone else
      const forged = await r.send(r.people.a, 'note', { text: 'Person B: pay the bill (asked by Person C)', kind: 'message', task: { for: r.people.b.did, by: r.people.b.did } })
      assert.equal(forged.status, 400); assert.match(forged.body.payload.message, /weaver's to fill/)
      assert.equal((await r.send(r.people.a, 'note', { text: 'x', kind: 'message', task: { for: 'not-a-did' } })).status, 400)
    } finally { await r.stop() }
  })

  test('only the person it is for (or their agent) says it is done, and only once', async () => {
    const r = await room()
    try {
      const t1 = (await r.send(r.people.a, 'note', { text: 'Review the join page', kind: 'message', task: { for: r.people.b.did } })).body.hash
      const t2 = (await r.send(r.people.a, 'note', { text: 'Answer the question on keys', kind: 'message', task: { for: r.people.b.did } })).body.hash
      const thread = r.ctx.log.byHash.get(t1).document.id
      const notYours = await r.send(r.people.a, 'note', { text: 'Did it: Review the join page', kind: 'message', taskDone: t1 }, { threadId: thread })
      assert.equal(notYours.status, 403); assert.match(notYours.body.payload.message, /only Person B/)
      assert.equal((await r.send(r.people.b, 'note', { text: 'Did it: Review the join page', kind: 'message', taskDone: t1 }, { threadId: thread })).status, 201)
      const done = (await r.tasks()).find((t) => t.hash === t1)
      assert.ok(done.doneAt); assert.equal(done.doneByName, 'Person B')
      const again = await r.send(r.people.b, 'note', { text: 'Did it again', kind: 'message', taskDone: t1 })
      assert.equal(again.status, 400); assert.match(again.body.payload.message, /done already/)
      // their agent says it for them
      assert.equal((await r.as('b', 'note', { text: 'Did it: Answer the question on keys', kind: 'message', taskDone: t2 })).status, 201)
      assert.ok((await r.tasks()).every((t) => t.doneAt))
      assert.equal((await r.send(r.people.b, 'note', { text: 'Did it', kind: 'message', taskDone: 'f'.repeat(64) })).status, 400)
    } finally { await r.stop() }
  })

  test('the weaver turns an ask aimed at a person into their task, once, and says who asked', async () => {
    const r = await room()
    try {
      const goal = (await r.send(r.people.a, 'propose', { kind: 'goal', title: 'The test community runs its first deploy' })).body.hash
      await r.send(r.people.a, 'vote', { proposal: goal, choice: 'for' })
      await r.ctx.facilitator.tick()
      const ask = (await r.as('a', 'note', { text: 'Person B, could you set up the deploy key on your account?', kind: 'message' })).body.hash
      const chat = (await r.as('b', 'note', { text: 'nice weather today', kind: 'message' })).body.hash
      const answer = { heard: [], threads: [], agreements: [], conflicts: [], connections: [], next: [], vague: [], converged: [],
        tasks: [
          { entry: ask, for: r.people.b.did, task: 'Set up the deploy key on your account' },
          { entry: chat, for: r.agents.a.did, task: 'never an agent' },
          { entry: 'f'.repeat(64), for: r.people.b.did, task: 'not a line of this round' },
        ] }
      r.ctx.weaver.llm = { configured: true, model: 'test/model', chat: async () => ({ model: 'test/model', latencyMs: 2, usage: { total_tokens: 5 }, finishReason: 'stop', jsonMode: true, content: JSON.stringify(answer) }) }
      const round = (await r.ctx.weaver.round()).document.payload
      assert.deepEqual(round.facilitate.tasked, [ask])
      const lines = r.ctx.log.entries.filter((e) => NAME_OF[e.type] === 'note' && e.document.payload.facilitator?.what === 'task')
      assert.equal(lines.length, 1)
      assert.equal(lines[0].document.payload.text, 'Person B: Set up the deploy key on your account (asked by North Agent)')
      assert.equal(lines[0].document.threadId, r.ctx.log.byHash.get(ask).document.id, 'in the asking line’s thread')
      const [t] = await r.tasks()
      assert.equal(t.text, 'Set up the deploy key on your account', 'the list shows just what to do')
      assert.equal(t.by, r.agents.a.did); assert.equal(t.byName, 'North Agent')
      // the same judgment again, after more talk: no second task from the same line
      await r.as('b', 'note', { text: 'ok, on it soon', kind: 'message' })
      answer.tasks = [{ entry: ask, for: r.people.b.did, task: 'Set up the deploy key' }]
      await r.ctx.weaver.round()
      assert.equal((await r.tasks()).length, 1)
      assert.ok(r.st().taskFrom.has(ask))
    } finally { await r.stop() }
  })

  test('an agent aims a line at a person with the say tool’s task_for', async () => {
    const tools = new Map(), acts = []
    const server = { registerTool: (name, _def, fn) => tools.set(name, fn) }
    const adapter = {
      read: async (path) => (path === '/api/state' ? { people: [{ did: 'did:key:z6MkPersonB', name: 'Person B', kind: 'human' }, { did: 'did:key:z6MkAgentA', name: 'North Agent', kind: 'agent' }] } : {}),
      act: async (name, payload, extra) => { acts.push({ name, payload, extra }); return { hash: 'a'.repeat(64) } },
    }
    registerAgentTools(server, adapter)
    await tools.get('say')({ text: 'Person B, the partner form is yours to sign', task_for: 'Person B' })
    assert.deepEqual(acts[0].payload.task, { for: 'did:key:z6MkPersonB' })
    const bad = await tools.get('say')({ text: 'hello', task_for: 'Nobody Here' })
    assert.equal(acts.length, 1, 'nothing is said when the person is not in the room')
    assert.match(JSON.stringify(bad), /nobody here called/)
    await tools.get('say')({ text: 'just a line' })
    assert.equal(acts[1].payload.task, undefined)
  })
})
