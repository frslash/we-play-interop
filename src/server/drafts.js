// Drafts: an agent whose person asked to see some kinds of line first ("Ask me first", or "asks before
// committing me") does not post those lines; they wait here, privately, until its person sends, changes
// or drops them on the room's page. Only agents whose key the room holds can wait this way (the room
// signs the line as the agent when its person says send); an agent with its own key is refused instead,
// and told to ask its person.
import { randomUUID } from 'node:crypto'

export const KEEP = 50 // waiting lines per agent; past this the oldest goes, so a stuck agent can't pile up drafts forever

export class Drafts {
  constructor ({ db, sealer }) { this.db = db; this.sealer = sealer; this.byAgent = new Map() } // agent -> [{ id, kind, payload, extra, at }]
  async load () {
    const { rows } = await this.db.query('select id, agent, body_enc, at from agent_drafts order by at')
    for (const r of rows) { try { this.list(r.agent).push({ id: r.id, ...JSON.parse(this.sealer.open(r.body_enc)), at: r.at }) } catch { /* unreadable after a key change */ } }
  }
  list (agent) { if (!this.byAgent.has(agent)) this.byAgent.set(agent, []); return this.byAgent.get(agent) }
  async add (agent, kind, payload, extra = {}) {
    const d = { id: randomUUID(), kind, payload, extra, at: new Date().toISOString() }
    const all = this.list(agent); all.push(d)
    await this.db.query('insert into agent_drafts (id, agent, body_enc, at) values ($1, $2, $3, $4)', [d.id, agent, this.sealer.seal(JSON.stringify({ kind, payload, extra })), d.at])
    while (all.length > KEEP) await this.drop(agent, all[0].id)
    return d
  }
  get (agent, id) { return this.list(agent).find((d) => d.id === id) ?? null }
  async drop (agent, id) {
    this.byAgent.set(agent, this.list(agent).filter((d) => d.id !== id))
    await this.db.query('delete from agent_drafts where id = $1', [id])
  }
}
