// The agent's notebook: what an agent knows about its person, for this room.
// Private: only the agent and its person read or add to it (never the public log).
// It starts with what the person brings in (a summary, the work side of a digital
// twin) and grows with every note from the person and everything the agent
// learns. Stored encrypted with the workspace's key, like hosted agents' keys:
// whoever runs the server could read it, and the page says so.
import { TaskError } from './log.js'

const MAX_CHARS = 60_000 // about what an agent can take in at once; the oldest notes drop off beyond it

// A stored notebook that can't be opened (a changed WORKSPACE_KEY, a damaged row) is refused, never read as empty:
// reading it as empty let the next add() replace the row and wipe every earlier note. Nothing is cached, so it reads
// again once the right key is back.
const unreadable = () => new TaskError('notebookUnreadable', 'this notebook is stored but can\'t be opened right now, so nothing was read or changed; tell the room\'s host', { status: 503 })

export class Notebooks {
  constructor ({ db, sealer }) { this.db = db; this.sealer = sealer; this.cache = new Map(); this.readUpTo = new Map() }

  async get (agent) {
    if (this.cache.has(agent)) return this.cache.get(agent)
    const { rows } = await this.db.query('select notes_enc, read_up_to from agent_notes where agent = $1', [agent])
    let notes = []
    if (rows[0]) {
      try { notes = JSON.parse(this.sealer.open(rows[0].notes_enc)) } catch { throw unreadable() }
      if (!Array.isArray(notes)) throw unreadable()
    }
    if (rows[0]?.read_up_to) this.readUpTo.set(agent, rows[0].read_up_to)
    this.cache.set(agent, notes)
    return notes
  }

  async add (agent, from, text) {
    const notes = [...(await this.get(agent)), { at: new Date().toISOString(), from, text: String(text).slice(0, 2000) }]
    while (JSON.stringify(notes).length > MAX_CHARS && notes.length > 1) notes.shift()
    const sealed = this.sealer.seal(JSON.stringify(notes))
    await this.db.query('delete from agent_notes where agent = $1', [agent])
    await this.db.query('insert into agent_notes (agent, notes_enc, updated, read_up_to) values ($1, $2, $3, $4)', [agent, sealed, new Date().toISOString(), this.readUpTo.get(agent) ?? null])
    this.cache.set(agent, notes)
    return notes
  }

  /** Notes from the person the agent has not read yet (counted for its inbox). */
  async unread (agent) {
    const notes = await this.get(agent)
    const since = this.readUpTo.get(agent) ?? ''
    return notes.filter((n) => n.from === 'person' && n.at > since)
  }

  /** The agent opened its notebook: everything in it so far is read. Kept, so the person's page can say so after a restart. */
  async markRead (agent) {
    const at = new Date().toISOString()
    this.readUpTo.set(agent, at)
    await this.db.query('update agent_notes set read_up_to = $2 where agent = $1', [agent, at])
  }

  /** When the agent last opened its notebook (null: never). */
  async readAt (agent) { await this.get(agent); return this.readUpTo.get(agent) ?? null }

  async delete (agent) { await this.db.query('delete from agent_notes where agent = $1', [agent]); this.cache.delete(agent); this.readUpTo.delete(agent) }
}
