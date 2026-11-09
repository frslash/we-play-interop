// Joining a community from the agent bridge as the person (agent/community-join.js), against the stand-in community in
// test/helpers/fake-vtc-join.js and the stand-in trust agent in test/helpers/fake-vti.js. The stand-ins follow the wire of each task's
// bundle; they prove the bridge's side is self-consistent, not interop (test/live/community-join-live.test.js is the check against
// a real community).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join as pathJoin } from 'node:path'
import { after, describe, test } from 'node:test'
import { keyFromDidDocument } from '../src/shared/chain.js'
import { PASS_CHECK_TYPE } from '../src/shared/dtg.js'
import { newIdentity, resolveDidKey } from '../src/shared/did.js'
import { instant, postTask, typeUri, verifyTask } from '../src/shared/trusttask.js'
import { CommunityJoin, POLL_TOTAL_MS, joinCommunityCommand, refusalWords } from '../agent/community-join.js'
import { Vta, VtiError, decodeCredential } from '../agent/vta.js'
import { startFakeVti } from './helpers/fake-vti.js'
import { startFakeVtc } from './helpers/fake-vtc-join.js'

const noWait = async () => {}
const closers = [], dirs = []
after(async () => { await Promise.all(closers.map((c) => c())); for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
const tmp = () => { const d = mkdtempSync(pathJoin(tmpdir(), 'wpi-join-')); dirs.push(d); return d }

/** A trust agent holding the person's persona, a community that pushes into its vault, and a CommunityJoin between them. */
async function world (vtcOpts = {}, { stateDir } = {}) {
  const vti = await startFakeVti(); closers.push(() => vti.close())
  const persona = vti.persona()
  const credentialText = vti.credential([persona])
  const vta = new Vta({ credential: decodeCredential(credentialText), sleep: noWait })
  const vtc = await startFakeVtc({ deliver: async (_who, creds) => { for (const c of creds) await vta.receiveCredential(c) }, ...vtcOpts }); closers.push(() => vtc.close())
  const said = []
  const join = new CommunityJoin({ vta, communityDid: vtc.did, persona, resolver: vtc.resolver, fetch: globalThis.fetch, stateDir, sleep: noWait, say: (l) => said.push(l) })
  return { vti, vta, vtc, persona, join, said, credentialText }
}
const types = (vtc, family, v) => vtc.seen[typeUri(family, v)]

describe('allow, end to end', () => {
  test('manifest, submit, pass found and checked, member credential sent with the request id: the community records it as reciprocated', async () => {
    const dir = tmp(), { vtc, join, persona, said } = await world({}, { stateDir: dir })
    const r = await join.run({ yes: true })
    assert.equal(r.done, true); assert.equal(r.stage, 'answered')
    assert.equal(r.pass.role, 'member', 'the role comes from the role credential, read from the vault')
    assert.ok(vtc.reciprocated.has(join.state.requestId))
    assert.equal(types(vtc, 'vtc/join-requests/manifest', '0.4'), 1); assert.equal(types(vtc, 'vtc/join-requests/submit', '0.3'), 1); assert.equal(types(vtc, 'vtc/members/vmc', '0.1'), 1)
    const submit = JSON.parse(vtc.received.find((x) => x.includes('/join-requests/submit/')))
    assert.equal(submit.issuer, persona); assert.equal(submit.recipient, vtc.did); assert.equal(submit.proof.proofPurpose, 'authentication')
    assert.equal(submit.payload.criterion, vtc.criterion.requirementsDigest, 'the criterion is named by its digest')
    assert.equal(submit.payload.registryConsent, false, 'consent to registry publication is off unless asked for')
    assert.equal('extensions' in submit.payload, false, 'extensions are left out, never null'); assert.equal('attributes' in submit.payload, false)
    assert.deepEqual(submit.payload.vp, { '@context': ['https://www.w3.org/ns/credentials/v2'], type: ['VerifiablePresentation'], holder: persona, verifiableCredential: [] })
    const vmc = JSON.parse(vtc.received.find((x) => x.includes('/members/vmc/'))).payload
    assert.equal(vmc.requestId, join.state.requestId)
    assert.equal(vmc.vc.credentialSubject.id, vtc.did); assert.equal(vmc.vc.issuer, persona); assert.equal(vmc.vc.proof.proofPurpose, 'assertionMethod')
    assert.ok(vmc.vc.credentialSubject.digestMultibase, 'bound to the community\'s own grant')
    assert.ok(said.some((l) => /join is complete/.test(l)))
    // the state file: stage, request number, counts; mode 0600; no credential bodies, no attributes
    const files = readdirSync(dir); assert.equal(files.length, 1); assert.match(files[0], /^community-[0-9a-f]{16}\.json$/)
    assert.equal(statSync(pathJoin(dir, files[0])).mode & 0o777, 0o600)
    const text = readFileSync(pathJoin(dir, files[0]), 'utf8'), st = JSON.parse(text)
    assert.equal(st.stage, 'answered'); assert.deepEqual({ ...st.counts, refusedBy: undefined }, { submitted: 1, polled: 1, resends: 0, passesFound: 1, answersSent: 1, signedAnswers: 4, uncheckedAnswers: 0, refusedBy: undefined })
    assert.ok(!text.includes('proofValue') && !text.includes(persona), 'no credential bodies, no DIDs')
    // a second run finds it finished and sends nothing new
    const again = await join.run({ yes: true }); assert.equal(again.already, true); assert.equal(types(vtc, 'vtc/members/vmc', '0.1'), 1)
    // --status words
    const words = CommunityJoin.statusWords(CommunityJoin.readState(dir, vtc.did))
    assert.match(words, /Stage: answered/); assert.match(words, /Last verdict: allow/); assert.match(words, /answersSent 1/); assert.ok(!words.includes(persona))
  })

  test('a pass that arrives late is waited for; the credentials are asked for again once, as the task allows', async () => {
    const { vtc, join, said } = await world({ deliverAfterPolls: 5 })
    const r = await join.run({ yes: true })
    assert.equal(r.done, true)
    assert.equal(join.state.counts.resends, 1, 'one resend, never more')
    assert.ok(said.some((l) => /asked the community to send the credentials again/i.test(l)))
    assert.equal(vtc.delivered, 1)
  })

  test('closed discovery still answers: the manifest is signed as the persona, and an unsigned question is refused', async () => {
    const { vtc, join } = await world({ discoveryOpen: false })
    const m = await join.manifest(); assert.equal(m.communityDid, vtc.did)
    const unsigned = await postTask(`${vtc.url}/v1`, { id: 'urn:uuid:x', type: typeUri('vtc/join-requests/manifest', '0.4'), issuer: newIdentity().did, recipient: vtc.did, issuedAt: instant(), payload: {} })
    assert.equal(unsigned.kind, 'error'); assert.equal(unsigned.code, 'permissionDenied')
  })
})

describe('stops at the first thing that needs the person', () => {
  test('refer names the queue now holding it, and a later run resumes from the same request and ends after ten minutes of waiting', async () => {
    const dir = tmp(), { vtc, join } = await world({ policy: 'refer' }, { stateDir: dir })
    const a = await join.run({ yes: true })
    assert.equal(a.stopped.kind, 'refer'); assert.equal(a.stopped.queue, 'membership-review'); assert.match(a.stopped.words, /membership-review/)
    const id = join.state.requestId
    let slept = 0
    const later = new CommunityJoin({ vta: join.vta, communityDid: vtc.did, persona: join.persona, resolver: vtc.resolver, fetch: globalThis.fetch, stateDir: dir, sleep: async (ms) => { slept += ms } })
    const b = await later.run({ yes: true })
    assert.equal(b.stopped.kind, 'timeout'); assert.match(b.stopped.words, /ten minutes/)
    assert.equal(later.state.requestId, id); assert.equal(types(vtc, 'vtc/join-requests/submit', '0.3'), 1, 'no second application')
    assert.ok(slept <= POLL_TOTAL_MS && slept > POLL_TOTAL_MS / 2, `waited ${slept} ms`)
  })
  test('requestMore names what is needed; deny names the code and the reason', async () => {
    const more = await (await world({ policy: 'requestMore' })).join.run({ yes: true })
    assert.equal(more.stopped.kind, 'requestMore'); assert.deepEqual(more.stopped.needs, ['identity-vetting']); assert.match(more.stopped.words, /identity-vetting/)
    const deny = await (await world({ policy: 'deny' })).join.run({ yes: true })
    assert.equal(deny.stopped.kind, 'deny'); assert.match(deny.stopped.words, /notEligible/); assert.match(deny.stopped.words, /admits no one/)
  })
  test('without the person\'s yes nothing is sent but the manifest question', async () => {
    const { vtc, join } = await world()
    const r = await join.run({ ask: async () => false })
    assert.equal(r.stopped.kind, 'no-yes'); assert.equal(types(vtc, 'vtc/join-requests/submit', '0.3'), undefined); assert.equal(types(vtc, 'vtc/members/vmc', '0.1'), undefined)
    const yes = await join.run({ ask: async () => true }); assert.equal(yes.done, true, 'the same run with a yes goes through')
  })
  test('an attribute the manifest requires and was not given stops before sending; one not asked for is not sent; both given right goes through', async () => {
    const asks = [{ type: 'x:nickname', required: true, purpose: 'what to call you' }]
    const a = await world({ requestedAttributes: asks })
    const missing = await a.join.run({ yes: true })
    assert.equal(missing.stopped.kind, 'attributes'); assert.deepEqual(missing.stopped.missing, ['x:nickname']); assert.equal(types(a.vtc, 'vtc/join-requests/submit', '0.3'), undefined)
    const extra = await a.join.run({ yes: true, attributes: [{ type: 'x:nickname', value: 'Sam' }, { type: 'x:phone', value: '1' }] })
    assert.deepEqual(extra.stopped.unrequested, ['x:phone']); assert.equal(types(a.vtc, 'vtc/join-requests/submit', '0.3'), undefined)
    const ok = await a.join.run({ yes: true, attributes: [{ type: 'x:nickname', value: 'Sam' }], registryConsent: true })
    assert.equal(ok.done, true); assert.deepEqual(a.vtc.seenAttributes, [['x:nickname']]); assert.deepEqual(a.vtc.seenConsent, [true])
  })
  test('an application already open is continued, not made twice (the community answers requestAlreadyOpen with its number)', async () => {
    const { vtc, vta, persona, join } = await world({ policy: 'refer' })
    await join.run({ yes: true })
    const fresh = new CommunityJoin({ vta, communityDid: vtc.did, persona, resolver: vtc.resolver, fetch: globalThis.fetch, sleep: noWait })
    const r = await fresh.run({ yes: true })
    assert.equal(fresh.state.requestId, join.state.requestId); assert.equal(r.stopped.kind, 'timeout')
    assert.equal(fresh.state.counts.refusedBy.requestAlreadyOpen, 1, 'the refusal is counted by its code')
  })
})

describe('the member\'s own credential', () => {
  test('one whose subject is not the community is refused by the community, and the bridge says so in words', async () => {
    const { vtc, join } = await world()
    join.memberCredential = (pass) => { const vc = CommunityJoin.prototype.memberCredential.call(join, pass); return { ...vc, credentialSubject: { ...vc.credentialSubject, id: newIdentity().did } } }
    await assert.rejects(join.run({ yes: true }), (e) => {
      assert.ok(e instanceof VtiError); assert.match(e.code, /subjectMismatch$/)
      assert.match(refusalWords(e), /not about it: its subject must be the community itself/)
      return true
    })
    assert.equal(vtc.reciprocated.size, 0); assert.equal(join.state.counts.refusedBy.subjectMismatch, 1)
    assert.notEqual(join.state.stage, 'answered')
  })
  test('the credential carries what the community\'s ingress check wants, and is signed as the persona', async () => {
    const { join, persona, vta } = await world()
    const vc = join.memberCredential(null)
    assert.deepEqual(vc['@context'], ['https://www.w3.org/ns/credentials/v2', 'https://registry.trustoverip.org/dtg/context/v1'])
    assert.deepEqual(vc.type, ['VerifiableCredential', 'DTGCredential', 'MembershipCredential'])
    assert.equal(vc.issuerScope, 'directed'); assert.match(vc.id, /^urn:uuid:/); assert.equal('digestMultibase' in vc.credentialSubject, false, 'no digest without a pass to bind to')
    const s = await vta.signDocument(vc, { proofPurpose: 'assertionMethod' })
    assert.equal(s.signerDid, persona)
  })
})

describe('showing the pass to the room', () => {
  test('--show-pass: the pass check is signed by the persona for the room and sent only on a yes', async () => {
    const { vtc, join, persona } = await world()
    await join.run({ yes: true })
    const roomId = newIdentity(), got = []
    const room = http.createServer(async (req, res) => {
      if (req.url === '/api/community') { res.end(JSON.stringify({ pass: { recipient: roomId.did } })); return }
      const chunks = []; for await (const c of req) chunks.push(c)
      const doc = JSON.parse(Buffer.concat(chunks).toString()); got.push(doc)
      const v = await verifyTask(doc, { keyFor: async (d, vm, p) => keyFromDidDocument(resolveDidKey(d), d, vm, p), me: roomId.did })
      res.end(JSON.stringify({ type: 'x', payload: { current: v.ok } }))
    })
    await new Promise((r) => room.listen(0, '127.0.0.1', r)); closers.push(() => new Promise((r) => { room.closeAllConnections?.(); room.close(r) }))
    const roomUrl = `http://127.0.0.1:${room.address().port}`
    const shown = await join.showPass({ roomUrl })
    assert.equal(shown.document.type, PASS_CHECK_TYPE); assert.equal(shown.document.issuer, persona); assert.equal(shown.document.recipient, roomId.did); assert.equal(got.length, 0, 'made, not sent')
    assert.equal(shown.document.payload.membership.credentialSubject.id, persona); assert.equal(shown.document.payload.membership.issuer, vtc.did)
    const sent = await join.showPass({ roomUrl, send: true })
    assert.equal(got.length, 1); assert.equal(sent.answer.payload.current, true)
  })
})

describe('the command', () => {
  async function env () {
    const w = await world()
    return { w, env: { COMMUNITY_DID: w.vtc.did, COMMUNITY_PERSONA: w.persona, VTA_CREDENTIAL: w.credentialText } }
  }
  const run = async (args, e, extra = {}) => { const out = []; const code = await joinCommunityCommand(args, e, { say: (...a) => out.push(a.join(' ')), stateDir: extra.stateDir, ...extra }); return { code, out: out.join('\n') } }

  test('a missing setting is named', async () => {
    assert.match((await run([], {})).out, /COMMUNITY_DID/)
    assert.match((await run([], { COMMUNITY_DID: 'did:example:c' })).out, /COMMUNITY_PERSONA/)
    assert.match((await run([], { COMMUNITY_DID: 'did:example:c', COMMUNITY_PERSONA: 'did:example:p' })).out, /VTA_CREDENTIAL/)
  })
  test('a whole join with --yes, then --status, with nothing but counts in the output', async () => {
    const { w, env: e } = await env(), dir = tmp()
    const done = await run(['--yes'], e, { stateDir: dir, resolver: w.vtc.resolver, fetch: globalThis.fetch, sleep: noWait, vtaSleep: noWait })
    assert.equal(done.code, 0, done.out); assert.match(done.out, /join is complete/)
    const st = await run(['--status'], e, { stateDir: dir })
    assert.equal(st.code, 0); assert.match(st.out, /Stage: answered/); assert.match(st.out, /passesFound 1/); assert.ok(!st.out.includes(w.persona) && !st.out.includes('proofValue'))
  })
  test('a join that stops says why and exits non-zero; no yes on the terminal sends nothing', async () => {
    const { w, env: e } = await env()
    const no = await run([], e, { resolver: w.vtc.resolver, fetch: globalThis.fetch, sleep: noWait, vtaSleep: noWait, ask: async () => false })
    assert.equal(no.code, 3); assert.match(no.out, /Nothing was sent/); assert.equal(types(w.vtc, 'vtc/join-requests/submit', '0.3'), undefined)
  })
  test('the bridge wires `join-community --status` (the one subcommand), and prints where it stands', () => {
    const dir = tmp()
    const r = spawnSync(process.execPath, ['agent/bridge.js', 'join-community', '--status'], { env: { PATH: process.env.PATH, HOME: dir, WPI_URL: 'http://127.0.0.1:9', WPI_AGENT_KEY_FILE: pathJoin(dir, 'cfg', 'agent-key'), COMMUNITY_DID: 'did:example:c' }, encoding: 'utf8', timeout: 20_000 })
    assert.equal(r.status, 0, r.stderr); assert.match(r.stderr, /No join has been started/)
    assert.ok(existsSync(pathJoin(dir, 'cfg', 'agent-key')))
  })
})
