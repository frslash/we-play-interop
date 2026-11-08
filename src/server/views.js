// Read views shared by the HTTP API and the MCP server: everything is public.
import { proofConfig, signingInputHex } from '../shared/proof.js'
import { buildDocument, checkPayload, NAME_OF, TYPES } from '../shared/types.js'

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
