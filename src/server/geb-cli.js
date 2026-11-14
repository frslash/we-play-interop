// Geb's CLI as the bridge's node (geb.js). One `geb listen --json` process for the room's Geb identity, and one-shot
// commands for posting, rooms and members, all against the room's own Geb home (GEB_HOME, beside the room's other keys).
// Pinned to the release below: Geb's `listen --json` output and its wire are not versioned yet, so an upgrade is a
// deliberate change, checked against what the release prints. Shapes are from Geb CLI 0.5.18 as run on throwaway
// identities (docs/geb.md lists each fact and the ones still to confirm).
import { spawn as spawnDefault, execFile as execFileDefault } from 'node:child_process'
import { createInterface } from 'node:readline'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { GEB_DID_RE } from '../shared/types.js'

export const GEB_CLI_VERSION = '0.5.18'
const RESTART_MS = [1_000, 5_000, 15_000, 60_000] // a listener that stops comes back, more slowly each time it keeps stopping
/** A Geb room's id as the CLI prints it (a uuid today): letters, digits and a few marks, never starting with "-". */
export const GEB_GROUP_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/

/**
 * Why a Geb command failed, as a fixed word and the subcommand's name only. Never Geb's stderr, never Node's
 * `err.message` (which is `Command failed: <cmd> <every arg>`: a member's words and the room's Geb home), never an
 * argument: this text reaches logs, the counts and, through `status()`, every member's screen (Security, 2026-11-13).
 */
export class GebCliError extends Error {
  constructor (sub, code) { super(`geb ${sub}: ${code}`); this.name = 'GebCliError'; this.sub = sub; this.code = code }
}
const CODES = new Set(['timeout', 'not-json', 'not-a-list', 'unknown-command', 'not-found', 'bad-did', 'bad-room', 'no-room', 'failed'])
/** The fixed word for a failed run. stderr is read only to tell "this CLI has no such command", and never kept. */
export function failureCode (err, stderr) {
  if (err?.killed || err?.signal === 'SIGTERM' || /ETIMEDOUT/.test(String(err?.code ?? ''))) return 'timeout'
  if (err?.code === 'ENOENT') return 'not-found'
  if (/unknown command/i.test(String(stderr ?? ''))) return 'unknown-command'
  if (Number.isInteger(err?.code)) return `exit-${err.code}`
  return 'failed'
}
/** A fixed, content-free reason for any error the bridge meets: a Geb code, or the error's kind. */
export const safeReason = (err) => err instanceof GebCliError && (CODES.has(err.code) || /^exit-\d{1,3}$/.test(err.code)) ? err.code : 'error'

/**
 * The room's Geb home holds its keys: it must be readable by the room's own user only (folders 700, files 600), or the
 * bridge does not start. Says what is wrong in a fixed sentence, never the path.
 */
export function checkHomeModes (home, { uid = process.getuid?.() } = {}) {
  const bad = (p, st) => (st.mode & 0o077) !== 0 || (uid !== undefined && st.uid !== uid)
  let top
  try { top = statSync(home) } catch { throw new Error('GEB_HOME: the room\'s Geb home cannot be read') }
  if (!top.isDirectory()) throw new Error('GEB_HOME: the room\'s Geb home is not a folder')
  const walk = (dir, st) => {
    if (bad(dir, st)) throw new Error('GEB_HOME: the room\'s Geb home must be the room\'s alone (folders 700, files 600)')
    for (const name of readdirSync(dir)) {
      const p = join(dir, name), s = statSync(p)
      if (s.isDirectory()) walk(p, s)
      else if (bad(p, s)) throw new Error('GEB_HOME: the room\'s Geb home must be the room\'s alone (folders 700, files 600)')
    }
  }
  walk(home, top)
}
const did = (sub, d) => { if (typeof d !== 'string' || !GEB_DID_RE.test(d)) throw new GebCliError(sub, 'bad-did'); return d }
const dids = (sub, list) => { if (!Array.isArray(list) || !list.length) throw new GebCliError(sub, 'bad-did'); return list.map((d) => did(sub, d)) }
const room = (sub, g) => { if (typeof g !== 'string' || !GEB_GROUP_RE.test(g)) throw new GebCliError(sub, 'bad-room'); return g }

/**
 * One line of `geb listen --json`, as an event the bridge reads, or null when the line is not one (some lines under
 * --json are not JSON, such as `room.presumed {…}`). A message's `at` is epoch milliseconds; a room event's is a string.
 */
export function parseListenLine (line) {
  let j
  try { j = JSON.parse(line) } catch { return null }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null
  switch (j.event) {
    case 'gmessage':
      if (typeof j.id !== 'string' || typeof j.from !== 'string' || typeof j.group !== 'string') return null
      return { type: 'message', id: j.id, group: j.group, groupName: typeof j.name === 'string' ? j.name : '', direct: j.direct === true, from: j.from, text: typeof j.text === 'string' ? j.text : '', at: typeof j.at === 'number' ? j.at : Date.parse(j.at) || Date.now(), replay: j.via === 'replay', signed: j.sig === 'signed' }
    case 'group': return { type: 'group', id: typeof j.id === 'string' ? j.id : null, name: j.name ?? '', members: j.members ?? null, epoch: j.epoch ?? null }
    case 'request': return { type: 'request', from: typeof j.from === 'string' ? j.from : typeof j.did === 'string' ? j.did : null }
    case 'listening': return { type: 'listening', did: typeof j.did === 'string' ? j.did : null }
    default: return { type: 'other', event: typeof j.event === 'string' ? j.event : '' }
  }
}

export class GebCli {
  /**
   * `bin`: the CLI (`geb`, or the path of its `geb.mjs`, run with this Node). `home`: the room's Geb home. `did`: the
   * room's Geb identity, as the CLI made it (GEB_ROOM_DID). `spawn` and `execFile` are for tests.
   */
  constructor ({ bin = 'geb', home, did, spawn = spawnDefault, execFile = execFileDefault, timeoutMs = 30_000, restartMs = RESTART_MS }) {
    if (!home) throw new Error('GEB_HOME: the room\'s Geb home is not set')
    if (!did) throw new Error('GEB_ROOM_DID: the room\'s Geb identity is not set')
    if (!GEB_DID_RE.test(did)) throw new Error('GEB_ROOM_DID: the room\'s Geb identity is not a did:peer:2')
    const [cmd, pre] = bin.endsWith('.mjs') || bin.endsWith('.js') ? [process.execPath, [bin]] : [bin, []]
    Object.assign(this, { cmd, pre, home, did, spawn, execFile, timeoutMs, restartMs })
    this.child = null
    this.stopping = false
    this.restarts = 0
  }

  args (...a) { return [...this.pre, ...a, '--home', this.home] }
  /** One command; its standard output. Arguments go as an array, never through a shell. A failure is a fixed code. */
  run (...a) {
    const sub = a[0] === 'group' ? `group ${a[1]}` : a[0]
    return new Promise((resolve, reject) => this.execFile(this.cmd, this.args(...a), { timeout: this.timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new GebCliError(sub, failureCode(err, stderr)))
      resolve(String(stdout))
    }))
  }
  async json (...a) { const out = await this.run(...a); try { return JSON.parse(out) } catch { throw new GebCliError(a[0], 'not-json') } }

  /** The listener: every line it prints becomes an event; if it stops, it is started again, and the bridge is told. */
  async start (onEvent) {
    checkHomeModes(this.home)
    this.onEvent = onEvent
    this.stopping = false
    this.listen()
  }
  listen () {
    const child = this.child = this.spawn(this.cmd, this.args('listen', '--json'), { stdio: ['ignore', 'pipe', 'pipe'] })
    createInterface({ input: child.stdout }).on('line', (line) => { const ev = parseListenLine(line); if (ev) this.onEvent(ev) })
    child.stderr?.resume()
    child.on('exit', (code) => {
      if (this.child === child) this.child = null
      if (this.stopping) return
      this.onEvent({ type: 'stopped', code })
      const wait = this.restartMs[Math.min(this.restarts++, this.restartMs.length - 1)]
      this.timer = setTimeout(() => { if (!this.stopping) this.listen() }, wait)
      this.timer.unref?.()
    })
  }
  async stop () { this.stopping = true; clearTimeout(this.timer); this.child?.kill('SIGTERM'); this.child = null }

  // Every DID and room id is checked before it becomes an argument, so nothing from Geb's output can be read as a flag.
  async send (to, text) { return this.run('send', did('send', to), text) }
  async gsend (group, text) { return this.run('gsend', room('gsend', group), text) }
  async accept (from) { return this.run('accept', did('accept', from), '--agree') }
  /** A new MLS room with these members; its id, read back from the room list by its name (the newest of that name). */
  async groupNew (name, members) {
    await this.run('group', 'new', '--mls', name, ...dids('group new', members))
    const rooms = await this.json('groups', '--json')
    const mine = (Array.isArray(rooms) ? rooms : rooms?.groups ?? []).filter((r) => r?.name === name)
    const id = mine.at(-1)?.id
    if (typeof id !== 'string' || !GEB_GROUP_RE.test(id)) throw new GebCliError('group new', 'no-room')
    return id
  }
  async groupAdd (group, members) { return this.run('group', 'add', room('group add', group), ...dids('group add', members)) }
  async groupRemove (group, members) { return this.run('group', 'remove', room('group remove', group), ...dids('group remove', members)) } // to confirm on 0.5.18 before step 1 (docs/geb.md)
  async members (group) {
    const list = await this.json('gmembers', room('gmembers', group), '--json')
    if (!Array.isArray(list)) throw new GebCliError('gmembers', 'not-a-list')
    return list.map((m) => m?.did).filter((d) => typeof d === 'string')
  }
}
