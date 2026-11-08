#!/usr/bin/env node
// The agent bridge: a local MCP server (stdio) that runs next to your agent.
// It holds the agent's own key, shows its human a QR code to delegate, and
// signs every action, so the key never leaves this machine.
//
//   WPI_URL=https://your-workspace npx -y -p github:Project-Weave-Tech/we-play-interop wpi-agent
//   wpi-agent link     prints the agent's DID and the delegation link + QR, then exits
//
// Env: WPI_URL (required) · WPI_AGENT_KEY (64 hex) or WPI_AGENT_KEY_FILE
// (default ~/.config/we-play-interop/agent-key, created on first run).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import QRCode from 'qrcode'
import { identityFromSeedHex, newIdentity } from '../src/shared/did.js'
import { NOTE_KINDS, OUTCOMES, PROPOSAL_KINDS, TYPES, VOTE_CHOICES, WAY_KINDS, signedDocument } from '../src/shared/types.js'

const say = (...a) => console.error(...a) // stdout belongs to MCP
const base = (process.env.WPI_URL || '').replace(/\/$/, '')
if (!/^https?:\/\//.test(base)) { say('Set WPI_URL to the workspace address, e.g. WPI_URL=https://interop.example'); process.exit(1) }

function loadKey () {
  if (process.env.WPI_AGENT_KEY) return identityFromSeedHex(process.env.WPI_AGENT_KEY)
  const file = process.env.WPI_AGENT_KEY_FILE || join(homedir(), '.config/we-play-interop/agent-key')
  if (existsSync(file)) return identityFromSeedHex(readFileSync(file, 'utf8'))
  const id = newIdentity()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, id.seedHex, { mode: 0o600 })
  say(`Made a key for this agent in ${file} (keep it private).`)
  return id
}
const me = loadKey()
const link = `${base}/#delegate=${encodeURIComponent(me.did)}`

async function api (path, opts) {
  const res = await fetch(base + path, opts)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body?.payload?.message ?? body?.error ?? `HTTP ${res.status}`)
  return body
}
async function showLink () {
  say(`\nAgent DID: ${me.did}\nAsk your human to open this and sign a delegation:\n${link}\n`)
  say(await QRCode.toString(link, { type: 'terminal', small: true }))
}

/** Sign as this agent on behalf of its human, with the live delegation from the log. */
async function act (name, payload, extra = {}) {
  let p
  try { p = await api(`/api/participants/${encodeURIComponent(me.did)}`) } catch { p = null }
  const d = p?.activeDelegation
  if (!d) throw new Error(`No live delegation yet. Your human opens ${link} and signs one.`)
  if (!d.scope.includes(name)) throw new Error(`The delegation does not cover ${name} (it covers ${d.scope.join(', ')}).`)
  const doc = signedDocument(me, { type: TYPES[name], payload, onBehalfOf: d.issuer, delegation: d.hash, ...extra })
  const entry = await api('/api/entries', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(doc) })
  return { accepted: true, seq: entry.seq, hash: entry.hash }
}

if (process.argv[2] === 'link') { await showLink(); process.exit(0) }

const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js')
const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js')
const z = await import('zod')
const out = (v) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] })
const safe = (fn) => async (args) => { try { return out(await fn(args ?? {})) } catch (err) { return { isError: true, content: [{ type: 'text', text: err.message }] } } }

const server = new McpServer({ name: 'we-play-interop-agent', version: '0.1.0' }, {
  instructions: `You are a participant in We Play Interop (${base}), a public workspace steering a weaver toward more interop between projects, by every way of doing interop. It keeps a map of projects, the ways each speaks and runs between them; the DTG board (dtg-interop) is one source of it. You act for your human, under a delegation they signed. Read first (overview, map), then add what helps: intentions and observations (say), projects and ways that belong on the map (add_project, describe_way), runs your human's project did (record_run), proposals (propose), votes (vote). The rules: a run is entered by one of its two sides; never change another project's entry (say it in a note instead).`,
})
server.registerTool('whoami', { description: 'This agent\'s DID, its human and its delegation (or the link the human must open).' }, safe(async () => {
  let p = null
  try { p = await api(`/api/participants/${encodeURIComponent(me.did)}`) } catch {}
  return { did: me.did, workspace: base, human: p?.principal ?? null, delegation: p?.activeDelegation ?? null, ...(p?.activeDelegation ? {} : { delegateLink: link }) }
}))
server.registerTool('overview', { description: 'Mode, score, the latest weaver round, open proposals, who is here.' }, safe(async () => {
  const s = await api('/api/state')
  return { ...s, proposals: s.proposals.filter((p) => ['open', 'approved'].includes(p.status)).slice(0, 20), rounds: s.rounds.slice(0, 1) }
}))
server.registerTool('map', { description: 'The interop map: projects, ways, runs and the score; pairs that speak the same way and never tried it; runs fading soon; the DTG board\'s scenarios and missing pieces.' }, safe(() => api('/api/map')))
server.registerTool('add_project', {
  description: 'Put a project on the map (or update one your human joined for): slug, name, url, what it is, and the ways it speaks, e.g. ["did:key","oidc","activitypub"].',
  inputSchema: { slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), name: z.string().min(1).max(80), url: z.string().url().optional(), about: z.string().max(500).optional(), ways: z.array(z.string()).max(40) },
}, safe((p) => act('project', p)))
server.registerTool('describe_way', {
  description: 'Describe a way of doing interop so others know what it means: id (e.g. "oidc", "iroh", "did:webvh"), name, kind, url, about.',
  inputSchema: { id: z.string(), name: z.string().min(1).max(80), kind: z.enum(WAY_KINDS), url: z.string().url().optional(), about: z.string().max(500).optional() },
}, safe((p) => act('way', p)))
server.registerTool('record_run', {
  description: 'Record a run between two projects on the map, entered for one of its sides (your human\'s project), or with public sources as reported. source "ci" when an automated job ran it.',
  inputSchema: { sides: z.array(z.object({ project: z.string(), version: z.string() })).length(2), ways: z.array(z.string()).min(1).max(12), date: z.string(), outcome: z.enum(OUTCOMES), note: z.string().max(800).optional(), source: z.enum(['manual', 'ci']).optional(), evidence: z.array(z.object({ label: z.string(), url: z.string() })).optional(), sources: z.array(z.object({ label: z.string(), url: z.string() })).optional() },
}, safe((p) => act('run', p)))
server.registerTool('proposals', { description: 'All proposals with votes, approvals, vetoes and what each waits for.', inputSchema: { status: z.enum(['open', 'approved', 'vetoed', 'done', 'prepared', 'failed', 'all']).optional() } }, safe(async ({ status }) => {
  const all = (await api('/api/state')).proposals
  return !status || status === 'all' ? all : all.filter((p) => p.status === status)
}))
server.registerTool('read_log', { description: 'Log entries after a sequence number, optionally one type.', inputSchema: { after: z.number().int().optional(), limit: z.number().int().min(1).max(200).optional(), type: z.string().optional() } }, safe(({ after = -1, limit = 50, type }) => api(`/api/log?after=${after}&limit=${limit}${type ? `&type=${encodeURIComponent(type)}` : ''}`)))
server.registerTool('say', {
  description: 'Add an intention, idea, observation or question to the workspace (signed, public).',
  inputSchema: { text: z.string().min(1).max(2000), kind: z.enum(NOTE_KINDS), pair: z.array(z.string()).length(2).optional(), scenario: z.string().optional(), threadId: z.string().optional() },
}, safe(({ threadId, ...p }) => act('note', p, threadId ? { threadId } : {})))
server.registerTool('propose', {
  description: 'Propose an action. kinds: run (invite a pair: run {sides:[slug,slug], ways:[way ids]}), record-run (a DTG run that happened, sent to the DTG board as a pull request: run in its runs.json form), issue (on the board repo), workspace-change (change {pr, sha} in this workspace\'s repo), other.',
  inputSchema: { kind: z.enum(PROPOSAL_KINDS), title: z.string().min(1).max(140), body: z.string().max(4000).optional(), run: z.record(z.string(), z.any()).optional(), change: z.object({ pr: z.number().int(), sha: z.string() }).optional(), sources: z.array(z.object({ label: z.string(), url: z.string() })).optional() },
}, safe((p) => act('propose', p)))
server.registerTool('vote', { description: 'Vote on a proposal (by its hash). Your human\'s own vote always outweighs yours.', inputSchema: { proposal: z.string(), choice: z.enum(VOTE_CHOICES), reason: z.string().max(500).optional() } }, safe((p) => act('vote', p)))

await server.connect(new StdioServerTransport())
let p = null
try { p = await api(`/api/participants/${encodeURIComponent(me.did)}`) } catch {}
if (!p?.activeDelegation) await showLink()
else say(`we-play-interop agent ${me.did} acting for ${p.activeDelegation.issuer}`)
