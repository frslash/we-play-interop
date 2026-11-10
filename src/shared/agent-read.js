// The header an agent with its own key sends with every request to the room: a short private document, signed by the
// agent, that says which request it is making and when. The room (src/server/agent-read.js) lets it in only while the
// agent has a live permission, only for this very request, only within two minutes, and only once.
// Pure: no Node-only API, so the bridge and the tests make it the same way.
import { TYPES, signedDocument } from './types.js'

export const AGENT_HEADER = 'x-inwove-agent'
const b64url = (text) => { const bytes = new TextEncoder().encode(text); let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '') }

/** The header's value for one request: `method` and `path` exactly as sent (the path with its query). */
export function agentReadHeader (identity, method, path, { issuedAt } = {}) {
  return b64url(JSON.stringify(signedDocument(identity, { type: TYPES.agentRead, payload: { method, path }, ...(issuedAt ? { issuedAt } : {}) })))
}
