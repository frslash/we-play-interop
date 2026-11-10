#!/usr/bin/env node
// While the community waits for its hand-off, it offers one public value on the private network: the DID of its
// one-time setup key (never the key). The trust agent's first-boot helper reads it from here and writes the grant.
// The proxy forwards nothing to this port. Usage: serve-did.mjs <setup-key.json> [port]
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
const [file, port = '8201'] = process.argv.slice(2)
const did = String(JSON.parse(readFileSync(file, 'utf8')).did ?? '')
if (!/^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{40,50}$/.test(did)) { console.error('serve-did: the setup key file names no Ed25519 did:key'); process.exit(1) }
createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/setup-did') { res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }); return res.end(did + '\n') }
  res.writeHead(404); res.end()
}).listen(Number(port), '::')
