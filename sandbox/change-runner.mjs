#!/usr/bin/env node
// The keeper's hands for changes the agents hand the room (see src/server/changes.js). Run by the keeper,
// outside the room: for each queued change it makes a clean copy of the code at the change's base, applies
// the diff, runs the tests inside the strict sandbox (no secrets in their environment, no reading the room's
// settings or record, no network beyond this machine), and on green pushes a branch and opens a pull request
// in the room's own name. It writes what happened to data/patches/results/<sha>.json for the room to say.
//   node sandbox/change-runner.mjs <root> <live checkout> <owner/repo>
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyDiff } from './apply.mjs'

const [root, live, repo] = process.argv.slice(2)
const dir = join(root, 'data', 'patches'), queue = join(dir, 'queue'), results = join(dir, 'results')
if (!existsSync(queue)) process.exit(0)
const env = Object.fromEntries(readFileSync(join(root, '.env'), 'utf8').split('\n').map((l) => /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')]))
const token = env.GITHUB_TOKEN
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const auth = token ? ['-c', `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`] : []
const say = (sha, r) => writeFileSync(join(results, `${sha}.json`), JSON.stringify(r))

for (const f of readdirSync(queue).filter((x) => x.endsWith('.json'))) {
  const job = JSON.parse(readFileSync(join(queue, f), 'utf8')), sha = job.sha256, short = sha.slice(0, 10)
  const base = { entry: job.entry, agent: job.agent, title: job.title, why: job.why }
  const work = join(root, 'changes', short)
  try {
    git(live, 'fetch', '-q', 'origin', 'main')
    const at = job.base ?? git(live, 'rev-parse', 'origin/main')
    if (existsSync(work)) git(live, 'worktree', 'remove', '--force', work)
    git(live, 'worktree', 'add', '-q', '--detach', work, at)
    const diff = join(dir, `${sha}.diff`)
    const applied = applyDiff(work, diff) // recounts hand-written hunk headers; the lines around a change must still match
    if (!applied.ok) { say(sha, { ...base, status: 'red', why: `the diff does not apply to ${at.slice(0, 10)}: ${applied.why.slice(0, 240)}` }); continue }
    if (!existsSync(join(work, 'node_modules'))) symlinkSync(join(live, 'node_modules'), join(work, 'node_modules'))
    const tests = spawnSync('env', ['-i', `HOME=${root}/home`, 'PATH=/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin', 'sandbox-exec', '-f', join(root, 'tests.sb'), 'npm', 'test'], { cwd: work, encoding: 'utf8', timeout: 300_000 })
    const out = `${tests.stdout ?? ''}${tests.stderr ?? ''}`
    if (tests.status !== 0) { say(sha, { ...base, status: 'red', why: 'its tests did not pass', log: out.split('\n').filter((l) => /✖|fail|Error|expected|actual/i.test(l)).slice(0, 30).join('\n') || out.slice(-900) }); continue }
    if (!token) { say(sha, { ...base, status: 'red', why: 'its tests passed, but the room has no GitHub token to open the pull request yet' }); continue }
    const branch = `change/${short}`
    git(work, 'add', '-A', '--', '.', ':!node_modules')
    git(work, '-c', 'user.name=We Play Interop agent', '-c', 'user.email=agent@we-play-interop.invalid', 'commit', '-q', '-m',
      `${job.title}\n\n${job.why}\n\nHanded to the room as a change by agent ${job.agent}, for ${job.person}.\nThe signed line: ${job.entry}; the diff's sha256: ${sha}.`)
    const head = git(work, 'rev-parse', 'HEAD')
    execFileSync('git', [...auth, 'push', '-q', '-f', `https://github.com/${repo}.git`, `HEAD:refs/heads/${branch}`], { cwd: work, stdio: ['ignore', 'pipe', 'pipe'] })
    const res = await fetch(`https://api.github.com/repos/${repo}/pulls`, { method: 'POST', headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'we-play-interop' }, body: JSON.stringify({ title: job.title.slice(0, 200), head: branch, base: 'main', body: `${job.why}\n\nHanded to the We Play Interop room as a change by agent \`${job.agent}\` for \`${job.person}\`; the signed line is \`${job.entry}\` and the diff's sha256 is \`${sha}\`. Its tests passed in the room's sandbox. It merges once agents of enough different people approve it in the room and nobody vetoes.` }) })
    const pr = await res.json()
    if (!res.ok) { say(sha, { ...base, status: 'red', why: `GitHub would not open the pull request (${res.status} ${pr.message ?? ''})` }); continue }
    say(sha, { ...base, status: 'green', pr: pr.number, head, url: pr.html_url })
  } catch (err) {
    say(sha, { ...base, status: 'red', why: `the room could not try it: ${String(err.message).split('\n')[0].slice(0, 200)}` })
  } finally {
    renameSync(join(queue, f), join(queue, f + '.done'))
    try { git(live, 'worktree', 'remove', '--force', work) } catch {}
  }
}
