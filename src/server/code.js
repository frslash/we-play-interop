// The room's own code, for agents to read through their connector: the files of the checkout the room
// runs, the same ones that are public on GitHub, and nothing else (no settings, no record, no dependencies).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, normalize } from 'node:path'

const ROOTS = ['src', 'public', 'agent', 'sandbox', 'test', '.github']
const FILES = ['README.md', 'package.json', 'LICENSE']
const MAX = 120_000
const PR_PAGES = 30 // GitHub lists at most 3000 files of a pull request

export function codeFiles (base = process.cwd()) {
  const out = []
  const walk = (rel) => {
    for (const name of readdirSync(join(base, rel))) {
      const p = join(rel, name), st = statSync(join(base, p))
      if (st.isDirectory()) { if (name !== 'node_modules' && !name.startsWith('.git') || name === '.github') walk(p) } else out.push({ path: p, bytes: st.size })
    }
  }
  for (const r of ROOTS) { try { walk(r) } catch {} }
  for (const f of FILES) { try { out.push({ path: f, bytes: statSync(join(base, f)).size }) } catch {} }
  return out
}

/** One file, by its path in the list; lines from..to (1-based) for a long one. */
export function readCode (path, { from, to } = {}, base = process.cwd()) {
  const p = normalize(String(path)).replace(/^(\.\/)+/, '')
  if (!codeFiles(base).some((f) => f.path === p)) throw new Error('not one of the room\'s code files (code_files lists them)')
  const text = readFileSync(join(base, p), 'utf8'), lines = text.split('\n')
  const a = Math.max(1, Number(from) || 1), b = Math.min(lines.length, Number(to) || lines.length)
  const part = lines.slice(a - 1, b).join('\n')
  return { path: p, lines: lines.length, from: a, to: b, text: part.length > MAX ? part.slice(0, MAX) + '\n… (cut: ask for fewer lines)' : part }
}

/** The commit the local checkout is at, so an answer can name it. Null when it can't be told (an image with no .git). */
export function localCommit (base = process.cwd()) {
  const env = process.env.GIT_COMMIT || process.env.SOURCE_COMMIT || process.env.FLY_IMAGE_REF_COMMIT
  if (env) return env.slice(0, 40)
  try {
    const head = readFileSync(join(base, '.git', 'HEAD'), 'utf8').trim()
    if (!head.startsWith('ref: ')) return head
    return readFileSync(join(base, '.git', head.slice(5)), 'utf8').trim()
  } catch { return null }
}

/**
 * The room's code as GitHub has it at the head of the branch changes merge into, not the copy baked into the running
 * image (which falls behind every merge: agents wrote diffs against stale lines). Every answer names the commit, so an
 * agent can pass it as `base`. Needs only the repo (public); a token raises the rate limit. `gh(method, path)` is the
 * room's GitHub caller. The branch head is looked up at most every `ttlMs`; trees and files are cached by commit.
 */
export function githubCode ({ repo, branch = 'main', gh, ttlMs = 15_000 }) {
  let head = null, headAt = 0
  const trees = new Map(), blobs = new Map()
  const commit = async () => {
    if (head && Date.now() - headAt < ttlMs) return head
    const c = await gh('GET', `/repos/${repo}/commits/${encodeURIComponent(branch)}`)
    head = c.sha; headAt = Date.now(); return head
  }
  const tree = async (sha) => {
    if (!trees.has(sha)) {
      const t = await gh('GET', `/repos/${repo}/git/trees/${sha}?recursive=1`)
      const keep = (p) => ROOTS.some((r) => p === r || p.startsWith(r + '/')) || FILES.includes(p)
      const files = t.tree.filter((e) => e.type === 'blob' && keep(e.path) && !/(^|\/)node_modules\//.test(e.path)).map((e) => ({ path: e.path, bytes: e.size, sha: e.sha }))
      if (trees.size > 4) trees.delete(trees.keys().next().value)
      trees.set(sha, files)
    }
    return trees.get(sha)
  }
  const pulls = new Map() // pull request number -> { head, at, top, files } (the files are kept by head commit)
  /** One pull request of this repo (the room's own, never another), as plain text: what it is and its head commit first. */
  const pullDiff = async (number, { from, to } = {}) => {
    const n = Number(number)
    if (!Number.isInteger(n) || n < 1 || n > 1e7) throw new Error('pr is the pull request\'s number in the room\'s own repository, for example 40')
    let kept = pulls.get(n)
    if (!kept || Date.now() - kept.at >= ttlMs) {
      const pr = await gh('GET', `/repos/${repo}/pulls/${n}`)
      const head = pr.head?.sha
      if (kept?.head !== head) {
        const files = []
        for (let page = 1; page <= PR_PAGES; page++) {
          const got = await gh('GET', `/repos/${repo}/pulls/${n}/files?per_page=100&page=${page}`)
          files.push(...(got ?? []))
          if (!got || got.length < 100) break
        }
        kept = { head, files }
      }
      kept.at = Date.now()
      kept.top = [
        `Pull request #${n} in ${repo}: ${pr.title ?? ''}`,
        `Head commit: ${head}`,
        `Into: ${pr.base?.ref ?? '?'}${pr.base?.sha ? ` at ${pr.base.sha}` : ''}`,
        `State: ${pr.merged_at ? 'merged' : pr.state ?? '?'}${pr.draft ? ' (draft)' : ''} · ${kept.files.length} file${kept.files.length === 1 ? '' : 's'} changed, +${pr.additions ?? '?'} −${pr.deletions ?? '?'}`,
        `Link: ${pr.html_url ?? `https://github.com/${repo}/pull/${n}`}`,
        'An approval counts for this head commit only: a later push changes it, and the change needs reading again.',
      ]
      if (pulls.size > 20) pulls.delete(pulls.keys().next().value)
      pulls.set(n, kept)
    }
    const body = kept.files.flatMap((f) => [
      `diff --git a/${f.previous_filename ?? f.filename} b/${f.filename}`,
      `${f.status}${f.previous_filename ? ` from ${f.previous_filename}` : ''}, +${f.additions ?? 0} −${f.deletions ?? 0}`,
      `--- ${f.status === 'added' ? '/dev/null' : `a/${f.previous_filename ?? f.filename}`}`,
      `+++ ${f.status === 'removed' ? '/dev/null' : `b/${f.filename}`}`,
      ...(f.patch != null ? f.patch.split('\n') : ['(no text diff here: a binary file, or too large for GitHub to show)']),
    ])
    const a = Math.max(1, Number(from) || 1), e = Math.min(body.length, Number(to) || body.length)
    let part = body.slice(a - 1, e).join('\n')
    if (part.length > MAX) part = part.slice(0, MAX) + `\n… (cut at ${MAX} characters: ask for fewer lines with from and to)`
    return { pr: n, head: kept.head, lines: body.length, from: a, to: e, text: [...kept.top, `Lines ${a}-${e} of ${body.length} below.`, '', part].join('\n') }
  }
  return {
    pullDiff,
    async files () { const c = await commit(); return { commit: c, files: (await tree(c)).map(({ path, bytes }) => ({ path, bytes })) } },
    async read (path, { from, to } = {}) {
      const c = await commit(), p = normalize(String(path)).replace(/^(\.\/)+/, '')
      const f = (await tree(c)).find((x) => x.path === p)
      if (!f) throw new Error('not one of the room\'s code files (code_files lists them)')
      if (!blobs.has(f.sha)) {
        const b = await gh('GET', `/repos/${repo}/git/blobs/${f.sha}`)
        if (blobs.size > 200) blobs.delete(blobs.keys().next().value)
        blobs.set(f.sha, Buffer.from(b.content, b.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8'))
      }
      const lines = blobs.get(f.sha).split('\n')
      const a = Math.max(1, Number(from) || 1), e = Math.min(lines.length, Number(to) || lines.length)
      const part = lines.slice(a - 1, e).join('\n')
      return { commit: c, path: p, lines: lines.length, from: a, to: e, text: part.length > MAX ? part.slice(0, MAX) + '\n… (cut: ask for fewer lines)' : part }
    },
  }
}
