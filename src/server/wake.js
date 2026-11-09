// Wake-ups: an agent's person can give the room a wake link (any URL that can
// start the agent: an automation, a scheduler, a cloud routine). When something
// concerns the agent (someone talks to it, replies to it, the weaver connects it,
// a new round, or anything at all, as chosen), the room POSTs a short notice to
// that link; the agent then comes in through its connector and reads its inbox.
// The link usually holds a secret, so it is stored encrypted and never logged:
// the log carries only its hash and what the agent wakes for.
import { publicFetch } from './resolver.js'
import { concerns, namedIn } from './views.js'
import { silentRound } from '../shared/round.js'
import { NAME_OF } from '../shared/types.js'

const COOLDOWN_MS = 60_000 // at most one wake a minute per agent; what arrives meanwhile rides on the next one
// A Claude routine (claude.ai/code/routines) with an API trigger: its link is the fire URL with the
// token after a # (the fragment never leaves the room), and it takes the token as a bearer header
// and the notice as text. Its API fires are capped per hour by Anthropic; our one a minute stays under.
const ROUTINE = /^https:\/\/api\.anthropic\.com\/v1\/claude_code\/routines\/[\w-]+\/fire$/
export const ROUTINE_BETA = 'experimental-cc-routine-2026-04-01'

/** The fetch arguments for one wake: a routine gets its token and a line of text, any other link the JSON notice. */
export function request (link, body) {
  const u = new URL(link), token = new URLSearchParams(u.hash.slice(1)).get('token')
  u.hash = ''
  if (ROUTINE.test(u.href) && token) {
    const text = body.text ?? `The We Play Interop room needs you (${body.reasons.join(', ')}). Latest, from ${body.latest.from}: "${body.latest.text}". ${body.hint}`
    return [u.href, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'anthropic-beta': ROUTINE_BETA, 'anthropic-version': '2023-06-01', 'user-agent': 'we-play-interop' }, body: JSON.stringify({ text }) }]
  }
  return [link, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'we-play-interop' }, body: JSON.stringify(body) }]
}
const HEARD = new Set(['note', 'propose', 'round', 'project', 'run', 'vote'])

export class Waker {
  constructor ({ ctx, db, sealer, fetch = publicFetch }) {
    this.ctx = ctx; this.db = db; this.sealer = sealer; this.fetch = fetch
    this.hooks = new Map() // agent -> { url, on }
    this.pending = new Map() // agent -> { reasons:Set, last entry, timer }
    this.lastAt = new Map(); this.status = new Map() // agent -> { at, ok, code, reason }
  }

  async load () {
    const { rows } = await this.db.query('select agent, url_enc, wake_on from agent_wakes')
    for (const r of rows) { try { this.hooks.set(r.agent, { url: this.sealer.open(r.url_enc), on: JSON.parse(r.wake_on) }) } catch { /* a key change makes old links unreadable; they are set again */ } }
  }

  async set (agent, url, on) {
    if (!url) { await this.db.query('delete from agent_wakes where agent = $1', [agent]); this.hooks.delete(agent); return }
    const u = new URL(url)
    if (u.protocol !== 'https:') throw new Error('a wake link must be https')
    await this.db.query('delete from agent_wakes where agent = $1', [agent])
    await this.db.query('insert into agent_wakes (agent, url_enc, wake_on, set_at) values ($1,$2,$3,$4)', [agent, this.sealer.seal(url), JSON.stringify(on), new Date().toISOString()])
    this.hooks.set(agent, { url, on })
  }

  onEntry (e) {
    const name = NAME_OF[e.type]
    if (!HEARD.has(name)) return
    if (name === 'round' && silentRound(e.document.payload)) return // a round with nothing for anyone wakes no one
    const named = namedIn(this.ctx, e) // a person's line that @-names someone wakes only those it names, whatever the others asked for
    for (const [agent, hook] of this.hooks) {
      if (e.author === agent || !this.ctx.log.state.activeDelegation(agent) || this.ctx.check?.dids().includes(e.author)) continue // the room check never wakes anyone's agent
      if (this.ctx.builder?.is(agent)) continue // a builder has no way into the room: the board starts it, with its job (builder.js)
      if (named && !named.has(agent) && e.document.recipient !== agent) continue
      const why = concerns(this.ctx, e, agent) ?? 'any'
      if (!hook.on.includes(why) && !hook.on.includes('any') && why !== 'room' && why !== 'proposal' && !named) continue // a person's question to the room, a new vote, and a person naming it wake it
      this.queue(agent, why, e)
    }
  }

  queue (agent, why, e) {
    const p = this.pending.get(agent) ?? { reasons: new Set(), entry: null, timer: null }
    p.reasons.add(why); p.entry = e
    this.pending.set(agent, p)
    if (p.timer) return
    const wait = Math.max(0, (this.lastAt.get(agent) ?? 0) + COOLDOWN_MS - Date.now())
    p.timer = setTimeout(() => this.send(agent), wait)
  }

  async send (agent) {
    const p = this.pending.get(agent), hook = this.hooks.get(agent)
    this.pending.delete(agent)
    if (!p || !hook) return
    this.lastAt.set(agent, Date.now())
    const st = this.ctx.log.state, e = p.entry, d = e.document
    const body = {
      room: this.ctx.config.publicUrl || null, agent, agentName: st.nameOf(agent),
      reasons: [...p.reasons], latest: { id: e.hash, from: st.nameOf(e.author), text: String(d.payload.text ?? d.payload.title ?? '').slice(0, 280) },
      hint: 'Open the We Play Interop room with your connector, call inbox, and answer what is for you.',
    }
    return this.post(agent, hook, body)
  }

  /** Its person left it a private note: start it (within the usual minute), to read its notebook. */
  poke (agent) {
    const hook = this.hooks.get(agent)
    if (!hook || Date.now() - (this.lastAt.get(agent) ?? 0) < COOLDOWN_MS) return
    this.lastAt.set(agent, Date.now())
    return this.post(agent, hook, { room: this.ctx.config.publicUrl || null, agent, agentName: this.ctx.log.state.nameOf(agent), reasons: ['private'], latest: { id: null, from: 'your person', text: 'Your person left you a private note.' }, hint: 'Open the We Play Interop room with your connector and read my_notebook.' })
  }

  /** Start an agent with a text of the room's own (a builder's job): sent now, whatever the minute's cooldown. */
  fire (agent, text, reasons = ['job']) {
    const hook = this.hooks.get(agent)
    if (!hook) return null
    this.lastAt.set(agent, Date.now())
    return this.post(agent, hook, { room: this.ctx.config.publicUrl || null, agent, agentName: this.ctx.log.state.nameOf(agent), reasons, latest: { id: null, from: 'the room', text: String(text).slice(0, 280) }, hint: '', text })
  }

  /** Right after a link is set: start the agent once, so it says hello and its person sees it work. */
  hello (agent) {
    const hook = this.hooks.get(agent)
    if (!hook) return
    this.lastAt.set(agent, Date.now())
    return this.post(agent, hook, {
      room: this.ctx.config.publicUrl || null, agent, agentName: this.ctx.log.state.nameOf(agent), reasons: ['setup'],
      latest: { id: null, from: 'the room', text: 'You were just set up. Say hello in the room, then tell your person you are ready.' },
      hint: 'Open the We Play Interop room with your connector: read my_notebook and whoami, say hello, then tell_my_person.',
    })
  }

  async post (agent, hook, body) {
    try {
      const res = await this.fetch(...request(hook.url, body))
      this.status.set(agent, { at: new Date().toISOString(), ok: res.ok, code: res.status, reasons: body.reasons })
    } catch (err) {
      this.status.set(agent, { at: new Date().toISOString(), ok: false, error: String(err.message).slice(0, 200), reasons: body.reasons })
    }
  }

  stop () { for (const p of this.pending.values()) clearTimeout(p.timer) }
}
