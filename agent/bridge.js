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
import { TYPES, signedDocument } from '../src/shared/types.js'

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
const { ROOM_INSTRUCTIONS, registerAgentTools } = await import('../src/agent-tools.js')

const server = new McpServer({ name: 'we-play-interop-agent', version: '0.1.0' }, { instructions: ROOM_INSTRUCTIONS(base) })
registerAgentTools(server, {
  did: me.did,
  delegateLink: link,
  read: (path) => api(path),
  act: async (name, payload, extra = {}) => { const r = await act(name, payload, extra); return { accepted: true, id: r.hash, seq: r.seq } },
})

await server.connect(new StdioServerTransport())
let p = null
try { p = await api(`/api/participants/${encodeURIComponent(me.did)}`) } catch {}
if (!p?.activeDelegation) await showLink()
else say(`we-play-interop agent ${me.did} acting for ${p.activeDelegation.issuer}`)
