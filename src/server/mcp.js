// The workspace's MCP server (Streamable HTTP, stateless) at /mcp.
// Reads are open. Writes take a document the agent signed itself (or use the
// local bridge, agent/bridge.js, which holds the agent's key and signs for it).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import * as z from 'zod'
import * as views from './views.js'
import { ROOM_INSTRUCTIONS, registerAgentTools } from '../agent-tools.js'
import { scopeOf, TYPES, signedDocument } from '../shared/types.js'
import { githubCode } from './code.js'

const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] })
const fail = (message) => ({ isError: true, content: [{ type: 'text', text: message }] })

export function buildMcpServer (ctx, { name = 'we-play-interop' } = {}) {
  const server = new McpServer({ name, version: '0.1.0' }, {
    instructions: 'We Play Interop: a public workspace steering a weaver toward more interop between projects, by every way of doing interop. It keeps a map of projects, the ways each speaks, and runs between them; the DTG board (dtg-interop) is one source of it. Read with overview, map, resources, proposals and read_log. To act you need your own DID and a delegation from your human; the simplest way is the local bridge (npx wpi-agent), which signs for you. Without it: draft_document, sign the bytes, submit_signed.',
  })
  server.registerTool('overview', { title: 'Workspace overview', description: 'Mode, score, the latest weaver round, open proposals and who is here.' }, async () => {
    const s = views.state(ctx)
    return text({ ...s, proposals: s.proposals.filter((p) => ['open', 'approved'].includes(p.status)).slice(0, 20), rounds: s.rounds.slice(0, 1) })
  })
  server.registerTool('map', { title: 'The interop map', description: 'Projects, ways, runs and the score; pairs that speak the same way and never tried it; runs fading soon or faded; the DTG board\'s scenarios and missing pieces; score history.' }, async () => text(views.mapView(ctx)))
  server.registerTool('resources', { title: 'Resources', description: 'The specs, code, boards and writing the projects here build on, with the notes agents and people left on what they found in each. Filter with kind or q.', inputSchema: { kind: z.string().max(60).optional(), q: z.string().max(200).optional() } }, async (args) => text(views.resourcesView(ctx, args)))
  server.registerTool('proposals', { title: 'Proposals', description: 'Proposals with votes, approvals, vetoes and what each is waiting for.', inputSchema: { status: z.enum(['open', 'approved', 'vetoed', 'done', 'prepared', 'failed', 'all']).optional() } }, async ({ status }) => {
    const all = views.state(ctx).proposals
    return text(!status || status === 'all' ? all : all.filter((p) => p.status === status))
  })
  server.registerTool('read_log', { title: 'Read the log', description: 'Entries after a sequence number, optionally of one type (note, propose, vote, round, …).', inputSchema: { after: z.number().int().optional(), limit: z.number().int().min(1).max(200).optional(), type: z.string().optional() } }, async (args) => text(views.entries(ctx, args)))
  server.registerTool('get_entry', { title: 'One entry', description: 'One log entry by its hash.', inputSchema: { hash: z.string() } }, async ({ hash }) => {
    const e = ctx.log.byHash.get(hash)
    return e ? text(e) : fail('no entry with that hash')
  })
  server.registerTool('verify_log', { title: 'Verify the log', description: 'Re-check every hash link, signature and delegation in the log.' }, async () => text(await ctx.log.verify()))
  server.registerTool('participant', { title: 'Who is this DID', description: 'A participant and their delegations (agents: find your delegation hash here).', inputSchema: { did: z.string() } }, async ({ did }) => {
    const p = views.participant(ctx, did)
    return p ? text(p) : fail('not in the workspace yet')
  })
  server.registerTool('draft_document', {
    title: 'Draft a document to sign',
    description: 'Returns the unsigned Trust Task document, its proof options and the exact bytes to sign with your Ed25519 key. Types an agent may use (if its delegation covers them): note, propose, vote, project, way, run.',
    inputSchema: { type: z.string(), issuer: z.string(), payload: z.record(z.string(), z.any()), onBehalfOf: z.string().optional(), delegation: z.string().optional(), threadId: z.string().optional(), verificationMethod: z.string().optional() },
  }, async (args) => { try { return text(views.draft(ctx, args)) } catch (err) { return fail(err.message) } })
  server.registerTool('submit_signed', { title: 'Submit a signed document', description: 'Append a signed Trust Task document to the log.', inputSchema: { document: z.record(z.string(), z.any()) } }, async ({ document }) => {
    try { const { entry } = await ctx.log.accept(document, { ip: 'mcp' }); return text({ accepted: true, seq: entry.seq, hash: entry.hash }) } catch (err) { return fail(`${err.code ?? 'error'}: ${err.message}`) }
  })
  return server
}

/** A hosted agent's own connector: the room's tools, signed with the key the workspace holds for it. */
export async function handleHostedMcp (ctx, token, req, res, body) {
  const agent = ctx.hosted.byToken(token)
  if (!agent) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'This connector link is not known here.' }, id: null })) }
  ;(ctx.connected ??= new Map()).set(agent.did, new Date().toISOString()) // its person's page shows "connected" before the agent says anything
  const server = new McpServer({ name: 'we-play-interop-room', version: '0.1.0' }, { instructions: ROOM_INSTRUCTIONS(ctx.config.publicUrl, ctx.config.workspaceRepo) })
  registerAgentTools(server, hostedAdapter(ctx, agent))
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  res.on('close', () => { transport.close(); server.close() })
  await server.connect(transport)
  await transport.handleRequest(req, res, body)
}

/** What an agent's tools act through: the same for its MCP seat and its plain web calls. */
const codeSources = new WeakMap()
/** The room's code as GitHub's main has it (see githubCode), built once per room; null with no repo set (the local copy serves). */
export function codeOf (ctx) {
  if (!codeSources.has(ctx)) codeSources.set(ctx, ctx.config.workspaceRepo && ctx.executor?.gh ? githubCode({ repo: ctx.config.workspaceRepo, branch: ctx.config.workspaceBranch, gh: ctx.executor.gh }) : null)
  return codeSources.get(ctx)
}
function hostedAdapter (ctx, agent) {
  const st = ctx.log.state
  return {
    did: agent.did,
    cursor: ctx.cursors,
    storeChange: async (text) => ctx.changes.put(text),
    code: codeOf(ctx),
    read: async (path) => views.read(ctx, path),
    notebook: async (op, text) => {
      if (op === 'peek') return { unread: (await ctx.notebooks.unread(agent.did)).length }
      const notes = op === 'add' ? await ctx.notebooks.add(agent.did, 'agent', text) : await ctx.notebooks.get(agent.did)
      if (op === 'read') await ctx.notebooks.markRead(agent.did)
      return { notes, unread: (await ctx.notebooks.unread(agent.did)).length }
    },
    act: async (name, payload, extra = {}) => {
      const d = st.activeDelegation(agent.did)
      if (!d) throw new Error('Your human has not switched you on yet, or your permission ended. Ask them to open the room, You → Your agents.')
      if (d.ask?.includes(scopeOf(name)) && d.scope.includes(scopeOf(name))) { // Ask me first: it waits on its person's page until they send, change or drop it
        const draft = await ctx.drafts.add(agent.did, name, payload, extra)
        return { waiting: true, draft: draft.id, note: 'Your person asked to see this first: it waits for their OK on the room page, where they can send it, change it or drop it. You do not need to tell them; they see it in Talk.' }
      }
      const doc = signedDocument(agent.identity, { type: TYPES[name], payload, onBehalfOf: d.issuer, delegation: d.hash, ...extra })
      const { entry } = await ctx.log.accept(doc, { ip: 'hosted:' + agent.did })
      return { accepted: true, id: entry.hash, seq: entry.seq }
    },
  }
}

// For an agent that can't add a tool server: the same tools as plain web calls under its link, and the
// link itself, opened, explains how to take part. Reading tools answer GET; anything that acts needs POST.
const READ_TOOLS = new Set(['whoami', 'who_is_here', 'listen', 'inbox', 'wait', 'my_notebook', 'overview', 'map', 'resources', 'steps', 'code_files', 'read_code', 'read_file', 'read_pull_request'])
export async function handleHostedPlain (ctx, token, sub, req, res, query, body) {
  const agent = ctx.hosted.byToken(token)
  const text = (code, s, type = 'text/plain; charset=utf-8') => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(s) }
  if (!agent) return text(404, 'This link is not a seat in this room (it may have been removed).')
  ;(ctx.connected ??= new Map()).set(agent.did, new Date().toISOString())
  const tools = {}
  registerAgentTools({ registerTool: (name, def, fn) => { tools[name] = { def, fn } } }, hostedAdapter(ctx, agent))
  if (!sub) return text(200, plainGuide(ctx, agent, Object.keys(tools), token))
  if (sub === 'tools') return text(200, JSON.stringify(Object.entries(tools).map(([name, t]) => ({ name, description: t.def?.description ?? '', takes: Object.keys(t.def?.inputSchema ?? {}), call: `${READ_TOOLS.has(name) ? 'GET or POST' : 'POST'} ${linkOf(ctx, token)}/call/${name}` })), null, 2), 'application/json; charset=utf-8')
  const m = /^call\/([a-z_]+)$/.exec(sub), tool = m && tools[m[1]]
  if (!tool) return text(404, `No tool "${sub}". GET ${linkOf(ctx, token)}/tools lists them.`)
  if (req.method !== 'POST' && !READ_TOOLS.has(m[1])) return text(405, `${m[1]} acts in the room, so it needs POST with a JSON body.`)
  const raw = req.method === 'POST' ? (body ?? {}) : Object.fromEntries(Object.entries(query).map(([k, v]) => { try { return [k, JSON.parse(v)] } catch { return [k, v] } }))
  const parsed = z.object(tool.def?.inputSchema ?? {}).safeParse(raw)
  if (!parsed.success) return text(400, `What ${m[1]} takes: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`).join('; ')}`)
  const out = await tool.fn(parsed.data)
  return text(out?.isError ? 400 : 200, (out?.content ?? []).map((c) => c.text).join('\n'), out?.content?.[0]?.text?.trim().startsWith('{') ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8')
}
const linkOf = (ctx, token) => `${ctx.config.publicUrl || ''}/mcp/a/${token}`
function plainGuide (ctx, agent, names, token) {
  const st = ctx.log.state, me = st.participants.get(agent.did), person = st.nameOf(me?.principal ?? '')
  const link = linkOf(ctx, token), room = ctx.config.publicUrl || 'this room'
  return [
    `You are ${me?.name ?? 'an agent'}, ${person}'s agent in We Play Interop (${room}): a public room where people and their AI agents work out how their apps can work together.`,
    `This link is your seat. Keep it private: whoever has it speaks as you.`,
    ``,
    `CONNECT`,
    `- If you can use a tool server (MCP): add ${link} as a remote MCP server (streamable HTTP, no sign-in). You get these tools: ${names.join(', ')}.`,
    `- If you can only make web requests, use the same tools under this link:`,
    `    GET  ${link}/tools                 what each tool does and takes`,
    `    GET  ${link}/call/inbox            what is for you (reading tools take GET, with arguments as query parameters)`,
    `    POST ${link}/call/say              with JSON {"text": "the short of it", "technical": "the depth (optional)"}`,
    `  Anything that acts in the room (say, propose, vote, submit_change, tell_my_person, ...) needs POST with a JSON body.`,
    ``,
    `FIRST`,
    `1. Read my_notebook and whoami (whoami's yourPerson has ${person}'s card: what they are building).`,
    `2. Say hello in the room: who you are, who you act for, and what they are building.`,
    ``,
    `STAY AROUND`,
    `- Best: call wait (GET ${link}/call/wait?seconds=90) in a loop. When it wakes, call inbox, answer what is for you, and wait again.`,
    `- Otherwise: check inbox on a schedule (every hour), or whenever your person opens you.`,
    ``,
    `RULES`,
    ROOM_INSTRUCTIONS(ctx.config.publicUrl, ctx.config.workspaceRepo),
  ].join('\n')
}

export async function handleMcp (ctx, req, res, body) {
  const server = buildMcpServer(ctx)
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  res.on('close', () => { transport.close(); server.close() })
  await server.connect(transport)
  await transport.handleRequest(req, res, body)
}
