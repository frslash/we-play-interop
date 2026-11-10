// The header an agent with its own key sends with a read to the room: a short private document, signed by the
// agent, that says which room it is for (the origin), which request (method and the exact path with its query), when,
// and carries a one-time nonce. The room (src/server/agent-read.js) lets it in only while the agent has a live
// permission, only for GET and HEAD, only for this very request at this very room, only within 60 seconds, and only once.
// Pure: no Node-only API, so the bridge and the tests make it the same way.
import { TYPES, signedDocument } from './types.js'

export const AGENT_HEADER = 'x-inwove-agent'
const b64url = (text) => { const bytes = new TextEncoder().encode(text); let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '') }
const nonce = () => { const b = crypto.getRandomValues(new Uint8Array(16)); let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '') }

/** The header's value for one read: `origin` is the room's (scheme, host, port), `method` GET or HEAD, `path` exactly as sent (with its query). */
export function agentReadHeader (identity, method, path, { origin, issuedAt, nonce: n } = {}) {
  return b64url(JSON.stringify(signedDocument(identity, { type: TYPES.agentRead, payload: { origin: new URL(origin).origin, method, path, nonce: n ?? nonce() }, ...(issuedAt ? { issuedAt } : {}) })))
}
