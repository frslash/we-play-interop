// How the keeper applies an agent's diff to a clean copy of the code. Agents often write diffs by hand, and a
// hand-written diff's hunk headers (@@ -a,b +c,d @@) are easy to miscount, so the counts are recounted from
// each hunk's own lines (--recount). Everything else stays strict: the lines around each change must still
// match the code exactly, or the change is refused with git's reason.
import { spawnSync } from 'node:child_process'

export const APPLY_ARGS = ['apply', '--recount', '--whitespace=nowarn']

/** Apply the diff at `diff` inside `cwd`: { ok: true } or { ok: false, why } with git's own words. */
export function applyDiff (cwd, diff) {
  for (const extra of [['--check'], []]) {
    const r = spawnSync('git', [...APPLY_ARGS, ...extra, diff], { cwd, encoding: 'utf8' })
    if (r.status !== 0) return { ok: false, why: (r.stderr || r.error?.message || 'git apply failed').trim() }
  }
  return { ok: true }
}
