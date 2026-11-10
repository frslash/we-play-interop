// The room's draft entry for the DTG interop board (docs/dtg-board/inwove): checked against the board's rules
// without the board's code. The lists below are copied from the board's schema/project.schema.json and
// credential-profiles.json / basics.json at board commit af997a1; the board's own validator is run by whoever commits
// the entry there. No network, no live file.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = path.join(root, 'docs/dtg-board/inwove')
const entry = JSON.parse(readFileSync(path.join(dir, 'project.json'), 'utf8'))
const readme = readFileSync(path.join(dir, 'README.md'), 'utf8')

// schema/project.schema.json, board commit af997a1
const TOP = ['slug', 'name', 'shortName', 'purpose', 'website', 'docs', 'logo', 'licence', 'repositories', 'apps', 'stack', 'requiredParty', 'basics', 'provenance', 'updated', 'facets', 'credentials', 'messaging', 'replication', 'trustTaskUse', 'ceremonies']
const REQUIRED = ['slug', 'name', 'repositories', 'stack', 'basics', 'provenance', 'updated']
const ENUM = {
  model: ['W3C VC 2.0', 'W3C VC 1.1', 'W3C VC (version not stated)', 'SD-JWT VC', 'ACDC', 'JLINC agreement', 'flat JSON (fpp-poc)'],
  proof: ['eddsa-jcs-2022', 'eddsa-rdfc-2022', 'ecdsa-jcs-2019', 'JWS EdDSA', 'KERI signatures'],
  status: ['runs', 'building', 'committed'],
  protocol: ['TSP 1.0', 'TSP (version not stated)', 'DIDComm v2', 'HTTPS', 'WebRTC', 'Reticulum', 'Nostr', 'BLE'],
  via: ['direct', 'mediator', 'app server', 'host', 'peers (DHT)', 'mesh', 'key-blind carrier'],
  replication: ['MLS', 'Perspective Diff Sync (Holochain)', 'RLTP replication', 'HTTPS', 'CRDT ledger', 'signed hash chain', 'event log', 'bundle replication'],
  basic: ['stated', 'runs', 'vectors', 'spec', 'open', 'n/a'],
  documentProof: ['Data Integrity eddsa-jcs-2022', 'pairwise MAC'],
  kind: ['registry', 'own']
}
// credential-profiles.json keys and basics.json ids, board commit af997a1
const PROFILES = ['VMC', 'VRC', 'VIC', 'VDC', 'VAC', 'VPC', 'VSC', 'VEC', 'VWC', 'VSC-vetted', 'VSC-presented', 'Personhood', 'EndorsementCredential', 'WitnessCredential', 'OpenBadgeCredential']
const BASICS = ['did-resolution', 'multi-device', 'same-carrier', 'cross-carrier', 'document-framework', 'error-answers', 'traditional-tools', 'shared-room', 'newcomer-history', 'captured-device', 'registry-lookup', 'trust-network']
const BLOB = 'https://github.com/frslash/we-play-interop/blob/main/'
const inEnum = (v, list, what) => assert.ok(list.includes(v), `${what}: "${v}" is not in the board's list`)
const evidenceOf = (o) => (o?.evidence ?? [])

test('required fields present, no key outside the schema, slug right', () => {
  for (const k of REQUIRED) assert.ok(k in entry, `missing ${k}`)
  for (const k of Object.keys(entry)) assert.ok(TOP.includes(k), `${k} is not a field the board allows`)
  assert.match(entry.slug, /^[a-z0-9][a-z0-9-]{1,40}$/)
  assert.equal(entry.slug, path.basename(dir))
  assert.ok(entry.purpose.length <= 160)
  assert.match(entry.provenance.date, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(entry.provenance.kind, 'project')
})

test('every closed value is in the board lists', () => {
  for (const c of entry.credentials) {
    inEnum(c.model, ENUM.model, 'credentials.model'); inEnum(c.status, ENUM.status, 'credentials.status')
    c.proof.forEach((p) => inEnum(p, ENUM.proof, 'credentials.proof')); c.profiles.forEach((p) => inEnum(p, PROFILES, 'profile'))
  }
  for (const m of entry.messaging) { inEnum(m.protocol, ENUM.protocol, 'messaging.protocol'); inEnum(m.via, ENUM.via, 'messaging.via'); inEnum(m.status, ENUM.status, 'messaging.status') }
  for (const r of entry.replication) { inEnum(r.protocol, ENUM.replication, 'replication.protocol'); inEnum(r.via, ENUM.via, 'replication.via'); inEnum(r.status, ENUM.status, 'replication.status') }
  const t = entry.trustTaskUse
  inEnum(t.status, [...ENUM.status, 'none'], 'trustTaskUse.status')
  t.documentProof.forEach((p) => inEnum(p, ENUM.documentProof, 'documentProof')); t.namespaces.forEach((n) => inEnum(n.kind, ENUM.kind, 'namespace kind'))
  for (const [id, b] of Object.entries(entry.basics)) { inEnum(id, BASICS, 'basic id'); inEnum(b.status, ENUM.basic, 'basic status'); assert.ok(b.note && b.note.length <= 400) }
})

test('every runs, stated and vectors has evidence, and every evidence path exists in this tree', () => {
  const needs = []
  for (const [id, b] of Object.entries(entry.basics)) if (['runs', 'stated', 'vectors'].includes(b.status)) needs.push([`basics.${id}`, b])
  for (const k of ['credentials', 'messaging', 'replication']) entry[k].forEach((x, i) => { if (x.status === 'runs') needs.push([`${k}[${i}]`, x]) })
  if (entry.trustTaskUse.status === 'runs') needs.push(['trustTaskUse', entry.trustTaskUse])
  for (const [where, o] of needs) assert.ok(evidenceOf(o).length, `${where} needs evidence`)
  const all = [...Object.values(entry.basics), ...entry.credentials, ...entry.messaging, ...entry.replication, entry.trustTaskUse].flatMap(evidenceOf)
  assert.ok(all.length)
  for (const e of all) {
    assert.ok(e.label && e.url)
    if (e.url.startsWith(BLOB)) assert.ok(existsSync(path.join(root, e.url.slice(BLOB.length))), `${e.url} is not in this tree`)
  }
})

test('licence is the repository LICENSE', () => {
  assert.equal(entry.licence, 'MIT')
  assert.match(readFileSync(path.join(root, 'LICENSE'), 'utf8'), /^MIT License/)
})

test('no personal names or handles', () => {
  assert.ok(!/@[A-Za-z0-9_-]+/.test(readme), 'no @ handles in the README')
  assert.ok(!/^\s*People:/m.test(readme), 'no "People:" line')
  assert.ok(!/@[A-Za-z0-9_-]+/.test(JSON.stringify(entry)))
})
