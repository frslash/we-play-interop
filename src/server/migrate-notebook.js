// P2.10: a person's OWN, opt-in move of their agent's private notebook into their own sealed room.
// Room code only; test members only (see src/shared/sealed.js). Three rules, each enforced here and tested:
//  1. Only the person moves their own notebook: a signed consent naming this agent, signed by that agent's person.
//  2. The old copy stays until the person confirms, in a second signed act, after the sealed copy has been read back and matched.
//  3. Keys are never exported: this module is handed `put` and `get` closures that seal and open on the person's side. It never
//     sees, returns or logs a key, a note or a plaintext; its result and its errors carry counts and plain reasons only.
// No route calls this yet: wiring it to a signed request is the next step, and is the person's own tap.
const CONSENT_MAX_AGE_MS = 10 * 60e3
const CHUNK_BYTES = 30 * 1024 // under the sealed note cap (src/shared/sealed.js MAX_NOTE_BYTES, 34 KiB)
export class MigrationRefused extends Error {}

const refuse = (m) => { throw new MigrationRefused(m) }
const bytes = (s) => new TextEncoder().encode(s).length

function checkConsent ({ kind, consent, agent, ownerOf, verifyConsent, now }) {
  if (!consent || consent.kind !== kind) refuse('no consent for this step')
  if (consent.agent !== agent) refuse('consent is for another notebook')
  if (!ownerOf(agent) || consent.person !== ownerOf(agent)) refuse('only the notebook\'s own person can do this')
  const at = Date.parse(consent.at)
  if (!(at <= now() && now() - at <= CONSENT_MAX_AGE_MS)) refuse('consent is stale')
  let ok = false; try { ok = verifyConsent(consent) === true } catch {}
  if (!ok) refuse('consent is not signed by the person')
}

/** Split the notes into sealed-sized records, on note boundaries. */
export function chunkNotes (notes) {
  const out = []; let cur = []; let size = 2
  for (const n of notes) {
    const s = bytes(JSON.stringify(n)) + 1
    if (s > CHUNK_BYTES) refuse('a note is too large to move')
    if (cur.length && size + s > CHUNK_BYTES) { out.push(cur); cur = []; size = 2 }
    cur.push(n); size += s
  }
  if (cur.length || !out.length) out.push(cur)
  return out
}
const recordIdFor = (i) => `nb-${i}`

/**
 * Copy the notebook into the person's sealed room and check it reads back the same. Changes nothing in the old store.
 * put(recordId, text): seal and write, on the person's side. get(recordId): read and open, on the person's side.
 * Returns { notes, records, verified: true } (counts only); throws MigrationRefused otherwise, naming no content.
 */
export async function copyNotebookToSealedRoom ({ notebooks, agent, consent, ownerOf, verifyConsent, put, get, now = () => Date.now() }) {
  checkConsent({ kind: 'migrate-notebook', consent, agent, ownerOf, verifyConsent, now })
  const notes = await notebooks.get(agent)
  const chunks = chunkNotes(notes)
  for (let i = 0; i < chunks.length; i++) await put(recordIdFor(i), JSON.stringify(chunks[i]))
  for (let i = 0; i < chunks.length; i++) {
    let back = null; try { back = JSON.parse(await get(recordIdFor(i))) } catch {}
    if (JSON.stringify(back) !== JSON.stringify(chunks[i])) refuse('the sealed copy did not read back the same; the old notebook is untouched')
  }
  return { notes: notes.length, records: chunks.length, verified: true }
}

/**
 * The person's second act: after the copy verified, and they confirmed, retire the old store's copy.
 * Re-checks the sealed copy right now (not trusting an earlier result) before deleting anything.
 */
export async function retireOldNotebook ({ notebooks, agent, consent, ownerOf, verifyConsent, get, copy, now = () => Date.now() }) {
  checkConsent({ kind: 'confirm-notebook-moved', consent, agent, ownerOf, verifyConsent, now })
  if (!copy?.verified) refuse('the copy has not been verified')
  const notes = await notebooks.get(agent)
  const chunks = chunkNotes(notes)
  if (chunks.length !== copy.records) refuse('the notebook changed since the copy; copy again first')
  for (let i = 0; i < chunks.length; i++) {
    let back = null; try { back = JSON.parse(await get(recordIdFor(i))) } catch {}
    if (JSON.stringify(back) !== JSON.stringify(chunks[i])) refuse('the sealed copy no longer matches; the old notebook is kept')
  }
  await notebooks.delete(agent)
  return { retired: true, notes: notes.length }
}
