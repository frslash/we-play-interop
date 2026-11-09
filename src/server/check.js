// The room check: a test person and their agent walk the newcomer's path in the real room, through the
// room's own front door (its public address when it has one), after every start and on a schedule:
// the page loads, joining works, an agent can be made, its connector answers, it can wait on the room,
// a line to it wakes it, and its answer lands. Each run keeps which step worked, how long it took, and why
// a step failed (never anyone's words); the page shows the latest to everyone coming in, with since when a
// step has been broken. It writes like anyone else (a line to its agent and the agent's answer, each run);
// the page leaves the check out of Talk, Watch and the counts, and the Log keeps it all.
import { hkdfSync } from 'node:crypto'
import { signPermissionCredential } from '../shared/credential.js'
import { newIdentity } from '../shared/did.js'
import { AGENT_SCOPES, TYPES, signedDocument } from '../shared/types.js'

export const STEPS = {
  page: 'the page loads',
  join: 'joining',
  agent: 'making an agent',
  connect: 'its Claude connecting',
  listen: 'waiting on the room',
  wake: 'a line to it waking it',
  answer: 'its answer landing',
}
const KEEP_RUNS = 60 // about a week at the default pace; enough to say since when something broke
const RENEW_MS = 7 * 86400000 // give the check's agent a fresh permission when this little is left

export class RoomCheck {
  constructor ({ ctx, db, sealer, everyMinutes = 180, fetch = globalThis.fetch }) {
    this.ctx = ctx; this.db = db; this.sealer = sealer; this.fetch = fetch; this.everyMs = everyMinutes * 60_000
    this.me = newIdentity(Buffer.from(hkdfSync('sha256', ctx.identity.seed, 'we-play-interop', 'room-check', 32)))
    this.agent = null // { did, connector }
    this.runs = []; this.running = null; this.timer = null
  }

  async load () {
    const { rows } = await this.db.query('select k, v from room_check')
    for (const r of rows) {
      try {
        if (r.k === 'agent') this.agent = JSON.parse(this.sealer.open(r.v))
        if (r.k === 'runs') this.runs = JSON.parse(r.v)
      } catch { /* a key change makes the agent unreadable; the next run makes a new one */ }
    }
  }

  async put (k, v) {
    await this.db.query('delete from room_check where k = $1', [k])
    await this.db.query('insert into room_check (k, v) values ($1, $2)', [k, v])
  }

  /** The DIDs the page leaves out of the room's own view. */
  dids () { return [this.me.did, this.agent?.did].filter(Boolean) }

  /** What the page shows: the latest run, and since when each failing step has failed. */
  view () {
    const last = this.runs.at(-1)
    if (!last) return { dids: this.dids(), at: null }
    const brokenSince = {}
    for (const s of last.steps.filter((x) => !x.ok)) {
      let since = last.at
      for (let i = this.runs.length - 1; i >= 0; i--) { const st = this.runs[i].steps.find((x) => x.step === s.step); if (st && !st.ok) since = this.runs[i].at; else break }
      brokenSince[s.step] = since
    }
    return { dids: this.dids(), at: last.at, ok: last.ok, ms: last.ms, steps: last.steps, brokenSince, runs: this.runs.length, okRuns: this.runs.filter((r) => r.ok).length, labels: STEPS, everyMinutes: this.everyMs / 60_000 }
  }

  start (port) {
    this.port = port
    setTimeout(() => this.run('start').catch(() => {}), 20_000).unref?.()
    this.timer = setInterval(() => this.run('schedule').catch(() => {}), this.everyMs)
    this.timer.unref?.()
  }

  stop () { clearInterval(this.timer) }

  base () { return this.ctx.config.publicUrl || `http://localhost:${this.port ?? this.ctx.server?.address()?.port}` }

  /** One walk through the path. At most one at a time; asking during a run gets that run. */
  run (why = 'asked') {
    if (this.running) return this.running
    this.running = this.walk(why).finally(() => { this.running = null })
    return this.running
  }

  async walk (why) {
    const base = this.base(), st = this.ctx.log.state, steps = [], started = Date.now()
    const timed = async (step, fn) => {
      const t = Date.now()
      try { const note = await fn(); steps.push({ step, ok: true, ms: Date.now() - t, ...(note ? { note } : {}) }); return true } catch (err) { steps.push({ step, ok: false, ms: Date.now() - t, why: String(err.message ?? err).slice(0, 200) }); return false }
    }
    const get = async (path, ms = 15_000) => { const r = await this.fetch(base + path, { signal: AbortSignal.timeout(ms) }); if (!r.ok) throw new Error(`${path} answered ${r.status}`); return r }
    const send = async (id, name, payload, extra = {}) => {
      const r = await this.fetch(base + '/api/entries', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signedDocument(id, { type: TYPES[name], payload, ...extra })), signal: AbortSignal.timeout(15_000) })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(`${name} refused (${r.status}): ${body?.payload?.message ?? ''}`.trim())
      return body
    }
    const rpc = async (method, params) => { // through the same front door as everything else
      const r = await this.fetch(this.agent.connector.replace(/^https?:\/\/[^/]+/, base), { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15_000) })
      if (!r.ok) throw new Error(`the connector answered ${r.status}`)
      const body = await r.json()
      if (body.error) throw new Error(body.error.message)
      if (body.result?.isError) throw new Error(body.result.content?.[0]?.text ?? 'the tool refused')
      return body.result
    }

    const go = await timed('page', async () => {
      const page = await (await get('/')).text()
      if (!page.includes('We Play Interop')) throw new Error('the page loaded without the room in it')
      await get('/setup.js'); await get('/app.js')
    })
    if (go) await timed('join', async () => { if (st.participants.get(this.me.did)?.kind !== 'human') await send(this.me, 'join', { name: 'Room check' }) })
    if (steps.at(-1).ok && steps.at(-1).step === 'join') {
      await timed('agent', async () => {
        const a = this.agent && st.participants.get(this.agent.did), d = a && st.activeDelegation(this.agent.did)
        if (!a || a.removed || !this.agent.connector) {
          const made = await send(this.me, 'host', { label: 'Room check agent' })
          if (!made.hosted?.connector) throw new Error('making an agent gave no connector link')
          this.agent = { did: made.hosted.did, connector: made.hosted.connector }
          await this.put('agent', this.sealer.seal(JSON.stringify(this.agent)))
        }
        if (!d || Date.parse(d.expiresAt) - Date.now() < RENEW_MS) {
          const now = new Date(), issuedAt = now.toISOString(), expiresAt = new Date(now.getTime() + 90 * 86400000).toISOString()
          const credential = signPermissionCredential(this.me, { agent: this.agent.did, room: st.workspace, scope: AGENT_SCOPES, validFrom: issuedAt, validUntil: expiresAt }) // as the page signs it
          await send(this.me, 'delegate', { delegate: this.agent.did, scope: AGENT_SCOPES, label: 'Room check agent', credential }, { issuedAt, expiresAt })
          return 'gave it a fresh permission'
        }
      })
    }
    if (steps.at(-1).ok && steps.at(-1).step === 'agent') {
      const ok = await timed('connect', async () => { const r = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'room-check', version: '1' } }); if (!r?.serverInfo) throw new Error('the connector did not introduce itself') })
      let waiting = null, said = null
      if (ok) {
        await timed('listen', async () => {
          const head = this.ctx.log.head()?.seq ?? -1
          waiting = this.fetch(`${base}/api/wait?as=text&timeout=40&after=${head}&me=${encodeURIComponent(this.agent.did)}`, { signal: AbortSignal.timeout(50_000) }).then((r) => r.text())
          waiting.catch(() => {})
          for (let i = 0; i < 30 && !this.ctx.waits.listening(this.agent.did); i++) await new Promise((r) => setTimeout(r, 100))
          if (!this.ctx.waits.listening(this.agent.did)) throw new Error('its wait did not reach the room')
        })
      }
      if (waiting && steps.at(-1).ok) {
        await timed('wake', async () => {
          said = await send(this.me, 'note', { text: `Room check (${new Date().toISOString().slice(0, 16)}Z): are you there?`, kind: 'question' }, { recipient: this.agent.did })
          const line = await waiting
          if (!/^woke \d+ .*direct/.test(line)) throw new Error(`the wait answered "${line.trim().slice(0, 60)}" instead of waking`)
        })
      }
      if (said && steps.at(-1).ok) {
        await timed('answer', async () => {
          await rpc('tools/call', { name: 'say', arguments: { text: 'Here. (room check)', reply_to: said.hash } })
          const a = st.participants.get(this.agent.did)
          if (!a?.lastSaid || Date.parse(a.lastSaid) < started) throw new Error('the answer did not show up in the room')
        })
      }
    }
    for (const step of Object.keys(STEPS)) if (!steps.some((s) => s.step === step)) steps.push({ step, ok: false, skipped: true, why: 'not reached' })
    const run = { at: new Date(started).toISOString(), why, ok: steps.every((s) => s.ok), ms: Date.now() - started, base: this.ctx.config.publicUrl ? 'public' : 'local', steps }
    this.runs = [...this.runs, run].slice(-KEEP_RUNS)
    await this.put('runs', JSON.stringify(this.runs)).catch((e) => console.error('room check: could not keep the run', e.message))
    if (!run.ok) console.warn(`room check: ${steps.filter((s) => !s.ok && !s.skipped).map((s) => `${s.step}: ${s.why}`).join('; ')}`)
    return run
  }
}
