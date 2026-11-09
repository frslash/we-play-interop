// The three DTG context addresses in use (src/server/community.js, docs/dtg-contexts.md): the room reads all three,
// says which one a credential carried, counts them in /api/info, and writes only the registry one. Nothing here talks
// to another service: the community is the local stand-in (test/support/standin-community.js).
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, test } from 'node:test'
import { config as baseConfig } from '../src/server/config.js'
import { createApp } from '../src/server/index.js'
import { PASS_CHECK_TYPE } from '../src/shared/dtg.js'
import { newIdentity } from '../src/shared/did.js'
import { sign } from '../src/shared/proof.js'
import { signedTask } from '../src/shared/trusttask.js'
import { standInCommunity } from './support/standin-community.js'

const REGISTRY = 'https://registry.trustoverip.org/dtg/context/v1'
const FIRSTPERSON = 'https://firstperson.network/credentials/dtg/v1'
const TRUSTOVERIP = 'https://trustoverip.org/dtg/credentials/v1'
const OLDER = 'This credential uses an older DTG context address; OpenVTC communities refuse it.'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cards = JSON.parse(readFileSync(join(root, 'test/fixtures/rltp/encounter-cards.json'), 'utf8')) // RLTP's: `credential` carries the registry address, `credential025` the firstperson.network one

const settings = (dir, extra) => ({ ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, publicUrl: '', checkEveryMinutes: 0, boardDataUrl: 'data:application/json,{}', llm: { ...baseConfig.llm, apiKey: '' }, ...extra })

describe('the room reads, names and counts the three addresses', () => {
  let c, ctx, base, dir, room
  const member = newIdentity(new Uint8Array(32).fill(31))
  const show = async (membership) => {
    const res = await fetch(`${base}/api/community/pass`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signedTask(member, { type: PASS_CHECK_TYPE, recipient: room, payload: { membership } })) })
    return (await res.json()).payload
  }
  const withContext = (address) => ({ change: (v) => ({ ...v, '@context': [v['@context'][0], address, ...v['@context'].slice(2)] }) }) // before it is signed: the community signs over the address it names
  before(async () => {
    c = await standInCommunity()
    dir = mkdtempSync(join(tmpdir(), 'wpi-dtgctx-'))
    ctx = await createApp(settings(dir, { communityDid: c.did }), { hostWelcomeMs: null, resolver: c.resolver, communityFetch: c.fetch })
    await new Promise((r) => ctx.server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${ctx.server.address().port}`
    ctx.community.lists.ttlMs = 0; ctx.community.lists.failTtlMs = 0
    room = ctx.join.did
  })
  after(async () => { await ctx.stop(); await c.close(); rmSync(dir, { recursive: true, force: true }) })

  test('each address is named, only the registry one is current, the others carry the sentence, and none is refused for that alone', async () => {
    const reg = await show(c.issueVmc(member.did).credential)
    assert.equal(reg.member, true); assert.deepEqual(reg.context, { name: 'registry-v1', current: true })
    const first = await show(c.issueVmc(member.did, withContext(FIRSTPERSON)).credential)
    assert.equal(first.member, true, 'the room still takes it'); assert.deepEqual(first.context, { name: 'firstperson-wd01', current: false, note: OLDER })
    const trust = await show(c.issueVmc(member.did, withContext(TRUSTOVERIP)).credential)
    assert.equal(trust.member, true); assert.deepEqual(trust.context, { name: 'trustoverip-v1', current: false, note: OLDER })
    // a "no" for another reason still says which address it saw: RLTP's two encounter credentials (test/fixtures/rltp/encounter-cards.json)
    const a = await show(cards.credential), b = await show(cards.credential025)
    assert.equal(a.problem, 'kind'); assert.deepEqual(a.context, { name: 'registry-v1', current: true })
    assert.equal(b.problem, 'kind'); assert.deepEqual(b.context, { name: 'firstperson-wd01', current: false, note: OLDER })
    // the third, built here: a TrustStackers-style credential (their context) from a did:key issuer the test makes
    const other = newIdentity(new Uint8Array(32).fill(32))
    const ts = sign({ '@context': ['https://www.w3.org/ns/credentials/v2', TRUSTOVERIP, 'https://w3id.org/security/data-integrity/v1'], type: ['VerifiableCredential', 'DTGCredential', 'MembershipCredential'], issuer: other.did, validFrom: '2026-11-09T00:00:00Z', credentialSubject: { id: member.did } }, { seed: other.seed, verificationMethod: other.verificationMethod, created: '2026-11-09T00:00:00Z', proofPurpose: 'assertionMethod' })
    const t = await show(ts)
    assert.equal(t.problem, 'issuer'); assert.deepEqual(t.context, { name: 'trustoverip-v1', current: false, note: OLDER })
    // an address nobody here writes is "unknown", is a shape problem, and gets no "older" sentence
    const odd = await show(c.issueVmc(member.did, withContext('https://openvtc.org/contexts/dtg-membership-v1.jsonld')).credential)
    assert.equal(odd.problem, 'shape'); assert.equal(odd.context, undefined)
  })

  test('/api/info counts every credential by address and the distinct issuers behind verified ones, and holds no DID', async () => {
    const info = (await (await fetch(`${base}/api/info`)).json()).community
    assert.deepEqual(info.credentials.contexts, { 'registry-v1': 2, 'firstperson-wd01': 2, 'trustoverip-v1': 2, unknown: 1 })
    assert.deepEqual(info.credentials.issuers, { 'registry-v1': 1, 'firstperson-wd01': 1, 'trustoverip-v1': 1 }, 'the community is the one verified issuer under each name; the fixtures\' unverified issuers are not counted')
    assert.ok(!JSON.stringify(info.credentials).includes('did:'))
    assert.equal(ctx.community.issuerSets['registry-v1'].has(c.did), true, 'only in memory')
  })
})

test('nothing the room or the agent bridge writes uses an older address', () => {
  // every place the two older addresses appear, outside the reader (src/shared/dtg.js), tests and fixtures, docs and the README
  let out = ''
  try { out = execFileSync('git', ['grep', '-nE', 'firstperson\\.network/credentials|trustoverip\\.org/dtg/credentials', '--', 'src', 'agent', 'public', ':!src/shared/dtg.js'], { cwd: root, encoding: 'utf8' }) } catch (e) { if (e.status !== 1) throw e } // status 1: no match
  assert.equal(out, '', `an older DTG context address is written outside the reader:\n${out}`)
})
