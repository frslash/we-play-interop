#!/usr/bin/env node
// The agent bridge: a local MCP server (stdio) that runs next to your agent.
// It holds the agent's own key, shows its human a QR code to delegate, and
// signs every action, so the key never leaves this machine.
//
//   WPI_URL=https://your-workspace npx -y -p github:Project-Weave-Tech/we-play-interop wpi-agent
//   wpi-agent link     prints the agent's DID and the delegation link + QR, then exits
//   wpi-agent move-notebook   copies the notes the room's server holds into the sealed room, then exits
//   wpi-agent community-room offers | accept <roomId> | status | say "<text>" | drafts | send <n> | discard <n>   the community's encrypted room (agent/community-room.js)
//   wpi-agent join-community  joins COMMUNITY_DID as COMMUNITY_PERSONA through your own trust agent (agent/community-join.js; --status shows where it stands)
//
// Env: WPI_URL (required) · WPI_AGENT_KEY (64 hex) or WPI_AGENT_KEY_FILE
// (default ~/.config/we-play-interop/agent-key, created on first run).
// A community's encrypted room to read and talk in (after `community-room accept`): COMMUNITY_DID · COMMUNITY_PERSONA · VTA_CREDENTIAL (or _FILE)
// · optional COMMUNITY_ROOM (when several are joined) · COMMUNITY_TALK_AGENT_MAY_SAY=yes lets the agent speak there without asking (default: it keeps a draft).
// Notebook in a sealed room the person holds (all three, or none): VTA_CREDENTIAL (or VTA_CREDENTIAL_FILE) ·
// NOTEBOOK_ROOM · NOTEBOOK_HOST_DID. Then the notebook never touches the room's server (agent/vti-notebook.js).
import { createHash } from 'node:crypto'
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

/** The live delegation from the log, if it covers this action. */
async function delegationFor (name) {
  let p
  try { p = await api(`/api/participants/${encodeURIComponent(me.did)}`) } catch { p = null }
  const d = p?.activeDelegation
  if (!d) throw new Error(`No live delegation yet. Your human opens ${link} and signs one.`)
  if (!d.scope.includes(name)) throw new Error(`The delegation does not cover ${name} (it covers ${d.scope.join(', ')}).`)
  return d
}

/** Sign as this agent on behalf of its human, with the live delegation from the log. */
async function act (name, payload, extra = {}) {
  const d = await delegationFor(name)
  const doc = signedDocument(me, { type: TYPES[name], payload, onBehalfOf: d.issuer, delegation: d.hash, ...extra })
  const entry = await api('/api/entries', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(doc) })
  return { accepted: true, seq: entry.seq, hash: entry.hash }
}

/** Hand the room a change to its own code: sign a room:change line naming the diff's sha256, and send the diff with it.
 *  The room tests it and opens the pull request itself, so this machine needs no GitHub token. */
async function submitChange ({ title, why, base, patch }) {
  const text = String(patch), sha256 = createHash('sha256').update(text).digest('hex'), bytes = Buffer.byteLength(text)
  const d = await delegationFor('change')
  const doc = signedDocument(me, { type: TYPES.change, payload: { title, ...(why ? { why } : {}), ...(base ? { base } : {}), sha256, bytes }, onBehalfOf: d.issuer, delegation: d.hash })
  const entry = await api('/api/changes', { method: 'POST', headers: { 'content-type': 'text/x-diff; charset=utf-8', 'x-wpi-change': JSON.stringify(doc) }, body: text })
  return { accepted: true, id: entry.hash, seq: entry.seq, sha256, bytes }
}

if (process.argv[2] === 'link') { await showLink(); process.exit(0) }
const stateDir = dirname(process.env.WPI_AGENT_KEY_FILE || join(homedir(), '.config/we-play-interop/agent-key'))
if (process.argv[2] === 'join-community') process.exit(await (await import('./community-join.js')).joinCommunityCommand(process.argv.slice(3), process.env, { say, roomUrl: base, stateDir }))
if (process.argv[2] === 'community-room') process.exit(await (await import('./community-room.js')).communityRoomCommand(process.argv.slice(3), process.env, { say, stateDir }))

// Where this agent's notebook lives. With the three settings it is a sealed room its person holds, reached through
// their own trust agent from this machine; the credential for that trust agent stays here and is never sent to the room.
let sealed = null
if (['VTA_CREDENTIAL', 'VTA_CREDENTIAL_FILE', 'NOTEBOOK_ROOM', 'NOTEBOOK_HOST_DID'].some((k) => process.env[k])) { // loaded only when asked for: nothing changes for a bridge without these
  try { sealed = (await import('./vti-notebook.js')).notebookFromEnv(process.env, { agent: me }) } catch (err) { say(err.message); process.exit(1) }
}
/** The notebook on the room's server (encrypted with a key that server holds): used only when no sealed room is set. */
const roomNotebook = (op, text) => {
  const doc = signedDocument(me, { type: TYPES.notebook, payload: { agent: me.did, op, ...(text ? { text } : {}) } })
  return api('/api/notebook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(doc) })
}
const personCard = async () => { const p = await api(`/api/participants/${encodeURIComponent(me.did)}`); return p?.principal ? (await api(`/api/participants/${encodeURIComponent(p.principal)}`))?.card ?? null : null } // public, from the log

// The person's own one-way move: read the notes the room's server holds for this agent, write each into the sealed
// room, read them back and compare. The server's copy is left exactly as it is; removing it is the person's own, later, step.
if (process.argv[2] === 'move-notebook') {
  if (!sealed) { say('Set VTA_CREDENTIAL, NOTEBOOK_ROOM and NOTEBOOK_HOST_DID first: they say which sealed room to move the notebook into.'); process.exit(1) }
  try {
    const r = await sealed.importNotes((await roomNotebook('read')).notes ?? [])
    console.log(JSON.stringify(r))
    say(r.verified ? `Moved: ${r.moved} of ${r.notes} notes written to the sealed room (${r.alreadyThere} were there already), and every one read back the same. The room's server still holds its copy: nothing there was changed.` : `Not finished: ${r.moved} of ${r.notes} notes were written, but they did not all read back the same. The room's server still holds its copy; run this again.`)
    process.exit(r.verified ? 0 : 1)
  } catch (err) { say(`The move stopped: ${err.message} Nothing on the room's server was changed.`); process.exit(1) }
}

// The community's encrypted room, when this person has joined one: the agent then gets two tools to read and say things there.
let talk = null
if (process.env.COMMUNITY_DID) {
  try {
    const made = (await import('./community-room.js')).communityRoomFromEnv(process.env, { stateDir })
    if (made) talk = { read: ({ since } = {}) => made.cr.read(made.roomId, { since }), say: (text, { inReplyTo } = {}) => made.cr.agentSay(made.roomId, text, { inReplyTo }), room: made.roomId, maySay: made.cr.agentMaySay }
  } catch (err) { say(err.message); process.exit(1) }
}

const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js')
const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js')
const { COMMUNITY_TALK_INSTRUCTIONS, ROOM_INSTRUCTIONS, registerAgentTools } = await import('../src/agent-tools.js')

const server = new McpServer({ name: 'we-play-interop-agent', version: '0.1.0' }, { instructions: ROOM_INSTRUCTIONS(base, '', !!sealed) + (talk ? `\n${COMMUNITY_TALK_INSTRUCTIONS}` : '') })
registerAgentTools(server, {
  did: me.did,
  delegateLink: link,
  read: (path) => api(path),
  notebook: sealed ? sealed.adapter({ card: personCard }) : roomNotebook,
  notebookHome: () => (sealed ? sealed.status() : { lives: 'room-server' }),
  act: async (name, payload, extra = {}) => { const r = await act(name, payload, extra); return { accepted: true, id: r.hash, seq: r.seq } },
  submitChange,
  ...(talk ? { communityTalk: talk } : {}),
})

await server.connect(new StdioServerTransport())
let p = null
try { p = await api(`/api/participants/${encodeURIComponent(me.did)}`) } catch {}
if (!p?.activeDelegation) await showLink()
else say(`InWove agent ${me.did} acting for ${p.activeDelegation.issuer}`)
say(sealed ? `Notebook: in the sealed room ${sealed.roomId}, through your own trust agent. The room's server is never asked for it.` : 'Notebook: on the room\'s server, encrypted with a key that server holds. To keep it in a room you hold, see the README.')
if (talk) say(`Community room: ${talk.room}, read and talk through your own trust agent. The agent ${talk.maySay ? 'may speak there on its own' : 'keeps what it wants to say as a draft: wpi-agent community-room drafts, send <n>'}.`)
