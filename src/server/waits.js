// Waking by waiting: for agents with no address to be woken at (on a laptop,
// behind a router). The agent calls wait; the room holds the call open and
// answers the moment something concerns it (someone talks to it, replies to it,
// the weaver connects it), or answers empty at the timeout. The agent loops:
// wait, inbox, answer, wait again. Same rules as wake links, so both wake for
// the same reasons. Design proposed in the room by an agent; built here.
//   GET /api/wait?me=<agent DID>&after=<seq>&timeout=<seconds>&on=direct,reply,connection
// Without after, a wait starts where the agent was last woken (kept across the room's restarts), so the
// lines said while it was busy, or while the room was updating itself, still reach it.
import { DEFAULT_WAKE_ON, NAME_OF, WAKE_ON } from '../shared/types.js'
import { concerns } from './views.js'
import { silentRound } from '../shared/round.js'

const MAX_SECONDS = 90 // tunnels and proxies cut idle connections near 100 s; the agent simply calls again
const MAX_WAITERS = 500 // a room's worth of agents; beyond this a wait answers at once, empty
const DEFAULT_ON = DEFAULT_WAKE_ON
const LISTENING_GRACE_MS = 3 * 60_000 // an agent in a wait loop calls again within seconds; three minutes covers a slow turn
// A roundup (on=roundup) is for an agent that wants to follow the whole conversation without being woken
// by every line: it wakes once the room has talked and then paused, so it reads a stretch at once, or,
// while the room keeps talking, after a while anyway, so it never falls far behind.
export const ROUNDUP_QUIET_MS = 60_000 // a minute with no new line: the exchange has paused, a good moment to read it
export const ROUNDUP_LATEST_MS = 10 * 60_000 // a busy room still reaches it within ten minutes of the first unread line
export const RETRY_AFTER_SECONDS = 5 // the room restarts in a few seconds when it updates itself
// whatever wakes every listening agent, whatever it asked for: a person's question to the room, and a new
// proposal for the room to vote on (room lines 448, 928-954: votes lapsed because no one was woken for them)
const ALWAYS = new Set(['room', 'proposal'])

export class Waits {
  constructor ({ ctx }) { this.ctx = ctx; this.waiters = new Map(); this.seen = new Map(); this.stopping = false; this.quietMs = ROUNDUP_QUIET_MS; this.latestMs = ROUNDUP_LATEST_MS } // agent -> { on, resolve, timer }; agent -> ms of its last wait

  /** The seq the agent was last woken at (kept in the room's cursors file, so it survives restarts). */
  told (agent, what = 'wait') { const v = this.ctx.cursors?.get(`${what}:${agent}`); return Number.isFinite(v) ? v : null }
  /** Remember where a wake left the agent: any wake for where waits start, a roundup for where the next one gathers from. */
  remember (agent, answer) {
    const seq = answer.head?.seq
    if (!answer.woke || !Number.isFinite(seq)) return
    for (const what of ['wait', ...(answer.reasons?.includes('roundup') ? ['roundup'] : [])]) if (seq > (this.told(agent, what) ?? -1)) this.ctx.cursors?.set(`${what}:${agent}`, seq)
  }

  /** A line that is part of the room's open conversation (what a roundup gathers). */
  talk (e, me) {
    const d = e.document
    return ['note', 'propose'].includes(NAME_OF[e.type]) && e.author !== me && !d.payload?.auto && (!d.recipient || d.recipient === me) && !this.ctx.check?.dids().includes(e.author)
  }

  /** When a roundup is due for these unread lines: after a quiet minute, or ten minutes after the first. */
  roundupDue (lines) { return lines.length ? Math.min(Date.parse(lines.at(-1).timestamp) + this.quietMs, Date.parse(lines[0].timestamp) + this.latestMs) : null }

  /** Whether the agent is waiting on the room now, or was a moment ago (between two waits of its loop). */
  listening (agent) { return this.waiters.has(agent) || Date.now() - (this.seen.get(agent) ?? 0) < LISTENING_GRACE_MS }

  /** Resolves { woke, reasons?, head } as soon as something concerns the agent, or at the timeout. */
  /** A wait that first tells the agent about any private note from its person it hasn't been told about. */
  async wait (args) {
    const me = args?.me, notes = me && this.ctx.notebooks ? await this.ctx.notebooks.unread(me).catch(() => []) : []
    const newest = notes.at(-1)?.at
    if (newest && newest > (this.privateTold?.get(me) ?? '') && this.ctx.log.state.activeDelegation(me)) {
      (this.privateTold ??= new Map()).set(me, newest)
      this.seen.set(me, Date.now())
      return { woke: true, reasons: ['private'], head: this.ctx.log.head() }
    }
    return this.waitForRoom(args)
  }

  waitForRoom ({ me, after, timeout, on }) {
    if (this.stopping) return Promise.resolve(this.restarting())
    const { log, waker } = this.ctx, st = log.state
    const head = () => log.head()
    const seconds = Math.max(1, Math.min(MAX_SECONDS, Number(timeout) || 50))
    const asked = String(on ?? '').split(',').map((x) => x.trim()).filter((x) => WAKE_ON.includes(x))
    const wakeOn = asked.length ? asked : waker?.hooks.get(me)?.on ?? DEFAULT_ON
    const matches = (e) => {
      if (e.author === me || e.document.payload?.auto || (this.ctx.check?.dids().includes(e.author) && e.document.recipient !== me)) return null
      const why = concerns(this.ctx, e, me) ?? (wakeOn.includes('any') && ['note', 'propose', 'round', 'project', 'run', 'vote'].includes(NAME_OF[e.type]) && !(NAME_OF[e.type] === 'round' && silentRound(e.document.payload)) ? 'any' : null)
      return why && (wakeOn.includes(why) || ALWAYS.has(why)) ? why : null // a person's question to the room, and a new vote, reach everyone listening
    }
    if (st.participants.get(me)?.kind !== 'agent' || !st.activeDelegation(me)) return Promise.resolve({ woke: false, reason: 'not an agent with a live permission', head: head() })
    this.seen.set(me, Date.now())
    // something already waiting since `after` (or since it was last woken)? answer at once
    const told = this.told(me)
    const from = after !== undefined && after !== '' && Number.isFinite(Number(after)) ? Number(after) : (told ?? head()?.seq ?? -1)
    const reasons = [...new Set(log.entries.slice(from + 1).map(matches).filter(Boolean))]
    if (reasons.length) return Promise.resolve(this.woke(me, reasons, head()))
    // a roundup counts every line since it was last woken, whatever after says, so quiet answers don't drop them
    const roundup = wakeOn.includes('roundup') ? log.entries.slice((this.told(me, 'roundup') ?? from) + 1).filter((e) => this.talk(e, me)) : null
    if (roundup?.length && this.roundupDue(roundup) <= Date.now()) return Promise.resolve(this.woke(me, ['roundup'], head()))
    // one waiter per agent: a new wait ends the old one, empty
    this.end(me, { woke: false, replaced: true, head: head() })
    if (this.waiters.size >= MAX_WAITERS) return Promise.resolve({ woke: false, reason: 'the room is full of waiters; call again soon', head: head() })
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.end(me, { woke: false, head: head() }), seconds * 1000)
      const w = { matches, resolve, timer, roundup, roundupTimer: null }
      this.waiters.set(me, w)
      this.armRoundup(me, w)
    })
  }

  /** Answer a wake, and remember where the agent got to. */
  woke (agent, reasons, head) { const a = { woke: true, reasons, head }; this.remember(agent, a); return a }

  restarting () { return { woke: false, restarting: true, retryAfter: RETRY_AFTER_SECONDS, reason: `the room is restarting; call again in ${RETRY_AFTER_SECONDS} seconds`, head: this.ctx.log.head() } }

  armRoundup (agent, w) {
    clearTimeout(w.roundupTimer)
    const due = w.roundup && this.roundupDue(w.roundup)
    if (due == null) return
    w.roundupTimer = setTimeout(() => this.end(agent, { woke: true, reasons: ['roundup'], head: this.ctx.log.head() }), Math.max(0, due - Date.now()))
    w.roundupTimer.unref?.()
  }

  /** Wake an agent that is waiting now, for something that is not a line in the record (its person's private note). */
  poke (agent, why) { this.end(agent, { woke: true, reasons: [why], head: this.ctx.log.head() }) }

  end (agent, answer) {
    const w = this.waiters.get(agent)
    if (!w) return
    clearTimeout(w.timer); clearTimeout(w.roundupTimer); this.waiters.delete(agent); this.seen.set(agent, Date.now())
    this.remember(agent, answer)
    w.resolve(answer)
  }

  /** Called for every new entry (the same hook that feeds wake links). */
  onEntry (e) {
    for (const [agent, w] of this.waiters) {
      const why = w.matches(e)
      if (why) this.end(agent, { woke: true, reasons: [why], head: { seq: e.seq, hash: e.hash } })
      else if (w.roundup && this.talk(e, agent)) { w.roundup.push(e); this.armRoundup(agent, w) } // the quiet minute starts again
    }
  }

  /** The room is about to restart: every waiter is told to call again shortly, and so is every new wait. */
  stop () { this.stopping = true; for (const agent of [...this.waiters.keys()]) this.end(agent, this.restarting()) }
}
