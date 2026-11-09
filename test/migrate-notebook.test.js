// P2.10, on test members only: the person's own opt-in move of a notebook into their sealed room.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { present, issueCredential, newRoomKey, newRoomPersona, openNote, sealNote } from '../src/shared/sealed.js'
import { SealedHost } from '../src/server/sealed-host.js'
import { toHex } from '../src/shared/crypto.js'
import { MigrationRefused, chunkNotes, copyNotebookToSealedRoom, retireOldNotebook } from '../src/server/migrate-notebook.js'

const HOUR = 3600e3
function setup (notes) {
  const t = Date.parse('2026-11-09T12:00:00Z'); const now = () => t
  const host = new SealedHost({ now }); const room = newIdentity(); host.createRoom(room.did)
  const person = newRoomPersona(); const other = newRoomPersona(); const key = newRoomKey()
  const cred = issueCredential(room, { subject: person.did, role: 'member', scopes: ['notes:read', 'notes:write'], notBefore: new Date(t), ttlMs: 24 * HOUR })
  const call = (op, args) => host.call(present(person, cred, { room: room.did, nonce: host.challenge(), op, host: host.host, args }), args)
  const put = async (id, text) => call('write', { recordId: id, epoch: 0, sealed: await sealNote(key, { room: room.did, recordId: id, epoch: 0 }, text) })
  const get = async (id) => { const r = call('read', { recordId: id }); return openNote(key, { room: room.did, recordId: id, epoch: r.epoch }, r.sealed) }
  let store = notes
  const notebooks = { get: async () => store, delete: async () => { store = null }, alive: () => store !== null }
  const mk = (kind, over = {}) => ({ kind, agent: 'agent-1', person: person.did, at: new Date(t).toISOString(), ...over })
  const base = { notebooks, agent: 'agent-1', ownerOf: (a) => (a === 'agent-1' ? person.did : null), verifyConsent: () => true, put, get, now }
  return { host, base, notebooks, mk, person, other, put, get, key }
}
const refused = (fn, re) => assert.rejects(async () => fn(), (e) => e instanceof MigrationRefused && (!re || re.test(e.message)))
const NOTES = [{ at: '2026-11-01T00:00:00Z', from: 'person', text: 'one' }, { at: '2026-11-02T00:00:00Z', from: 'agent', text: 'two' }]

describe('P2.10 opt-in notebook move (test members only)', () => {
  test('copy: sealed on the host, read back the same, old copy stays', async () => {
    const MARK = 'MARK-' + toHex(crypto.getRandomValues(new Uint8Array(6)))
    const s = setup([...NOTES, { at: '2026-11-03T00:00:00Z', from: 'person', text: MARK }])
    const r = await copyNotebookToSealedRoom({ ...s.base, consent: s.mk('migrate-notebook') })
    assert.deepEqual(r, { notes: 3, records: 1, verified: true })
    assert.ok(s.notebooks.alive(), 'old copy stays until the person confirms')
    assert.ok(!s.host.dumpAll().includes(MARK), 'the host holds ciphertext only')
    assert.ok(!JSON.stringify(r).includes(MARK))
  })

  test('nobody moves another person\'s notebook: wrong person, wrong agent, no consent, stale, unsigned', async () => {
    const s = setup(NOTES)
    await refused(() => copyNotebookToSealedRoom({ ...s.base, consent: s.mk('migrate-notebook', { person: s.other.did }) }), /own person/)
    await refused(() => copyNotebookToSealedRoom({ ...s.base, consent: s.mk('migrate-notebook', { agent: 'agent-2' }) }), /another notebook/)
    await refused(() => copyNotebookToSealedRoom({ ...s.base, consent: undefined }), /no consent/)
    await refused(() => copyNotebookToSealedRoom({ ...s.base, consent: s.mk('confirm-notebook-moved') }), /no consent/)
    await refused(() => copyNotebookToSealedRoom({ ...s.base, consent: s.mk('migrate-notebook', { at: '2026-11-09T11:00:00Z' }) }), /stale/)
    await refused(() => copyNotebookToSealedRoom({ ...s.base, verifyConsent: () => false, consent: s.mk('migrate-notebook') }), /not signed/)
    await refused(() => copyNotebookToSealedRoom({ ...s.base, ownerOf: () => null, consent: s.mk('migrate-notebook') }), /own person/)
    assert.equal(s.host.events.filter((e) => e.op === 'write').length, 0, 'nothing was written')
  })

  test('a copy that does not read back the same refuses, and leaves the old notebook', async () => {
    const s = setup(NOTES)
    await refused(() => copyNotebookToSealedRoom({ ...s.base, get: async () => '[]', consent: s.mk('migrate-notebook') }), /did not read back/)
    assert.ok(s.notebooks.alive())
  })

  test('retire: needs the second signed act and a verified copy; then, and only then, the old copy goes', async () => {
    const s = setup(NOTES)
    const copy = await copyNotebookToSealedRoom({ ...s.base, consent: s.mk('migrate-notebook') })
    await refused(() => retireOldNotebook({ ...s.base, copy, consent: s.mk('migrate-notebook') }), /no consent/) // the first act is not the second
    await refused(() => retireOldNotebook({ ...s.base, copy: { ...copy, verified: false }, consent: s.mk('confirm-notebook-moved') }), /not been verified/)
    assert.ok(s.notebooks.alive())
    await refused(() => retireOldNotebook({ ...s.base, copy, get: async () => '[]', consent: s.mk('confirm-notebook-moved') }), /no longer matches/)
    assert.ok(s.notebooks.alive())
    assert.deepEqual(await retireOldNotebook({ ...s.base, copy, consent: s.mk('confirm-notebook-moved') }), { retired: true, notes: 2 })
    assert.equal(s.notebooks.alive(), false)
  })

  test('keys are never exported: a planted key canary is in no result and no error', async () => {
    const s = setup(NOTES); const canary = toHex(s.key)
    const out = []
    out.push(JSON.stringify(await copyNotebookToSealedRoom({ ...s.base, consent: s.mk('migrate-notebook') })))
    try { await copyNotebookToSealedRoom({ ...s.base, get: async () => '[]', consent: s.mk('migrate-notebook') }) } catch (e) { out.push(e.message) }
    assert.ok(!out.join('|').includes(canary)); assert.ok(!s.host.dumpAll().includes(canary))
  })

  test('big notebooks split into sealed-sized records and still read back', async () => {
    const big = Array.from({ length: 40 }, (_, i) => ({ at: `2026-11-01T00:${String(i).padStart(2, '0')}:00Z`, from: 'person', text: 'x'.repeat(1900) }))
    assert.ok(chunkNotes(big).length > 1)
    const s = setup(big)
    const r = await copyNotebookToSealedRoom({ ...s.base, consent: s.mk('migrate-notebook') })
    assert.equal(r.records, chunkNotes(big).length); assert.equal(r.notes, 40)
  })
})
