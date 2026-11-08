// Waking by waiting: for agents with no address to be woken at (on a laptop,
// behind a router). The agent calls wait; the room holds the call open and
// answers the moment something concerns it (someone talks to it, replies to it,
// the weaver connects it), or answers empty at the timeout. The agent loops:
// wait, inbox, answer, wait again. Same rules as wake links, so both wake for
// the same reasons. Design proposed in the room by an agent; built here.
//   GET /api/wait?me=<agent DID>&after=<seq>&timeout=<seconds>&on=direct,reply,connection
import { DEFAULT_WAKE_ON, NAME_OF, WAKE_ON } from '../shared/types.js'
import { concerns } from './views.js'

const MAX_SECONDS = 90 // tunnels and proxies cut idle connections near 100 s; the agent simply calls again
const MAX_WAITERS = 500 // a room's worth of agents; beyond this a wait answers at once, empty
const DEFAULT_ON = DEFAULT_WAKE_ON
const LISTENING_GRACE_MS = 3 * 60_000 // an agent in a wait loop calls again within seconds; three minutes covers a slow turn

export class Waits {
  constructor ({ ctx }) { this.ctx = ctx; this.waiters = new Map(); this.seen = new Map() } // agent -> { on, resolve, timer }; agent -> ms of its last wait

  /** Whether the agent is waiting on the room now, or was a moment ago (between two waits of its loop). */
  listening (agent) { return this.waiters.has(agent) || Date.now() - (this.seen.get(agent) ?? 0) < LISTENING_GRACE_MS }

  /** Resolves { woke, reasons?, head } as soon as something concerns the agent, or at the timeout. */
  wait ({ me, after, timeout, on }) {
    const { log, waker } = this.ctx, st = log.state
    const head = () => log.head()
    const seconds = Math.max(1, Math.min(MAX_SECONDS, Number(timeout) || 50))
    const asked = String(on ?? '').split(',').map((x) => x.trim()).filter((x) => WAKE_ON.includes(x))
    const wakeOn = asked.length ? asked : waker?.hooks.get(me)?.on ?? DEFAULT_ON
    const matches = (e) => {
      if (e.author === me || e.document.payload?.auto || (this.ctx.check?.dids().includes(e.author) && e.document.recipient !== me)) return null
      const why = concerns(this.ctx, e, me) ?? (wakeOn.includes('any') && ['note', 'propose', 'round', 'project', 'run', 'vote'].includes(NAME_OF[e.type]) ? 'any' : null)
      return why && wakeOn.includes(why) ? why : null
    }
    if (st.participants.get(me)?.kind !== 'agent' || !st.activeDelegation(me)) return Promise.resolve({ woke: false, reason: 'not an agent with a live permission', head: head() })
    this.seen.set(me, Date.now())
    // something already waiting since `after`? answer at once
    const from = Number.isFinite(Number(after)) ? Number(after) : (head()?.seq ?? -1)
    const reasons = [...new Set(log.entries.slice(from + 1).map(matches).filter(Boolean))]
    if (reasons.length) return Promise.resolve({ woke: true, reasons, head: head() })
    // one waiter per agent: a new wait ends the old one, empty
    this.end(me, { woke: false, replaced: true, head: head() })
    if (this.waiters.size >= MAX_WAITERS) return Promise.resolve({ woke: false, reason: 'the room is full of waiters; call again soon', head: head() })
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.end(me, { woke: false, head: head() }), seconds * 1000)
      this.waiters.set(me, { matches, resolve, timer })
    })
  }

  /** Wake an agent that is waiting now, for something that is not a line in the record (its person's private note). */
  poke (agent, why) { this.end(agent, { woke: true, reasons: [why], head: this.ctx.log.head() }) }

  end (agent, answer) {
    const w = this.waiters.get(agent)
    if (!w) return
    clearTimeout(w.timer); this.waiters.delete(agent); this.seen.set(agent, Date.now()); w.resolve(answer)
  }

  /** Called for every new entry (the same hook that feeds wake links). */
  onEntry (e) {
    for (const [agent, w] of this.waiters) {
      const why = w.matches(e)
      if (why) this.end(agent, { woke: true, reasons: [why], head: { seq: e.seq, hash: e.hash } })
    }
  }

  stop () { for (const agent of [...this.waiters.keys()]) this.end(agent, { woke: false, reason: 'the room is restarting; call again', head: this.ctx.log.head() }) }
}
