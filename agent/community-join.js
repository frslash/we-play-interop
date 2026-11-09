// Joining a community from the agent bridge, as the person. The person's own persona applies to the community named by
// COMMUNITY_DID; their own trust agent (agent/vta.js) signs every document as that persona; the community's door is
// the only place anything is sent. The room's server sees none of it and holds no key (a pass is shown to the room only
// when the person asks, `--show-pass`).
//
// Read from OpenVTC at the commit the room builds from (c6964c4):
//   the door         the community's DID document lists a VTCRest service (vtc-service/src/member_portal/oob.rs:295);
//                    documents are posted to <that>/trust-tasks (vtc-service/src/routes/mod.rs:1550,1688)
//   manifest 0.4     vti-specs-vtc/trust-tasks/vtc/join-requests/manifest/0.4.bundle.json: an empty payload; a community that
//                    turned public discovery off refuses an unsigned caller (vtc-service/src/trust_tasks/mod.rs discovery_refusal)
//   submit 0.3       .../submit/0.3.bundle.json: { vp, criterion, registryConsent, attributes }. `criterion` is the criterion's
//                    requirementsDigest, not its id (vta-sdk/src/protocols/join_requests.rs JoinRequestSubmitBody); an
//                    open request is answered requestAlreadyOpen with its id, a current member alreadyMember
//                    (the same file, :287,:297; vtc-service/src/trust_tasks/mod.rs handle_submit)
//   status 0.1       .../status/0.1.bundle.json; no requestId means "my open request" (handle_status)
//   the pass         pushed by the community as credential-exchange/issue to the holder (vtc-service/src/credentials/delivery.rs);
//                    this bridge only reads it from the person's own vault (agent/vta.js queryCredentials, getCredential)
//   members/vmc 0.1  .../members/vmc/0.1.bundle.json; what the community checks of a member's own credential:
//                    vtc-service/src/members/inbound_vmc.rs verify_member_vmc and check_acknowledgement_binding,
//                    vtc-service/src/credentials/ingress.rs classify_dtg (contexts, types, issuerScope, an `id`)
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { keyFromDidDocument } from '../src/shared/chain.js'
import { DTG_CONTEXTS, PASS_CHECK_TYPE, VC_V2, dtgDigest, verifyDtgCredential } from '../src/shared/dtg.js'
import { verifySignature } from '../src/shared/proof.js'
import { instant, serviceEndpoint, signerOf, taskDocument, typeUri } from '../src/shared/trusttask.js'
import { uuid } from '../src/shared/types.js'
import { createResolver, publicFetch } from '../src/server/resolver.js'
import { VtiError, Vta, readCredential, safeAddress, sendTask, unwrap } from './vta.js'
import { inWords } from './vti-notebook.js'

const DTG_CONTEXT = Object.keys(DTG_CONTEXTS)[0] // the current DTG context: the only one a community accepts
export const TASKS = { manifest: ['vtc/join-requests/manifest', '0.4'], submit: ['vtc/join-requests/submit', '0.3'], status: ['vtc/join-requests/status', '0.1'], vmc: ['vtc/members/vmc', '0.1'] }

// What these limits protect. A person is waiting at a terminal: the first look at the community's answer comes after
// 5 s and the wait doubles up to a minute, so a community that decides in seconds is not made to wait long and one
// that is slow is not asked every few seconds. Past ten minutes the command ends and says to run it again (the run
// then resumes from the request it already made), because a person at a terminal has gone to do something else.
export const POLL_FIRST_MS = 5_000
export const POLL_CAP_MS = 60_000
export const POLL_TOTAL_MS = 10 * 60_000
// A community may refuse to say how many attributes it wants; this one never sends more than the task allows (submit 0.3: 32).
const MAX_ATTRIBUTES = 32
// What this protects: the member's own credential should be dated early enough that a community whose clock runs
// a little behind this machine's does not find it "not yet valid" (it checks validFrom <= now).
const BACKDATE_MS = 60_000

const tail = (code) => String(code ?? '').split(':').pop()
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const hex16 = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 16)
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A community's refusal (or the trust agent's), in words a person can act on. The code follows, for whoever looks it up. */
export function refusalWords (e) {
  const code = e?.code, t = tail(code), at = code ? ` (${code})` : ''
  const types = Array.isArray(e?.details?.types) && e.details.types.length ? ` (${e.details.types.join(', ')})` : ''
  if (e instanceof VtiError && e.from === 'the community') {
    if (t === 'policyUnsatisfied') return `the community says this application does not meet what that criterion asks for, and does not invite more${at}`
    if (t === 'criterionUnknown') return `the community does not know that criterion any more. Run this again: it reads the community's current criteria first${at}`
    if (t === 'notAccepting') return `the community publishes no criteria, so it is not taking applications at present${at}`
    if (t === 'presentationInvalid') return `the community could not accept the presentation (it failed a check, or its holder was not this persona)${at}`
    if (t === 'attributesMissing') return `the community asks for attributes that were not given${types}${at}`
    if (t === 'attributesUnrequested') return `these attributes were given but the community did not ask for them${types}${at}`
    if (t === 'alreadyMember') return `this persona is already a member of that community: nothing to apply for${at}`
    if (t === 'subjectMismatch') return `the community says the membership credential is not about it: its subject must be the community itself${at}`
    if (t === 'notAMember') return `the community does not count this persona as a current member yet, so it cannot take the member's own credential${at}`
    if (t === 'invalidCredential') return `the community did not accept the member's own credential (it failed a check, or is not a membership credential)${at}`
    if (t === 'requestNotFound') return `the community has no join request with that number${at}`
    if (t === 'requestNotApproved') return `the community has not approved that join request, so there is nothing to answer yet${at}`
    if (t === 'requestApplicantMismatch') return `that join request belongs to another persona${at}`
    if (t === 'notFound') return `the community has no open join request for this persona${at}`
    if (t === 'permissionDenied') return `the community would not answer this persona: ${e.message}${at}`
  }
  return inWords(e)
}

const emptyCounts = () => ({ submitted: 0, polled: 0, resends: 0, passesFound: 0, answersSent: 0, signedAnswers: 0, uncheckedAnswers: 0, refusedBy: {} })

export class CommunityJoin {
  /**
   * `vta`: the person's trust agent. `persona`: the member DID the person names (COMMUNITY_PERSONA). `url`: the
   * community's door when the person names it themselves; otherwise it is read from the community's DID document
   * and reached only over public https. `stateDir`: where the small state file lives (beside the bridge's key).
   */
  constructor ({ vta, communityDid, persona, url, resolver = createResolver(), fetch: f, stateDir, sleep = pause, say = () => {} } = {}) {
    if (!vta) throw new Error('joining a community needs the person\'s trust agent (VTA_CREDENTIAL)')
    if (!/^did:/.test(String(communityDid ?? ''))) throw new Error('COMMUNITY_DID is not set: it is the DID of the community to join')
    if (!/^did:/.test(String(persona ?? ''))) throw new Error('COMMUNITY_PERSONA is not set: it is the DID of the persona that applies (the member DID your trust agent holds a key for)')
    if (url && !safeAddress(url)) throw new Error('COMMUNITY_URL must be an https:// address (plain http:// only for this machine)')
    this.vta = vta; this.communityDid = communityDid; this.persona = persona; this.resolver = resolver; this.sleep = sleep; this.say = say
    this.url = url ? String(url).replace(/\/+$/, '') : null
    this.fetch = f ?? (this.url ? globalThis.fetch : publicFetch) // an address from the community's own DID document is only ever reached as a public https host
    this.stateFile = stateDir ? join(stateDir, `community-${hex16(communityDid)}.json`) : null
    this.state = this.#load()
    this.last = null
  }

  // ----- the small state file: stage, request number, times, counts. No credential bodies, no attributes, no names. -----
  #load () {
    const fresh = { stage: 'new', requestId: null, verdict: null, credentialsDelivered: null, startedAt: null, updatedAt: null, counts: emptyCounts() }
    if (!this.stateFile || !existsSync(this.stateFile)) return fresh
    try {
      const s = JSON.parse(readFileSync(this.stateFile, 'utf8'))
      return { ...fresh, ...s, counts: { ...emptyCounts(), ...(s.counts ?? {}), refusedBy: { ...(s.counts?.refusedBy ?? {}) } } }
    } catch { return fresh } // a state file this reader cannot read is started again, never believed
  }
  #save (patch = {}) {
    Object.assign(this.state, patch, { updatedAt: instant() })
    this.state.startedAt ??= this.state.updatedAt
    if (!this.stateFile) return
    mkdirSync(join(this.stateFile, '..'), { recursive: true })
    const tmp = `${this.stateFile}.tmp`
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 })
    renameSync(tmp, this.stateFile); try { chmodSync(this.stateFile, 0o600) } catch {}
  }
  /** The state file as it stands, for `--status` (no trust agent needed). */
  static readState (stateDir, communityDid) {
    const f = join(stateDir, `community-${hex16(communityDid)}.json`)
    if (!existsSync(f)) return null
    try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return null }
  }
  /** What `--status` prints: the stage, the last verdict, whether the pass was delivered, and the counts. */
  static statusWords (state) {
    if (!state) return 'No join has been started for this community from this machine.'
    const c = state.counts ?? {}
    return [
      `Stage: ${state.stage}${state.updatedAt ? ` (last change ${state.updatedAt})` : ''}`,
      `Last verdict: ${state.verdict ? `${state.verdict.effect}${state.verdict.code ? ` (${state.verdict.code})` : ''}` : 'none yet'}`,
      `Credentials delivered to the vault: ${state.credentialsDelivered === null || state.credentialsDelivered === undefined ? 'not known yet' : state.credentialsDelivered ? 'yes' : 'not yet'}`,
      `Counts: submitted ${c.submitted ?? 0}, polled ${c.polled ?? 0}, resends ${c.resends ?? 0}, passesFound ${c.passesFound ?? 0}, answersSent ${c.answersSent ?? 0}, refusedBy ${JSON.stringify(c.refusedBy ?? {})}`,
    ].join('\n')
  }

  // ----- the door -----
  async door () {
    if (this.url) return this.url
    let doc
    try { doc = await this.resolver.resolve(this.communityDid) } catch (e) { throw new VtiError('unavailable', `the community's DID could not be read (${e.message}); name its address with COMMUNITY_URL`, { from: 'this bridge' }) }
    const at = serviceEndpoint(doc, 'VTCRest')
    if (!at) throw new VtiError('unavailable', 'the community\'s DID lists no VTCRest door; name its address with COMMUNITY_URL', { from: 'this bridge' })
    return (this.url = at.replace(/\/+$/, ''))
  }

  /** One document to the community: written unsigned here, signed as the persona by the person's trust agent, posted, answered. */
  async #send (name, payload) {
    const [family, version] = TASKS[name]
    const doc = taskDocument({ type: typeUri(family, version), issuer: this.persona, recipient: this.communityDid, payload })
    try {
      const signed = (await this.vta.signDocument(doc, { proofPurpose: 'authentication', created: doc.issuedAt })).document
      const r = await sendTask(await this.door(), signed, { fetch: this.fetch })
      if (r.reply?.proof) await this.#checkSigned(r.reply)
      const out = unwrap(r, 'the community')
      this.last = { ok: true, task: name, at: Date.now() }
      return out
    } catch (e) {
      const t = tail(e?.code ?? 'network'), by = this.state.counts.refusedBy
      by[t] = (by[t] ?? 0) + 1; this.last = { ok: false, task: name, code: e?.code ?? 'network', at: Date.now() }
      this.#save()
      throw e
    }
  }
  /** A signed answer must be signed by the community itself; one whose DID this machine cannot read goes unchecked, and that is counted. */
  async #checkSigned (reply) {
    const bad = () => { throw new VtiError('proofInvalid', 'the answer is signed, but not by the community it was sent to', { from: 'the community' }) }
    if (signerOf(reply) !== this.communityDid) bad()
    let doc = null
    try { doc = await this.resolver.resolve(this.communityDid) } catch {}
    if (!doc) { this.state.counts.uncheckedAnswers++; return }
    let key = null
    try { key = keyFromDidDocument(doc, this.communityDid, reply.proof.verificationMethod, reply.proof.proofPurpose) } catch {}
    if (!key || !verifySignature(reply, key).ok) bad()
    this.state.counts.signedAnswers++
  }

  // ----- the steps -----
  /** The community's criteria and the attributes it asks for. Signed as the persona, so a community with public discovery off still answers. */
  async manifest () {
    const m = await this.#send('manifest', {})
    if (m.communityDid !== this.communityDid) throw new VtiError('indeterminate', 'the manifest is for another community than the one named by COMMUNITY_DID', { from: 'the community' })
    if (!Array.isArray(m.criteria)) throw new VtiError('indeterminate', 'the manifest lists no criteria', { from: 'the community' })
    this.manifestData = m
    return m
  }

  /** The criterion wanted: the one named (by its id or its requirementsDigest), else the first the community lists. */
  chooseCriterion (wanted) {
    const list = this.manifestData?.criteria ?? []
    if (!list.length) throw new VtiError('notAccepting', 'the community publishes no criteria, so it is not taking applications at present', { from: 'the community' })
    if (!wanted) return list[0]
    const hit = list.find((c) => c.id === wanted || c.requirementsDigest === wanted)
    if (!hit) throw new Error(`the community has no criterion named "${wanted}" (it lists: ${list.map((c) => c.id).join(', ')})`)
    return hit
  }

  /** What the manifest requires that was not given, and what was given that it does not ask for: both by type. */
  checkAttributes (given) {
    const asked = this.manifestData?.requestedAttributes ?? [], have = new Set(given.map((a) => a.type))
    return { missing: asked.filter((a) => a.required !== false && !have.has(a.type)).map((a) => a.type), unrequested: given.filter((a) => !asked.some((x) => x.type === a.type)).map((a) => a.type) }
  }

  /** The presentation sent with a join request: this persona as holder, with the credentials the criterion asks for (none for an open one). */
  presentation (credentials = []) {
    return { '@context': [VC_V2], type: ['VerifiablePresentation'], holder: this.persona, verifiableCredential: credentials }
  }

  /** Apply under `criterion`. Answers { requestId, verdict: { effect, with } }. Unset members are left out, never null (#1099). */
  async submit ({ criterion, attributes = [], credentials = [], registryConsent = false } = {}) {
    if (attributes.length > MAX_ATTRIBUTES) throw new Error(`at most ${MAX_ATTRIBUTES} attributes can be sent`)
    const payload = { vp: this.presentation(credentials), ...(criterion?.requirementsDigest ? { criterion: criterion.requirementsDigest } : {}), registryConsent: Boolean(registryConsent), ...(attributes.length ? { attributes: attributes.map(({ type, value }) => ({ type, value })) } : {}) }
    const out = await this.#send('submit', payload)
    if (typeof out.requestId !== 'string' || !isObj(out.verdict) || typeof out.verdict.effect !== 'string') throw new VtiError('indeterminate', 'the community answered the application with no request number or verdict', { from: 'the community' })
    this.state.counts.submitted++
    this.#save({ requestId: out.requestId, verdict: { effect: out.verdict.effect, ...(out.verdict.with?.code ? { code: out.verdict.with.code } : {}) }, stage: 'submitted' })
    return out
  }

  /** Where the join stands. `requestId` omitted asks about this persona's open request. `resend` asks for the credentials again (only after approval, and the community rate-limits it). */
  async status ({ requestId, resend = false } = {}) {
    const out = await this.#send('status', { ...(requestId ? { requestId } : {}), ...(resend ? { resendCredentials: true } : {}) })
    if (typeof out.status !== 'string') throw new VtiError('indeterminate', 'the community answered the status question with no status', { from: 'the community' })
    this.state.counts.polled++; if (resend) this.state.counts.resends++
    this.#save({ ...(out.requestId ? { requestId: out.requestId } : {}), ...(typeof out.credentialsDelivered === 'boolean' ? { credentialsDelivered: out.credentialsDelivered } : {}), ...(out.status === 'rejected' && out.code ? { verdict: { effect: 'deny', code: out.code } } : {}) })
    return out
  }

  #keyFor = async (did, vm, purpose) => keyFromDidDocument(await this.resolver.resolve(did), did, vm, purpose)

  /** The membership pass and role credential in the person's own vault, each checked with the room's own reader. Null when no pass has arrived (it is pushed by the community, not returned). */
  async findPass () {
    const check = async (type, kind) => {
      const rows = (await this.vta.queryCredentials({ type, issuerDid: this.communityDid })).filter((r) => r.status === undefined || ['valid', 'unknown'].includes(r.status))
      const good = []
      for (const row of rows) {
        let got; try { got = await this.vta.getCredential(row.id) } catch { continue } // one that cannot be read does not stop the others
        if (!got.credential) continue // a credential not in JSON-LD form (an SD-JWT) is not one this reader checks
        const r = await verifyDtgCredential(got.credential, { keyFor: this.#keyFor, kinds: [kind] })
        if (!r.ok || !r.checked) continue
        if (r.claims.issuer !== this.communityDid || r.claims.subject !== this.persona) continue
        good.push({ id: row.id, vc: got.credential, claims: r.claims, notes: r.notes })
      }
      return good.sort((a, b) => String(b.claims.validFrom).localeCompare(String(a.claims.validFrom)))[0] ?? null
    }
    const pass = await check('MembershipCredential', 'membership')
    if (!pass) return null
    const roleCred = await check('AuthorityCredential', 'authority')
    const roles = roleCred?.claims.authority?.scope === this.communityDid ? (roleCred.claims.authority.actions ?? []).filter((a) => a.startsWith('role:')).map((a) => a.slice(5)) : []
    this.state.counts.passesFound++
    this.#save({ stage: this.state.stage === 'answered' ? 'answered' : 'pass-found' })
    return { pass: pass.vc, passId: pass.id, validUntil: pass.claims.validUntil, role: roles[0] ?? null, notes: [...pass.notes, ...(roleCred && !roles.length ? ['a role credential was found, but it names no role for this community'] : []), ...(roleCred?.claims.authority?.maxAttenuation !== undefined && roleCred.claims.authority.maxAttenuation !== 0 ? ['the role credential may be narrowed further (maxAttenuation is not 0)'] : [])] }
  }

  /** The member's own membership credential, naming the community, signed by this persona: the community's ingress check wants these exact members. */
  memberCredential (pass) {
    return {
      '@context': [VC_V2, DTG_CONTEXT], type: ['VerifiableCredential', 'DTGCredential', 'MembershipCredential'],
      id: `urn:uuid:${uuid()}`, issuer: this.persona,
      issuerScope: 'directed', // a persona is known to the community and to those it shows this to: OpenVTC's own member credential declares `directed` (members/inbound_vmc.rs tests); any of the three is accepted
      validFrom: instant(Date.now() - BACKDATE_MS),
      credentialSubject: { id: this.communityDid, ...(pass ? { digestMultibase: dtgDigest(pass) } : {}) }, // the digest of the community's grant completes the pair (check_acknowledgement_binding)
    }
  }

  /** Send the member's own credential; with `requestId` of the approved request it closes the join. */
  async answer ({ requestId, pass } = {}) {
    const signed = await this.vta.signDocument(this.memberCredential(pass), { proofPurpose: 'assertionMethod' })
    const out = await this.#send('vmc', { vc: signed.document, ...(requestId ? { requestId } : {}) })
    this.state.counts.answersSent++
    this.#save({ stage: 'answered' })
    return out
  }

  // ----- the whole run -----
  /** What will be sent, in words: the person's yes is for exactly this. */
  plan ({ criterion, attributes, credentials, registryConsent }) {
    return [
      `Applying to the community as your persona, under criterion "${criterion.id}" (${criterion.admission === 'review' ? 'a person reviews applications' : 'admitted automatically if it is met'}).`,
      `  attributes sent: ${attributes.length ? attributes.map((a) => a.type).join(', ') : 'none'}`,
      `  registry publication consent: ${registryConsent ? 'YES' : 'no'}`,
      `  credentials in the presentation: ${credentials.length ? credentials.map((c) => [].concat(c?.type ?? ['unknown']).filter((t) => !['VerifiableCredential', 'DTGCredential'].includes(t)).join('/') || 'credential').join(', ') : 'none'}`,
      'When it is approved, your own membership credential naming the community is made (signed by your persona) and sent to the community.',
    ]
  }

  async #wait (wait, spent) { await this.sleep(wait); return { wait: Math.min(wait * 2, POLL_CAP_MS), spent: spent + wait } }

  /**
   * Do the steps in order and stop at the first thing that needs the person. Returns { done, stage, stopped?, pass? }
   * where `stopped` is { kind, words, ... }. `ask(question)` is the person's yes on stdin; `yes` skips asking.
   */
  async run ({ criterion: wanted, attributes = [], credentials = [], registryConsent = false, yes = false, ask = async () => false } = {}) {
    const say = this.say, stop = (kind, words, extra = {}) => ({ done: false, stage: this.state.stage, stopped: { kind, words, ...extra } })
    if (this.state.stage === 'answered') { const p = await this.findPass(); say('This join was finished earlier: the community has your member credential.'); return { done: true, stage: 'answered', pass: p, already: true } }
    let requestId = this.state.requestId, joined = false
    if (!requestId) {
      await this.manifest()
      let criterion
      try { criterion = this.chooseCriterion(wanted) } catch (e) { if (e instanceof VtiError) return stop('notAccepting', refusalWords(e)); throw e }
      const { missing, unrequested } = this.checkAttributes(attributes)
      if (missing.length) return stop('attributes', `The community asks for ${missing.join(', ')} and it was not given. Give each with --attr <type>=<value>, then run this again.`, { missing })
      if (unrequested.length) return stop('attributes', `These were given but the community does not ask for them: ${unrequested.join(', ')}. They are not sent. Take them off, then run this again.`, { unrequested })
      for (const line of this.plan({ criterion, attributes, credentials, registryConsent })) say(line)
      if (!yes && !(await ask('Send this? Type yes to send, anything else to stop: '))) { this.#save({ stage: 'manifest-read' }); return stop('no-yes', 'Nothing was sent (only the community\'s published requirements were read). Run this again and answer yes, or give --yes.') }
      let sub
      try { sub = await this.submit({ criterion, attributes, credentials, registryConsent }) } catch (e) {
        if (e instanceof VtiError && tail(e.code) === 'requestAlreadyOpen' && typeof e.details?.requestId === 'string') { say('This persona already has an open request with the community: continuing with it.'); this.#save({ requestId: e.details.requestId, stage: 'submitted' }) } else if (e instanceof VtiError && tail(e.code) === 'alreadyMember') { say(refusalWords(e)); joined = true } else if (e instanceof VtiError && tail(e.code) === 'attributesMissing') return stop('attributes', refusalWords(e), { missing: e.details?.types ?? [] })
        else if (e instanceof VtiError && e.from === 'the community') return stop('refused', refusalWords(e), { code: e.code })
        else throw e
      }
      if (sub) {
        const v = sub.verdict, w = v.with ?? {}
        if (v.effect === 'refer') return stop('refer', `The community has handed this to ${w.queue ? `its "${w.queue}" queue` : 'a person to decide'}. Run this again later: it picks up from the same request.`, { queue: w.queue })
        if (v.effect === 'requestMore') return stop('requestMore', `The community needs more before it decides: ${(w.needs ?? []).join(', ') || 'more evidence'}. Supply it, then run this again.`, { needs: w.needs ?? [] })
        if (v.effect === 'deny') return stop('deny', `The community turned this application down${w.code ? ` (${w.code})` : ''}${w.reason ? `: ${w.reason}` : ''}.`, { code: w.code, reason: w.reason })
      }
      requestId = this.state.requestId
    }
    // wait for approval
    let pass = null, resent = false
    if (!joined) {
      let wait = POLL_FIRST_MS, spent = 0
      for (;;) {
        let s
        try { s = await this.status({ requestId: requestId ?? undefined }) } catch (e) { if (e instanceof VtiError && tail(e.code) === 'notFound') return stop('notFound', refusalWords(e)); throw e }
        requestId = this.state.requestId
        if (s.status === 'approved') break
        if (s.status === 'rejected') return stop('rejected', `The community turned this application down${s.code ? ` (${s.code})` : ''}${s.reason ? `: ${s.reason}` : ''}.`, { code: s.code, reason: s.reason })
        if (s.status === 'withdrawn') return stop('withdrawn', 'This application was withdrawn. Run this again to apply afresh.')
        if (s.status === 'deferred') return stop('deferred', `The community needs more before it decides: ${(s.needs ?? []).join(', ') || 'more evidence'}. Supply it, then run this again.`, { needs: s.needs ?? [] })
        if (spent + wait > POLL_TOTAL_MS) return stop('timeout', 'Still waiting after ten minutes. Run this again later: it picks up from the same request.')
        say(`Waiting for the community to decide (${s.status})…`)
        ;({ wait, spent } = await this.#wait(wait, spent))
      }
      this.#save({ stage: 'approved' })
      say('Approved.')
    }
    // the pass arrives by push into the person's own vault
    let wait = POLL_FIRST_MS, spent = 0
    for (;;) {
      pass = await this.findPass()
      if (pass) break
      if (!resent && this.state.credentialsDelivered === false && requestId) {
        resent = true
        const s = await this.status({ requestId, resend: true })
        say(s.credentialResend === 'queued' ? 'Asked the community to send the credentials again.' : s.credentialResend === 'rateLimited' ? `The community will resend a little later${s.retryAfter ? ` (not before ${s.retryAfter})` : ''}.` : s.credentialResend === 'notNeeded' ? 'The community says the credentials were delivered already.' : 'The community does not offer to resend credentials.')
      }
      if (spent + wait > POLL_TOTAL_MS) return stop('timeout', 'The membership credential has not reached your trust agent after ten minutes. Run this again later: it picks up from the same request.')
      say('Waiting for the community to deliver the membership credential to your trust agent…')
      ;({ wait, spent } = await this.#wait(wait, spent))
    }
    say(`Found your membership credential${pass.role ? ` (role: ${pass.role})` : ''}${pass.validUntil ? `, valid until ${pass.validUntil}` : ''}.`)
    for (const n of pass.notes) say(`  note: ${n}`)
    await this.answer({ requestId: joined ? undefined : requestId, pass: pass.pass })
    say('Sent the community your own membership credential. The join is complete.')
    return { done: true, stage: 'answered', pass }
  }

  /**
   * The pass check the room's own POST /api/community/pass takes (src/shared/dtg.js passCheck): a Trust Task document
   * signed by this persona, addressed to the room, carrying the pass. Made here, where the key is; the room's server
   * never holds it. Answers { document } and, when `send`, the room's answer.
   */
  async showPass ({ roomUrl, send = false, pass, fetch: f = globalThis.fetch } = {}) {
    const base = String(roomUrl ?? '').replace(/\/+$/, '')
    if (!/^https?:\/\//.test(base)) throw new Error('WPI_URL is not set: it is the address of the room to show the pass to')
    const info = await (await f(`${base}/api/community`)).json()
    const room = info?.pass?.recipient
    if (!room) return { document: null, words: 'This room takes no membership pass (it names no community).' }
    const found = pass ?? (await this.findPass())?.pass
    if (!found) return { document: null, words: 'No membership credential is in your vault yet, so there is no pass to show.' }
    const doc = taskDocument({ type: PASS_CHECK_TYPE, issuer: this.persona, recipient: room, payload: { membership: found } })
    const document = (await this.vta.signDocument(doc, { proofPurpose: 'authentication', created: doc.issuedAt })).document
    if (!send) return { document }
    const res = await f(`${base}/api/community/pass`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(document), signal: AbortSignal.timeout(30_000) })
    return { document, answer: await res.json().catch(() => null), status: res.status }
  }
}

/** A yes from the person at this terminal. Anything but yes, or a closed stdin, is a no. */
export function askOnTerminal (question, { input = process.stdin, output = process.stderr } = {}) {
  return new Promise((resolve) => {
    const rl = createInterface({ input, output, terminal: false })
    let done = false
    const finish = (v) => { if (!done) { done = true; rl.close(); resolve(v) } }
    output.write(question)
    rl.once('line', (l) => finish(/^\s*y(es)?\s*$/i.test(l)))
    rl.once('close', () => finish(false))
  })
}

/** `join-community [--yes] [--registry-consent] [--criterion <id|digest>] [--attr type=value]… [--status] [--show-pass]`. Answers the exit code. */
export async function joinCommunityCommand (args, env, { say = console.error, roomUrl, stateDir, ask = askOnTerminal, fetch: f, resolver, sleep, vtaFetch, vtaSleep } = {}) {
  const opts = { yes: false, registryConsent: false, status: false, showPass: false, criterion: undefined, attributes: [] }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--yes') opts.yes = true
    else if (a === '--registry-consent') opts.registryConsent = true
    else if (a === '--status') opts.status = true
    else if (a === '--show-pass') opts.showPass = true
    else if (a === '--criterion') opts.criterion = args[++i]
    else if (a === '--attr') {
      const m = /^([^=]+)=(.*)$/s.exec(args[++i] ?? '')
      if (!m) { say('--attr takes type=value, for example --attr x:nickname=Sam'); return 2 }
      opts.attributes.push({ type: m[1], value: m[2] })
    } else { say(`Unknown option ${a}. Options: --yes, --registry-consent, --criterion <id>, --attr type=value, --status, --show-pass`); return 2 }
  }
  const communityDid = env.COMMUNITY_DID
  if (!/^did:/.test(String(communityDid ?? ''))) { say('Set COMMUNITY_DID to the DID of the community to join.'); return 1 }
  if (opts.status) { say(CommunityJoin.statusWords(stateDir ? CommunityJoin.readState(stateDir, communityDid) : null)); return 0 }
  if (!env.COMMUNITY_PERSONA) { say('Set COMMUNITY_PERSONA to the DID of the persona that applies (the member DID your trust agent holds a key for).'); return 1 }
  let credential
  try { credential = readCredential(env) } catch (e) { say(e.message); return 1 }
  if (!credential) { say('Set VTA_CREDENTIAL (or VTA_CREDENTIAL_FILE): joining is done by your own trust agent, which signs as your persona.'); return 1 }
  let join
  try {
    const vta = new Vta({ credential, url: env.VTA_URL || credential.vtaUrl, ...(vtaFetch ? { fetch: vtaFetch } : {}), ...(vtaSleep ? { sleep: vtaSleep } : {}), ...(resolver ? { resolver } : {}) })
    join = new CommunityJoin({ vta, communityDid, persona: env.COMMUNITY_PERSONA, url: env.COMMUNITY_URL, stateDir, say, ...(f ? { fetch: f } : {}), ...(resolver ? { resolver } : {}), ...(sleep ? { sleep } : {}) })
  } catch (e) { say(e.message); return 1 }
  try {
    const r = await join.run({ criterion: opts.criterion, attributes: opts.attributes, registryConsent: opts.registryConsent, yes: opts.yes, ask })
    if (!r.done) { say(r.stopped.words); return 3 }
    if (opts.showPass) {
      const shown = await join.showPass({ roomUrl, pass: r.pass?.pass, ...(f ? { fetch: f } : {}) })
      if (!shown.document) say(shown.words)
      else {
        say(`The room's pass check is ready: a ${PASS_CHECK_TYPE} document signed by your persona, addressed to the room, carrying your membership credential. The room checks it and keeps what it keeps today; nothing new is stored there.`)
        if (opts.yes || await ask('Send it to the room now? Type yes to send: ')) { const sent = await join.showPass({ roomUrl, send: true, pass: r.pass?.pass, ...(f ? { fetch: f } : {}) }); say(`The room answered (HTTP ${sent.status}): ${JSON.stringify(sent.answer?.payload ?? sent.answer)}`) } else say('Not sent.')
      }
    }
    return 0
  } catch (e) { say(`The join stopped: ${refusalWords(e)}`); return 1 }
}
