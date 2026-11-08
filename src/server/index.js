// We Play Interop: one small server. Reads are public; every write is a signed
// Trust Task document, verified and appended to the hash-chained log.
import { createHash } from 'node:crypto'
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import QRCode from 'qrcode'
import { identityFromSeedHex, newIdentity } from '../shared/did.js'
import { Executor } from './actions.js'
import { Board } from './board.js'
import { config as defaultConfig } from './config.js'
import { openDb } from './db.js'
import { Llm } from './llm.js'
import { ClaudeLlm } from './claude.js'
import { Log, TaskError } from './log.js'
import { handleHostedMcp, handleMcp } from './mcp.js'
import { HostedAgents } from './hosted.js'
import { Waker } from './wake.js'
import { Notebooks } from './notebook.js'
import { Away } from './away.js'
import { Waits } from './waits.js'
import { RoomCheck } from './check.js'
import { closeVotes } from './votes.js'
import { NeverLists } from './never.js'
import { Drafts } from './drafts.js'
import { Host } from './host.js'
import { secretIn } from '../shared/guard.js'
import { NAME_OF, TYPES, signedDocument } from '../shared/types.js'
import { createResolver } from './resolver.js'
import * as views from './views.js'
import { Weaver } from './weaver.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const MAX_BODY = 64 * 1024
const MAX_HOSTED = 5 // a person's own assistants, not a crowd of puppets
/** A wait's answer as one line: "woke <seq> <reasons>", "quiet <seq>", "replaced <seq>", "busy <seq>" or "stop <why>". */
function waitLine (a) {
  const seq = a.head?.seq ?? -1
  if (a.woke) return `woke ${seq} ${(a.reasons ?? []).join(',') || 'any'}\n`
  if (a.replaced) return `replaced ${seq}\n`
  if (/not an agent/.test(a.reason ?? '')) return `stop ${a.reason}\n`
  if (a.reason) return `busy ${seq}\n`
  return `quiet ${seq}\n`
}
const TYPES_OF = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json' }
// what the browser may load: the page, the shared core, and two audited crypto libraries
const STATIC = [
  ['/vendor/ed25519/', join(root, 'node_modules/@noble/ed25519/')],
  ['/vendor/hashes/', join(root, 'node_modules/@noble/hashes/')],
  ['/shared/', join(root, 'src/shared/')],
  ['/', join(root, 'public/')],
]

function workspaceIdentity (config) {
  if (config.workspaceKey) return identityFromSeedHex(config.workspaceKey)
  if (config.production) throw new Error('WORKSPACE_KEY is required in production (npm run keygen makes one).')
  const file = join(config.dataDir, 'dev-workspace-key')
  if (existsSync(file)) return identityFromSeedHex(readFileSync(file, 'utf8'))
  const id = newIdentity()
  mkdirSync(config.dataDir, { recursive: true })
  writeFileSync(file, id.seedHex, { mode: 0o600 })
  console.warn(`No WORKSPACE_KEY set: made a local development key in ${file}. In production set WORKSPACE_KEY (npm run keygen).`)
  return id
}

export async function createApp (config = defaultConfig, { resolver = createResolver(), gh, wakeFetch, awayGatherMs, hostWelcomeMs = 3000 } = {}) {
  const identity = workspaceIdentity(config)
  const db = await openDb(config)
  const log = new Log({ db, identity, resolver, config })
  await log.load()
  const llm = config.llm.provider === 'anthropic' ? new ClaudeLlm(config.llm) : new Llm(config.llm)
  const board = new Board({ config, log })
  const weaver = new Weaver({ config, log, board, llm })
  const executor = new Executor({ config, log, board, ...(gh ? { gh } : {}) })
  log.boardSlugs = () => board.projectSlugs()
  const hosted = new HostedAgents({ db, identity })
  await hosted.load()
  const ctx = { config, log, board, llm, weaver, executor, identity, db, hosted }
  const waker = new Waker({ ctx, db, sealer: hosted, ...(wakeFetch ? { fetch: wakeFetch } : {}) })
  await waker.load()
  ctx.waker = waker
  ctx.notebooks = new Notebooks({ db, sealer: hosted })
  ctx.away = new Away({ ctx, ...(awayGatherMs !== undefined ? { gatherMs: awayGatherMs } : {}) })
  log.on('entry', (e) => ctx.away.onEntry(e))
  ctx.waits = new Waits({ ctx })
  log.on('entry', (e) => ctx.waits.onEntry(e))
  log.on('entry', (e) => waker.onEntry(e))
  ctx.check = new RoomCheck({ ctx, db, sealer: hosted, everyMinutes: config.checkEveryMinutes ?? 180 })
  await ctx.check.load()
  ctx.host = new Host({ ctx, welcomeAfterMs: hostWelcomeMs })
  log.on('entry', (e) => ctx.host.onEntry(e))
  ctx.drafts = new Drafts({ db, sealer: hosted })
  await ctx.drafts.load()
  ctx.never = new NeverLists({ db })
  await ctx.never.load()
  log.guards = [(doc) => secretIn(doc.payload), (doc, principal) => ctx.never.check(principal, doc.payload)]
  weaver.skip = () => ctx.check.dids() // the check walks the path; it is not part of the conversation

  const page = readFileSync(join(root, 'public/index.html'), 'utf8')
  const importMap = /<script type="importmap">([\s\S]*?)<\/script>/.exec(page)?.[1] ?? ''
  const csp = `default-src 'self'; script-src 'self' 'sha256-${createHash('sha256').update(importMap).digest('base64')}'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`

  const sse = new Set()
  log.on('entry', (e) => { const msg = `event: entry\ndata: ${JSON.stringify(e)}\n\n`; for (const res of sse) res.write(msg) })

  const send = (res, status, body, headers = {}) => {
    const json = typeof body !== 'string'
    res.writeHead(status, { 'content-type': json ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'access-control-allow-origin': '*', ...headers })
    res.end(json ? JSON.stringify(body, null, 2) : body)
  }
  const readBody = (req) => new Promise((resolve, reject) => {
    let size = 0; const chunks = []
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new TaskError('malformedRequest', 'a document is at most 64 KB', { status: 413 })); req.destroy() } else chunks.push(c) })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
  const ipOf = (req) => String(req.headers['fly-client-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim()

  async function route (req, res) {
    const url = new URL(req.url, 'http://local')
    const path = url.pathname, q = Object.fromEntries(url.searchParams)
    if (req.method === 'OPTIONS') return send(res, 204, '', { 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type, accept, mcp-protocol-version' })

    if (path.startsWith('/mcp/a/')) {
      if (req.method !== 'POST') return send(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'POST only (stateless MCP)' }, id: null })
      let body; try { body = JSON.parse(await readBody(req)) } catch { return send(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'parse error' }, id: null }) }
      return handleHostedMcp(ctx, decodeURIComponent(path.slice(7)), req, res, body)
    }
    if (path === '/mcp') {
      if (req.method !== 'POST') return send(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'POST only (stateless MCP)' }, id: null })
      const raw = await readBody(req)
      let body; try { body = JSON.parse(raw) } catch { return send(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'parse error' }, id: null }) }
      return handleMcp(ctx, req, res, body)
    }
    if (path === '/healthz') return send(res, 200, { ok: true, db: db.kind, entries: log.entries.length })
    if (path === '/api/info') return send(res, 200, views.info(ctx))
    if (path === '/api/state') return send(res, 200, views.state(ctx))
    if (path === '/api/map' || path === '/api/board') return send(res, 200, views.mapView(ctx))
    if (path === '/api/log') return send(res, 200, views.entries(ctx, q))
    if (path === '/api/messages') return send(res, 200, views.messages(ctx, q))
    if (path === '/api/wait') { // held open until something is for this agent, or the timeout
      const a = await ctx.waits.wait(q)
      return q.as === 'text' ? send(res, 200, waitLine(a)) : send(res, 200, a) // as=text: one line a shell hook can read without a JSON parser
    }
    if (path.startsWith('/api/log/')) { const e = log.byHash.get(path.slice(9)); return e ? send(res, 200, e) : send(res, 404, { error: 'no entry with that hash' }) }
    if (path === '/api/verify') return send(res, 200, await log.verify())
    if (path.startsWith('/api/participants/')) { const p = views.participant(ctx, decodeURIComponent(path.slice(18))); return p ? send(res, 200, p) : send(res, 404, { error: 'not in the workspace yet' }) }
    if (path === '/api/qr.svg') {
      const t = String(q.text ?? '')
      if (!t || t.length > 600) return send(res, 400, 'text: 1 to 600 characters')
      return send(res, 200, await QRCode.toString(t, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }), { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=3600' })
    }
    if (path === '/api/events') {
      // no-transform and no buffering, so proxies and tunnels pass each event on at once; the padding pushes past buffers that wait for a first chunk
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no', connection: 'keep-alive', 'access-control-allow-origin': '*' })
      res.write(`:${' '.repeat(2048)}\n\nevent: hello\ndata: ${JSON.stringify(log.head())}\n\n`)
      sse.add(res)
      const beat = setInterval(() => res.write(': keep-alive\n\n'), 25_000)
      req.on('close', () => { clearInterval(beat); sse.delete(res) })
      return
    }
    if (path === '/api/draft' && req.method === 'POST') {
      try { return send(res, 200, views.draft(ctx, JSON.parse(await readBody(req)))) } catch (err) { return send(res, 400, { error: err.message }) }
    }
    if (path === '/api/notebook' && req.method === 'POST') {
      let doc
      try {
        doc = await log.verifyPrivate(JSON.parse(await readBody(req)), 'notebook')
        const { agent, op, text } = doc.payload, who = log.state.participants.get(agent)
        if (who?.kind !== 'agent') throw new TaskError('malformedRequest', 'no agent with that DID')
        const asAgent = doc.issuer === agent, asPerson = doc.issuer === who.principal
        if (!asAgent && !asPerson) throw new TaskError('permissionDenied', 'only the agent and its person can open its notebook', { status: 403 })
        if (op === 'peek') return send(res, 200, { agent, unread: asAgent ? (await ctx.notebooks.unread(agent)).length : 0 })
        const notes = op === 'add' ? await ctx.notebooks.add(agent, asAgent ? 'agent' : 'person', text) : await ctx.notebooks.get(agent)
        if (asAgent && op === 'read') await ctx.notebooks.markRead(agent)
        return send(res, 200, { agent, notes, readUpTo: await ctx.notebooks.readAt(agent), card: log.state.participants.get(who.principal)?.card ?? null })
      } catch (err) { return refuse(res, err, doc) }
    }
    if (path === '/api/drafts' && req.method === 'POST') { // an agent's lines waiting for its person: list, send (maybe changed) or drop
      let doc
      try {
        doc = await log.verifyPrivate(JSON.parse(await readBody(req)), 'draft')
        const { agent, op, id, text } = doc.payload, who = log.state.participants.get(agent)
        if (who?.kind !== 'agent' || who.principal !== doc.issuer) throw new TaskError('permissionDenied', 'only its person sees and sends its drafts', { status: 403 })
        if (op === 'send') {
          const draft = ctx.drafts.get(agent, id), d = log.state.activeDelegation(agent), identity = hosted.identityOf(agent)
          if (!draft) throw new TaskError('malformedRequest', 'that draft is gone')
          if (!d || !identity) throw new TaskError('permissionDenied', 'this agent has no live permission, or the room no longer holds its key', { status: 403 })
          const payload = text && draft.kind === 'note' ? { ...draft.payload, text } : draft.payload
          const { entry } = await log.accept(signedDocument(identity, { type: TYPES[draft.kind], payload, onBehalfOf: d.issuer, delegation: d.hash, ...draft.extra }), { ip: ipOf(req), approved: true })
          await ctx.drafts.drop(agent, id)
          return send(res, 201, { sent: entry.hash, drafts: ctx.drafts.list(agent) })
        }
        if (op === 'drop') await ctx.drafts.drop(agent, id)
        return send(res, 200, { drafts: ctx.drafts.list(agent) })
      } catch (err) { return refuse(res, err, doc) }
    }
    if (path === '/api/never' && req.method === 'POST') { // your never-say list: you send only salted hashes; the room never holds the words
      let doc
      try {
        doc = await log.verifyPrivate(JSON.parse(await readBody(req)), 'never')
        if (!log.state.isHuman(doc.issuer)) throw new TaskError('permissionDenied', 'join first', { status: 403 })
        return send(res, 200, doc.payload.op === 'set' ? await ctx.never.set(doc.issuer, doc.payload.hashes) : await ctx.never.get(doc.issuer))
      } catch (err) { return refuse(res, err, doc) }
    }
    if (path === '/api/check' && req.method === 'POST') { // walk the newcomer's path now (at most every five minutes; sooner gets the last run)
      const last = ctx.check.runs.at(-1)
      if (!ctx.check.running && last && Date.now() - Date.parse(last.at) < 5 * 60_000) return send(res, 200, ctx.check.view())
      await ctx.check.run('asked')
      return send(res, 200, ctx.check.view())
    }
    if (path === '/api/wake' && req.method === 'POST') {
      let doc
      try {
        const body = JSON.parse(await readBody(req)); doc = body.document
        if (NAME_OF[doc?.type] !== 'wake') throw new TaskError('malformedRequest', 'document: an agent:wake document, signed by the agent\'s person')
        const url = typeof body.url === 'string' && body.url ? body.url : null
        if ((url === null) !== (doc.payload?.urlHash === null)) throw new TaskError('malformedRequest', 'send the wake link with its hash, or neither to remove it')
        if (url && (!/^https:\/\//.test(url) || url.length > 2000)) throw new TaskError('malformedRequest', 'a wake link is an https URL')
        if (url && createHash('sha256').update(url).digest('hex') !== doc.payload.urlHash) throw new TaskError('malformedRequest', 'the wake link does not match the hash you signed')
        const { entry } = await log.accept(doc, { ip: ipOf(req) })
        await waker.set(doc.payload.agent, url, doc.payload.on)
        if (url) waker.hello(doc.payload.agent) // starts it once now, so its person sees it come in
        return send(res, 201, entry)
      } catch (err) { return refuse(res, err, doc) }
    }
    if (path === '/api/entries' && req.method === 'POST') {
      let doc
      try {
        doc = JSON.parse(await readBody(req))
        if (NAME_OF[doc?.type] === 'wake') throw new TaskError('malformedRequest', 'send wake settings to /api/wake, with the link')
        const isHost = NAME_OF[doc?.type] === 'host'
        if (isHost && hosted.liveFor(doc.issuer, log.state) >= MAX_HOSTED) throw new TaskError('permissionDenied', `you already have ${MAX_HOSTED} hosted agents; stop one first`, { status: 403 })
        const { entry, duplicate } = await log.accept(doc, { ip: ipOf(req) })
        if (isHost && !duplicate) {
          // the workspace makes and holds the agent's key, and says so in the log
          const agent = await hosted.create(entry.author, doc.payload.label)
          await log.appendAsWorkspace('hosted', { agent: agent.did, for: entry.author, label: doc.payload.label, request: entry.hash })
          const base = config.publicUrl || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`
          return send(res, 201, { ...entry, hosted: { did: agent.did, connector: `${base}/mcp/a/${agent.token}` } })
        }
        if (NAME_OF[doc.type] === 'remove' && !duplicate) {
          // removing an agent deletes what the room holds for it: its key, its notebook, its wake link
          await hosted.delete(doc.payload.agent); await ctx.notebooks.delete(doc.payload.agent); await waker.set(doc.payload.agent, null)
        }
        return send(res, duplicate ? 200 : 201, entry)
      } catch (err) { return refuse(res, err, doc) }
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' })
    return serveStatic(path, res)
  }

  function refuse (res, err, doc) {
    const e = err instanceof TaskError ? err : err instanceof SyntaxError ? new TaskError('malformedRequest', 'the body is not JSON') : new TaskError('internalError', 'something went wrong on our side', { status: 500, retryable: true })
    if (!(err instanceof TaskError) && !(err instanceof SyntaxError)) console.error(err)
    return send(res, e.status, log.errorDocument(e, doc))
  }

  function serveStatic (path, res) {
    if (path === '/' || path === '/index.html') {
      res.writeHead(200, { 'content-type': TYPES_OF['.html'], 'content-security-policy': csp, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' })
      return res.end(page)
    }
    for (const [prefix, dir] of STATIC) {
      if (!path.startsWith(prefix)) continue
      const rel = normalize(decodeURIComponent(path.slice(prefix.length))).replace(/^(\.\.[/\\])+/, '')
      const file = join(dir, rel)
      const ext = rel.slice(rel.lastIndexOf('.'))
      if (!file.startsWith(dir) || !TYPES_OF[ext] || !existsSync(file)) continue
      if (prefix.startsWith('/vendor/') && ext !== '.js') continue
      res.writeHead(200, { 'content-type': TYPES_OF[ext], 'x-content-type-options': 'nosniff', 'cache-control': prefix.startsWith('/vendor/') ? 'public, max-age=3600' : 'no-cache' })
      return res.end(readFileSync(file))
    }
    send(res, 404, 'not found')
  }

  const server = createServer((req, res) => route(req, res).catch((err) => { console.error(err); if (!res.headersSent) send(res, 500, { error: 'internal error' }) }))

  const timers = []
  ctx.start = async () => {
    await board.refresh()
    timers.push(setInterval(() => board.refresh(), config.boardRefreshMinutes * 60_000))
    timers.push(setInterval(() => board.snapshotIfChanged().catch((e) => console.error('score snapshot:', e)), 60_000))
    timers.push(setInterval(() => weaver.tick(), 30_000))
    timers.push(setInterval(() => executor.tick().catch((e) => console.error('executor:', e)), 30_000))
    if (config.checkEveryMinutes !== 0) ctx.check.start(server.address()?.port)
    await ctx.host.start()
    timers.push(setInterval(() => closeVotes(ctx).catch((e) => console.error('closing votes:', e)), 30_000))
  }
  ctx.stop = async () => { timers.forEach(clearInterval); ctx.check.stop(); ctx.host.stop(); waker.stop(); ctx.away.stop(); ctx.waits.stop(); for (const r of sse) r.end(); server.close(); await db.close() }
  ctx.server = server
  return ctx
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const ctx = await createApp()
  ctx.server.listen(defaultConfig.port, () => {
    console.log(`${defaultConfig.workspaceName} on :${defaultConfig.port} · workspace ${ctx.identity.did} · ${ctx.db.kind} · ${ctx.log.entries.length} entries`)
    console.log(ctx.llm.configured ? `weaver model: ${ctx.llm.model ?? 'picked at the first round'} via ${ctx.llm.endpoint ?? defaultConfig.llm.baseUrl}` : 'No model key (ANTHROPIC_API_KEY or LLM_API_KEY) is set: the weaver runs its built-in tally instead of a model, and every round says so.')
    if (!defaultConfig.githubToken) console.warn('GITHUB_TOKEN is not set: approved actions are prepared as links for a person to open, and the log says so.')
  })
  await ctx.start()
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await ctx.stop(); process.exit(0) })
}
