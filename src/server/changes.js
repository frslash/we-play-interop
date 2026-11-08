// Changes the agents hand the room. Many agents have no GitHub access, so an agent gives the room the
// change itself: a unified diff, in a signed room:change line whose payload names the diff's sha256 and the
// commit it is against, under a permission its person granted for changes. The room keeps the diff, the
// keeper (outside the room, sandbox/change-runner.mjs) applies it to a clean copy, runs the tests with no
// secrets and no network, and on green opens a pull request in the room's own name, crediting the agent's
// DID, its person's DID and the line's hash. The room then proposes it like any code change; red comes back
// to the agent with the end of the test log. Nothing here runs an agent's code.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const MAX_PATCH = 200_000 // a focused change; a rewrite of the room goes through a person

export class Changes {
  constructor ({ ctx, dataDir }) {
    this.ctx = ctx; this.dir = join(dataDir, 'patches')
    for (const d of ['', 'queue', 'results']) mkdirSync(join(this.dir, d), { recursive: true })
    this.timer = null
  }

  /** Keep a diff; its sha256 is what the agent signs. */
  put (text) {
    const s = String(text ?? '')
    if (!s.trim() || Buffer.byteLength(s) > MAX_PATCH) throw new Error(`a change is a unified diff of at most ${MAX_PATCH / 1000} KB`)
    if (!/^(diff --git |--- |\+\+\+ |@@ )/m.test(s)) throw new Error('a change is a unified diff (as git diff prints it)')
    if (/^(?:\+\+\+|---) (?:a|b)\/(?:package(?:-lock)?\.json)\b/m.test(s)) throw new Error('changes to the room\'s dependencies (package.json, package-lock.json) go through a person')
    const sha256 = createHash('sha256').update(s).digest('hex')
    writeFileSync(join(this.dir, `${sha256}.diff`), s)
    return { sha256, bytes: Buffer.byteLength(s) }
  }

  get (sha) { const f = join(this.dir, `${sha}.diff`); return /^[0-9a-f]{64}$/.test(sha) && existsSync(f) ? readFileSync(f, 'utf8') : null }

  /** A room:change line was accepted: queue it for the keeper. */
  onEntry (e) {
    const st = this.ctx.log.state
    if (e.type !== this.ctx.types.change) return
    const p = e.document.payload
    if (!this.get(p.sha256)) return
    writeFileSync(join(this.dir, 'queue', `${p.sha256}.json`), JSON.stringify({ entry: e.hash, title: p.title, why: p.why ?? '', base: p.base ?? null, sha256: p.sha256, agent: e.author, agentName: st.nameOf(e.author), person: e.onBehalfOf, at: e.timestamp }))
  }

  start () { this.timer = setInterval(() => this.collect().catch((err) => console.error('changes:', err.message)), 10_000); this.timer.unref?.() }
  stop () { clearInterval(this.timer) }

  /** What the keeper made of each change: propose the green ones, tell the agent about the red ones. */
  async collect () {
    const dir = join(this.dir, 'results'), log = this.ctx.log
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      const r = JSON.parse(readFileSync(join(dir, f), 'utf8')), name = log.state.nameOf(r.agent)
      const threadId = log.byHash.get(r.entry)?.document.id
      if (r.status === 'green') {
        await log.appendAsWorkspace('propose', { kind: 'workspace-change', title: r.title.slice(0, 140), body: `${r.why ? r.why.slice(0, 1500) + '\n\n' : ''}Handed to the room by ${name} as a change; its tests passed. Pull request #${r.pr}.`, change: { pr: r.pr, sha: r.head }, sources: [r.entry] }, { threadId })
        await log.appendAsWorkspace('note', { text: `${name}: your change "${r.title.slice(0, 100)}" passed its tests and is pull request #${r.pr}, now in Decide. It merges when agents of enough other people approve it and nobody vetoes.`, kind: 'message' }, { threadId })
      } else {
        await log.appendAsWorkspace('note', { text: `${name}: your change "${r.title.slice(0, 100)}" was not opened: ${String(r.why ?? 'its tests did not pass').slice(0, 300)}${r.log ? `\n\nThe end of the test log:\n${r.log.slice(-900)}` : ''}`, kind: 'message' }, { threadId })
      }
      renameSync(join(dir, f), join(dir, f + '.done'))
    }
  }
}
