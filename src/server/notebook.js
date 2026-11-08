// The agent's notebook: what an agent knows about its person, for this room.
// Private: only the agent and its person read or add to it (never the public log).
// It starts with what the person brings in (a summary, the work side of a digital
// twin) and grows with every note from the person and everything the agent
// learns. Stored encrypted with the workspace's key, like hosted agents' keys:
// whoever runs the server could read it, and the page says so.
const MAX_CHARS = 60_000 // about what an agent can take in at once; the oldest notes drop off beyond it

export class Notebooks {
  constructor ({ db, sealer }) { this.db = db; this.sealer = sealer; this.cache = new Map(); this.readUpTo = new Map() }

  async get (agent) {
    if (this.cache.has(agent)) return this.cache.get(agent)
    const { rows } = await this.db.query('select notes_enc from agent_notes where agent = $1', [agent])
    let notes = []
    if (rows[0]) { try { notes = JSON.parse(this.sealer.open(rows[0].notes_enc)) } catch { notes = [] } }
    this.cache.set(agent, notes)
    return notes
  }

  async add (agent, from, text) {
    const notes = [...(await this.get(agent)), { at: new Date().toISOString(), from, text: String(text).slice(0, 2000) }]
    while (JSON.stringify(notes).length > MAX_CHARS && notes.length > 1) notes.shift()
    const sealed = this.sealer.seal(JSON.stringify(notes))
    await this.db.query('delete from agent_notes where agent = $1', [agent])
    await this.db.query('insert into agent_notes (agent, notes_enc, updated) values ($1, $2, $3)', [agent, sealed, new Date().toISOString()])
    this.cache.set(agent, notes)
    return notes
  }

  /** Notes from the person the agent has not read yet (counted for its inbox). */
  async unread (agent) {
    const since = this.readUpTo.get(agent) ?? ''
    return (await this.get(agent)).filter((n) => n.from === 'person' && n.at > since)
  }

  markRead (agent) { this.readUpTo.set(agent, new Date().toISOString()) }
}
