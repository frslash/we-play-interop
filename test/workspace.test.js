import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { createDID, defaultVerifier } from 'didwebvh-ts'
import { canonicalize, ed25519, multibase } from '../src/shared/crypto.js'
import { didPeer4FromDocument, ed25519Multikey, newIdentity, resolveDidKey, resolveDidPeer4 } from '../src/shared/did.js'
import { sign, signingInput, verifySignature } from '../src/shared/proof.js'
import { verifyChain } from '../src/shared/chain.js'
import { TYPES, signedDocument } from '../src/shared/types.js'
import { computeBoard } from '../src/server/board.js'
import { computeMap } from '../src/server/map.js'
import { State } from '../src/server/state.js'
import { config as baseConfig } from '../src/server/config.js'
import { createApp } from '../src/server/index.js'
import { createResolver } from '../src/server/resolver.js'

// A small synthetic board in dtg-interop's data.json shape.
const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10)
const BOARD = {
  generated: day(0),
  projects: [
    { slug: 'alpha', name: 'Alpha', credentials: [{ profiles: ['VRC'], proof: ['eddsa-jcs-2022'], status: 'runs' }], facets: { didMethods: ['did:key'] } },
    { slug: 'beta', name: 'Beta', credentials: [{ profiles: ['VRC'], status: 'runs' }] },
    { slug: 'gamma', name: 'Gamma', credentials: [{ profiles: ['VRC'], status: 'building' }], facets: { didMethods: ['did:key', { value: 'did:webvh', status: 'building' }] } },
  ],
  credentialProfiles: { profiles: { VRC: {}, VMC: {} } },
  ceremonies: [{ id: 'shake' }], basics: [{ id: 'did-resolution' }],
  scenarios: [
    { id: 'connect', title: 'Connect', needs: [{ kind: 'credential', id: 'VRC', bringers: [{ project: 'alpha', status: 'runs' }, { project: 'beta', status: 'runs' }, { project: 'gamma', status: 'runs' }] }, { oneOf: [{ kind: 'ceremony', id: 'shake', bringers: [{ project: 'alpha', status: 'runs' }, { project: 'gamma', status: 'runs' }] }] }] },
    { id: 'write', title: 'Write', needs: [], missing: [{ label: 'a message type', thread: 't1' }] },
  ],
  runs: [
    { subjects: [{ kind: 'credential', id: 'VRC' }, { kind: 'ceremony', id: 'shake' }], date: day(26), sides: [{ project: 'alpha', version: '1' }, { project: 'beta', version: '2' }], outcome: 'pass' },
    { subjects: [{ kind: 'credential', id: 'VRC' }], date: day(45), sides: [{ project: 'beta', version: '1' }, { project: 'gamma', version: '1' }], outcome: 'pass' },
  ],
}

describe('crypto core', () => {
  test('JCS sorts keys and keeps JSON number spelling', () => {
    assert.equal(canonicalize({ b: 2, a: [1, 'x', { d: null, c: true }], e: 1e21, f: 0.1 }), '{"a":[1,"x",{"c":true,"d":null}],"b":2,"e":1e+21,"f":0.1}')
  })
  test('did:key round trip and eddsa-jcs-2022 sign/verify, tamper fails', () => {
    const id = newIdentity()
    const doc = resolveDidKey(id.did)
    assert.equal(doc.authentication[0], id.verificationMethod)
    const signed = sign({ id: 'x', type: TYPES.note, issuer: id.did, payload: { text: 'hi', kind: 'idea' } }, { seed: id.seed, verificationMethod: id.verificationMethod })
    assert.equal(verifySignature(signed, id.publicKey).ok, true)
    assert.equal(verifySignature({ ...signed, payload: { text: 'ho', kind: 'idea' } }, id.publicKey).ok, false)
  })
  test('did:peer:4 long form resolves and checks its hash', () => {
    const id = newIdentity()
    const input = { '@context': ['https://www.w3.org/ns/did/v1'], verificationMethod: [{ id: '#key-1', type: 'Multikey', publicKeyMultibase: ed25519Multikey(id.publicKey) }], authentication: ['#key-1'] }
    const { long, short } = didPeer4FromDocument(input)
    const { doc } = resolveDidPeer4(long)
    assert.equal(doc.id, long); assert.deepEqual(doc.alsoKnownAs, [short])
    assert.throws(() => resolveDidPeer4(long.slice(0, -2) + 'zz'))
  })
})

describe('board scoring', () => {
  test('pairs from runs only, fading, missing, ready to try', () => {
    const b = computeBoard(BOARD)
    assert.equal(b.score.passingPairs, 2)
    assert.equal(b.score.freshPairs, 1) // beta|gamma is 45 days old
    assert.equal(b.score.plays, 1) // alpha|beta covered connect
    assert.equal(b.score.missing, 1)
    assert.equal(b.faded.length, 1)
    assert.ok(b.fadingSoon.some((f) => f.pair.join('|') === 'alpha|beta'))
    assert.deepEqual(b.opportunities.map((o) => o.pair.join('|')), ['alpha|gamma'])
  })
})

describe('the interop map', () => {
  test('board projects bring their ways; workspace projects and runs join them', () => {
    const st = new State()
    st.participants.set('did:x', { did: 'did:x', kind: 'human', name: 'P', projects: ['meshnet'] })
    st.mapProjects.set('meshnet', { slug: 'meshnet', name: 'Meshnet', url: 'https://mesh.example', about: 'a mesh', ways: ['oidc', 'eddsa-jcs-2022'], addedBy: 'did:x' })
    st.mapProjects.set('loginco', { slug: 'loginco', name: 'LoginCo', ways: ['oidc'], addedBy: 'did:x' })
    let m = computeMap({ board: BOARD, state: st })
    assert.equal(m.score.projects, 5)
    assert.deepEqual(m.projects.find((p) => p.slug === 'alpha').ways.sort(), ['credential:VRC', 'did:key', 'eddsa-jcs-2022'])
    assert.deepEqual(m.projects.find((p) => p.slug === 'gamma').ways, ['did:key']) // only what runs
    // a pair across sources that speaks the same way comes first
    assert.deepEqual(m.sharedWays[0].pair, ['alpha', 'meshnet']); assert.equal(m.sharedWays[0].crossesSources, true)
    assert.ok(m.sharedWays.some((o) => o.pair.join('|') === 'meshnet|loginco' || o.pair.join('|') === 'loginco|meshnet'))
    st.mapRuns.push({ sides: ['meshnet', 'alpha'], versions: ['1', '2'], date: day(1), results: [{ way: 'eddsa-jcs-2022', outcome: 'pass' }], reported: false })
    m = computeMap({ board: BOARD, state: st })
    assert.equal(m.score.passingPairs, 3); assert.equal(m.score.connected, 4)
    assert.ok(!m.sharedWays.some((o) => o.pair.join('|') === 'alpha|meshnet' && o.ways.includes('eddsa-jcs-2022')))
    assert.equal(m.ways.find((w) => w.id === 'eddsa-jcs-2022').passingPairs, 1)
  })
})

// --- a did:webvh made by the DIF reference library, signed by our eddsa-jcs-2022 code
async function makeWebvh () {
  const update = newIdentity(), key = newIdentity()
  const mk = ed25519Multikey(update.publicKey)
  const signer = {
    getVerificationMethodId: () => `did:key:${mk}#${mk}`,
    sign: async ({ document, proof }) => ({ proofValue: multibase(ed25519.sign(signingInput(document, proof), update.seed)) }),
  }
  const vk = ed25519Multikey(key.publicKey)
  const { did, log } = await createDID({
    address: 'interop.example', signer, verifier: defaultVerifier, updateKeys: [mk],
    didDocument: { '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'], id: '{DID}', verificationMethod: [{ id: '{DID}#key-1', type: 'Multikey', controller: '{DID}', publicKeyMultibase: vk }], authentication: ['{DID}#key-1'], assertionMethod: ['{DID}#key-1'] },
  })
  const jsonl = log.map((e) => JSON.stringify(e)).join('\n') + '\n'
  const fetch = async (url) => (String(url).endsWith('/did.jsonl') ? new Response(jsonl, { status: 200 }) : new Response('not found', { status: 404 }))
  return { did, key: { ...key, did, verificationMethod: `${did}#key-1` }, fetch }
}

describe('the workspace, end to end', () => {
  let ctx, base, dir, webvh, ghCalls, wakeCalls = []
  const wakeFetch = async (url, init) => { wakeCalls.push({ url, body: JSON.parse(init.body) }); return new Response('ok', { status: 200 }) }
  const human = newIdentity(), other = newIdentity(), agent = newIdentity(), stranger = newIdentity()
  const postDoc = async (doc) => { const r = await fetch(`${base}/api/entries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(doc) }); return { status: r.status, body: await r.json() } }
  const send = (id, name, payload, extra) => postDoc(signedDocument(id, { type: TYPES[name], payload, ...extra }))
  const get = async (p) => (await fetch(base + p)).json()

  // a pretend GitHub that records what the executor asks of it
  const runsFile = JSON.stringify({ $comment: 'runs', runs: BOARD.runs }, null, 2) + '\n'
  const gh = async (method, path, body) => {
    ghCalls.push({ method, path, body })
    if (path === '/user') return { login: 'bot' }
    if (path.endsWith('/forks') || path.endsWith('/merge-upstream')) return {}
    if (path === '/repos/bot/dtg-interop') return {}
    if (path.includes('/contents/runs.json?ref=')) return { content: Buffer.from(runsFile).toString('base64'), sha: 'blob1' }
    if (path.endsWith('/git/ref/heads/main')) return { object: { sha: 'c0ffee' } }
    if (path.endsWith('/git/refs')) return {}
    if (method === 'PUT' && path.endsWith('/contents/runs.json')) return {}
    if (method === 'POST' && path.endsWith('/pulls')) return { html_url: 'https://github.com/x/pull/9', number: 9 }
    if (method === 'POST' && path.endsWith('/issues')) return { html_url: 'https://github.com/x/issues/3', number: 3 }
    if (method === 'GET' && /\/pulls\/\d+$/.test(path)) return { state: 'open', title: 'Improve the weaver', head: { sha: 'a'.repeat(40) } }
    if (path.includes('/statuses/')) return {}
    if (method === 'PUT' && path.endsWith('/merge')) return { sha: 'b'.repeat(40) }
    throw new Error('unexpected ' + method + ' ' + path)
  }

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wpi-'))
    webvh = await makeWebvh()
    ghCalls = []
    const config = { ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, githubToken: 'test', vetoWindowMinutes: 0, approvalsRequired: 1, weaverIntervalMinutes: 0, publicUrl: 'https://interop.example', boardDataUrl: 'data:application/json,' + encodeURIComponent(JSON.stringify(BOARD)), llm: { ...baseConfig.llm, apiKey: '' } }
    ctx = await createApp(config, { resolver: createResolver({ fetch: webvh.fetch }), gh, wakeFetch })
    await new Promise((r) => ctx.server.listen(0, r))
    base = `http://localhost:${ctx.server.address().port}`
    await ctx.board.refresh()
  })
  after(async () => { await ctx.stop(); rmSync(dir, { recursive: true, force: true }) })

  test('genesis and the first board snapshot are in the log', async () => {
    const { entries } = await get('/api/log')
    assert.deepEqual(entries.map((e) => e.type), [TYPES.genesis, TYPES.score])
    assert.equal(entries[1].parent, entries[0].hash)
  })

  test('people join by signing; bad signatures and strangers are refused with trust-task-error', async () => {
    assert.equal((await send(human, 'join', { name: 'Person A', projects: ['alpha'] })).status, 201)
    assert.equal((await send(other, 'join', { name: 'Person B' })).status, 201)
    const forged = signedDocument(human, { type: TYPES.note, payload: { text: 'x', kind: 'idea' } })
    forged.payload.text = 'changed after signing'
    const r = await postDoc(forged)
    assert.equal(r.status, 400); assert.equal(r.body.type, 'https://trusttasks.org/spec/trust-task-error/0.6'); assert.equal(r.body.payload.code, 'proofInvalid')
    assert.equal((await send(stranger, 'note', { text: 'hello', kind: 'idea' })).body.payload.code, 'permissionDenied')
    const old = await send(human, 'note', { text: 'old', kind: 'idea' }, { issuedAt: new Date(Date.now() - 3600_000).toISOString() })
    assert.equal(old.body.payload.code, 'expired')
  })

  test('a retry of the same bytes is fine; the same id with other content is not', async () => {
    const doc = signedDocument(human, { type: TYPES.note, payload: { text: 'we should rerun alpha and beta', kind: 'intention' } })
    assert.equal((await postDoc(doc)).status, 201)
    assert.equal((await postDoc(doc)).status, 200)
    const clash = signedDocument(human, { type: TYPES.note, payload: { text: 'different', kind: 'idea' } })
    clash.id = doc.id
    assert.equal((await postDoc(sign({ ...clash, proof: undefined }, { seed: human.seed, verificationMethod: human.verificationMethod }))).body.payload.code, 'idConflict')
  })

  test('did:webvh and did:peer:4 people can join', async () => {
    assert.equal((await send(webvh.key, 'join', { name: 'Webvh person' })).status, 201)
    const peerKey = newIdentity()
    const { long } = didPeer4FromDocument({ verificationMethod: [{ id: '#key-1', type: 'Multikey', publicKeyMultibase: ed25519Multikey(peerKey.publicKey) }], authentication: ['#key-1'] })
    const peer = { ...peerKey, did: long, verificationMethod: `${long}#key-1` }
    assert.equal((await send(peer, 'join', { name: 'Peer person' })).status, 201)
  })

  let delegation
  test('an agent acts only through a live delegation, within its scope', async () => {
    const asAgent = (name, payload) => send(agent, name, payload, { onBehalfOf: human.did, delegation })
    const exp = new Date(Date.now() + 86400000).toISOString()
    const d = await send(human, 'delegate', { delegate: agent.did, scope: ['note', 'vote'], label: 'test agent' }, { expiresAt: exp })
    assert.equal(d.status, 201); delegation = d.body.hash
    assert.equal((await asAgent('note', { text: 'agent here', kind: 'observation' })).status, 201)
    assert.equal((await asAgent('propose', { kind: 'other', title: 'x' })).body.payload.code, 'permissionDenied') // not in scope
    assert.equal((await asAgent('approve', { proposal: delegation })).body.payload.code, 'permissionDenied') // humans only
    assert.equal((await send(agent, 'note', { text: 'no delegation named', kind: 'idea' })).body.payload.code, 'permissionDenied')
    assert.equal((await send(human, 'delegate', { delegate: other.did, scope: ['note'] }, { expiresAt: exp })).body.payload.code, 'permissionDenied') // a person is not an agent
  })

  let issue, vetoed
  test('votes count once per person, and a person outweighs their agent', async () => {
    issue = (await send(human, 'propose', { kind: 'issue', title: 'Ask for a message Trust Task type', body: 'The write scenario is blocked on it.' })).body.hash
    await send(agent, 'vote', { proposal: issue, choice: 'against' }, { onBehalfOf: human.did, delegation })
    await send(human, 'vote', { proposal: issue, choice: 'for' })
    await send(agent, 'vote', { proposal: issue, choice: 'against' }, { onBehalfOf: human.did, delegation })
    await send(other, 'vote', { proposal: issue, choice: 'for' })
    const p = (await get('/api/state')).proposals.find((x) => x.hash === issue)
    assert.deepEqual(p.tally, { for: 2, against: 0, abstain: 0 })
  })

  test('approved proposals act after the veto window; vetoed ones never do', async () => {
    vetoed = (await send(other, 'propose', { kind: 'issue', title: 'Something contested' })).body.hash
    await send(other, 'approve', { proposal: vetoed })
    await send(human, 'veto', { target: vetoed, reason: 'not yet' })
    await send(other, 'approve', { proposal: issue })
    await ctx.executor.tick()
    const s = await get('/api/state')
    assert.equal(s.proposals.find((x) => x.hash === issue).status, 'done')
    assert.equal(s.proposals.find((x) => x.hash === vetoed).status, 'vetoed')
    assert.ok(ghCalls.some((c) => c.method === 'POST' && c.path === '/repos/Project-Weave-Tech/dtg-interop/issues'))
  })

  test('record-run opens a pull request that only appends one run', async () => {
    ghCalls = []
    const run = { subjects: [{ kind: 'credential', id: 'VRC' }], date: day(0), sides: [{ project: 'alpha', version: '1.1' }, { project: 'beta', version: '2.0' }], outcome: 'pass', note: 'Rerun before it faded.' }
    const p = (await send(human, 'propose', { kind: 'record-run', title: 'alpha × beta rerun', run })).body.hash
    assert.equal((await send(other, 'propose', { kind: 'record-run', title: 'not my run', run })).body.payload.code, 'permissionDenied') // no project
    await send(human, 'approve', { proposal: p })
    await ctx.executor.tick()
    const put = ghCalls.find((c) => c.method === 'PUT' && c.path.endsWith('/contents/runs.json'))
    const written = JSON.parse(Buffer.from(put.body.content, 'base64').toString())
    assert.deepEqual(written.runs.slice(0, -1), BOARD.runs)
    assert.deepEqual(written.runs.at(-1), run)
    assert.ok(ghCalls.every((c) => !(c.method === 'PUT' && !c.path.endsWith('runs.json') && !c.path.endsWith('/merge'))))
  })

  test('workspace changes merge only at the approved commit', async () => {
    ghCalls = []
    const good = (await send(human, 'propose', { kind: 'workspace-change', title: 'Improve the weaver', change: { pr: 7, sha: 'a'.repeat(40) } })).body.hash
    const moved = (await send(human, 'propose', { kind: 'workspace-change', title: 'Stale commit', change: { pr: 8, sha: 'c'.repeat(40) } })).body.hash
    await send(other, 'approve', { proposal: good }); await send(other, 'approve', { proposal: moved })
    await ctx.executor.tick()
    const s = await get('/api/state')
    assert.equal(s.proposals.find((x) => x.hash === good).status, 'done')
    assert.equal(s.proposals.find((x) => x.hash === moved).status, 'failed')
    const merge = ghCalls.find((c) => c.path.endsWith('/pulls/7/merge'))
    assert.equal(merge.body.sha, 'a'.repeat(40))
    assert.ok(ghCalls.some((c) => c.path === `/repos/Project-Weave-Tech/we-play-interop/statuses/${'a'.repeat(40)}`))
  })

  test('anyone can put a project on the map; only its people change it; runs are entered by a side', async () => {
    assert.equal((await send(human, 'project', { slug: 'meshnet', name: 'Meshnet', url: 'https://mesh.example', about: 'A community mesh network.', ways: ['oidc', 'eddsa-jcs-2022'] })).status, 201)
    assert.equal((await send(other, 'project', { slug: 'meshnet', name: 'Not Meshnet', ways: [] })).body.payload.code, 'permissionDenied')
    assert.equal((await send(other, 'project', { slug: 'alpha', name: 'Alpha?', ways: ['x'] })).body.payload.code, 'permissionDenied') // a board row
    assert.equal((await send(human, 'way', { id: 'oidc', name: 'OpenID Connect', kind: 'identity', url: 'https://openid.net/connect/' })).status, 201)
    assert.equal((await send(other, 'way', { id: 'oidc', name: 'something else', kind: 'other' })).body.payload.code, 'permissionDenied')
    assert.equal((await send(human, 'way', { id: 'credential:VRC', name: 'x', kind: 'credentials' })).body.payload.code, 'malformedRequest')
    const run = { sides: [{ project: 'alpha', version: '1.2' }, { project: 'meshnet', version: '0.3' }], ways: ['eddsa-jcs-2022'], date: day(0), outcome: 'pass', note: 'Each verified the other\'s signed document.' }
    assert.equal((await send(other, 'run', run)).body.payload.code, 'malformedRequest') // not a side, no sources
    assert.equal((await send(human, 'run', { ...run, sides: [run.sides[0], { project: 'nowhere', version: '1' }] })).body.payload.code, 'malformedRequest')
    assert.equal((await send(human, 'run', run)).status, 201)
    await ctx.board.snapshotIfChanged()
    const map = await get('/api/map')
    assert.ok(map.projects.some((p) => p.slug === 'meshnet' && p.sources.includes('workspace')))
    assert.ok(map.pairs.some((p) => p.pair.join('|') === 'alpha|meshnet'))
    assert.equal(map.score.passingPairs, 3)
    assert.equal(ctx.log.state.score.score.passingPairs, 3) // the snapshot recorded it
    assert.equal(map.ways.find((w) => w.id === 'oidc').name, 'OpenID Connect')
  })

  test('the weaver posts a round, model or not, and turns new directions into proposals', async () => {
    await send(human, 'note', { text: 'I want alpha and gamma to connect', kind: 'intention', pair: ['alpha', 'gamma'] })
    const round = await ctx.weaver.tick()
    assert.ok(round, 'a round was posted')
    const p = round.document.payload
    assert.equal(p.model.ok, false); assert.match(p.model.note, /LLM_API_KEY/)
    assert.ok(p.heard.length >= 1)
    // no goal is held: the room is asked, one goal is offered as a suggestion, nothing is assumed
    assert.equal(p.next[0].kind, 'ask')
    const offered = ctx.log.state.proposals.get(p.next.find((x) => x.kind === 'goal').proposal)
    assert.equal(offered.byWeaver, true); assert.equal(offered.kind, 'goal')
    assert.ok(!p.next.some((x) => x.kind === 'run'), 'no map suggestions before anyone holds a goal that watches the map')
    // with a model: unknown hashes are dropped, bad runs are dropped, a good run becomes a proposal
    ctx.weaver.llm = { configured: true, model: 'test/model', chat: async () => ({ model: 'test/model', latencyMs: 5, usage: { total_tokens: 10 }, finishReason: 'stop', jsonMode: true, content: JSON.stringify({ heard: [{ entry: 'f'.repeat(64), gist: 'ghost' }], threads: [], agreements: [], conflicts: [], next: [{ action: 'alpha and gamma try Connect', why: 'Both bring it.', kind: 'run', run: { sides: ['alpha', 'gamma'], ways: ['did:key'] }, holds: [] }, { action: 'a bad one', kind: 'run', run: { sides: ['alpha', 'nowhere'], ways: ['x'] } }] }) }) }
    await send(other, 'note', { text: 'agree, alpha and gamma', kind: 'observation' })
    const r2 = (await ctx.weaver.tick()).document.payload
    assert.equal(r2.model.ok, true); assert.equal(r2.heard.length, 0)
    assert.equal(r2.next[0].kind, 'ask') // still no goal held
    const made = ctx.log.state.proposals.get(r2.next.find((x) => x.kind === 'run').proposal)
    assert.equal(made.byWeaver, true); assert.deepEqual(made.run.sides, ['alpha', 'gamma'])
    assert.ok(!r2.next.some((x) => x.run?.sides?.includes('nowhere')))
  })

  test('the room decides what winning looks like', async () => {
    const goal = (await send(other, 'propose', { kind: 'goal', title: 'Every project here can verify every other one\'s signatures', measure: 'connected', direction: 'up' })).body.hash
    assert.equal((await send(other, 'propose', { kind: 'goal', title: 'x', measure: 'happiness' })).body.payload.code, 'malformedRequest')
    await send(other, 'vote', { proposal: goal, choice: 'for' })
    await send(human, 'vote', { proposal: goal, choice: 'for' })
    assert.deepEqual(ctx.log.state.goals().held.map((g) => g.hash), [goal])
    ctx.weaver.llm = { configured: false }
    await send(human, 'note', { text: 'ok, that is the goal', kind: 'observation' })
    const r = (await ctx.weaver.tick()).document.payload
    assert.ok(!r.next.some((x) => x.kind === 'ask'), 'a goal is held, so no need to ask')
    assert.ok(r.next.some((x) => x.kind === 'run'), 'the held goal watches the map, so the map can suggest')
  })

  test('revoking stops the agent', async () => {
    assert.equal((await send(human, 'revoke', { delegation })).status, 201)
    assert.equal((await send(agent, 'note', { text: 'still here?', kind: 'question' }, { onBehalfOf: human.did, delegation })).body.payload.code, 'permissionDenied')
  })

  test('a hosted agent joins by a connector link, talks, listens and replies', async () => {
    const rpc = async (url, method, params, id = 1) => {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) })
      return { status: r.status, body: await r.json() }
    }
    const call = async (url, name, args = {}) => (await rpc(url, 'tools/call', { name, arguments: args })).body.result
    const made = await send(human, 'host', { label: "Person A's Claude" })
    assert.equal(made.status, 201)
    const { did, connector } = made.body.hosted
    assert.match(connector, /\/mcp\/a\/[A-Za-z0-9_-]{40,}$/)
    assert.ok(ctx.log.state.hosted.has(did), 'the log says the workspace holds this key')
    const url = connector.replace(/^https?:\/\/[^/]+/, base)
    assert.equal((await rpc(url, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude', version: '0' } })).body.result.serverInfo.name, 'we-play-interop-room')
    const tools = (await rpc(url, 'tools/list', {}, 2)).body.result.tools.map((t) => t.name)
    for (const t of ['who_is_here', 'listen', 'say', 'propose', 'vote', 'add_project']) assert.ok(tools.includes(t), t)
    assert.match((await call(url, 'say', { text: 'hello?' })).content[0].text, /switched you on/) // no permission yet
    await send(human, 'delegate', { delegate: did, scope: ['note', 'propose', 'vote', 'project', 'way', 'run'], label: "Person A's Claude" }, { expiresAt: new Date(Date.now() + 86400000).toISOString() })
    const hello = JSON.parse((await call(url, 'say', { text: 'Hello room, I am here for Person A.' })).content[0].text)
    assert.equal(hello.accepted, true)
    const e = ctx.log.byHash.get(hello.id)
    assert.equal(e.author, did); assert.equal(e.onBehalfOf, human.did)
    const direct = JSON.parse((await call(url, 'say', { text: 'Person B, want to try did:key together?', to: 'Person B' })).content[0].text)
    assert.equal(ctx.log.byHash.get(direct.id).document.recipient, other.did)
    const answer = await send(other, 'note', { text: 'Yes, let us.', kind: 'message' }, { threadId: ctx.log.byHash.get(direct.id).document.id, recipient: did })
    const heard = JSON.parse((await call(url, 'listen', { since: hello.seq - 1 })).content[0].text)
    const reply = heard.items.find((i) => i.id === answer.body.hash)
    assert.equal(reply.replyTo, direct.id); assert.equal(reply.toDid, did)
    assert.ok(heard.items.find((i) => i.id === hello.id).mine)
    const here = JSON.parse((await call(url, 'who_is_here')).content[0].text)
    assert.ok(here.find((p) => p.did === did && p.hosted && p.you))
    assert.equal((await rpc(base + '/mcp/a/not-a-real-link', 'tools/list', {})).status, 404)
  })

  test('an agent can be woken: the room calls its wake link when something is for it', async () => {
    const made = await send(other, 'host', { label: "Person B's Claude" })
    const agent = made.body.hosted.did
    await send(other, 'delegate', { delegate: agent, scope: ['note', 'vote'], label: "Person B's Claude" }, { expiresAt: new Date(Date.now() + 86400000).toISOString() })
    const url = 'https://automation.example/hooks/secret-token-123'
    const urlHash = createHash('sha256').update(url).digest('hex')
    const setWake = async (id, payload, link) => { const r = await fetch(`${base}/api/wake`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ document: signedDocument(id, { type: TYPES.wake, payload }), url: link }) }); return { status: r.status, body: await r.json() } }
    assert.equal((await setWake(human, { agent, urlHash, on: ['direct'] }, url)).body.payload.code, 'permissionDenied') // not your agent
    assert.equal((await setWake(other, { agent, urlHash, on: ['direct'] }, url + 'x')).body.payload.code, 'malformedRequest') // link does not match what was signed
    const ok = await setWake(other, { agent, urlHash, on: ['direct', 'reply'] }, url)
    assert.equal(ok.status, 201)
    assert.ok(!JSON.stringify(ctx.log.entries).includes('secret-token-123'), 'the wake link is never in the log')
    wakeCalls.length = 0
    await send(human, 'note', { text: 'Your agent around? Want to compare notes?', kind: 'message' }, { recipient: agent })
    await send(human, 'note', { text: 'A second one, right after.', kind: 'message' }, { recipient: agent })
    await send(human, 'note', { text: 'Something for everyone.', kind: 'message' })
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(wakeCalls.length, 1, 'one wake a minute at most; the rest rides on the next one')
    assert.equal(wakeCalls[0].url, url); assert.deepEqual(wakeCalls[0].body.reasons, ['direct'])
    assert.equal((await get(`/api/participants/${encodeURIComponent(agent)}`)).wake.last.ok, true)
    const removed = await setWake(other, { agent, urlHash: null, on: [] }, null)
    assert.equal(removed.status, 201); assert.ok(!ctx.waker.hooks.has(agent))
  })

  test('anyone can verify the whole log, and tampering shows', async () => {
    const report = await get('/api/verify')
    assert.equal(report.ok, true, JSON.stringify(report.problems))
    assert.equal(report.signaturesNotChecked, 0)
    const entries = structuredClone(ctx.log.entries)
    entries[3].document.payload.name = 'Someone else'
    const bad = await verifyChain(entries, { keyFor: (d, v, p) => createResolver({ fetch: webvh.fetch }).keyFor(d, v, p) })
    assert.equal(bad.ok, false)
    assert.ok(bad.problems.some((x) => x.seq === 3))
  })

  test('the MCP endpoint lists and runs tools', async () => {
    const rpc = async (method, params, id = 1) => {
      const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) })
      return r.json()
    }
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
    assert.equal(init.result.serverInfo.name, 'we-play-interop')
    const tools = (await rpc('tools/list', {}, 2)).result.tools.map((t) => t.name)
    for (const t of ['overview', 'map', 'proposals', 'read_log', 'draft_document', 'submit_signed', 'verify_log']) assert.ok(tools.includes(t), t)
    const map = await rpc('tools/call', { name: 'map', arguments: {} }, 3)
    assert.match(map.result.content[0].text, /sharedWays/)
  })

  test('the log survives a restart, byte for byte', async () => {
    const before = ctx.log.entries.map((e) => e.hash)
    await ctx.stop()
    ctx = await createApp({ ...ctx.config }, { resolver: createResolver({ fetch: webvh.fetch }), gh })
    await new Promise((r) => ctx.server.listen(0, r))
    base = `http://localhost:${ctx.server.address().port}`
    assert.deepEqual(ctx.log.entries.map((e) => e.hash), before)
    assert.equal((await ctx.log.verify()).ok, true)
  })
})
