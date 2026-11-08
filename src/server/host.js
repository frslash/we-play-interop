// The host: the weaver, as the room's own agent. It belongs to no one and speaks for no one. Its
// permission is written down and signed by the room, once, in the record, like everyone else's:
// welcome people, summarise, point people to each other, run votes and prompt whoever has to act.
// When someone joins for the first time it welcomes them and names the agents listening right now,
// which wakes them to answer from their own side; the host itself never answers for a person.
import { NAME_OF } from '../shared/types.js'

export const CHARTER = 'The host’s permission, signed by the room: I am the room’s host, an AI agent of the room itself, not anyone’s. I may welcome people, summarise what the room is doing, point people to each other, run the votes and prompt whoever has to act. I never speak for a person, never vote, and never commit anyone to anything.'

export class Host {
  constructor ({ ctx, welcomeAfterMs = 3000 }) { this.ctx = ctx; this.after = welcomeAfterMs; this.timers = new Set() }

  /** The charter goes into the record once. */
  async start () {
    const st = this.ctx.log.state
    const signed = this.ctx.log.entries.some((e) => e.author === st.workspace && NAME_OF[e.type] === 'note' && String(e.document.payload.text).startsWith('The host’s permission'))
    if (!signed) await this.ctx.log.appendAsWorkspace('note', { text: CHARTER, kind: 'observation' })
  }

  onEntry (e) {
    const st = this.ctx.log.state, p = st.participants.get(e.author)
    if (this.after === null || NAME_OF[e.type] !== 'join' || p?.kind !== 'human' || p.since !== e.timestamp) return // first joins only (null: no welcomes, for tests)
    if (this.ctx.check?.dids().includes(e.author)) return
    const t = setTimeout(() => { this.timers.delete(t); this.welcome(e.author).catch((err) => console.error('host welcome:', err.message)) }, this.after)
    this.timers.add(t)
  }

  /** The agents a newcomer can ask right now: listening, with a live permission, not the room check's. */
  guides (except) {
    const st = this.ctx.log.state, skip = this.ctx.check?.dids() ?? []
    return [...st.participants.values()].filter((p) => p.kind === 'agent' && !p.removed && !skip.includes(p.did) && p.principal !== except && st.activeDelegation(p.did) && this.ctx.waits?.listening(p.did)).map((p) => p.name).slice(0, 3)
  }

  async welcome (did) {
    const st = this.ctx.log.state, name = st.nameOf(did), g = this.guides(did)
    const text = `Welcome, ${name}. I'm the room's host: an AI agent of the room itself, speaking for no one. Ask anything here: how the room works, how safe it is, how to bring your agent.${g.length ? ` ${g.join(', ')} ${g.length === 1 ? 'is' : 'are'} here now and can answer from their own side.` : ' The agents here answer when they are next around.'}`
    await this.ctx.log.appendAsWorkspace('note', { text, kind: 'message' })
  }

  stop () { for (const t of this.timers) clearTimeout(t) }
}
