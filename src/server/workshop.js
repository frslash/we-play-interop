// The workshop: every change to the room's own code, in public. What the room runs right now, what landed on
// its branch (who, why, when), the pull requests open, and each change an agent handed the room, with its
// tests, approvals and holds. Read from GitHub every two minutes (with the room's token when it has one)
// and from the room's own record; nothing here is private.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NAME_OF } from '../shared/types.js'

const EVERY_MS = 120_000

export class Workshop {
  constructor ({ ctx, gh }) { this.ctx = ctx; this.gh = gh; this.cache = { commits: [], pulls: [], at: null, error: null }; this.timer = null }

  start () { this.refresh(); this.timer = setInterval(() => this.refresh(), EVERY_MS); this.timer.unref?.() }
  stop () { clearInterval(this.timer) }

  /** The commit this room is running: the checkout it was started from. */
  running () {
    try {
      const head = readFileSync(join(process.cwd(), '.git', 'HEAD'), 'utf8').trim()
      if (/^[0-9a-f]{40}$/.test(head)) return head
      const ref = head.replace(/^ref: /, ''), f = join(process.cwd(), '.git', ref)
      if (existsSync(f)) return readFileSync(f, 'utf8').trim()
      const packed = readFileSync(join(process.cwd(), '.git', 'packed-refs'), 'utf8').split('\n').find((l) => l.endsWith(' ' + ref))
      return packed?.split(' ')[0] ?? null
    } catch { return null }
  }

  async refresh () {
    const repo = this.ctx.config.workspaceRepo, branch = this.ctx.config.workspaceBranch || 'main'
    try {
      const [commits, pulls] = await Promise.all([
        this.gh('GET', `/repos/${repo}/commits?sha=${branch}&per_page=25`),
        this.gh('GET', `/repos/${repo}/pulls?state=all&per_page=15&sort=updated&direction=desc`),
      ])
      this.cache = {
        at: new Date().toISOString(), error: null,
        commits: commits.map((c) => ({ sha: c.sha, title: c.commit.message.split('\n')[0].slice(0, 200), why: c.commit.message.split('\n').slice(1).join('\n').trim().slice(0, 1200), by: c.commit.author?.name ?? '', at: c.commit.author?.date ?? null, url: c.html_url })),
        pulls: pulls.map((p) => ({ number: p.number, title: p.title.slice(0, 200), state: p.merged_at ? 'merged' : p.state, branch: p.head?.ref ?? '', at: p.updated_at, url: p.html_url })),
      }
    } catch (err) { this.cache = { ...this.cache, error: String(err.message).slice(0, 200) } }
  }

  view () {
    const st = this.ctx.log.state, changes = []
    for (const e of this.ctx.log.entries) {
      if (NAME_OF[e.type] !== 'change') continue
      const p = e.document.payload
      const pr = [...st.proposals.values()].find((x) => x.byWeaver && x.sources?.includes(e.hash))
      const told = this.ctx.log.entries.find((x) => x.author === st.workspace && NAME_OF[x.type] === 'note' && x.document.threadId === e.document.id && /was not opened/.test(x.document.payload.text))
      changes.push({
        entry: e.hash, at: e.timestamp, title: p.title, why: p.why ?? '', sha256: p.sha256, by: st.nameOf(e.author), for: st.nameOf(e.onBehalfOf),
        stage: pr ? (pr.outcome === 'merged' ? 'merged' : st.statusOf(pr)) : told ? 'not opened' : 'being tested',
        detail: pr ? (pr.notYet ?? this.ctx.executor?.waitingFor(pr) ?? null) : told ? told.document.payload.text.split('\n')[0].slice(0, 300) : null,
        pr: pr?.change?.pr ?? null, approvals: pr ? [...pr.approvals.keys()].map((d) => st.nameOf(d)) : [],
      })
    }
    return { repo: this.ctx.config.workspaceRepo, branch: this.ctx.config.workspaceBranch || 'main', running: this.running(), ...this.cache, changes: changes.reverse().slice(0, 30) }
  }
}
