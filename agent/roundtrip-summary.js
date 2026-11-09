#!/usr/bin/env node
// The log-roundtrip job's last step: read import-log.js's JSON result and say its four values
// (ok, entries, head seq and hash, unchecked signatures) in two places:
//   - the job summary ($GITHUB_STEP_SUMMARY), as before;
//   - a notice annotation (a "::notice" line on stdout). Annotations are public on a public
//     repository: anyone can read them without signing in, through
//     GET /repos/{owner}/{repo}/check-runs/{id}/annotations. They need no write permission,
//     so the workflow stays read-only.
// Exits 1 unless ok is true and no signature went unchecked.
//   node agent/roundtrip-summary.js import.json
import { appendFileSync, readFileSync } from 'node:fs'

export function summaryLine(r) {
  return `ok=${r?.ok} entries=${r?.entries} head.seq=${r?.head?.seq} head.hash=${r?.head?.hash} signaturesNotChecked=${r?.signaturesNotChecked}`
}

export function noticeLine(r) {
  return `ok=${r?.ok} entries=${r?.entries} head=${r?.head?.seq}:${r?.head?.hash} unchecked=${r?.signaturesNotChecked}`
}

// Workflow commands need %, CR and LF escaped in the message, and also : and , in properties.
export const escapeData = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
export const escapeProperty = (s) => escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C')
export const notice = (title, message) => `::notice title=${escapeProperty(title)}::${escapeData(message)}`

export const passed = (r) => r?.ok === true && r?.signaturesNotChecked === 0

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2]
  if (!file) { console.error('usage: node agent/roundtrip-summary.js <import.json>'); process.exit(2) }
  let r
  try { r = JSON.parse(readFileSync(file, 'utf8')) } catch (err) { r = { ok: false, reason: err.message } }
  const line = summaryLine(r)
  console.log(line)
  console.log(notice('log-roundtrip', noticeLine(r)))
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, line + '\n')
  if (!passed(r)) process.exitCode = 1
}
