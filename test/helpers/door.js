// A stand-in for the room's Trust Task door (src/server/door.js), for tests of sign-in on its own: no room, no
// database, a clock the test moves. test/signin.test.js also plays the whole exchange through the real door.
// Same interface: door.register(typeUri, handler, { purposes, precheck }), where handler({ doc, payload, signer, http })
// returns the answer's payload or throws a Refusal. It checks what the real door checks, in the order OpenVTC's
// receive pipeline does (vti-trust-task-server/src/spine.rs:3-26): size before anything is read, shape, age,
// recipient, the task's own gate before the proof, the proof, the id (the same document again gets the same answer;
// another document under the same id is refused), then the task, then a signed answer. A refusal is signed too.
import { createServer } from 'node:http'
import { canonicalize } from '../../src/shared/crypto.js'
import { MAX_DOCUMENT_BYTES, checkTask, refusalTo, responseTo, signTask, statusFor, verifyTask } from '../../src/shared/trusttask.js'
import { Refusal, SIGNED } from '../../src/server/signin.js'

/** me(): the identity the door answers as ({ did, seed, verificationMethod }). keyFor: a resolver's key lookup. */
export function standInDoor ({ me, keyFor, now = Date.now }) {
  const handlers = new Map(), seen = new Map() // id -> { digest, answer }: what was answered for a document, so its redelivery hears the same
  const refuse = (doc, r) => ({ status: statusFor(r.code), body: signTask(refusalTo(doc, { code: r.code, message: r.message, details: r.details }, me().did), me()) })
  return {
    path: '/trust-tasks',
    register (type, handler, opts = {}) { handlers.set(type, { handler, ...opts }) },
    /** One document in (text, or an object), one answer out: { status, body }. `http` is absent for a document that did not come over the web. */
    async receive (raw, http) {
      if (http && http.pageOrigin === undefined) http = { ...http, pageOrigin: http.origin } // these tests name the browser's Origin header `origin`; the real door hands it to a task as pageOrigin
      const text = typeof raw === 'string' ? raw : JSON.stringify(raw)
      if (Buffer.byteLength(text) > MAX_DOCUMENT_BYTES) return refuse(null, { code: 'malformedRequest', message: `a document is at most ${MAX_DOCUMENT_BYTES} bytes`, details: { maxBytes: MAX_DOCUMENT_BYTES } })
      let doc; try { doc = JSON.parse(text) } catch { return refuse(null, { code: 'malformedRequest', message: 'the body is not JSON' }) }
      const basic = checkTask(doc, { me: me().did, now: now() })
      if (!basic.ok) return refuse(doc, basic)
      const h = handlers.get(doc.type)
      if (!h) return refuse(doc, { code: 'unsupportedType', message: 'this room does not serve that task', details: { requestedType: String(doc.type).slice(0, 200) } })
      const pre = h.precheck?.(doc)
      if (pre) return refuse(doc, pre)
      const v = await verifyTask(doc, { keyFor, me: me().did, now: now(), purposes: h.purposes })
      if (!v.ok) return refuse(doc, v)
      const digest = canonicalize(doc), prior = seen.get(doc.id)
      if (prior) {
        if (prior.digest !== digest) return refuse(doc, { code: 'idConflict', message: 'a different document was already sent under this id' })
        return prior.answer ?? { status: 202, body: null } // still being answered
      }
      const slot = { digest, answer: null }; seen.set(doc.id, slot)
      try {
        const out = await h.handler({ doc, payload: doc.payload, signer: v.signer, http })
        slot.answer = { status: 200, body: out?.[SIGNED] ? out : signTask(responseTo(doc, out, me().did), me()) } // an answer the task signed itself goes out as it is
        return slot.answer
      } catch (e) {
        seen.delete(doc.id) // a refusal is not kept: the same document may be tried again
        if (e instanceof Refusal) return refuse(doc, e)
        throw e
      }
    },
  }
}

/**
 * The stand-in door and the room's sign-in reads behind a real http server on this machine only, so the browser's
 * and the wallet's halves can be played over HTTP exactly as test/live does against a running room.
 */
export async function serve ({ door, signIn }) {
  const send = (res, status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers }); res.end(body === null ? undefined : JSON.stringify(body)) }
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://local'), path = url.pathname
      if (req.method === 'POST' && path === door.path) {
        const chunks = []; for await (const c of req) chunks.push(c)
        const a = await door.receive(Buffer.concat(chunks).toString('utf8'), { origin: req.headers.origin, host: req.headers.host, ip: req.socket.remoteAddress, userAgent: req.headers['user-agent'], https: false })
        return send(res, a.status, a.body, { 'cache-control': 'no-store' })
      }
      if (await signIn.handle(req, res, path, Object.fromEntries(url.searchParams), send)) return
      if (path === '/api/info') return send(res, 200, { signIn: signIn.view() }) // the part of the room's /api/info that is about sign-in
      send(res, 404, { error: 'not found' })
    } catch (e) { send(res, 500, { error: String(e?.message ?? e) }) }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => { signIn.stop(); server.closeAllConnections?.(); server.close(resolve) }) }
}
