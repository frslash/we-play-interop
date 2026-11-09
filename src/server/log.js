// The append-only, hash-chained log, and the rules for what may be appended.
// Every write goes through accept(): shape, freshness, replay, signature,
// who-may-say-what, delegation. Nothing is appended without a verified signature.
// A delegation that carries its permission as a credential the person signed
// (src/shared/credential.js) has it verified once, here, and every write the
// agent makes is then checked against what the credential says.
import { EventEmitter } from 'node:events'
import { canonicalize } from '../shared/crypto.js'
import { hashCore, verifyChain } from '../shared/chain.js'
import { credentialRefuses, grantMismatch, verifyPermissionCredential } from '../shared/credential.js'
import { sign, verifySignature } from '../shared/proof.js'
import { AGENT_SCOPES, buildDocument, checkPayload, checkShape, NAME_OF, scopeOf, TYPES, WHO } from '../shared/types.js'
import { insertEntry, loadEntries } from './db.js'
import { State } from './state.js'

const ERROR_TYPE = 'https://trusttasks.org/spec/trust-task-error/0.6'

/** A refusal, answered as a Trust Task error document (trust-task-error). */
export class TaskError extends Error {
  constructor (code, message, { status = 400, retryable = false, retryAfter } = {}) {
    super(message); this.code = code; this.status = status; this.retryable = retryable; this.retryAfter = retryAfter
  }
}

export class Log extends EventEmitter {
  constructor ({ db, identity, resolver, config }) {
    super()
    this.db = db; this.identity = identity; this.resolver = resolver; this.config = config
    this.entries = []; this.byHash = new Map(); this.byDocId = new Map()
    this.state = new State()
    this.queue = Promise.resolve()
    this.rate = new Map()
    this.verified = null
    this.boardSlugs = () => new Set() // set by the board once it has loaded
  }

  async load () {
    for (const e of await loadEntries(this.db)) this.#index(e)
    if (!this.entries.length) {
      await this.appendAsWorkspace('genesis', {
        name: this.config.workspaceName,
        board: this.config.boardRepo,
        workspaceRepo: this.config.workspaceRepo,
        scope: 'interop between projects, all ways of doing it; the DTG board is one source of the map',
        rules: {
          vetoWindowMinutes: this.config.vetoWindowMinutes,
          approvalsRequired: this.config.approvalsRequired,
          freshDays: this.config.freshDays,
          agentsMay: AGENT_SCOPES,
          humansOnly: ['join', 'delegate', 'revoke', 'approve', 'veto', 'mode'],
        },
      })
    } else if (this.state.workspace !== this.identity.did) {
      throw new Error(`WORKSPACE_KEY does not match this log: the log was started by ${this.state.workspace}, the key is ${this.identity.did}. Set the original WORKSPACE_KEY.`)
    }
  }

  #index (e) {
    this.entries.push(e); this.byHash.set(e.hash, e); this.byDocId.set(e.document.id, e)
    this.state.apply(e)
  }

  head () { const e = this.entries.at(-1); return e ? { seq: e.seq, hash: e.hash } : null }

  /** Serialized append: one writer at a time, each entry pointing at the one before. */
  #append (document, { author, onBehalfOf, delegation }) {
    const run = async () => {
      const prev = this.entries.at(-1)
      const core = { seq: this.entries.length, parent: prev ? prev.hash : null, timestamp: new Date().toISOString(), author, onBehalfOf, ...(delegation ? { delegation } : {}), type: document.type, document }
      const hash = hashCore(core)
      const witness = sign(core, { seed: this.identity.seed, verificationMethod: this.identity.verificationMethod, created: core.timestamp, proofPurpose: 'assertionMethod' }).proof
      const entry = { ...core, hash, witness }
      await insertEntry(this.db, entry)
      this.#index(entry)
      this.emit('entry', entry)
      return entry
    }
    const p = this.queue.then(run, run)
    this.queue = p.catch(() => {})
    return p
  }

  /** The workspace (and its weaver) speaking. */
  async appendAsWorkspace (name, payload, { threadId } = {}) {
    const doc = buildDocument({ type: TYPES[name], issuer: this.identity.did, payload, threadId })
    const signed = sign(doc, { seed: this.identity.seed, verificationMethod: this.identity.verificationMethod, created: doc.issuedAt })
    return this.#append(signed, { author: this.identity.did, onBehalfOf: this.identity.did })
  }

  /** Accept a document from a person or an agent, or throw a TaskError. */
  async accept (doc, { ip = '', approved = false } = {}) {
    const shape = checkShape(doc)
    if (shape) throw new TaskError('malformedRequest', shape)
    const name = NAME_OF[doc.type], st = this.state, now = Date.now()
    if (WHO[name] === 'private') throw new TaskError('malformedRequest', `${name} is private: send it to /api/${name}, it never enters the log`)
    if (WHO[name] === 'workspace' || doc.issuer === st.workspace) throw new TaskError('permissionDenied', `only the workspace writes ${name}`, { status: 403 })

    const seen = this.byDocId.get(doc.id)
    if (seen) {
      if (canonicalize(seen.document) === canonicalize(doc)) return { entry: seen, duplicate: true } // a retry of the same bytes
      throw new TaskError('idConflict', 'a different document with this id is already in the log', { status: 409 })
    }
    const skew = this.config.maxSkewMinutes * 60_000, at = Date.parse(doc.issuedAt)
    if (at < now - skew) throw new TaskError('expired', `issuedAt is more than ${this.config.maxSkewMinutes} minutes old; sign it again`)
    if (at > now + skew) throw new TaskError('malformedRequest', 'issuedAt is in the future; check the clock')
    if (name !== 'delegate' && doc.expiresAt && Date.parse(doc.expiresAt) <= now) throw new TaskError('expired', 'the document has expired')
    const bad = checkPayload(name, doc)
    if (bad) throw new TaskError('malformedRequest', bad)

    // the signature
    let key
    try { key = await this.resolver.keyFor(doc.issuer, doc.proof.verificationMethod, doc.proof.proofPurpose) } catch (err) {
      throw new TaskError(/did:webvh: (https only|host)|did not resolve|fetch|timeout/i.test(err.message) ? 'indeterminate' : 'proofInvalid', `could not get the issuer's key: ${err.message}`, { retryable: /fetch|timeout/i.test(err.message) })
    }
    const sig = verifySignature(doc, key)
    if (!sig.ok) throw new TaskError('proofInvalid', sig.reason)

    // who may say this
    const principal = doc.onBehalfOf ?? doc.issuer
    let delegation = null
    if (doc.onBehalfOf) {
      const sandboxApprove = (this.config.sandbox || this.config.agentApprovals) && name === 'approve' // agents approve changes to the room's own code themselves (an experiment)
      if (WHO[name] !== 'anyone' && !sandboxApprove) throw new TaskError('permissionDenied', `agents may note, propose and vote; ${name} stays with humans`, { status: 403 })
      delegation = st.delegations.get(doc.delegation)
      if (!delegation) throw new TaskError('permissionDenied', 'the delegation named is not in the log', { status: 403 })
      if (delegation.issuer !== doc.onBehalfOf || delegation.delegate !== doc.issuer) throw new TaskError('permissionDenied', 'that delegation is not from this human to this agent', { status: 403 })
      if (delegation.revoked) throw new TaskError('permissionDenied', 'that delegation was revoked', { status: 403 })
      if (delegation.credential) { // the permission as its person signed it decides, not only the room's own table
        const no = credentialRefuses(delegation.credential, { agent: doc.issuer, person: doc.onBehalfOf, room: st.workspace, kind: sandboxApprove ? 'vote' : name, at: now, slackMs: skew })
        if (no) throw new TaskError(no.code, no.message, { status: no.code === 'expired' ? 400 : 403 })
      }
      if (Date.parse(delegation.expiresAt) <= now) throw new TaskError('expired', 'that delegation has expired; ask your human for a new one')
      if (!delegation.scope.includes(sandboxApprove ? 'vote' : scopeOf(name))) throw new TaskError('permissionDenied', `the delegation does not cover ${name}`, { status: 403 })
      if (sandboxApprove && st.proposals.get(doc.payload.proposal)?.kind !== 'workspace-change') throw new TaskError('permissionDenied', 'agents approve only changes to the room\'s own code (workspace-change); other outside actions stay with people', { status: 403 })
      const target = sandboxApprove ? st.proposals.get(doc.payload.proposal) : null, handedBy = target?.byWeaver && target.sources?.length ? this.byHash.get(target.sources[0])?.onBehalfOf : null
      if (sandboxApprove && (target?.principal === doc.onBehalfOf || handedBy === doc.onBehalfOf)) throw new TaskError('permissionDenied', 'an agent never approves its own person\'s change: another person\'s agent has to', { status: 403 })
      if ((delegation.ask?.includes(scopeOf(name)) || delegation.credential?.askFirst.includes(scopeOf(name))) && !approved) throw new TaskError('permissionDenied', `your person asked to see each ${name} first, so it was not posted: tell them what you would like to say (or bring them in through the room's link, where it can wait for their OK)`, { status: 403 })
      if (!st.isHuman(doc.onBehalfOf)) throw new TaskError('permissionDenied', 'onBehalfOf has not joined', { status: 403 })
    } else {
      if (st.isAgent(doc.issuer)) throw new TaskError('permissionDenied', 'this DID belongs to an agent: sign with onBehalfOf and delegation', { status: 403 })
      if (name !== 'join' && !st.isHuman(doc.issuer)) throw new TaskError('permissionDenied', 'join first (member/join)', { status: 403 })
      if (name !== 'join' && st.participants.get(doc.issuer)?.left) throw new TaskError('permissionDenied', 'you left this room; join again to take part', { status: 403 })
      if (st.participants.get(doc.issuer)?.replacedBy) throw new TaskError('permissionDenied', `this account was replaced by ${st.nameOf(st.participants.get(doc.issuer).replacedBy)}'s new key; use that one`, { status: 403 })
    }
    if (name === 'card' && (doc.payload.model !== undefined || doc.payload.runsOn !== undefined) && !(doc.onBehalfOf && st.isAgent(doc.issuer))) throw new TaskError('permissionDenied', 'model and runsOn are an agent\'s own word about itself: only the agent sets them', { status: 403 })
    if (name === 'delegate' && doc.payload.credential !== undefined) await this.#checkCredential(doc)
    this.#checkContext(name, doc, principal)
    for (const guard of this.guards ?? []) { const why = guard(doc, principal, name); if (why) throw new TaskError('malformedRequest', why, { status: 422 }) } // nothing secret enters the permanent record
    this.#limit(principal, ip)
    this.verified = null
    const entry = await this.#append(doc, { author: doc.issuer, onBehalfOf: principal, delegation: delegation?.hash })
    return { entry, duplicate: false }
  }

  /** A grant carrying its permission as a credential: the person's signature on it, and that it says what the grant says. */
  async #checkCredential (doc) {
    const r = await verifyPermissionCredential(doc.payload.credential, { keyFor: (d, vm, pp) => this.resolver.keyFor(d, vm, pp) })
    if (!r.ok) throw new TaskError(r.problem === 'shape' ? 'malformedRequest' : 'proofInvalid', `the permission's credential: ${r.reason}`, { retryable: /fetch|timeout/i.test(r.reason) })
    if (!r.checked) throw new TaskError('proofInvalid', 'the permission\'s credential: the room could not check its signature')
    const why = grantMismatch(r.claims, doc, this.state.workspace)
    if (why) throw new TaskError(r.claims.issuer !== doc.issuer ? 'permissionDenied' : 'malformedRequest', `the permission's credential does not match the grant: ${why}`, { status: r.claims.issuer !== doc.issuer ? 403 : 400 })
  }

  #checkContext (name, doc, principal) {
    const p = doc.payload, st = this.state
    const proposal = (h) => { const pr = st.proposals.get(h); if (!pr) throw new TaskError('malformedRequest', 'no proposal with that hash'); return pr }
    switch (name) {
      case 'delegate': {
        if (p.delegate === doc.issuer || p.delegate === st.workspace || st.isHuman(p.delegate)) throw new TaskError('permissionDenied', 'an agent needs a DID of its own, not a person\'s', { status: 403 })
        const other = st.participants.get(p.delegate)
        if (other?.kind === 'agent' && other.principal !== doc.issuer && st.participants.get(other.principal)?.replacedBy !== doc.issuer) throw new TaskError('permissionDenied', 'that agent already acts for someone else', { status: 403 }) // a replaced key's agents can be signed for again by its new key
        break
      }
      case 'away':
        if (st.participants.get(p.agent)?.principal !== doc.issuer) throw new TaskError('permissionDenied', 'you can set this only for your own agent', { status: 403 })
        if (!st.hosted.has(p.agent)) throw new TaskError('permissionDenied', 'only agents brought in with a link can answer while you are away (the room needs their key)', { status: 403 })
        break
      case 'link': {
        const old = st.participants.get(p.old)
        if (p.old === doc.issuer || old?.kind !== 'human') throw new TaskError('malformedRequest', 'old: the DID of the account you had before (a person in this room)')
        if (old.replacedBy) throw new TaskError('permissionDenied', `that account was already replaced by ${st.nameOf(old.replacedBy)}`, { status: 403 })
        break
      }
      case 'vouch': {
        const l = st.links.get(p.request)
        if (!l) throw new TaskError('malformedRequest', 'no request to link an old name with that hash')
        if (l.replacedAt) throw new TaskError('permissionDenied', 'that old name is already linked', { status: 403 })
        if (doc.issuer === l.from || doc.issuer === l.old) throw new TaskError('permissionDenied', 'someone else has to vouch for you: people who know you', { status: 403 })
        break
      }
      case 'replace': {
        const l = st.links.get(p.request)
        if (!this.config.hosts?.includes(doc.issuer)) throw new TaskError('permissionDenied', this.config.hosts?.length ? 'only the room\'s host marks an account replaced' : 'this room has no host named yet (ROOM_HOSTS), so no one can mark an account replaced', { status: 403 })
        if (!l) throw new TaskError('malformedRequest', 'no request to link an old name with that hash')
        if (l.replacedAt) throw new TaskError('permissionDenied', 'that old name is already linked', { status: 403 })
        if (st.participants.get(l.old)?.replacedBy) throw new TaskError('permissionDenied', 'that account was already replaced', { status: 403 })
        if (![...l.vouches.keys()].some((d) => d !== l.from && d !== l.old && st.isHuman(d))) throw new TaskError('permissionDenied', 'no one has vouched for this yet: people who know them vouch first', { status: 403 })
        break
      }
      case 'remove':
        if (st.participants.get(p.agent)?.kind !== 'agent' || st.participants.get(p.agent).principal !== doc.issuer) throw new TaskError('permissionDenied', 'you can remove only your own agents', { status: 403 })
        break
      case 'wake':
        if (st.participants.get(p.agent)?.principal !== doc.issuer) throw new TaskError('permissionDenied', 'you can set wake-ups only for your own agent', { status: 403 })
        break
      case 'revoke': {
        const d = st.delegations.get(p.delegation)
        if (!d || d.issuer !== doc.issuer) throw new TaskError('permissionDenied', 'you can revoke only your own delegations', { status: 403 })
        break
      }
      case 'vote': case 'approve': proposal(p.proposal); break
      case 'veto': proposal(p.target); break
      case 'project': {
        const mine = st.participants.get(principal)?.projects ?? []
        const prev = st.mapProjects.get(p.slug)
        const owned = this.boardSlugs().has(p.slug) || st.membersOf(p.slug).length > 0
        if (!mine.includes(p.slug) && (owned || (prev && prev.addedBy !== principal))) throw new TaskError('permissionDenied', `only people who joined for ${p.slug} (or their agents) change its entry; say what you know in a note`, { status: 403 })
        break
      }
      case 'way': {
        const prev = st.mapWays.get(p.id)
        if (prev && prev.addedBy !== principal) throw new TaskError('permissionDenied', `the way ${p.id} is already described; say what to change in a note`, { status: 403 })
        break
      }
      case 'run': {
        const known = (slug) => st.mapProjects.has(slug) || this.boardSlugs().has(slug)
        for (const s of p.sides) if (!known(s.project)) throw new TaskError('malformedRequest', `${s.project} is not on the map yet: add it first (map:project)`)
        const mine = st.participants.get(principal)?.projects ?? []
        if (!p.sides.some((s) => mine.includes(s.project)) && !p.sources?.length) throw new TaskError('malformedRequest', 'a run is entered by one of its two sides: join for your project, or add sources (public links) and it shows as reported')
        break
      }
      case 'propose':
        if (p.kind === 'record-run') {
          const mine = st.participants.get(principal)?.projects ?? []
          if (!mine.length) throw new TaskError('permissionDenied', 'the board takes a run from one of its two sides: join with your project (projects in member/join) to record runs', { status: 403 })
          const sides = p.run.sides.map((s) => s.project)
          if (!sides.some((s) => mine.includes(s)) && !p.sources?.length) throw new TaskError('malformedRequest', 'neither side is your project: add sources (public links) so the board shows it as reported by your project')
        }
        break
    }
  }

  /** Rate limit: a person (with their agents) and an address each get a steady allowance. */
  #limit (principal, ip) {
    const now = Date.now(), windowMs = 60_000
    const perPerson = this.config.ratePerMinute ?? 30
    for (const [k, max] of [['p:' + principal, perPerson], ['ip:' + ip, perPerson * 4]]) {
      const hits = (this.rate.get(k) ?? []).filter((t) => t > now - windowMs)
      if (hits.length >= max) throw new TaskError('unavailable', 'too many entries in a minute; slow down', { status: 429, retryable: true, retryAfter: new Date(hits[0] + windowMs).toISOString() })
      hits.push(now); this.rate.set(k, hits)
    }
  }

  /** Check a private, signed request (never appended): shape, freshness, replay, signature. */
  async verifyPrivate (doc, expected) {
    const shape = checkShape(doc)
    if (shape) throw new TaskError('malformedRequest', shape)
    if (NAME_OF[doc.type] !== expected) throw new TaskError('unsupportedType', `expected ${expected}`)
    const bad = checkPayload(expected, doc)
    if (bad) throw new TaskError('malformedRequest', bad)
    const now = Date.now(), at = Date.parse(doc.issuedAt), skew = this.config.maxSkewMinutes * 60_000
    if (Math.abs(now - at) > skew) throw new TaskError('expired', 'sign it again: issuedAt is not current')
    this.seenPrivate ??= new Map()
    for (const [id, t] of this.seenPrivate) if (t < now - 2 * skew) this.seenPrivate.delete(id)
    if (this.seenPrivate.has(doc.id)) throw new TaskError('idConflict', 'this request was already used', { status: 409 })
    let key
    try { key = await this.resolver.keyFor(doc.issuer, doc.proof.verificationMethod, doc.proof.proofPurpose) } catch (err) { throw new TaskError('proofInvalid', `could not get the issuer's key: ${err.message}`) }
    const sig = verifySignature(doc, key)
    if (!sig.ok) throw new TaskError('proofInvalid', sig.reason)
    this.seenPrivate.set(doc.id, now)
    return doc
  }

  /** A signed trust-task-error answering a refused document. */
  errorDocument (err, doc) {
    const out = buildDocument({ type: ERROR_TYPE, issuer: this.identity.did, threadId: doc?.threadId ?? (typeof doc?.id === 'string' ? doc.id : undefined), payload: {
      code: err.code, message: err.message, retryable: err.retryable, ...(err.retryAfter ? { retryAfter: err.retryAfter } : {}),
      ...(typeof doc?.id === 'string' ? { inResponseTo: { typeUri: String(doc.type ?? ''), id: doc.id } } : {}),
    } })
    return sign(out, { seed: this.identity.seed, verificationMethod: this.identity.verificationMethod, created: out.issuedAt })
  }

  /** Re-verify the whole chain (cached until the next append). */
  async verify () {
    if (this.verified?.head?.hash === this.head()?.hash) return this.verified
    this.verified = { ...(await verifyChain(this.entries, { keyFor: (d, vm, pp) => this.resolver.keyFor(d, vm, pp) })), verifiedAt: new Date().toISOString() }
    return this.verified
  }
}
