// Hosted agents: for an agent that cannot hold a key itself (Claude in the app
// or on the web, through a connector link), the workspace makes the agent a
// did:key and holds it. Everything else is unchanged: the agent acts only under
// a delegation its human signs with the human's own key, the log says which
// agents are hosted, and the human can stop the agent at any time.
// The agent's key is stored encrypted (AES-256-GCM, key derived from
// WORKSPACE_KEY); the connector link's secret is stored only as a hash.
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto'
import { identityFromSeedHex, newIdentity } from '../shared/did.js'

const sha = (s) => createHash('sha256').update(s).digest('hex')
const b64url = (b) => Buffer.from(b).toString('base64url')

export class HostedAgents {
  constructor ({ db, identity }) {
    this.db = db
    this.key = Buffer.from(hkdfSync('sha256', identity.seed, 'we-play-interop', 'hosted-agent-keys', 32))
    this.byTokenHash = new Map()
  }

  seal (hex) {
    const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', this.key, iv)
    const enc = Buffer.concat([c.update(hex, 'utf8'), c.final()])
    return [iv, c.getAuthTag(), enc].map(b64url).join('.')
  }

  open (sealed) {
    const [iv, tag, enc] = sealed.split('.').map((x) => Buffer.from(x, 'base64url'))
    const d = createDecipheriv('aes-256-gcm', this.key, iv); d.setAuthTag(tag)
    return Buffer.concat([d.update(enc), d.final()]).toString('utf8')
  }

  async load () {
    const { rows } = await this.db.query('select did, principal, label, token_hash, seed_enc from hosted_agents')
    for (const r of rows) this.byTokenHash.set(r.token_hash, { did: r.did, principal: r.principal, label: r.label, sealed: r.seed_enc })
  }

  /** Hosted agents of a person that are live or waiting for their permission (stopped ones do not count). */
  liveFor (principal, state) {
    return [...this.byTokenHash.values()].filter((a) => a.principal === principal && (state.activeDelegation(a.did) || ![...state.delegations.values()].some((d) => d.delegate === a.did))).length
  }

  /** A new agent key for this human; returns its DID and the connector secret (shown once). */
  async create (principal, label) {
    const id = newIdentity(), token = b64url(randomBytes(32)), tokenHash = sha(token)
    const sealed = this.seal(id.seedHex)
    await this.db.query('insert into hosted_agents (did, principal, label, token_hash, seed_enc, created) values ($1,$2,$3,$4,$5,$6)', [id.did, principal, label, tokenHash, sealed, new Date().toISOString()])
    this.byTokenHash.set(tokenHash, { did: id.did, principal, label, sealed })
    return { did: id.did, token }
  }

  /** Forget an agent's key for good: its connector link stops working. */
  async delete (did) {
    await this.db.query('delete from hosted_agents where did = $1', [did])
    for (const [k, a] of this.byTokenHash) if (a.did === did) this.byTokenHash.delete(k)
  }

  /** The agent behind a connector secret, with its signing identity, or null. */
  byToken (token) {
    const rec = this.byTokenHash.get(sha(String(token)))
    if (!rec) return null
    return { ...rec, identity: identityFromSeedHex(this.open(rec.sealed)) }
  }
}
