// What can be said in the workspace. Every input is a Trust Task document:
// { id, type, issuer, issuedAt, payload, proof } plus, for an agent,
// onBehalfOf (its human) and delegation (the log entry that lets it act).
// Type URIs use the Trust Task URN form so no domain is needed:
//   urn:we-play-interop:tasks:spec:<slug with : for />:<MAJOR.MINOR>
import { sign } from './proof.js'

export const NS = 'urn:we-play-interop:tasks:spec:'
const T = (slug, v = '0.1') => NS + slug.replaceAll('/', ':') + ':' + v

export const TYPES = {
  genesis: T('workspace/genesis'),
  join: T('member/join'),
  delegate: T('delegation/grant'),
  revoke: T('delegation/revoke'),
  note: T('input/note'),
  propose: T('proposal/open'),
  vote: T('proposal/vote'),
  approve: T('proposal/approve'),
  veto: T('proposal/veto'),
  mode: T('weaver/mode'),
  round: T('weaver/round'),
  project: T('map/project'),
  way: T('map/way'),
  run: T('map/run'),
  score: T('score/snapshot'),
  result: T('action/result'),
  host: T('agent/host'),
  wake: T('agent/wake'),
  card: T('member/card'),
  remove: T('agent/remove'),
  leave: T('member/leave'),
  away: T('agent/away'),
  notebook: T('agent/notebook'),
  never: T('member/never'),
  draft: T('agent/draft'),
  upload: T('media/upload'),
  change: T('room/change'),
  hosted: T('agent/hosted'),
}
export const NAME_OF = Object.fromEntries(Object.entries(TYPES).map(([k, v]) => [v, k]))

/** Who may write each kind of document. */
export const WHO = {
  genesis: 'workspace', round: 'workspace', score: 'workspace', result: 'workspace', hosted: 'workspace', host: 'human', wake: 'human', card: 'anyone', notebook: 'private', never: 'private', draft: 'private', upload: 'private', change: 'anyone', remove: 'human', leave: 'human', away: 'human',
  join: 'human', delegate: 'human', revoke: 'human', approve: 'human', veto: 'human', mode: 'human',
  note: 'anyone', propose: 'anyone', vote: 'anyone', project: 'anyone', way: 'anyone', run: 'anyone',
}
/** What a human can let an agent do (delegation scope). Approving, vetoing and delegating stay human. */
export const AGENT_SCOPES = ['note', 'propose', 'vote', 'project', 'way', 'run', 'card', 'change']
/** Kinds of ways to do interop: deliberately broad. */
export const WAY_KINDS = ['identity', 'credentials', 'messaging', 'data', 'sync', 'network', 'storage', 'compute', 'governance', 'payments', 'other']
/** Way ids from the DTG board carry its item kind; the workspace does not define those. */
export const BOARD_WAY_PREFIXES = ['credential:', 'task:', 'ceremony:', 'basic:']
export const WAY_RE = /^[A-Za-z0-9][A-Za-z0-9._:/+#-]{0,199}$/

export const MODES = ['anarchy', 'democracy', 'weave']
/** What can wake an agent: someone talks to it, replies to it, the weaver connects it, every round, or anything new. */
export const WAKE_ON = ['direct', 'reply', 'mention', 'person', 'room', 'connection', 'ask', 'round', 'any']
// what wakes an agent unless it says otherwise: anything aimed at it, its own person speaking to the room, a question the weaver puts to everyone
export const DEFAULT_WAKE_ON = ['direct', 'reply', 'mention', 'person', 'room', 'connection', 'ask']
/** What an agent answers while its person is away, and how it picks its model. */
export const AWAY_ON = ['direct', 'reply', 'connection']
export const AWAY_MODELS = ['smart', 'fast', 'best']
export const NOTE_KINDS = ['message', 'intention', 'idea', 'observation', 'question']
export const VOTE_CHOICES = ['for', 'against', 'abstain']
/**
 * Proposal kinds. Only three ever act outside the workspace, and only after
 * approval and a quiet veto window:
 *  record-run        a run that happened, appended to dtg-interop runs.json by pull request
 *  issue             an issue on dtg-interop (corrections to another project's row go here)
 *  workspace-change  merge a pull request into this workspace's own repository, pinned to one commit
 * goal (what winning looks like) stays inside the workspace and steers the weaver.
 * run (an invitation for a pair to try ways together) and other stay inside the workspace.
 */
export const PROPOSAL_KINDS = ['goal', 'run', 'record-run', 'issue', 'workspace-change', 'other']
/**
 * What winning looks like is up to the room: a goal is a proposal of kind goal,
 * held while more people back it than oppose it and nobody vetoed it. A goal may
 * name one of the map's numbers to watch (measure) and which way it should move.
 */
export const MEASURES = ['passingPairs', 'freshPairs', 'connected', 'projects', 'ways', 'waysTried', 'runs', 'freshRuns', 'missing', 'faded', 'fadingSoon', 'dtgPlays']
export const EXTERNAL_KINDS = ['record-run', 'issue', 'workspace-change']
export const SUBJECT_KINDS = ['credential', 'task', 'ceremony', 'basic']
export const OUTCOMES = ['pass', 'fail', 'partial']

export const HASH_RE = /^[0-9a-f]{64}$/
const DID_RE = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

const uuid = () => {
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** An unsigned document. */
export function buildDocument ({ type, issuer, recipient, payload, onBehalfOf, delegation, threadId, expiresAt, issuedAt = new Date().toISOString() }) {
  const doc = { id: 'urn:uuid:' + uuid(), type, issuer, issuedAt, payload }
  if (recipient) doc.recipient = recipient
  if (threadId) doc.threadId = threadId
  if (expiresAt) doc.expiresAt = expiresAt
  if (onBehalfOf) { doc.onBehalfOf = onBehalfOf; doc.delegation = delegation }
  return doc
}

/** Build and sign with an identity from did.js newIdentity(). */
export function signedDocument (identity, fields) {
  const doc = buildDocument({ issuer: identity.did, ...fields })
  return sign(doc, { seed: identity.seed, verificationMethod: identity.verificationMethod, created: doc.issuedAt })
}

// ---- payload checks: small, explicit, readable. Each returns an error string or null.
const str = (v, min, max) => typeof v === 'string' && v.trim().length >= min && v.length <= max
// a short single line: text only, no line breaks or control characters
const optLine = (v, max) => v === undefined || (typeof v === 'string' && v.length <= max && !/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(v))
const optStr = (v, max) => v === undefined || (typeof v === 'string' && v.length <= max)
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)
const url = (v) => typeof v === 'string' && /^https:\/\/[^\s]+$/.test(v) && v.length <= 500

function checkRunInvite (run) {
  if (!isObj(run)) return 'run: an object with sides and ways'
  if (!Array.isArray(run.sides) || run.sides.length !== 2 || !run.sides.every((s) => SLUG_RE.test(s)) || run.sides[0] === run.sides[1]) return 'run.sides: two different project slugs'
  if (!Array.isArray(run.ways) || !run.ways.length || run.ways.length > 12 || !run.ways.every((w) => WAY_RE.test(w))) return 'run.ways: 1 to 12 way ids'
  return null
}
const checkLinks = (v, name) => (v === undefined || (Array.isArray(v) && v.length <= 10 && v.every((x) => isObj(x) && str(x.label, 1, 200) && url(x.url))) ? null : `${name}: up to 10 { label, url }`)
/** A run as dtg-interop's runs.schema.json wants it. */
export function checkBoardRun (run) {
  if (!isObj(run)) return 'run: an object'
  const allowed = ['subjects', 'date', 'sides', 'outcome', 'source', 'note', 'protocol', 'vectors', 'reportedBy']
  const extra = Object.keys(run).filter((k) => !allowed.includes(k))
  if (extra.length) return `run: unknown field ${extra[0]}`
  if (!Array.isArray(run.subjects) || !run.subjects.length) return 'run.subjects: at least one'
  for (const s of run.subjects) {
    if (!isObj(s) || !SUBJECT_KINDS.includes(s.kind) || !str(s.id, 1, 200)) return 'run.subjects[]: { kind, id }'
    if (Object.keys(s).some((k) => !['kind', 'id', 'outcome'].includes(k))) return 'run.subjects[]: only kind, id, outcome'
    if (s.outcome !== undefined && !OUTCOMES.includes(s.outcome)) return 'run.subjects[].outcome: pass|fail|partial'
  }
  if (!DATE_RE.test(run.date ?? '')) return 'run.date: YYYY-MM-DD'
  if (!Array.isArray(run.sides) || run.sides.length !== 2) return 'run.sides: exactly two'
  for (const s of run.sides) if (!isObj(s) || !SLUG_RE.test(s.project ?? '') || !str(s.version, 1, 300) || Object.keys(s).length !== 2) return 'run.sides[]: { project, version }'
  if (run.sides[0].project === run.sides[1].project) return 'run.sides: two different projects'
  if (!OUTCOMES.includes(run.outcome)) return 'run.outcome: pass|fail|partial'
  if (run.source !== undefined && !['manual', 'ci'].includes(run.source)) return 'run.source: manual|ci'
  if (!optStr(run.note, 800)) return 'run.note: at most 800 characters'
  if (run.protocol !== undefined && !url(run.protocol)) return 'run.protocol: an https URL'
  if (run.vectors !== undefined && (!Array.isArray(run.vectors) || !run.vectors.every((v) => isObj(v) && str(v.label, 1, 200) && url(v.url)))) return 'run.vectors: [{ label, url }]'
  if (run.reportedBy !== undefined) return 'run.reportedBy: set by the workspace, not by hand'
  return null
}

export function checkPayload (name, doc) {
  const p = doc.payload
  if (!isObj(p)) return 'payload must be an object'
  switch (name) {
    case 'join':
      if (!str(p.name, 1, 60)) return 'name: 1 to 60 characters'
      if (p.projects !== undefined && (!Array.isArray(p.projects) || p.projects.length > 5 || !p.projects.every((s) => SLUG_RE.test(s)))) return 'projects: up to 5 board project slugs'
      if (!optStr(p.about, 280)) return 'about: at most 280 characters'
      return null
    case 'delegate': {
      if (!DID_RE.test(p.delegate ?? '')) return 'delegate: the agent DID'
      if (!Array.isArray(p.scope) || !p.scope.length || !p.scope.every((s) => AGENT_SCOPES.includes(s))) return `scope: some of ${AGENT_SCOPES.join(', ')}`
      if (!optStr(p.label, 60)) return 'label: at most 60 characters'
      if (p.ask !== undefined && (!Array.isArray(p.ask) || !p.ask.every((s) => p.scope.includes(s)))) return 'ask: the kinds of line (from scope) that wait for your OK before they are posted'
      if (!RFC3339.test(doc.expiresAt ?? '')) return 'a delegation needs expiresAt'
      const days = (Date.parse(doc.expiresAt) - Date.parse(doc.issuedAt)) / 86400000
      if (!(days > 0 && days <= 90)) return 'expiresAt: after issuedAt and within 90 days'
      return null
    }
    case 'revoke': return HASH_RE.test(p.delegation ?? '') ? null : 'delegation: the hash of the delegation entry'
    case 'host': return str(p.label, 1, 60) ? null : 'label: a name for the agent, 1 to 60 characters'
    case 'remove': return DID_RE.test(p.agent ?? '') ? null : 'agent: your agent\'s DID'
    case 'leave': return optStr(p.why, 280) ? null : 'why: at most 280 characters (optional, public)'
    case 'away':
      if (!DID_RE.test(p.agent ?? '')) return 'agent: your agent\'s DID'
      if (typeof p.enabled !== 'boolean') return 'enabled: true or false'
      if (!Array.isArray(p.on) || !p.on.every((x) => AWAY_ON.includes(x))) return `on: some of ${AWAY_ON.join(', ')}`
      if (!Number.isInteger(p.perHour) || p.perHour < 1 || p.perHour > 60) return 'perHour: 1 to 60 answers an hour'
      return AWAY_MODELS.includes(p.model) ? null : `model: ${AWAY_MODELS.join(' | ')}`
    case 'card':
      if (p.goals !== undefined && (!Array.isArray(p.goals) || p.goals.length > 5 || !p.goals.every((g) => str(g, 1, 140)))) return 'goals: up to 5, each 1 to 140 characters'
      if (!optStr(p.workingOn, 300)) return 'workingOn: at most 300 characters'
      if (!optStr(p.lookingFor, 300)) return 'lookingFor: at most 300 characters'
      // an agent's own word about what it runs on: one short line of plain text, never checked by the room
      if (!optLine(p.model, 80)) return 'model: one line of plain text, at most 80 characters (for example Claude Opus 5.5, or a local model)'
      if (!optLine(p.runsOn, 120)) return 'runsOn: one line of plain text, at most 120 characters (where inference runs: local, or a named host)'
      return null
    case 'change':
      if (!str(p.title, 1, 140)) return 'title: 1 to 140 characters'
      if (!optStr(p.why, 2000)) return 'why: at most 2000 characters'
      if (p.base != null && !/^[0-9a-f]{40}$/.test(p.base)) return 'base: the 40-character commit the diff is against, or leave it out for the latest'
      if (!/^[0-9a-f]{64}$/.test(p.sha256 ?? '')) return 'sha256: the diff\'s sha256'
      return Number.isInteger(p.bytes) && p.bytes > 0 && p.bytes <= 200000 ? null : 'bytes: the diff\'s size'
    case 'upload':
      if (!/^[0-9a-f]{64}$/.test(p.sha256 ?? '')) return 'sha256: the photo\'s sha256'
      return ['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'text/plain', 'text/markdown', 'text/csv'].includes(p.type) ? null : 'type: a photo, a PDF, an Office file or plain text'
    case 'draft':
      if (!DID_RE.test(p.agent ?? '')) return 'agent: your agent\'s DID'
      if (!['list', 'send', 'drop'].includes(p.op)) return 'op: list | send | drop'
      if (p.op !== 'list' && !str(p.id, 1, 64)) return 'id: the draft'
      return p.text !== undefined && !str(p.text, 1, 2000) ? 'text: 1 to 2000 characters' : null
    case 'never':
      if (!['get', 'set'].includes(p.op)) return 'op: get | set'
      if (p.op === 'set' && (!Array.isArray(p.hashes) || p.hashes.length > 200 || !p.hashes.every((x) => /^[0-9a-f]{64}$/.test(x)))) return 'hashes: up to 200 sha256 hex strings'
      return null
    case 'notebook':
      if (!DID_RE.test(p.agent ?? '')) return 'agent: the agent\'s DID'
      if (!['read', 'add', 'peek'].includes(p.op)) return 'op: read | add | peek'
      return p.op === 'add' && !str(p.text, 1, 2000) ? 'text: 1 to 2000 characters' : null
    case 'wake':
      if (!DID_RE.test(p.agent ?? '')) return 'agent: your agent\'s DID'
      if (p.urlHash !== null && !HASH_RE.test(p.urlHash ?? '')) return 'urlHash: SHA-256 (hex) of the wake link, or null to remove it'
      if (!Array.isArray(p.on) || !p.on.every((x) => WAKE_ON.includes(x))) return `on: some of ${WAKE_ON.join(', ')}`
      return null
    case 'note':
      if (!str(p.text, 1, 2000)) return 'text: 1 to 2000 characters'
      if (p.files !== undefined && (!Array.isArray(p.files) || p.files.length > 4 || !p.files.every((f) => isObj(f) && /^[0-9a-f]{64}$/.test(f.sha256 ?? '') && ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'text/plain', 'text/markdown', 'text/csv'].includes(f.type) && str(f.name, 1, 120) && Number.isInteger(f.bytes) && f.bytes > 0 && f.bytes <= 10485760))) return 'files: up to 4 files, each { sha256, type, name, bytes }'
      if (p.media !== undefined && (!Array.isArray(p.media) || p.media.length > 4 || !p.media.every((m) => isObj(m) && /^[0-9a-f]{64}$/.test(m.sha256 ?? '') && ['image/jpeg', 'image/png', 'image/webp'].includes(m.type) && Number.isInteger(m.w) && Number.isInteger(m.h) && m.w > 0 && m.h > 0 && m.w <= 8000 && m.h <= 8000))) return 'media: up to 4 photos, each { sha256, type, w, h }'
      if (p.tech !== undefined && !str(p.tech, 1, 4000)) return 'tech: the technical layer, 1 to 4000 characters'
      if (!NOTE_KINDS.includes(p.kind)) return `kind: ${NOTE_KINDS.join(' | ')}`
      if (p.pair !== undefined && (!Array.isArray(p.pair) || p.pair.length !== 2 || !p.pair.every((s) => SLUG_RE.test(s)))) return 'pair: two project slugs'
      if (p.scenario !== undefined && !SLUG_RE.test(p.scenario)) return 'scenario: a scenario id'
      return null
    case 'propose':
      if (!PROPOSAL_KINDS.includes(p.kind)) return `kind: ${PROPOSAL_KINDS.join(' | ')}`
      if (!str(p.title, 1, 140)) return 'title: 1 to 140 characters'
      if (!optStr(p.body, 4000)) return 'body: at most 4000 characters'
      if (p.kind === 'goal') {
        if (p.measure !== undefined && !MEASURES.includes(p.measure)) return `measure: one of ${MEASURES.join(', ')}`
        if (p.direction !== undefined && !['up', 'down'].includes(p.direction)) return 'direction: up | down'
        return null
      }
      if (p.kind === 'run') return checkRunInvite(p.run)
      if (p.kind === 'record-run') {
        const e = checkBoardRun(p.run); if (e) return e
        if (p.sources !== undefined && (!Array.isArray(p.sources) || !p.sources.every((v) => isObj(v) && str(v.label, 1, 200) && url(v.url)))) return 'sources: [{ label, url }]'
        return null
      }
      if (p.kind === 'workspace-change') {
        if (!isObj(p.change) || !Number.isInteger(p.change.pr) || p.change.pr < 1 || !/^[0-9a-f]{40}$/.test(p.change.sha ?? '')) return 'change: { pr: pull request number, sha: its 40-character head commit }'
      }
      return null
    case 'project':
      if (!SLUG_RE.test(p.slug ?? '')) return 'slug: lowercase letters, digits and hyphens'
      if (!str(p.name, 1, 80)) return 'name: 1 to 80 characters'
      if (p.url !== undefined && !url(p.url)) return 'url: an https URL'
      if (!optStr(p.about, 500)) return 'about: at most 500 characters'
      if (!Array.isArray(p.ways) || p.ways.length > 40 || !p.ways.every((w) => WAY_RE.test(w))) return 'ways: up to 40 way ids (e.g. did:key, oidc, activitypub, iroh)'
      return null
    case 'way':
      if (!WAY_RE.test(p.id ?? '') || /[A-Z]/.test(p.id) || BOARD_WAY_PREFIXES.some((x) => p.id.startsWith(x))) return 'id: lowercase, e.g. oidc, activitypub, did:webvh (credential:, task:, ceremony:, basic: come from the DTG board)'
      if (!str(p.name, 1, 80)) return 'name: 1 to 80 characters'
      if (!WAY_KINDS.includes(p.kind)) return `kind: ${WAY_KINDS.join(' | ')}`
      if (p.url !== undefined && !url(p.url)) return 'url: an https URL'
      return optStr(p.about, 500) ? null : 'about: at most 500 characters'
    case 'run': {
      if (!Array.isArray(p.sides) || p.sides.length !== 2 || !p.sides.every((s) => isObj(s) && SLUG_RE.test(s.project ?? '') && str(s.version, 1, 300)) || p.sides[0].project === p.sides[1].project) return 'sides: two different projects, each { project, version }'
      if (!Array.isArray(p.ways) || !p.ways.length || p.ways.length > 12 || !p.ways.every((w) => WAY_RE.test(w))) return 'ways: 1 to 12 way ids it tested'
      if (!DATE_RE.test(p.date ?? '') || Date.parse(p.date) > Date.now() + 86400000) return 'date: YYYY-MM-DD, not in the future'
      if (!OUTCOMES.includes(p.outcome)) return 'outcome: pass | fail | partial'
      if (!optStr(p.note, 800)) return 'note: at most 800 characters'
      if (p.source !== undefined && !['manual', 'ci'].includes(p.source)) return 'source: manual | ci'
      return checkLinks(p.evidence, 'evidence') ?? checkLinks(p.sources, 'sources')
    }
    case 'vote':
      if (!HASH_RE.test(p.proposal ?? '')) return 'proposal: the hash of the proposal entry'
      if (!VOTE_CHOICES.includes(p.choice)) return `choice: ${VOTE_CHOICES.join(' | ')}`
      return optStr(p.reason, 500) ? null : 'reason: at most 500 characters'
    case 'approve': return HASH_RE.test(p.proposal ?? '') ? null : 'proposal: the hash of the proposal entry'
    case 'veto':
      if (!HASH_RE.test(p.target ?? '')) return 'target: the hash of the proposal it stops'
      return str(p.reason, 1, 500) ? null : 'reason: 1 to 500 characters'
    case 'mode':
      if (!MODES.includes(p.mode)) return `mode: ${MODES.join(' | ')}`
      return optStr(p.reason, 500) ? null : 'reason: at most 500 characters'
    default: return null // workspace-authored types are made by the server itself
  }
}

/** Framework-level shape of a Trust Task document (before any signature check). */
export function checkShape (doc) {
  if (!isObj(doc)) return 'a document is a JSON object'
  if (!str(doc.id, 1, 200)) return 'id: required'
  if (typeof doc.type !== 'string' || !NAME_OF[doc.type]) return 'type: not a type this workspace knows'
  if (!DID_RE.test(doc.issuer ?? '') || doc.issuer.length > 4096) return 'issuer: a DID'
  if (!RFC3339.test(doc.issuedAt ?? '')) return 'issuedAt: an RFC 3339 timestamp'
  if (doc.expiresAt !== undefined && !RFC3339.test(doc.expiresAt)) return 'expiresAt: an RFC 3339 timestamp'
  if (doc.threadId !== undefined && !str(doc.threadId, 1, 200)) return 'threadId: a string'
  if (doc.recipient !== undefined && (!DID_RE.test(doc.recipient) || doc.recipient.length > 4096)) return 'recipient: a DID'
  if (!isObj(doc.payload)) return 'payload: an object'
  if (doc.onBehalfOf !== undefined || doc.delegation !== undefined) {
    if (!DID_RE.test(doc.onBehalfOf ?? '')) return 'onBehalfOf: the DID of the human the agent acts for'
    if (!HASH_RE.test(doc.delegation ?? '')) return 'delegation: the hash of the delegation entry'
  }
  if (!isObj(doc.proof)) return 'proof: required'
  return null
}
