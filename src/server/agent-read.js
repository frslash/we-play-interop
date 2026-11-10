// An agent that holds its own key asks the room a question: it signs a short private document saying which request it
// is making and when, and sends it in the x-inwove-agent header (base64url of the JSON). The gate lets the request in as
// { kind: 'agent', did } when
//   - the document is signed by an agent that has a live permission from its person (not stopped, not run out),
//   - it says this very method and path (a signed "GET /api/state" opens nothing else),
//   - it was made within two minutes (a copied header goes stale at once), and
//   - it has not been used before (log.verifyPrivate remembers each document's id).
// A hosted agent does not need this: the secret in its link is its credential.
//
// The measurement (build rule 9): `stats` counts what was let in and, for every refusal, the reason, without content;
// /api/info shows it to members.
import { TaskError } from './log.js'

export const FRESH_MS = 2 * 60_000 // long enough for clocks that are a little apart; short enough that a header seen on the wire is useless a moment later
const MAX_HEADER = 4000 // a signed document of this size is a few hundred bytes; past this nothing is parsed

export function createAgentReads (ctx, { now = Date.now } = {}) {
  const stats = { allowed: 0, refused: {} }
  const refused = (why) => { stats.refused[why] = (stats.refused[why] ?? 0) + 1; return { why } }

  /** { did } for a good header; { why } (plain words, nothing secret) for a bad one; null when there is no header. */
  async function identify (req) {
    const header = req.headers['x-inwove-agent']
    if (header === undefined) return null
    if (typeof header !== 'string' || header.length > MAX_HEADER) return refused('malformed')
    let doc
    try { doc = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) } catch { return refused('malformed') }
    if (typeof doc?.issuer !== 'string') return refused('malformed')
    const st = ctx.log.state
    if (!st.isAgent(doc.issuer) || !st.activeDelegation(doc.issuer)) return refused('no live permission') // before any signature work: a stranger's header costs nothing to turn away
    if (!(Math.abs(now() - Date.parse(doc.issuedAt)) <= FRESH_MS)) return refused('stale')
    try { await ctx.log.verifyPrivate(doc, 'agentRead') } catch (err) { return refused(err instanceof TaskError ? (err.code === 'idConflict' ? 'reused' : err.code) : 'invalid') }
    if (doc.onBehalfOf !== undefined || doc.delegation !== undefined) return refused('malformed')
    if (doc.payload.method !== req.method || doc.payload.path !== req.url) return refused('another request')
    stats.allowed++
    return { did: doc.issuer }
  }
  return { identify, stats }
}

/** What an agent's own header says, in words for the 401 that refused it. */
export const WHY_WORDS = {
  malformed: 'the x-inwove-agent header is not a signed read (base64url of a signed agent/read document)',
  'no live permission': 'this agent has no live permission from a person here: its person signs one, then it can read',
  stale: 'the signed read is older than two minutes (or its clock is off): sign it again',
  reused: 'that signed read was already used: sign a new one for each request',
  'another request': 'that signed read is for a different method or path',
  proofInvalid: 'the signature does not check',
}
