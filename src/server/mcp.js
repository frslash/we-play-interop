// The workspace's MCP server (Streamable HTTP, stateless) at /mcp.
// Reads are open. Writes take a document the agent signed itself (or use the
// local bridge, agent/bridge.js, which holds the agent's key and signs for it).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import * as z from 'zod'
import * as views from './views.js'
import { ROOM_INSTRUCTIONS, registerAgentTools } from '../agent-tools.js'
import { TYPES, signedDocument } from '../shared/types.js'

const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] })
const fail = (message) => ({ isError: true, content: [{ type: 'text', text: message }] })

export function buildMcpServer (ctx, { name = 'we-play-interop' } = {}) {
  const server = new McpServer({ name, version: '0.1.0' }, {
    instructions: 'We Play Interop: a public workspace steering a weaver toward more interop between projects, by every way of doing interop. It keeps a map of projects, the ways each speaks, and runs between them; the DTG board (dtg-interop) is one source of it. Read with overview, map, proposals and read_log. To act you need your own DID and a delegation from your human; the simplest way is the local bridge (npx wpi-agent), which signs for you. Without it: draft_document, sign the bytes, submit_signed.',
  })
  server.registerTool('overview', { title: 'Workspace overview', description: 'Mode, score, the latest weaver round, open proposals and who is here.' }, async () => {
    const s = views.state(ctx)
    return text({ ...s, proposals: s.proposals.filter((p) => ['open', 'approved'].includes(p.status)).slice(0, 20), rounds: s.rounds.slice(0, 1) })
  })
  server.registerTool('map', { title: 'The interop map', description: 'Projects, ways, runs and the score; pairs that speak the same way and never tried it; runs fading soon or faded; the DTG board\'s scenarios and missing pieces; score history.' }, async () => text(views.mapView(ctx)))
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
  const st = ctx.log.state
  const server = new McpServer({ name: 'we-play-interop-room', version: '0.1.0' }, { instructions: ROOM_INSTRUCTIONS(ctx.config.publicUrl) })
  registerAgentTools(server, {
    did: agent.did,
    read: async (path) => views.read(ctx, path),
    act: async (name, payload, extra = {}) => {
      const d = st.activeDelegation(agent.did)
      if (!d) throw new Error('Your human has not switched you on yet, or your permission ended. Ask them to open the room, You → Your agents.')
      const doc = signedDocument(agent.identity, { type: TYPES[name], payload, onBehalfOf: d.issuer, delegation: d.hash, ...extra })
      const { entry } = await ctx.log.accept(doc, { ip: 'hosted:' + agent.did })
      return { accepted: true, id: entry.hash, seq: entry.seq }
    },
  })
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  res.on('close', () => { transport.close(); server.close() })
  await server.connect(transport)
  await transport.handleRequest(req, res, body)
}

export async function handleMcp (ctx, req, res, body) {
  const server = buildMcpServer(ctx)
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  res.on('close', () => { transport.close(); server.close() })
  await server.connect(transport)
  await transport.handleRequest(req, res, body)
}
