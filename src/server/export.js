// Export and import of the room's public record (item P0.5 of the data-room plan).
// The export is the signed hash chain, byte for byte as the room holds it, wrapped in a small versioned
// envelope. It carries only what the public log already shows: the log, and so the cards, proposals and
// votes that are folded from it. It carries NO private tables (agents' notebooks, drafts, wake links,
// never-say fingerprints, hosted keys): those are the person's, and moving them is a separate, reviewed step.
// Hard gate: an import is accepted only if the chain verifies and its head equals the one the export claims.
import { verifyChain } from '../shared/chain.js'
import { insertEntry, loadEntries } from './db.js'

export const EXPORT_FORMAT = 'we-play-interop-export'
export const EXPORT_VERSION = 1

/** Wrap entries (all of them, in order) in the versioned envelope. */
export function makeExport (entries, { now = new Date() } = {}) {
  const head = entries.length ? { seq: entries.at(-1).seq, hash: entries.at(-1).hash } : null
  return { format: EXPORT_FORMAT, version: EXPORT_VERSION, exportedAt: now.toISOString(), workspace: entries[0]?.author ?? null, count: entries.length, head, includes: ['log'], entries }
}

/** Check an export without touching anything: shape, claimed head, then the whole chain. */
export async function checkExport (doc, { keyFor } = {}) {
  const fail = (problem) => ({ ok: false, problem })
  if (doc?.format !== EXPORT_FORMAT) return fail('not a We Play Interop export')
  if (doc.version !== EXPORT_VERSION) return fail(`export version ${doc.version} is not one this code reads (it reads ${EXPORT_VERSION})`)
  if (!Array.isArray(doc.entries) || !doc.entries.length) return fail('the export has no entries')
  if (doc.count !== doc.entries.length) return fail('count does not match the entries')
  const report = await verifyChain(doc.entries, keyFor ? { keyFor } : undefined)
  if (!report.ok) return { ok: false, problem: 'the chain does not verify', report }
  // The gate's pass test: a signature that could not be checked (a DID method nobody resolved) is a fail, never a pass.
  if (report.signaturesNotChecked > 0) return { ok: false, problem: `${report.signaturesNotChecked} signature(s) could not be checked (is every author's DID method resolvable?)`, report }
  if (report.head?.hash !== doc.head?.hash || report.head?.seq !== doc.head?.seq) return { ok: false, problem: 'the chain head is not the one the export claims', report }
  return { ok: true, report }
}

/** Import into an EMPTY database. Refuses a non-empty one, and anything that does not verify; then reads it back and compares heads. */
export async function importExport (db, doc, { keyFor } = {}) {
  if ((await loadEntries(db)).length) throw new Error('refusing to import: this database already has a log')
  const checked = await checkExport(doc, { keyFor })
  if (!checked.ok) throw Object.assign(new Error(`refusing to import: ${checked.problem}`), { report: checked.report })
  for (const e of doc.entries) await insertEntry(db, e)
  const back = await loadEntries(db), head = back.at(-1)
  if (back.length !== doc.count || head.hash !== doc.head.hash) throw new Error('import did not reproduce the chain head; nothing should move until it does')
  return { entries: back.length, head: { seq: head.seq, hash: head.hash }, signaturesNotChecked: checked.report.signaturesNotChecked }
}
