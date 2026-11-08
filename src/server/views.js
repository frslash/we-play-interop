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
    mode: st.mode,
    head: log.head(),
    weaver: { model: llm.configured ? (llm.model ?? 'chosen at first round') : null, configured: llm.configured, endpoint: config.llm.baseUrl, nextRoundAt: new Date(weaver.nextRoundAt()).toISOString(), rounds: st.roundCount, lastError: weaver.lastError },
    rules: { vetoWindowMinutes: config.vetoWindowMinutes, approvalsRequired: config.approvalsRequired, freshDays: config.freshDays, actsOutside: config.githubToken ? 'opens pull requests and issues itself' : 'prepares links for a person to open (no GitHub token set)' },
    types: TYPES,
  }
}

export function state (ctx) {
  const { log, board, executor } = ctx, st = log.state
  const people = [...st.participants.values()].filter((p) => p.kind !== 'workspace').map((p) => ({ ...p, delegation: p.kind === 'agent' ? st.activeDelegation(p.did)?.hash ?? null : undefined }))
  return {
    ...info(ctx),
    people,
    proposals: [...st.proposals.values()].reverse().map((pr) => ({ ...st.proposalView(pr), waitingFor: executor.waitingFor(pr) })),
    rounds: [...st.rounds].reverse(),
    score: board.score(),
    board: { fetchedAt: board.fetchedAt, error: board.error },
    counts: st.counts,
  }
}

/** The whole map, the DTG board's own view, and the score over time. */
export function mapView (ctx) {
  const { board, log } = ctx, d = board.view
  return {
    ...board.map(), score: board.score(),
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
  if (name === 'note') return { ...base, kind: p.kind, text: p.text }
  if (name === 'round') {
    const next = (p.next ?? []).map((n) => n.action).join(' · ')
    const links = (p.connections ?? []).map((c) => `${c.between.map((d) => st.nameOf(d)).join(' & ')}: ${c.why}`).join(' · ')
    return { ...base, from: 'the weaver', text: [next && `Next: ${next}`, links && `Should talk: ${links}`].filter(Boolean).join('\n') || 'Listening.', ...(p.connections?.length ? { connections: p.connections } : {}) }
  }
  return { ...base, text: gist(e, st).text }
}

export function messages (ctx, { after = -1, limit = 40, me } = {}) {
  const all = ctx.log.entries, items = []
  let i = Math.max(0, Number(after) + 1)
  for (; i < all.length && items.length < Math.min(Number(limit) || 40, 100); i++) if (HEARD.has(NAME_OF[all[i].type])) items.push(message(ctx, all[i], me))
  return { items, more: i < all.length, head: ctx.log.head() }
}

/** In-process reads for the hosted connector (the same answers the HTTP API gives). */
export function read (ctx, path) {
  const url = new URL(path, 'http://local'), q = Object.fromEntries(url.searchParams), p = url.pathname
  if (p === '/api/state') return state(ctx)
  if (p === '/api/map') return mapView(ctx)
  if (p === '/api/messages') return messages(ctx, q)
  if (p === '/api/log') return entries(ctx, q)
  if (p.startsWith('/api/log/')) return ctx.log.byHash.get(decodeURIComponent(p.slice(9))) ?? null
  if (p.startsWith('/api/participants/')) return participant(ctx, decodeURIComponent(p.slice(18)))
  throw new Error(`nothing at ${p}`)
}

export function participant (ctx, did) {
  const st = ctx.log.state, p = st.participants.get(did)
  const delegations = [...st.delegations.values()].filter((d) => d.delegate === did || d.issuer === did)
  return p ? { ...p, activeDelegation: st.activeDelegation(did) ?? null, delegations } : null
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
