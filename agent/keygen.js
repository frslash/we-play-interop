#!/usr/bin/env node
// A new Ed25519 key and its did:key. Use it as WORKSPACE_KEY (or WPI_AGENT_KEY).
import { newIdentity } from '../src/shared/did.js'

const id = newIdentity()
console.log(`# ${id.did}`)
console.log(`WORKSPACE_KEY=${id.seedHex}`)
console.error('Keep the key secret: it signs as this DID. Put it in your environment, never in the repository.')
