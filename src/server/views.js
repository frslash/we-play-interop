// Read views shared by the HTTP API and the MCP server: everything is public.
import { proofConfig, signingInputHex } from '../shared/proof.js'
import { buildDocument, checkPayload, NAME_OF, TYPES } from '../shared/types.js'
import { gist } from './weaver.js'

export function info (ctx) {
  const { config, log, llm, weaver } = ctx, st = log.state
  return {
    name: config.workspaceName,
    workspace: st.workspace,
    publicUrl: config.publicUrl || null,
    board: { repo: config.boardRepo, data: config.boardDataUrl },
    workspaceRepo: config.workspaceRepo,
    operator: config.operator || null,
    sandbox: config.sandbox || false,
    branch: config.workspaceBranch || 'main',
    tunnel: (() => { try { const h = new URL(config.publicUrl).hostname; return /trycloudflare\.com$/i.test(h) ? 'Cloudflare’s quick tunnel' : /ngrok/i.test(h) ? 'an ngrok tunnel' : null } catch { return null } })(),
    mode: st.mode,
    head: log.head(),
    weaver: { model: llm.configured ? (llm.model ?? 'chosen at first round') : null, configured: llm.configured, endpoint: llm.endpoint ?? config.llm.baseUrl, nextRoundAt: new Date(weaver.nextRoundAt()).toISOString(), rounds: st.roundCount, lastError: weaver.lastError, lastSilent: weaver.lastSilent ?? null, speaksAfterQuietMinutes: config.weaverQuietMinutes, atMostEveryMinutes: config.weaverIntervalMinutes },
    rules: { voteMinutes: config.voteMinutes, agentApprovers: config.agentApprovals ? config.agentApprovers : null, vetoWindowMinutes: config.vetoWindowMinutes, approvalsRequired: config.approvalsRequired, freshDays: config.freshDays, actsOutside: config.githubToken ? 'opens pull requests and issues itself' : 'prepares links for a person to open (no GitHub token set)' },
    types: TYPES,
  }
}

/** How an agent can be reached right now: waiting on the room, a wake link, the room answering for it, or not at all (null). */
function listeningOf (ctx, p) {
  if (!ctx.log.state.activeDelegation(p.did)) return null
  if (ctx.waits?.listening(p.did)) return 'waiting'
  if (p.wake) return 'wake link'
  if (ctx.log.state.away.get(p.did)?.enabled) return 'room answers'
  return null
}

export function state (ctx) {
  const { log, board, executor } = ctx, st = log.state
  const people = [...st.participants.values()].filter((p) => p.kind !== 'workspace').map((p) => ({ ...p, delegation: p.kind === 'agent' ? st.activeDelegation(p.did)?.hash ?? null : undefined, ...(p.kind === 'agent' && ctx.waker?.status.get(p.did) ? { wakeLast: ctx.waker.status.get(p.did) } : {}), ...(p.kind === 'agent' && st.away.get(p.did) ? { away: st.away.get(p.did), awayLast: ctx.away?.status.get(p.did) ?? null } : {}), ...(p.kind === 'agent' ? { listening: listeningOf(ctx, p), connected: ctx.connected?.get(p.did) ?? null, ask: st.activeDelegation(p.did)?.ask ?? [], until: st.activeDelegation(p.did)?.expiresAt ?? null, waiting: ctx.drafts?.list(p.did).length ?? 0 } : {}) }))
  const checkDids = ctx.check?.dids() ?? []
  const theirs = people.filter((p) => p.kind === 'agent' && p.hosted && !checkDids.includes(p.did))
  const comingIn = { agents: theirs.length, saidHello: theirs.filter((p) => p.firstSaid).length, answeringNow: theirs.filter((p) => p.listening).length }
  return {
    ...info(ctx),
    people,
    check: ctx.check?.view() ?? null,
    comingIn,
    proposals: [...st.proposals.values()].reverse().map((pr) => ({ ...st.proposalView(pr), waitingFor: executor.waitingFor(pr) })),
    rounds: [...st.rounds].reverse(),
    score: board.score(),
    board: { fetchedAt: board.fetchedAt, error: board.error },
    counts: st.counts,
  }
}

/**
 * The map as a graph: projects and people, and the lines between them.
 *   connection  a passing run, fresh        faded     a pass older than 30 days
 *   broken      the latest run failed        potential both speak a way, never tried
 *   tether      a person and their project   suggested the weaver thinks they should talk
 *   intention   someone wants to reach this  tension   they pull apart (votes both ways, a veto)
 */
export function graph (ctx, m) {
  const st = ctx.log.state
  const asPerson = (did) => st.participants.get(did)?.principal ?? did // an agent's lines belong to its person
  const nodes = new Map(), edges = new Map()
  for (const p of m.projects) nodes.set(p.slug, { id: p.slug, kind: 'project', label: p.name, about: p.about, ways: p.ways, sources: p.sources, url: p.url, members: p.members })
  for (const p of st.participants.values()) if (p.kind === 'human') nodes.set(p.did, { id: p.did, kind: 'person', label: p.name, projects: p.projects, card: p.card ?? null, agents: [...st.participants.values()].filter((a) => a.principal === p.did && !a.removed).map((a) => a.name) })
  const edge = (a, b, kind, label) => { if (!nodes.has(a) || !nodes.has(b) || a === b) return; const k = [a, b].sort().join('|') + '|' + kind; const cur = edges.get(k); if (cur) { cur.weight++; if (label && !cur.labels.includes(label)) cur.labels.push(label) } else edges.set(k, { a, b, kind, weight: 1, labels: label ? [label] : [] }) }
  for (const p of m.pairs) {
    const ways = p.ways
    const pass = ways.filter((w) => w.latestPass), fresh = pass.filter((w) => w.fresh)
    const broken = ways.filter((w) => w.latest.outcome !== 'pass' && (!w.latestPass || w.latestPass < w.latest.date))
    if (fresh.length) edge(p.pair[0], p.pair[1], 'connection', fresh.map((w) => w.name).join(', '))
    else if (pass.length) edge(p.pair[0], p.pair[1], 'faded', pass.map((w) => w.name).join(', '))
    if (broken.length) edge(p.pair[0], p.pair[1], 'broken', broken.map((w) => `${w.name}: ${w.latest.outcome}`).join(', '))
  }
  for (const o of m.sharedWays.slice(0, 14)) edge(o.pair[0], o.pair[1], 'potential', o.ways.slice(0, 3).join(', '))
  for (const p of st.participants.values()) if (p.kind === 'human') for (const slug of p.projects ?? []) edge(p.did, slug, 'tether', 'part of it')
  for (const r of st.rounds.slice(-10)) {
    for (const c of r.connections ?? []) edge(asPerson(c.between[0]), asPerson(c.between[1]), 'suggested', c.why)
    for (const i of r.intentions ?? []) edge(asPerson(i.who), nodes.has(i.toward) ? i.toward : asPerson(i.toward), 'intention', i.wants)
    for (const t of r.tensions ?? []) edge(asPerson(t.between[0]), asPerson(t.between[1]), 'tension', t.about)
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] }
}

/** The whole map, the DTG board's own view, and the score over time. */
export function mapView (ctx) {
  const { board, log } = ctx, d = board.view
  const m = board.map()
  return {
    ...m, score: board.score(), graph: graph(ctx, m),
    dtg: d ? { score: d.score, generated: d.generated, scenarios: d.scenarios, plays: d.plays, missing: d.missing, readyToTry: d.opportunities, catalog: d.catalog } : null,
    history: log.state.scoreHistory, fetchedAt: board.fetchedAt, error: board.error,
  }
}

const HEARD = new Set(['note', 'propose', 'round', 'project', 'way', 'run', 'vote', 'approve', 'veto', 'mode', 'join', 'delegate', 'result'])
/** What an agent hears: who said what, to whom, in reply to what, in plain words. */
export function message (ctx, e, me) {
  const st = ctx.log.state, doc = e.document, p = doc.payload, name = NAME_OF[e.type]
  const base = { id: e.hash, seq: e.seq, at: e.timestamp, type: name, from: st.nameOf(e.author), fromDid: e.author, ...(e.onBehalfOf !== e.author ? { for: st.nameOf(e.onBehalfOf) } : {}), ...(me && e.author === me ? { mine: true } : {}) }
  if (doc.recipient) Object.assign(base, { to: st.nameOf(doc.recipient), toDid: doc.recipient })
  if (doc.threadId) { const parent = ctx.log.byDocId.get(doc.threadId); if (parent) base.replyTo = parent.hash }
  if (name === 'note') return { ...base, kind: p.kind, text: p.text, ...(p.tech ? { technical: p.tech } : {}), ...(p.media?.length ? { photos: p.media.map((m) => `${ctx.config.publicUrl || ''}/media/${m.sha256}`) } : {}) }
  if (name === 'round') {
    const next = (p.next ?? []).map((n) => n.action).join(' · ')
    const links = (p.connections ?? []).map((c) => `${c.between.map((d) => st.nameOf(d)).join(' & ')}: ${c.why}`).join(' · ')
    return { ...base, from: 'the weaver', text: [next && `Next: ${next}`, links && `Should talk: ${links}`].filter(Boolean).join('\n') || 'Listening.', ...(p.connections?.length ? { connections: p.connections } : {}) }
  }
  return { ...base, text: gist(e, st).text }
}

/** Why an entry concerns an agent (direct, reply, connection, round), or null. */
/** Why an entry concerns an agent, most specific first, or null. */
export function concerns (ctx, e, agent) {
  const name = NAME_OF[e.type], d = e.document, me = ctx.log.state.participants.get(agent)
  if (e.author === agent) return null
  if (name === 'note' && d.recipient === agent) return 'direct'
  if (name === 'note' && d.threadId && ctx.log.byDocId.get(d.threadId)?.author === agent) return 'reply'
  if (['note', 'propose'].includes(name) && me?.name && mentions(d.payload.text ?? d.payload.title ?? '', me.name)) return 'mention'
  // its own person speaking to the room (not a line addressed to someone else)
  if (['note', 'propose'].includes(name) && me?.principal && e.onBehalfOf === me.principal && e.author === me.principal && !d.recipient) return 'person'
  if (name === 'round' && (d.payload.connections ?? []).some((c) => c.between.includes(agent))) return 'connection'
  if (name === 'round' && (d.payload.next ?? []).some((n) => n.kind === 'ask')) return 'ask'
  if (name === 'round') return 'round'
  return null
}

/** Whether text names someone: "Ada", "@Ada", any case, as a whole word. */
export function mentions (text, name) {
  const esc = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^\\p{L}\\p{N}])@?${esc}(?![\\p{L}\\p{N}])`, 'iu').test(String(text))
}

export function messages (ctx, { after = -1, limit = 40, me, forMe } = {}) {
  const all = ctx.log.entries, items = [], only = forMe && me && forMe !== '0'
  let i = Math.max(0, Number(after) + 1)
  for (; i < all.length && items.length < Math.min(Number(limit) || 40, 100); i++) {
    if (!HEARD.has(NAME_OF[all[i].type])) continue
    const why = me ? concerns(ctx, all[i], me) : null
    if (only && (!why || why === 'round')) continue
    items.push({ ...message(ctx, all[i], me), ...(why && why !== 'round' ? { forYou: why } : {}) })
  }
  return { items, more: i < all.length, head: ctx.log.head() }
}

/** In-process reads for the hosted connector (the same answers the HTTP API gives). */
export function read (ctx, path) {
  const url = new URL(path, 'http://local'), q = Object.fromEntries(url.searchParams), p = url.pathname
  if (p === '/api/state') return state(ctx)
  if (p === '/api/map') return mapView(ctx)
  if (p === '/api/messages') return messages(ctx, q)
  if (p === '/api/wait') return ctx.waits.wait(q)
  if (p === '/api/log') return entries(ctx, q)
  if (p.startsWith('/api/log/')) return ctx.log.byHash.get(decodeURIComponent(p.slice(9))) ?? null
  if (p.startsWith('/api/participants/')) return participant(ctx, decodeURIComponent(p.slice(18)))
  throw new Error(`nothing at ${p}`)
}

export function participant (ctx, did) {
  const st = ctx.log.state, p = st.participants.get(did)
  const delegations = [...st.delegations.values()].filter((d) => d.delegate === did || d.issuer === did)
  return p ? { ...p, activeDelegation: st.activeDelegation(did) ?? null, delegations, ...(p.wake ? { wake: { ...p.wake, last: ctx.waker?.status.get(did) ?? null } } : {}) } : null
}

export function entries (ctx, { after = -1, limit = 100, type } = {}) {
  const all = ctx.log.entries
  const t = type ? (TYPES[type] ?? type) : null
  const out = []
  for (let i = Math.max(0, Number(after) + 1); i < all.length && out.length < Math.min(Number(limit) || 100, 500); i++) if (!t || all[i].type === t) out.push(all[i])
  return { entries: out, head: ctx.log.head() }
}

/**
 * For agents with their own signer: the unsigned document, the proof options,
 * and the exact bytes to sign (hex). Put the signature in proof.proofValue as
 * 'z' + base58btc(signature) and POST the document to /api/entries.
 */
export function draft (ctx, { type, payload, issuer, onBehalfOf, delegation, threadId, expiresAt, verificationMethod }) {
  const t = TYPES[type] ?? type
  const name = NAME_OF[t]
  if (!name) throw new Error(`unknown type ${type}; one of ${Object.keys(TYPES).join(', ')}`)
  if (!issuer) throw new Error('issuer: your DID')
  if (onBehalfOf && !delegation) delegation = ctx.log.state.activeDelegation(issuer)?.hash
  const doc = buildDocument({ type: t, issuer, payload: payload ?? {}, onBehalfOf, delegation, threadId, expiresAt })
  const problem = checkPayload(name, doc)
  const vm = verificationMethod ?? (issuer.startsWith('did:key:') ? `${issuer}#${issuer.slice(8)}` : null)
  if (!vm) throw new Error('verificationMethod: the key id in your DID document')
  const cfg = proofConfig({ verificationMethod: vm, created: doc.issuedAt, proofPurpose: 'authentication' })
  return {
    document: doc, proof: cfg, signingInputHex: signingInputHex(doc, cfg), problem,
    howTo: 'Sign the signingInputHex bytes with Ed25519, set document.proof = { ...proof, proofValue: "z" + base58btc(signature) }, POST document to /api/entries within 10 minutes.',
  }
}
