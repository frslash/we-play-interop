// One whole wallet sign-in against a room over HTTP, playing both the browser (the page's own code, with a key that
// cannot be read out) and the wallet (test/helpers/wallet.js). test/live/signin-live.test.js runs it against a real
// room; test/signin.test.js runs the same thing against a room on this machine, so the live check is known to work
// before anyone points it at something real. It leaves one short session in the room for a key made here and thrown
// away, signed in as a DID made here and thrown away. Nothing is written to the room's log.
import assert from 'node:assert/strict'
import { newIdentity } from '../../src/shared/did.js'
import { isEd25519DidKey, newSessionKey, readTriggerLink, starter } from '../../src/shared/signin.js'
import { verifyTask } from '../../src/shared/trusttask.js'
import { createResolver } from '../../src/server/resolver.js'
import { testWallet } from './wallet.js'

/**
 * url: the room's address. person: who approves (a fresh did:key unless given). resolver: resolves the room's DID.
 * For an https room the wallet finds the door the way a real one does, from the room's DID document; for a room on
 * plain http (this machine) it is told the address, since such a room has no DID document a wallet could read.
 */
export async function playSignIn ({ url, person = newIdentity(), resolver = createResolver(), fetch: f = globalThis.fetch }) {
  const origin = new URL(url).origin, local = origin.startsWith('http:')
  const json = async (path, init) => { const r = await f(origin + path, init); return { status: r.status, body: await r.json().catch(() => null) } }
  const config = (await json('/api/signin/config')).body
  assert.ok(config, 'the room answers GET /api/signin/config')
  assert.equal(config.on, true, `wallet sign-in is on in this room${config.why ? ` (it says: ${config.why[0]})` : ''}`)
  if (!local) assert.deepEqual(config.didDocument, { status: 'ok' }, 'the room\'s published DID document lists what a wallet needs (TrustTaskHTTPS, SignInPortal, its signing key)')
  const before = (await json('/api/info')).body.signIn.counts

  const post = (door, withOrigin) => async (doc) => (await f(door, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', ...(withOrigin ? { origin } : {}) }, body: JSON.stringify(doc) })).json()
  const key = await newSessionKey()
  const browser = starter({ config, key, send: post(origin + config.trustTasks, true) }) // the page: same origin, so the browser sends Origin
  const opened = await browser.open()
  assert.equal(readTriggerLink(opened.link).from, config.serviceDid); assert.ok(opened.link.length <= 251)
  assert.equal((await browser.redeem(opened.requestId)).stage, 'pending', 'before a scan the page only waits')

  const wallet = testWallet({ person, resolver, plainHttp: local, send: (doc, base) => post(`${String(base).replace(/\/+$/, '')}/trust-tasks`, false)(doc) })
  const claimed = await wallet.scan(opened.link, local ? { base: (origin + config.trustTasks).replace(/\/trust-tasks$/, '') } : {})
  assert.equal(claimed.kind, 'response', `the room answers the claim (${claimed.code ?? ''} ${claimed.message ?? ''})`)
  const shown = await browser.redeem(opened.requestId)
  assert.equal(shown.stage, 'claimed'); assert.match(shown.matchNumber ?? '', /^[0-9]{2}$/, 'the page is given the number to show')
  const proved = await wallet.prove(shown.matchNumber)
  assert.equal(proved.kind, 'response', `the room accepts the person's proof (${proved.code ?? ''} ${proved.message ?? ''})`)
  const decided = await wallet.respond('approve', { sessionSeconds: 300 })
  assert.equal(decided.payload?.status, 'approved', `the room accepts the grant (${decided.code ?? ''} ${decided.message ?? ''})`)
  let done = await browser.redeem(opened.requestId)
  for (let i = 0; i < 3 && done.state === 'waiting'; i++) done = await browser.redeem(opened.requestId)
  assert.equal(done.state, 'signed-in'); assert.equal(done.subject, person.did); assert.deepEqual(done.amr, ['did', 'oob', 'uv'])

  const held = await json(`/api/signin/session?key=${encodeURIComponent(key.did)}`)
  assert.equal(held.status, 200); assert.equal(held.body.subject, person.did); assert.equal(held.body.mayWrite, false)
  assert.ok(isEd25519DidKey(held.body.grant.payload.sessionKey)); assert.equal(held.body.grant.payload.sessionKey, key.did)
  assert.equal((await verifyTask(held.body.grant, { keyFor: resolver.keyFor, me: config.serviceDid, purposes: ['assertionMethod'] })).ok, true, 'the grant the room shows is the person\'s own, and anyone can check it')
  assert.equal((await browser.redeem(opened.requestId).catch((e) => e)).code, 'auth/oob:alreadyDecided', 'a sign-in is collected once')

  const after = (await json('/api/info')).body.signIn.counts
  for (const stage of ['requested', 'claimed', 'proved', 'approved', 'redeemed']) assert.ok(after[stage] >= before[stage] + 1, `the room counted "${stage}"`)
  return { config, link: opened.link, session: held.body, kept: key.kept }
}
