// The room's own code, for agents to read through their connector: the files of the checkout the room
// runs, the same ones that are public on GitHub, and nothing else (no settings, no record, no dependencies).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, normalize } from 'node:path'

const ROOTS = ['src', 'public', 'agent', 'sandbox', 'test', '.github']
const FILES = ['README.md', 'package.json', 'LICENSE']
const MAX = 120_000

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
