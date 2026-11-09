// A line that names someone is for them (room line 2760, agreed 4 to 0). A person's line that @-names someone wakes only
// those it names (views.js namedIn, used by wake.js and waits.js), and the agents' instructions say a line that names
// others isn't theirs. An agent that answers one anyway gets one gentle note from the weaver, once: the note itself is
// in the log, so the weaver remembers it across restarts and never says it to that agent again.
import { NAME_OF } from '../shared/types.js'
import { namedIn } from './views.js'

export const NOT_NAMED = 'not-named' // what the weaver's note is, in its payload (weaver.what)

/** The weaver's note to an agent that answered a line naming others: friendly, short, said once. */
export const noteText = (agentName, names) => `@${agentName}, a gentle note: that line named ${names.join(' and ')}, so it was for ${names.length > 1 ? 'them' : 'them alone'}. A line that names others isn't yours: reply only when you're named or asked. I'll remember this, so I won't say it again.`

export class NotNamed {
  constructor ({ ctx }) { this.ctx = ctx; this.told = new Set() } // agents noted this run (the log keeps the rest)

  /** Whether the weaver has noted this agent before (its note is in the log). */
  noted (agent) {
    if (this.told.has(agent)) return true
    const ws = this.ctx.log.state.workspace
    return this.ctx.log.entries.some((x) => x.author === ws && x.document.payload?.weaver?.what === NOT_NAMED && x.document.payload.weaver.agent === agent)
  }

  /** The line an agent's reply answers, when it was a person's line that named others (not the agent, not its person). */
  answeredAnyway (e) {
    const st = this.ctx.log.state, d = e.document
    if (NAME_OF[e.type] !== 'note' || !st.isAgent(e.author) || !d.threadId || d.payload?.auto) return null
    const to = this.ctx.log.byDocId.get(d.threadId), named = to && namedIn(this.ctx, to)
    if (!named || named.has(e.author)) return null // named: it was asked
    if (to.author === st.participants.get(e.author)?.principal) return null // its own person: it was asked
    if (to.document.recipient === e.author) return null
    return { to, named }
  }

  async onEntry (e) {
    const hit = this.answeredAnyway(e)
    if (!hit || this.noted(e.author)) return null
    this.told.add(e.author)
    const st = this.ctx.log.state, names = [...hit.named].map((did) => st.nameOf(did))
    return this.ctx.log.appendAsWorkspace('note', { text: noteText(st.nameOf(e.author), names), kind: 'message', weaver: { what: NOT_NAMED, agent: e.author, line: hit.to.hash } }, { threadId: e.document.id })
  }
}
