// InWove on Geb (docs/geb.md): the room holds its own Geb identity and one Geb group room, and keeps that room in step with
// this one, both ways. A line said in the Geb room by a linked member is written here as a `geb:relayed` line, signed by
// the room and naming the member; a line said in People and AIs here is posted into the Geb room by the room, naming its
// author. People only lines never cross: the bridge reads the log exactly as the room's AIs read it (audience.js).
//
// A member links their own Geb identity with two proofs, so nobody can claim someone else's: a one-time code the room
// gives them, sent from that Geb identity to the room over Geb, and then their own signed `member:link-geb` line naming
// it (log.js checks the second against the first). Until the room has the go-ahead to open this to members, only a host
// may link (GEB_LINK_HOSTS_ONLY).
//
// The bridge talks to Geb through a node (geb-cli.js runs Geb's CLI; the tests use a fake). It is the only writer of
// the room's Geb identity: one listener, one bridge. Who is in the Geb room is kept to exactly the room's identity and
// the linked members: when someone leaves or unlinks, they are taken out, and if that cannot be done the bridge stops
// posting until it can, so a line never reaches someone who is no longer in the room.
import { randomBytes } from 'node:crypto'
import { NAME_OF, GEB_TEXT_MAX } from '../shared/types.js'
import { isPeopleOnly } from './audience.js'

export const GEB_LINK_HOSTS_ONLY = true // a code change, reviewed, lifts this once Legal's conditions for members are met (docs/geb.md)
export const LINK_CODE_MINUTES = 10
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no 0/O or 1/I: read off a screen and typed

/** A one-time code a person sends from their Geb identity to the room: "INWOVE-" and ten letters and digits. */
export const newLinkCode = () => 'INWOVE-' + [...randomBytes(10)].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('')
const day = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10)
/** What the room posts into the Geb room for a line said here: who said it, then what. Never starts with "-", so a CLI cannot read it as a flag. */
export const outboundText = (name, text) => `${name}: ${text}`.replace(/^-+/, (m) => '–'.repeat(m.length)).slice(0, GEB_TEXT_MAX)

export class GebBridge {
  /**
   * `node`: { did, start(onEvent), stop(), send(did, text), gsend(group, text), groupNew(name, dids) -> id,
   * groupAdd(group, dids), groupRemove(group, dids), members(group) -> [did], accept(did) } (geb-cli.js).
   */
  constructor ({ ctx, node, now = () => Date.now(), groupName = 'InWove' }) {
    Object.assign(this, { ctx, node, now, groupName })
    this.codes = new Map() // member -> { code, expiresMs }: one waiting code per person
    this.proofs = new Map() // member -> { did, atMs }: the Geb identity their code came from, until they link or it runs out
    this.inflight = new Set() // Geb message ids being written right now
    this.counts = new Map() // 'YYYY-MM-DD what' -> n, not yet written to the database
    this.running = false
    this.paused = null // why the bridge is not posting out, when it is not
    this.outbox = Promise.resolve() // lines go out one at a time, in order
  }

  get log () { return this.ctx.log }
  get st () { return this.ctx.log.state }
  /** The Geb room the room keeps, if it has made one as its present identity (a new identity makes a new room). */
  get group () { const r = this.st.gebRoom; return r && r.did === this.node?.did ? r.group : null }

  /** Start: the listener (which must run for Geb to seat anyone), then who is in the Geb room. */
  async start () {
    if (!this.node?.did) throw new Error('the Geb node has no identity')
    this.log.gebProof = (member, did) => this.proven(member, did)
    await this.node.start((ev) => this.onEvent(ev).catch((err) => { this.count('error'); console.error('geb bridge:', err.message) }))
    this.running = true
    this.count('started')
    await this.later(() => this.reconcile())
    this.flushTimer = setInterval(() => this.flush().catch(() => {}), 60_000)
    this.flushTimer.unref?.()
  }

  async stop () {
    this.running = false
    clearInterval(this.flushTimer)
    await this.node?.stop?.()
    await this.flush().catch(() => {})
  }

  // ---- linking: the code, then the person's own line
  /** A fresh one-time code for a member (one at a time: a new one replaces the last). */
  linkCode (member) {
    const code = newLinkCode(), expiresMs = this.now() + LINK_CODE_MINUTES * 60_000
    this.codes.set(member, { code, expiresMs })
    this.proofs.delete(member)
    this.count('codes')
    return { code, roomDid: this.node.did, expiresAt: new Date(expiresMs).toISOString() }
  }
  /** Where a member's link stands: the Geb identity their code came from, once it has. */
  linkStatus (member) {
    const p = this.proofs.get(member)
    if (p && this.now() - p.atMs < LINK_CODE_MINUTES * 60_000) return { proven: true, did: p.did }
    const c = this.codes.get(member)
    return { proven: false, waiting: Boolean(c && c.expiresMs > this.now()) }
  }
  /** log.js asks this before a member:link-geb line: did this member's code arrive from that Geb identity, recently? */
  proven (member, did) {
    const p = this.proofs.get(member)
    return Boolean(p && p.did === did && this.now() - p.atMs < LINK_CODE_MINUTES * 60_000)
  }
  waitingCodes () { const t = this.now(); return [...this.codes.values()].some((c) => c.expiresMs > t) }

  // ---- what Geb says
  async onEvent (ev) {
    if (!ev) return
    if (ev.type === 'request') { // someone asks to talk to the room: only while someone is linking, and only so their code can arrive
      if (!ev.from || !this.waitingCodes()) return this.count('requests-ignored')
      await this.node.accept(ev.from); return this.count('requests-accepted')
    }
    if (ev.type === 'stopped') { this.count('listener-stopped'); return }
    if (ev.type !== 'message') return
    if (!ev.signed) return this.count('refused-unsigned') // Geb checked the sender's signature, or it does not count
    if (ev.from === this.node.did) return // the room's own line, coming back
    if (ev.direct) return this.onDirect(ev)
    if (ev.group !== this.group) return this.count('other-rooms')
    if (this.st.gebSeen.has(ev.id) || this.inflight.has(ev.id)) return this.count('duplicates')
    const member = this.st.gebByDid.get(ev.from)
    if (!member || !this.st.isCurrentMember(member)) return this.count('refused-unlinked')
    const text = (ev.text ?? '').trim().slice(0, GEB_TEXT_MAX)
    if (!text) return this.count('refused-empty')
    for (const guard of this.log.guards ?? []) if (guard({ payload: { text } }, member, 'note')) return this.count('refused-guard') // nothing secret enters the record, from here either
    this.inflight.add(ev.id)
    try {
      await this.log.appendAsWorkspace('gebRelayed', { from: ev.from, member, group: ev.group, id: ev.id, text, at: new Date(ev.at).toISOString() })
      this.count('in')
    } finally { this.inflight.delete(ev.id) }
  }
  /** A one-to-one line to the room: only a link code counts. */
  onDirect (ev) {
    const said = (ev.text ?? '').trim().toUpperCase(), t = this.now()
    for (const [member, c] of this.codes) {
      if (c.code !== said || c.expiresMs <= t) continue
      this.codes.delete(member)
      this.proofs.set(member, { did: ev.from, atMs: t })
      return this.count('codes-heard')
    }
    this.count('direct-ignored')
  }

  // ---- what is said here
  /** Called for every new line in the record. */
  onEntry (e) {
    if (!this.running) return
    const name = NAME_OF[e.type]
    if (name === 'linkGeb') { if (!e.document.payload.end) this.proofs.delete(e.author); this.later(() => this.reconcile()); return }
    if (name === 'leave' || name === 'replace') { this.later(() => this.reconcile()); return }
    if (!this.crosses(e)) return
    const p = e.document.payload, author = e.author === e.onBehalfOf ? this.st.nameOf(e.author) : `${this.st.nameOf(e.author)} (for ${this.st.nameOf(e.onBehalfOf)})`
    const extra = p.media?.length ? ' (a photo, in InWove)' : p.files?.length ? ' (a file, in InWove)' : ''
    const text = outboundText(author, `${p.text ?? ''}${extra}`)
    this.later(async () => {
      if (this.paused) return this.count('held-paused')
      if (!this.group) return this.count('held-no-room') // nobody has linked yet, so there is no Geb room to post to
      await this.node.gsend(this.group, text); this.count('out')
    })
  }
  /** Whether a line here goes to the Geb room: a line said in People and AIs, as the room's AIs see it. Never a People only line. */
  crosses (e) {
    if (NAME_OF[e.type] !== 'note' || isPeopleOnly(e) || e.document.recipient) return false
    const skip = this.ctx.check?.dids() ?? []
    return !skip.includes(e.author) && !skip.includes(e.onBehalfOf)
  }
  later (fn) { this.outbox = this.outbox.then(fn).catch((err) => { this.count('error'); console.error('geb bridge:', err.message) }); return this.outbox }

  // ---- who is in the Geb room: exactly the room and the linked members. Geb makes a room with its members named, so the
  // room's Geb room is made at the first link, and the record says which it is.
  async reconcile () {
    const linked = [...this.st.gebLinks].filter(([m]) => this.st.isCurrentMember(m)).map(([, l]) => l.did)
    if (!this.group) {
      if (!linked.length) return
      const group = await this.node.groupNew(this.groupName, linked)
      await this.log.appendAsWorkspace('gebRoom', { did: this.node.did, group, name: this.groupName })
      this.count('room-made'); this.count('added', linked.length)
      return
    }
    const want = new Set([this.node.did, ...linked])
    const have = new Set(await this.node.members(this.group))
    const add = [...want].filter((d) => !have.has(d)), drop = [...have].filter((d) => !want.has(d))
    if (add.length) { await this.node.groupAdd(this.group, add); this.count('added', add.length) }
    if (drop.length) {
      try { await this.node.groupRemove(this.group, drop); this.count('removed', drop.length) } catch (err) {
        this.paused = `someone who is no longer linked is still in the Geb room and could not be taken out (${err.message})`
        this.count('paused'); console.error('geb bridge: paused,', this.paused)
        return
      }
    }
    this.paused = null
  }

  // ---- the measurement path: how many, of what, each day; never what was said
  count (what, n = 1) { const k = `${day(this.now())} ${what}`; this.counts.set(k, (this.counts.get(k) ?? 0) + n) }
  async flush () {
    const db = this.ctx.db; if (!db || !this.counts.size) return
    const rows = [...this.counts]; this.counts.clear()
    for (const [k, n] of rows) {
      const [d, what] = [k.slice(0, 10), k.slice(11)]
      await db.query('insert into geb_counts (day, what, n) values ($1, $2, $3) on conflict (day, what) do update set n = geb_counts.n + excluded.n', [d, what, n])
    }
  }
  /** The last `days` days' counts, the database's and the ones not yet written. */
  async tally (days = 7) {
    await this.flush()
    const since = day(this.now() - (days - 1) * 86_400_000)
    const { rows } = await this.ctx.db.query('select day, what, n from geb_counts where day >= $1 order by day, what', [since])
    return rows.map((r) => ({ day: r.day, what: r.what, n: Number(r.n) }))
  }

  /** What any member may see: is the room on Geb, as which identity, in which Geb room. */
  status () { return { running: this.running, roomDid: this.node?.did ?? null, group: this.group, paused: this.paused, hostsOnly: GEB_LINK_HOSTS_ONLY } }
}
