#!/usr/bin/env node
// The first real exchange between the room's code and a community built from the pinned OpenVTC source: read the
// community's health and DID, then send it one document signed the way the room signs (src/shared), and check the
// answer is that task's "#response". Run from the repository root: node community/smoke.mjs [community base URL]
// Prints what answered and how; exits non-zero on anything else. Throwaway key, made here.
import { newIdentity } from '../src/shared/did.js'
import { signedDocument } from '../src/shared/types.js'

const base = (process.argv[2] ?? 'http://127.0.0.1:8200').replace(/\/+$/, '')
const SPEC = 'https://trusttasks.org/spec/'
const whole = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') // whole seconds: the form every consumer here accepts
const fail = (m) => { console.error(`smoke: FAIL: ${m}`); process.exit(1) }

const health = await fetch(`${base}/health`).then((r) => r.json()).catch((e) => fail(`no health answer from ${base}: ${e.message}`))
const vtcDid = health.vtc_did ?? health.vtcDid
if (!/^did:/.test(String(vtcDid))) fail(`health did not name the community's DID: ${JSON.stringify(health).slice(0, 200)}`)
console.log(`community ${vtcDid} (version ${health.version ?? '?'}, status ${health.status ?? '?'})`)
const log = await fetch(`${base}/.well-known/did.jsonl`)
if (!log.ok) fail(`the community does not serve its DID log (${log.status})`)

const me = newIdentity()
const ask = async (family, payload) => {
  const type = SPEC + family
  const doc = signedDocument(me, { type, recipient: vtcDid, payload, issuedAt: whole() })
  const res = await fetch(`${base}/v1/trust-tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(doc) })
  const text = await res.text(); let reply = null; try { reply = JSON.parse(text) } catch {}
  return { type, status: res.status, reply }
}
// the join manifest: what the community asks of someone who wants to join (a signed request from anyone)
const m = await ask('vtc/join-requests/manifest/0.4', {})
if (m.reply?.type !== `${m.type}#response`) fail(`join manifest: HTTP ${m.status}, answer type ${m.reply?.type ?? '(none)'}, code ${m.reply?.payload?.code ?? '-'}: ${String(m.reply?.payload?.message ?? '').slice(0, 200)}`)
const criteria = m.reply.payload?.criteria ?? []
console.log(`join manifest answered: ${criteria.length} way(s) to join; the answer is ${m.reply.proof ? 'signed' : 'NOT signed'} by ${String(m.reply.issuer ?? '?')}`)
if (!m.reply.proof) fail('the community\'s answer carries no proof')
// a made-up task must be refused with the shared code, not accepted and not a server error
const bad = await ask('vtc/no-such-task/0.1', {})
const code = bad.reply?.payload?.code
if (!String(bad.reply?.type ?? '').startsWith(`${SPEC}trust-task-error/`) || !['unsupportedType', 'unsupportedVersion'].includes(code)) fail(`an unknown task was answered with ${bad.reply?.type ?? `HTTP ${bad.status}`} (${code ?? '-'})`)
console.log(`an unknown task is refused as ${code}`)
console.log('smoke: ok')
