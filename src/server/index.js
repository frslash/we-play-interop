// InWove: one small server. Reads are public; every write is a signed
// Trust Task document, verified and appended to the hash-chained log.
import { handleRoomDid, ensureRoomDid, growRoomDid, roomDidDiffers } from './roomdid.js'
import { RoomDidWatch } from './room-did-watch.js'
import { Door, serveRoomTasks } from './door.js'
import { Community } from './community.js'
import { servePass } from './pass.js'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
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
import { codeOf, handleHostedMcp, handleHostedPlain, handleMcp } from './mcp.js'
import { HostedAgents } from './hosted.js'
import { Waker } from './wake.js'
import { NotNamed } from './named.js'
import { Notebooks } from './notebook.js'
import { Away } from './away.js'
import { Waits } from './waits.js'
import { RoomCheck } from './check.js'
import { closeVotes } from './votes.js'
import { NeverLists } from './never.js'
import { Drafts } from './drafts.js'
import { forYou } from './foryou.js'
import { Host } from './host.js'
import { Media } from './media.js'
import { Changes, MAX_PATCH } from './changes.js'
import { Workshop } from './workshop.js'
import { Sources } from './sources.js'
import { Shelf, namedRepos } from './shelf.js'
import { RESOURCES as CURATED_RESOURCES } from '../../public/resources.js'
import { Cursors } from './cursors.js'
import { AGREED } from './rules.js'
import { ActivityPub } from './activitypub.js'
import { SignIn, registerSignIn } from './signin.js'
import { callerOf } from './caller.js'
import { secretIn } from '../shared/guard.js'
import { NAME_OF, TYPES, signedDocument } from '../shared/types.js'
import { MAX_DOCUMENT_BYTES } from '../shared/trusttask.js'
import { createResolver } from './resolver.js'
import * as views from './views.js'
import { Weaver } from './weaver.js'
import { Facilitator } from './facilitator.js'
import { Builder } from './builder.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const MAX_BODY = 64 * 1024
const MAX_HOSTED = 5 // a person's own assistants, not a crowd of puppets
const DOOR_PATHS = new Set(['/trust-tasks', '/v1/trust-tasks']) // the Trust Task door; some clients put /v1 after a bare origin, and both are the one door
const DOOR_READ_MAX = 1024 * 1024 // a body past the door's 64 KiB is refused whatever its size: counting stops here, so the refusal can go out while a huge upload is still arriving
/** A wait's answer as one line: "woke <seq> <reasons>", "quiet <seq>", "replaced <seq>", "busy <seq>" or "stop <why>". */
function waitLine (a) {
  const seq = a.head?.seq ?? -1
  if (a.woke) return `woke ${seq} ${(a.reasons ?? []).join(',') || 'any'}\n`
  if (a.replaced) return `replaced ${seq}\n`
  if (a.restarting) return `busy ${seq} restarting\n`
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

/**
 * A fingerprint of everything the browser loads (the page's files, the shared core, the vendored libraries): it changes
 * exactly when one of those files changes. Each release's files are served under /r/<fingerprint>/ and may be cached
 * for good, because a new release has a new address; the page itself is always re-checked. Before this, Cloudflare kept
 * the page's code in browsers for 4 hours whatever the room said, so a deploy looked missing until a hard refresh.
 */
export function releaseOf (dirs, base = root) {
  const h = createHash('sha256')
  const walk = (d) => {
    for (const n of readdirSync(d).sort()) {
      const f = join(d, n), s = statSync(f)
      if (s.isDirectory()) walk(f)
      else if (TYPES_OF[n.slice(n.lastIndexOf('.'))]) h.update(f.slice(base.length)).update('\0').update(readFileSync(f)).update('\0')
    }
  }
  for (const d of dirs) if (existsSync(d)) walk(d)
  return h.digest('hex').slice(0, 12)
}

/** The page, pointed at one release: its code, its style and every module it imports load from /r/<release>/. */
export function versioned (html, release, modules) {
  const r = `/r/${release}`
  return html
    .replace(/<script type="importmap">([\s\S]*?)<\/script>/, (_, json) => {
      const map = JSON.parse(json)
      const imports = Object.fromEntries(Object.entries(map.imports ?? {}).map(([k, v]) => [k, v.startsWith('/') ? r + v : v]))
      imports['/shared/'] = `${r}/shared/`
      for (const n of modules) imports[`/${n}`] = `${r}/${n}` // the page's own modules, imported by absolute path
      return `<script type="importmap">${JSON.stringify({ ...map, imports })}</script>`
    })
    .replace('<script type="module" src="/app.js">', `<script type="module" src="${r}/app.js">`)
    .replace('<link rel="stylesheet" href="/style.css">', `<link rel="stylesheet" href="${r}/style.css">`)
}

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

export async function createApp (config = defaultConfig, { resolver = createResolver(), gh, wakeFetch, apFetch, communityFetch, awayGatherMs, hostWelcomeMs = 3000, sources, shelf } = {}) {
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
  ctx.media = new Media({ dataDir: config.dataDir })
  ctx.cursors = new Cursors({ dataDir: config.dataDir })
  ctx.sources = new Sources({ dataDir: config.dataDir, ...sources }) // `sources` lets tests point it at a fake server; the app passes none
  // the projects shelf: every project's public code at one named commit, for agents to list, read and search (never fetched with the room's token)
  ctx.shelf = new Shelf({ dataDir: config.dataDir, maxBytes: (config.shelfMaxMb ?? 300) * 1024 * 1024, own: config.workspaceRepo, named: () => namedRepos(ctx, CURATED_RESOURCES), ...shelf }) // `shelf` lets tests play GitHub from a local server; the app passes none
  ctx.join = new RoomDidWatch({ identity, config }) // what the room's DID says and who the room answers as; the name is the one door.js reads
  await ctx.join.refresh(true)
  // the Trust Task door (door.js): other projects' software hands the room standard signed documents here. Made early, so any part of the room made after it can add its own tasks with ctx.door.register()
  ctx.door = serveRoomTasks(new Door({ ctx }), ctx)
  // the community whose membership pass the room takes (COMMUNITY_DID); it answers as the DID the room speaks as
  ctx.community = new Community({ config, resolver, identity, room: () => ctx.join.room, ...(communityFetch ? { fetch: communityFetch } : {}) })
  // ── wallet sign-in (auth/oob/*, src/server/signin.js). This and the one line marked the same way in route() are all of it here.
  ctx.signIn = new SignIn({ identity, config, resolver, log, door: () => ctx.door })
  registerSignIn(ctx.door, ctx) // its six tasks go on the room's Trust Task door, beside discovery, ping and the log's lines
  await ctx.signIn.refresh(true)
  // ── end wallet sign-in
  ctx.types = TYPES
  ctx.changes = new Changes({ ctx, dataDir: config.dataDir })
  log.on('entry', (e) => ctx.changes.onEntry(e))
  ctx.workshop = new Workshop({ ctx, gh: (...a) => executor.gh(...a) })
  log.on('entry', (e) => ctx.host.onEntry(e))
  // the room's public lines, followable from Mastodon and the rest of the fediverse (read only: nothing flows back in)
  ctx.activitypub = new ActivityPub({ ctx, dataDir: config.dataDir, ...(apFetch ? { fetch: apFetch } : {}) })
  log.on('entry', (e) => ctx.activitypub.onEntry(e))
  ctx.drafts = new Drafts({ db, sealer: hosted })
  await ctx.drafts.load()
  ctx.never = new NeverLists({ db })
  await ctx.never.load()
  log.guards = [(doc) => secretIn(doc.payload), (doc, principal) => ctx.never.check(principal, doc.payload)]
  weaver.skip = () => ctx.check.dids() // the check walks the path; it is not part of the conversation
  ctx.facilitator = new Facilitator({ ctx }) // the board of steps toward the held goals (facilitate mode)
  weaver.facilitator = ctx.facilitator
  ctx.notNamed = new NotNamed({ ctx }) // one gentle note from the weaver to an agent that answers a line naming others
  log.on('entry', (e) => ctx.notNamed.onEntry(e).catch(() => {}))
  ctx.builder = new Builder({ ctx }) // builds what the board hands it, from a routine with only this repository

  /**
   * A signed line for the log, and what the room does besides appending it (a hosted agent made, what it held for
   * someone who leaves deleted). POST /api/entries and the Trust Task door both come here, so they check, refuse and
   * act alike. Returns { entry, duplicate, hosted? } or throws a TaskError.
   */
  ctx.acceptEntry = async (doc, { ip = '', origin = config.publicUrl } = {}) => {
    if (NAME_OF[doc?.type] === 'wake') throw new TaskError('malformedRequest', 'send wake settings to /api/wake, with the link')
    const isHost = NAME_OF[doc?.type] === 'host'
    if (isHost && hosted.liveFor(doc.issuer, log.state) >= MAX_HOSTED) throw new TaskError('permissionDenied', `you already have ${MAX_HOSTED} hosted agents; stop one first`, { status: 403 })
    const { entry, duplicate } = await log.accept(doc, { ip })
    if (isHost && !duplicate) {
      // the workspace makes and holds the agent's key, and says so in the log
      const agent = await hosted.create(entry.author, doc.payload.label)
      await log.appendAsWorkspace('hosted', { agent: agent.did, for: entry.author, label: doc.payload.label, request: entry.hash })
      return { entry, duplicate, hosted: { did: agent.did, connector: `${origin}/mcp/a/${agent.token}` } }
    }
    if (NAME_OF[doc.type] === 'leave' && !duplicate) {
      // leaving deletes what the room holds privately for the person and their agents; the public record stays
      for (const a of [...log.state.participants.values()].filter((p) => p.kind === 'agent' && p.principal === entry.author)) {
        await hosted.delete(a.did); await ctx.notebooks.delete(a.did); await waker.set(a.did, null)
        for (const d of ctx.drafts.list(a.did)) await ctx.drafts.drop(a.did, d.id)
      }
      await ctx.never.set(entry.author, [])
    }
    if (NAME_OF[doc.type] === 'remove' && !duplicate) {
      // removing an agent deletes what the room holds for it: its key, its notebook, its wake link
      await hosted.delete(doc.payload.agent); await ctx.notebooks.delete(doc.payload.agent); await waker.set(doc.payload.agent, null)
    }
    return { entry, duplicate }
  }

  const release = releaseOf(STATIC.map(([, dir]) => dir))
  const page = versioned(readFileSync(join(root, 'public/index.html'), 'utf8'), release, readdirSync(join(root, 'public')).filter((n) => n.endsWith('.js')).sort())
  const importMap = /<script type="importmap">([\s\S]*?)<\/script>/.exec(page)?.[1] ?? ''
  const csp = `default-src 'self'; script-src 'self' 'sha256-${createHash('sha256').update(importMap).digest('base64')}'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`

  const sse = new Set()
  log.on('entry', (e) => { const msg = `event: entry\ndata: ${JSON.stringify(e)}\n\n`; for (const res of sse) res.write(msg) })

  const send = (res, status, body, headers = {}) => {
    const json = typeof body !== 'string'
    res.writeHead(status, { 'content-type': json ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'access-control-allow-origin': '*', ...headers })
    res.end(json ? JSON.stringify(body, null, 2) : body)
  }
  /** A document's body, at most 64 KB: the cap keeps one careless or hostile sender from filling the room's memory, so past it nothing more is kept, the rest is read and thrown away, and the caller answers a real 413 (destroying the socket would swallow that answer). */
  const readBody = (req) => new Promise((resolve, reject) => {
    let size = 0, over = false; const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (over) { if (size > 16 * MAX_BODY) req.destroy(); return } // read and thrown away, up to a point: past 1 MB the sender is only holding the room's connection open, and the 413 has long been sent
      if (size > MAX_BODY) { over = true; chunks.length = 0; reject(new TaskError('malformedRequest', 'a document is at most 64 KB', { status: 413 })) } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
  /** A document for the door: its bytes as they arrived. One chunk past the cap is kept at most (enough for the door to say "too large" in a signed refusal), the rest is counted and thrown away. */
  const readDoorBody = (req) => new Promise((resolve, reject) => {
    let bytes = 0, kept = 0; const chunks = []
    const done = (cut) => resolve({ raw: Buffer.concat(chunks), bytes, cut })
    req.on('data', (c) => {
      bytes += c.length
      if (kept <= MAX_DOCUMENT_BYTES) { chunks.push(c); kept += c.length }
      if (bytes > DOOR_READ_MAX) { req.removeAllListeners('data'); req.resume(); done(true) }
    })
    req.on('end', () => done(false))
    req.on('error', reject)
  })
  /** The door's answer: a signed document as JSON, or nothing at all for 202, 204 and 429. Open to any origin, like the room's other public routes. */
  const sendDoor = (res, out) => {
    res.writeHead(out.status, { 'access-control-allow-origin': '*', 'cache-control': 'no-store', ...(out.body ? { 'content-type': 'application/json' } : {}), ...out.headers })
    res.end(out.body)
  }
  /** Who is calling (caller.js decides; nothing here reads a forwarding header). */
  const callerFor = (req) => callerOf(req, { env: config })
  /** The address as a limit key: one the room could not confirm is marked, so it still limits but is never taken for a real network (sign-in's "same network" says unknown for it). */
  const ipOf = (req) => { const c = callerFor(req); return c.trusted ? c.ip : 'untrusted:' + c.ip }
  const baseOf = (req) => config.publicUrl || `${callerFor(req).https ? 'https' : 'http'}://${req.headers.host}`
  /** A link someone already holds (/j/<code>, from the old "Join on your phone" code, taken out in November 2026): the room's page, whatever the code. The code is never read. */
  const redirectOldLink = (res) => { res.writeHead(303, { location: '/', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); res.end() }

  async function route (req, res) {
    const url = new URL(req.url, 'http://local')
    const path = url.pathname, q = Object.fromEntries(url.searchParams)
    if (req.method === 'OPTIONS') return send(res, 204, '', { 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type, accept, mcp-protocol-version' })
    // the room is updating itself: say so the standard way (503 with Retry-After), so callers try again soon instead of failing
    if (ctx.waits.stopping && DOOR_PATHS.has(path) && req.method === 'POST') return sendDoor(res, ctx.door.busy(ctx.waits.restarting().retryAfter))
    if (ctx.waits.stopping) { const a = ctx.waits.restarting(); return send(res, 503, path === '/api/wait' && q.as === 'text' ? waitLine(a) : { error: a.reason, retryAfter: a.retryAfter }, { 'retry-after': String(a.retryAfter) }) }

    if (path.startsWith('/mcp/a/')) {
      const [token, ...rest] = path.slice(7).split('/'), sub = rest.join('/')
      const wantsMcp = req.method === 'POST' && !sub
      if (!wantsMcp && !(req.method === 'GET' && /text\/event-stream/.test(req.headers.accept ?? ''))) { // opened in a browser or by an agent without MCP: the plain way in
        let body = null
        if (req.method === 'POST') { try { body = JSON.parse((await readBody(req)) || '{}') } catch { return send(res, 400, 'the body is JSON') } }
        return handleHostedPlain(ctx, decodeURIComponent(token), sub, req, res, q, body)
      }
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
    if (handleRoomDid(req, res, path, { dataDir: config.dataDir, file: config.didLogFile })) return
    if (DOOR_PATHS.has(path)) { // the Trust Task door: a signed standard document in, a signed answer out
      if (req.method !== 'POST') return send(res, 405, { error: 'POST a signed Trust Task document here (application/json). /api/info says what this door serves and which DID to address.' }, { allow: 'POST' })
      const { raw, bytes, cut } = await readDoorBody(req)
      return sendDoor(res, await ctx.door.handle(raw, { origin: String(req.headers.origin ?? '').slice(0, 300), base: baseOf(req), host: String(req.headers.host ?? ''), ip: ipOf(req), userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300), https: callerFor(req).https, bytes, cut }))
    }
    if (await ctx.community.handle(req, res, path, readBody, send)) return
    if (await ctx.signIn.handle(req, res, path, q, send)) return // ── wallet sign-in: what a page reads to start one, and what the room holds for a browser key (reads only)
    if (path === '/.well-known/webfinger' || path.startsWith('/ap/')) return ctx.activitypub.handle(req, res, url)
    if (path === '/healthz') return send(res, 200, { ok: true, db: db.kind, entries: log.entries.length })
    if (path === '/api/me/pass' && req.method === 'GET') return servePass(ctx, req, res) // the member's membership pass: needs req.inwoveViewer (the gate), else 401
    if (path === '/api/info') { await ctx.join.refresh(); return send(res, 200, { ...views.info(ctx), join: { via: config.communityDid ? 'community' : 'none' }, roomDid: { differs: roomDidDiffers(ctx.join.status.document) }, door: ctx.door.info(baseOf(req)) }) }
    if (path === '/api/state') return send(res, 200, views.state(ctx))
    if (path === '/api/steps') return send(res, 200, ctx.facilitator.view())
    if (path === '/api/map' || path === '/api/board') return send(res, 200, views.mapView(ctx))
    if (path === '/api/resources') return send(res, 200, views.resourcesView(ctx, q))
    if (path === '/api/log') return send(res, 200, views.entries(ctx, q))
    if (path === '/api/messages') return send(res, 200, views.messages(ctx, q))
    if (path === '/api/wait') { // held open until something is for this agent, or the timeout
      const a = await ctx.waits.wait(q)
      const status = a.restarting ? 503 : 200, headers = a.restarting ? { 'retry-after': String(a.retryAfter) } : {} // a wait cut off by a restart
      return q.as === 'text' ? send(res, status, waitLine(a), headers) : send(res, status, a, headers) // as=text: one line a shell hook can read without a JSON parser
    }
    if (path.startsWith('/api/log/')) { const e = log.byHash.get(path.slice(9)); return e ? send(res, 200, e) : send(res, 404, { error: 'no entry with that hash' }) }
    if (path === '/api/verify') return send(res, 200, await log.verify())
    if (path.startsWith('/api/credentials/')) { const c = views.credential(ctx, decodeURIComponent(path.slice(17))); return typeof c === 'string' ? send(res, 404, { error: c }) : send(res, 200, c) }
    if (path.startsWith('/api/participants/')) { const p = views.participant(ctx, decodeURIComponent(path.slice(18))); return p ? send(res, 200, p) : send(res, 404, { error: 'not in the workspace yet' }) }
    if (path === '/api/qr.svg') {
      const t = String(q.text ?? '')
      if (!t || t.length > 600) return send(res, 400, 'text: 1 to 600 characters')
      return send(res, 200, await QRCode.toString(t, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }), { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=3600' })
    }
    if (path.startsWith('/j/') && (req.method === 'GET' || req.method === 'HEAD')) return redirectOldLink(res)
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
        if (op === 'add' && asPerson) { ctx.waits.poke(agent, 'private'); ctx.waker.poke(agent) } // a private line from its person wakes the agent, like a line to it in the room
        const notes = op === 'add' ? await ctx.notebooks.add(agent, asAgent ? 'agent' : 'person', text) : await ctx.notebooks.get(agent)
        if (asAgent && op === 'read') await ctx.notebooks.markRead(agent)
        return send(res, 200, { agent, notes, readUpTo: await ctx.notebooks.readAt(agent), card: log.state.participants.get(who.principal)?.card ?? null })
      } catch (err) { return refuse(res, err, doc) }
    }
    if (path === '/api/changes' && req.method === 'POST') { // a change from an agent that holds its own key: the diff as the body, its signed room:change line in x-wpi-change
      let doc
      try {
        try { doc = JSON.parse(String(req.headers['x-wpi-change'] ?? '')) } catch { throw new TaskError('malformedRequest', 'send the signed room:change document in the x-wpi-change header, and the diff as the body') }
        if (NAME_OF[doc?.type] !== 'change') throw new TaskError('unsupportedType', 'expected a room:change document in x-wpi-change')
        const chunks = []; let size = 0
        for await (const c of req) { size += c.length; if (size > MAX_PATCH) throw new TaskError('malformedRequest', `a change is a unified diff of at most ${MAX_PATCH / 1000} KB`, { status: 413 }); chunks.push(c) }
        const bytes = Buffer.concat(chunks), text = bytes.toString('utf8')
        if (createHash('sha256').update(text).digest('hex') !== doc.payload?.sha256 || Buffer.byteLength(text) !== doc.payload?.bytes) throw new TaskError('malformedRequest', 'the diff does not match the sha256 and bytes you signed')
        const no = ctx.changes.check(text)
        if (no) throw new TaskError('malformedRequest', no)
        const { entry, duplicate } = await log.accept(doc, { ip: ipOf(req) }) // the signature and the agent's permission for changes are checked here, before anything is kept
        if (!duplicate) { ctx.changes.put(text); ctx.changes.onEntry(entry) } // kept only once its line is signed and in the log; then queued for the keeper
        return send(res, 201, { ...entry, sha256: doc.payload.sha256, bytes: doc.payload.bytes })
      } catch (err) { return refuse(res, err, doc) }
    }
    if (path === '/api/media' && req.method === 'POST') { // a photo: its bytes, with a signed upload naming its hash (x-wpi-upload)
      let doc
      try {
        doc = await log.verifyPrivate(JSON.parse(String(req.headers['x-wpi-upload'] ?? '{}')), 'upload')
        const who = log.state.participants.get(doc.issuer)
        if (!who || (who.kind !== 'human' && who.kind !== 'agent')) throw new TaskError('permissionDenied', 'join first', { status: 403 })
        const chunks = []; let size = 0
        for await (const c of req) { size += c.length; if (size > 10 * 1024 * 1024 + 1) throw new TaskError('malformedRequest', 'a file is at most 10 MB', { status: 413 }); chunks.push(c) }
        const bytes = Buffer.concat(chunks)
        if (createHash('sha256').update(bytes).digest('hex') !== doc.payload.sha256) throw new TaskError('malformedRequest', 'the photo does not match the hash you signed')
        let stored
        try { stored = ctx.media.put(who.principal ?? doc.issuer, doc.payload.type, bytes) } catch (err) { throw new TaskError('malformedRequest', err.message) }
        if (!doc.payload.type.startsWith('image/')) await ctx.media.text(stored.sha256).catch(() => null) // its text, once, for read_file
        return send(res, 201, stored)
      } catch (err) { return refuse(res, err, doc) }
    }
    if (path.startsWith('/api/files/')) { const r = await views.fileText(ctx, path.slice(11), q); return r ? send(res, 200, r) : send(res, 404, { error: 'no file in this room has that sha256, or it has no text (a photo). The path is /api/files/<the sha256 a message lists under files>' }) }
    if (path.startsWith('/api/photos/')) { const r = views.photo(ctx, path.slice(12)); return r ? send(res, 200, r) : send(res, 404, { error: 'no photo in this room has that sha256' }) }
    if (path === '/api/shelf' || path.startsWith('/api/shelf/')) { // other projects' public code, each at one commit: list, read, search
      if (req.method !== 'GET') return send(res, 405, { error: 'GET only' })
      try { return send(res, 200, await views.shelf(ctx, path, q)) } catch (err) { if (!err.status) console.error('shelf:', err); return send(res, err.status ?? 500, { error: err.status ? err.message : 'the shelf could not answer' }, err.status === 429 ? { 'retry-after': '60' } : {}) }
    }
    if (path === '/api/sources') return send(res, 200, ctx.sources.view())
    if (path.startsWith('/api/sources/')) { // the cached copy, exactly as the source sent it
      const body = ctx.sources.body(decodeURIComponent(path.slice(13)))
      if (!body) return send(res, 404, { error: 'no such source, or its first copy has not been fetched yet' })
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'x-content-type-options': 'nosniff' }); return res.end(body)
    }
    if (path === '/rules.json') return send(res, 200, AGREED) // the room's rules as plain data, for anyone to read and check
    if (path === '/api/workshop') return send(res, 200, ctx.workshop.view()) // every change to the room's own code, in public
    if (/^\/api\/pulls\/\d+\/diff$/.test(path) && req.method === 'GET') { // a pull request of the room's own repo, read-only, for agents that can't reach GitHub
      const code = codeOf(ctx), plain = { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' }
      if (!code) return send(res, 404, 'This room has no link to its repository on GitHub, so it cannot show pull requests.', plain)
      try { const d = await code.pullDiff(path.split('/')[3], q); return send(res, 200, d.text, { ...plain, 'x-head-commit': String(d.head ?? '') }) } catch (err) { return send(res, err.status === 404 ? 404 : err.status === 429 ? 429 : 502, `Could not read that pull request: ${err.status === 404 ? 'there is no such pull request in the room\'s repository' : String(err.message).slice(0, 200)}`, { ...plain, ...(err.status === 429 ? { 'retry-after': '60' } : {}) }) }
    }
    if (path.startsWith('/patches/') && req.method === 'GET') { // a change an agent handed the room, to read before approving it
      const d = ctx.changes.get(path.slice(9))
      return d ? send(res, 200, d, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' }) : send(res, 404, { error: 'no change with that hash' })
    }
    if (path.startsWith('/media/') && req.method === 'GET') {
      const m = /^\/media\/([0-9a-f]{64})$/.exec(path), got = m && ctx.media.get(m[1])
      if (!got) return send(res, 404, { error: 'no photo with that hash' })
      const isImage = got.type.startsWith('image/'), name = String(q.name ?? 'file').replace(/[^\w.\- ]+/g, '_').slice(0, 120)
      res.writeHead(200, { 'content-type': got.type, 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox", 'access-control-allow-origin': '*', ...(isImage ? {} : { 'content-disposition': `attachment; filename="${name}"` }) })
      return res.end(got.bytes)
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
    if (path === '/api/for-you' && req.method === 'POST') { // what waits on you, for you alone: signed by you, answered only to you, never logged or kept
      let doc
      try {
        doc = await log.verifyPrivate(JSON.parse(await readBody(req)), 'forYou')
        if (!log.state.isHuman(doc.issuer)) throw new TaskError('permissionDenied', 'join first: this counts what waits on a person', { status: 403 })
        return send(res, 200, forYou(ctx, doc.issuer, doc.payload), { 'cache-control': 'no-store' })
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
        const { entry, duplicate, hosted: made } = await ctx.acceptEntry(doc, { ip: ipOf(req), origin: baseOf(req) })
        return send(res, duplicate ? 200 : 201, made ? { ...entry, hosted: made } : entry)
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
      res.writeHead(200, { 'content-type': TYPES_OF['.html'], 'content-security-policy': csp, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-cache' }) // always re-checked: it names the release to load
      return res.end(page)
    }
    const r = /^\/r\/([0-9a-f]{12})(\/.*)$/.exec(path)
    const forGood = Boolean(r && r[1] === release) // this release's address: its files never change under it
    if (r) path = r[2] // an older release's address still answers, with today's files, re-checked
    for (const [prefix, dir] of STATIC) {
      if (!path.startsWith(prefix)) continue
      const rel = normalize(decodeURIComponent(path.slice(prefix.length))).replace(/^(\.\.[/\\])+/, '')
      const file = join(dir, rel)
      const ext = rel.slice(rel.lastIndexOf('.'))
      if (!file.startsWith(dir) || !TYPES_OF[ext] || !existsSync(file)) continue
      if (prefix.startsWith('/vendor/') && ext !== '.js') continue
      res.writeHead(200, { 'content-type': TYPES_OF[ext], 'x-content-type-options': 'nosniff', 'cache-control': forGood ? 'public, max-age=31536000, immutable' : prefix.startsWith('/vendor/') ? 'public, max-age=3600' : 'no-cache' })
      return res.end(readFileSync(file))
    }
    send(res, 404, 'not found')
  }

  /**
   * A body that is not all in within `bodyTimeoutMs` of the request's start is answered 408 and the connection closed, before
   * any route (the door included) is waiting on it. It protects the room's connections and memory from one slow sender that
   * trickles a body to hold a socket and its buffered bytes open. Only requests that carry a body; a long-lived GET is not one.
   */
  const bodyMs = config.bodyTimeoutMs ?? 30_000
  const guardBody = (req, res) => {
    if (!['POST', 'PUT', 'PATCH'].includes(req.method) || !(bodyMs > 0)) return
    const timer = setTimeout(() => {
      if (!res.headersSent) { res.writeHead(408, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', connection: 'close' }); res.end(JSON.stringify({ error: 'the request body did not arrive in time' })) }
      res.once('finish', () => req.destroy()); setTimeout(() => req.destroy(), 1000).unref() // let the 408 out first; the room never waits on a sender longer than that
    }, bodyMs)
    timer.unref(); req.once('end', () => clearTimeout(timer)); req.once('close', () => clearTimeout(timer))
  }
  const server = createServer((req, res) => { guardBody(req, res); route(req, res).catch((err) => { console.error(err); if (!res.headersSent) send(res, 500, { error: 'internal error' }) }) })

  const timers = []
  ctx.start = async () => {
    await board.refresh()
    timers.push(setInterval(() => board.refresh(), config.boardRefreshMinutes * 60_000))
    timers.push(setInterval(() => board.snapshotIfChanged().catch((e) => console.error('score snapshot:', e)), 60_000))
    timers.push(setInterval(() => weaver.tick(), 30_000))
    timers.push(setInterval(() => ctx.facilitator.tick(), 30_000)) // the board's procedure: hear, close agreements, chase, report
    timers.push(setInterval(() => executor.tick().catch((e) => console.error('executor:', e)), 30_000))
    if (config.checkEveryMinutes !== 0) ctx.check.start(server.address()?.port)
    await ctx.host.start()
    ctx.changes.start()
    ctx.workshop.start()
    ctx.sources.start()
    timers.push(setInterval(() => closeVotes(ctx).catch((e) => console.error('closing votes:', e)), 30_000))
  }
  ctx.stop = async () => { ctx.waits.stop(); ctx.signIn.stop(); timers.forEach(clearInterval); ctx.check.stop(); ctx.host.stop(); ctx.changes.stop(); ctx.workshop.stop(); ctx.sources.stop(); ctx.shelf.flush(); ctx.cursors.save(); ctx.activitypub.stop(); waker.stop(); ctx.away.stop(); for (const r of sse) r.end(); server.close(); await db.close() }
  ctx.server = server
  return ctx
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const ctx = await createApp()
  await ensureRoomDid({ dataDir: defaultConfig.dataDir, file: defaultConfig.didLogFile, publicUrl: defaultConfig.publicUrl })
  await growRoomDid({ dataDir: defaultConfig.dataDir, file: defaultConfig.didLogFile, publicUrl: defaultConfig.publicUrl, roomPublicKey: ctx.identity.publicKey, updateKey: defaultConfig.roomDidUpdateKey, nextKey: defaultConfig.roomDidNextKey })
  ctx.server.listen(defaultConfig.port, () => {
    console.log(`${defaultConfig.workspaceName} on :${defaultConfig.port} · workspace ${ctx.identity.did} · ${ctx.db.kind} · ${ctx.log.entries.length} entries`)
    console.log(ctx.llm.configured ? `weaver model: ${ctx.llm.model ?? 'picked at the first round'} via ${ctx.llm.endpoint ?? defaultConfig.llm.baseUrl}` : 'No model key (ANTHROPIC_API_KEY or LLM_API_KEY) is set: the weaver runs its built-in tally instead of a model, and every round says so.')
    if (!defaultConfig.githubToken) console.warn('GITHUB_TOKEN is not set: approved actions are prepared as links for a person to open, and the log says so.')
  })
  await ctx.start()
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await ctx.stop(); process.exit(0) })
}
