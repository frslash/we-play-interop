// Linking GitHub, with a fake GitHub (test/helpers/github.js): the state is single use and belongs to the session that
// started it, the token is never stored or logged, "verified" is only for repositories GitHub listed, a stale or
// somebody else's verification opens nothing, and an agent joins only for repositories its person linked.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { after, before, describe, mock, test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { TYPES, signedDocument } from '../src/shared/types.js'
import { fakeGithub } from './helpers/github.js'
import { startRoom } from './helpers/room.js'

const NEED = 'Link the GitHub repositories you work on first.'
const stateOf = (r) => new URL(r.headers.get('location')).searchParams.get('state')
const msg = (r) => r.body?.payload?.message ?? ''

describe('linking GitHub', () => {
  let room, a, b, github
  before(async () => { github = fakeGithub(); room = await startRoom({ github }); a = await room.firstMember('Person A'); b = await room.newMember(a.id, 'Person B') })
  after(() => room.stop())

  test('Link GitHub sends a member to GitHub with no scope at all, a PKCE S256 challenge, the exact redirect and a random state', async () => {
    const r = await room.call('/api/github/start', { cookie: a.cookie })
    assert.equal(r.status, 302)
    const to = new URL(r.headers.get('location'))
    assert.equal(to.origin + to.pathname, 'https://github.com/login/oauth/authorize')
    assert.equal(to.searchParams.has('scope'), false, 'a public login and public repositories need no scope'); assert.equal(to.searchParams.get('client_id'), 'test-client-id')
    assert.equal(to.searchParams.get('code_challenge_method'), 'S256'); assert.match(to.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/)
    assert.equal(to.searchParams.get('redirect_uri'), room.config.publicUrl + '/api/github/callback')
    assert.match(to.searchParams.get('state'), /^[A-Za-z0-9_-]{43}$/)
    assert.ok(!to.href.includes('test-client-secret'), 'the secret never leaves the room')
    assert.notEqual(stateOf(await room.call('/api/github/start', { cookie: a.cookie })), to.searchParams.get('state'))
  })

  test('PKCE: the verifier behind the challenge, and the very redirect URI, go to GitHub in the token trade (and GitHub refuses a trade without them)', async () => {
    const to = new URL((await room.call('/api/github/start', { cookie: a.cookie })).headers.get('location'))
    const challenge = to.searchParams.get('code_challenge'), redirect = to.searchParams.get('redirect_uri'), state = to.searchParams.get('state')
    assert.equal(redirect, room.config.publicUrl + '/api/github/callback')
    const before = github.calls.length
    const code = github.grant('octo-a', ['acme/app'], { challenge, redirect })
    const r = await room.call(`/api/github/callback?code=${code}&state=${state}`, { cookie: a.cookie })
    assert.equal(r.headers.get('location'), '/#tab=you&github=1', 'GitHub, checking the challenge and the redirect, accepted the trade')
    const trade = github.calls.slice(before).find((c) => c.url.endsWith('/login/oauth/access_token')), sent = JSON.parse(trade.body)
    assert.equal(sent.redirect_uri, redirect); assert.equal(createHash('sha256').update(sent.code_verifier, 'ascii').digest('base64url'), challenge)
    assert.match(sent.code_verifier, /^[A-Za-z0-9_-]{43,128}$/)
    // a code made for another challenge (an attacker's own authorize request) does not trade
    const s2 = stateOf(await room.call('/api/github/start', { cookie: a.cookie }))
    const bad = github.grant('octo-a', ['acme/app'], { challenge: 'x'.repeat(43), redirect })
    assert.equal((await room.call(`/api/github/callback?code=${bad}&state=${s2}`, { cookie: a.cookie })).headers.get('location'), '/#tab=you&github=0&why=exchange')
  })

  test('linking dies with the session: sign out after starting, and the callback fails with the state reason', async () => {
    const c = await room.newMember(a.id, 'Person S')
    const state = stateOf(await room.call('/api/github/start', { cookie: c.cookie }))
    assert.equal((await room.call('/api/session/end', { method: 'POST', cookie: c.cookie })).status, 200)
    const r = await room.call(`/api/github/callback?code=${github.grant('octo-s', ['s/one'])}&state=${state}`)
    assert.equal(r.headers.get('location'), '/#tab=you&github=0&why=state')
    assert.equal(room.ctx.githubLink.verification(c.id.did), null)
  })

  test('linking dies with the session: a finished verification is gone after sign-out too, so a line that relied on it is refused', async () => {
    const c = await room.newMember(a.id, 'Person T')
    await room.call(`/api/github/callback?code=${github.grant('octo-t', ['t/one'])}&state=${stateOf(await room.call('/api/github/start', { cookie: c.cookie }))}`)
    assert.ok(room.ctx.githubLink.verification(c.id.did), 'it was there')
    await room.call('/api/session/end', { method: 'POST', cookie: c.cookie })
    assert.equal(room.ctx.githubLink.verification(c.id.did), null)
    const again = await room.signInWithKey(c.id)
    assert.match(msg(await room.say(c.id, 'repos', { github: 'octo-t', repos: [{ name: 't/one', verified: true }] })), /Link your GitHub first/)
    void again
  })

  test('without a session there is no start, and the linking view needs one too', async () => {
    assert.equal((await room.call('/api/github/start')).status, 401)
    assert.equal((await room.call('/api/github/linking')).status, 401)
  })

  test('the callback is open (GitHub sends the browser back), but only a live state does anything', async () => {
    const r = await room.call(`/api/github/callback?code=${github.grant('someone', ['x/y'])}&state=nothing-like-a-state`)
    assert.equal(r.status, 303); assert.equal(r.headers.get('location'), '/#tab=you&github=0&why=state')
  })

  test('a state works once: the same state brought back twice links nothing the second time', async () => {
    const start = await room.call('/api/github/start', { cookie: a.cookie }), state = stateOf(start)
    const first = await room.call(`/api/github/callback?code=${github.grant('octo-a', ['acme/app', 'acme/lib'])}&state=${state}`, { cookie: a.cookie })
    assert.equal(first.status, 303); assert.equal(first.headers.get('location'), '/#tab=you&github=1')
    const again = await room.call(`/api/github/callback?code=${github.grant('octo-evil', ['evil/repo'])}&state=${state}`, { cookie: a.cookie })
    assert.equal(again.headers.get('location'), '/#tab=you&github=0&why=state')
    const v = (await room.call('/api/github/linking', { cookie: a.cookie })).body
    assert.equal(v.enabled, true); assert.equal(v.pending.login, 'octo-a'); assert.deepEqual(v.pending.repos, ['acme/app', 'acme/lib'])
  })

  test('a state belongs to the session that started it: another member\'s cookie cannot spend it', async () => {
    const state = stateOf(await room.call('/api/github/start', { cookie: a.cookie }))
    const r = await room.call(`/api/github/callback?code=${github.grant('octo-b', ['b/b'])}&state=${state}`, { cookie: b.cookie })
    assert.equal(r.headers.get('location'), '/#tab=you&github=0&why=state')
    assert.equal((await room.call('/api/github/linking', { cookie: b.cookie })).body.pending, null, 'and it linked nothing for either of them')
  })

  test('a browser that comes back from GitHub without its Strict cookie still links the person who started it, and only them', async () => {
    const state = stateOf(await room.call('/api/github/start', { cookie: b.cookie }))
    await room.call(`/api/github/callback?code=${github.grant('octo-b', ['b/one'])}&state=${state}`) // no cookie: SameSite=Strict is not sent on the way back
    assert.deepEqual((await room.call('/api/github/linking', { cookie: b.cookie })).body.pending.repos, ['b/one'])
  })

  test('cancelling at GitHub, or a code GitHub refuses, ends in a plain refusal and counts as such', async () => {
    const s1 = stateOf(await room.call('/api/github/start', { cookie: a.cookie }))
    assert.equal((await room.call(`/api/github/callback?error=access_denied&state=${s1}`)).headers.get('location'), '/#tab=you&github=0&why=denied')
    const s2 = stateOf(await room.call('/api/github/start', { cookie: a.cookie }))
    assert.equal((await room.call(`/api/github/callback?code=not-a-code&state=${s2}`)).headers.get('location'), '/#tab=you&github=0&why=exchange')
    const f = (await room.call('/api/github/linking', { cookie: a.cookie })).body.room
    assert.ok(f.started >= 5 && f.linked >= 2 && f.failed.denied >= 1 && f.failed.exchange >= 1 && f.failed.state >= 3, JSON.stringify(f))
  })

  test('the code and the token are never stored or logged: a planted value is nowhere the room keeps or says anything', async () => {
    const logged = []; const spies = ['log', 'warn', 'error', 'info', 'debug'].map((k) => mock.method(console, k, (...x) => logged.push(x.map(String).join(' '))))
    const bodies = []
    try {
      const state = stateOf(await room.call('/api/github/start', { cookie: a.cookie }))
      const cb = await room.call(`/api/github/callback?code=${github.grant('octo-a', ['acme/app'])}&state=${state}`, { cookie: a.cookie })
      bodies.push(JSON.stringify([...cb.headers]), cb.text)
      const lk = await room.call('/api/github/linking', { cookie: a.cookie }); bodies.push(lk.text)
      bodies.push((await room.say(a.id, 'repos', { github: 'octo-a', repos: [{ name: 'acme/app', verified: true }] })).text)
      bodies.push((await room.call('/api/state', { cookie: a.cookie })).text, (await room.call('/api/log', { cookie: a.cookie })).text, (await room.call('/api/info', { cookie: a.cookie })).text)
    } finally { spies.forEach((s) => s.mock.restore()) }
    const tokens = [...github.tokensMade(), ...github.codesMade()]; assert.ok(tokens.length >= 2, 'both a token and a code were planted')
    const { rows: tables } = await room.ctx.db.query("select table_name from information_schema.tables where table_schema = 'public'")
    const kept = [JSON.stringify(room.ctx.log.entries), JSON.stringify(room.ctx.log.state.participants.get(a.id.did)), JSON.stringify(room.ctx.githubLink.stats)]
    for (const { table_name: t } of tables) kept.push(JSON.stringify((await room.ctx.db.query(`select * from "${t}"`)).rows))
    for (const t of tokens) for (const [where, text] of [['a response', bodies.join('\n')], ['the log, the state or a table', kept.join('\n')], ['console output', logged.join('\n')]]) assert.ok(!text.includes(t), `the token or code is not in ${where}`)
    // and GitHub was only ever asked for what the room needs: the trade, who this is, and the public repositories
    assert.ok(github.calls.every((c) => /^https:\/\/(github\.com\/login\/oauth\/access_token|api\.github\.com\/(user|users\/[^/]+\/repos)(\/repos)?(\?|$))/.test(c.url)), github.calls.map((c) => c.url).join(' '))
  })

  test('a member:repos line marks "verified" only the repositories GitHub listed; a private one the person types is "you said"', async () => {
    await room.linkGithub(a, { login: 'octo-a', repos: ['acme/app', 'acme/lib'], pick: ['acme/app'] }) // the picker's line: just the one
    const lie = await room.say(a.id, 'repos', { github: 'octo-a', repos: [{ name: 'acme/app', verified: true }, { name: 'secret/vault', verified: true }] })
    assert.equal(lie.status, 403); assert.match(msg(lie), /GitHub did not list secret\/vault/)
    const ok = await room.say(a.id, 'repos', { github: 'octo-a', repos: [{ name: 'Acme/App', verified: true }, { name: 'acme/lib', verified: true }, { name: 'secret/vault', verified: false }] })
    assert.equal(ok.status, 201, ok.text)
    const me = (await room.call('/api/state', { cookie: a.cookie })).body.people.find((p) => p.did === a.id.did)
    assert.equal(me.github, 'octo-a'); assert.deepEqual(me.repos, [{ name: 'Acme/App', verified: true }, { name: 'acme/lib', verified: true }, { name: 'secret/vault', verified: false }])
  })

  test('a repository GitHub vouched for before keeps its mark when the person links again, even if this time\'s list lacks it', async () => {
    await room.linkGithub(a, { login: 'octo-a', repos: ['acme/app', 'acme/lib'] })
    assert.equal((await room.say(a.id, 'repos', { github: 'octo-a', repos: [{ name: 'acme/app', verified: true }, { name: 'acme/lib', verified: true }] })).status, 201)
    await room.linkGithub(a, { login: 'octo-a', repos: ['acme/other'], pick: [] }).catch(() => {})
    const again = await room.say(a.id, 'repos', { github: 'octo-a', repos: [{ name: 'acme/app', verified: true }, { name: 'acme/other', verified: true }] })
    assert.equal(again.status, 201, again.text)
    const fresh = await room.say(a.id, 'repos', { github: 'octo-a', repos: [{ name: 'acme/app', verified: true }, { name: 'never/listed', verified: true }] })
    assert.equal(fresh.status, 403, 'but nobody newly claims a mark GitHub never gave')
  })

  test('a line without a verification, with another login, with someone else\'s, or a stale one, is refused', async () => {
    const c = await room.newMember(a.id, 'Person C')
    const line = (who, login) => room.say(who.id, 'repos', { github: login, repos: [{ name: 'acme/app', verified: true }] })
    assert.match(msg(await line(c, 'octo-a')), /Link your GitHub first/, 'nothing linked yet')
    assert.equal((await line(a, 'octo-other')).status, 403, 'a login GitHub did not give for this person')
    assert.equal((await line(c, 'octo-a')).status, 403, 'person A\'s verification is not person C\'s')
    mock.timers.enable({ apis: ['Date'], now: Date.now() })
    try {
      await room.linkGithub(a, { login: 'octo-a', repos: ['acme/app'] })
      mock.timers.tick(9 * 60_000); assert.equal((await line(a, 'octo-a')).status, 201, 'nine minutes on, still good')
      mock.timers.tick(2 * 60_000); assert.match(msg(await line(a, 'octo-a')), /Link your GitHub first/, 'eleven minutes on, stale')
    } finally { mock.timers.reset() }
  })

  test('only a person writes member:repos: an agent cannot link repositories for itself or its person', async () => {
    await room.linkGithub(a, { login: 'octo-a', repos: ['acme/app'] })
    const made = await room.say(a.id, 'host', { label: 'Helper', repos: ['acme/app'] })
    const agent = room.ctx.hosted.byToken(made.body.hosted.connector.split('/').pop())
    const dd = await room.say(a.id, 'delegate', { delegate: agent.did, scope: ['note'], repos: ['acme/app'] }, { expiresAt: new Date(Date.now() + 86400000).toISOString() })
    assert.equal(dd.status, 201, dd.text)
    const doc = signedDocument(agent.identity, { type: TYPES.repos, payload: { github: 'octo-a', repos: [{ name: 'acme/app', verified: true }] }, onBehalfOf: a.id.did, delegation: dd.body.hash })
    assert.equal((await room.call('/api/entries', { method: 'POST', body: doc })).status, 403)
  })
})

describe('an agent joins only for repositories its person linked', () => {
  let room, a
  before(async () => { room = await startRoom(); a = await room.firstMember('Person A') })
  after(() => room.stop())
  const expires = () => ({ expiresAt: new Date(Date.now() + 86400000).toISOString() })

  test('with nothing linked, host and delegate are refused in the room\'s words, with or without a repository named', async () => {
    for (const payload of [{ label: 'Helper' }, { label: 'Helper', repos: ['acme/app'] }]) {
      const r = await room.say(a.id, 'host', payload); assert.equal(r.status, 403); assert.equal(msg(r), NEED)
    }
    const r = await room.say(a.id, 'delegate', { delegate: newIdentity().did, scope: ['note'], repos: ['acme/app'] }, expires()); assert.equal(msg(r), NEED)
  })

  test('naming a repository that is not one of theirs is refused; naming theirs works, in any capitals', async () => {
    await room.linkGithub(a, { login: 'octo-a', repos: ['acme/app', 'acme/lib'], typed: ['me/private-thing'] })
    for (const repos of [['acme/other'], ['acme/app', 'nobody/else'], []]) { const r = await room.say(a.id, 'host', { label: 'Helper', repos }); assert.equal(r.status, repos.length ? 403 : 400, JSON.stringify(repos)); if (repos.length) assert.equal(msg(r), NEED) }
    assert.match(msg(await room.say(a.id, 'host', { label: 'Helper' })), new RegExp(NEED.replace(/\./g, '\\.')), 'and leaving them out is not allowed')
    assert.equal((await room.say(a.id, 'host', { label: 'Helper', repos: ['ACME/App', 'me/private-thing'] })).status, 201)
  })

  test('the delegation carries the repositories, and the agent\'s card says "Works on" them', async () => {
    const made = await room.say(a.id, 'host', { label: 'Coder', repos: ['acme/app'] })
    const did = made.body.hosted.did
    assert.equal(msg(await room.say(a.id, 'delegate', { delegate: did, scope: ['note'], repos: ['acme/lib', 'unlinked/repo'] }, expires())), NEED)
    assert.equal(msg(await room.say(a.id, 'delegate', { delegate: did, scope: ['note'] }, expires())), NEED)
    assert.equal((await room.say(a.id, 'delegate', { delegate: did, scope: ['note'], repos: ['acme/app', 'acme/lib'] }, expires())).status, 201)
    const card = (await room.call('/api/state', { cookie: a.cookie })).body.people.find((p) => p.did === did)
    assert.deepEqual(card.repos, ['acme/app', 'acme/lib'])
  })

  test('bad shapes are refused before the rule: not owner/name, twice, or more than thirty', async () => {
    for (const repos of [['justaname'], ['a/b', 'A/B'], Array.from({ length: 31 }, (_, i) => `o/r${i}`), 'acme/app']) assert.equal((await room.say(a.id, 'host', { label: 'X', repos })).status, 400, JSON.stringify(repos).slice(0, 40))
  })

  test('a test room may leave repositories out (never a real one: openRoom is an argument, not a setting)', async () => {
    const { createApp } = await import('../src/server/index.js')
    const { config } = room
    const open = await createApp({ ...config, dataDir: config.dataDir + '-open' }, { openRoom: true, awayGatherMs: 0, hostWelcomeMs: null })
    await new Promise((r) => open.server.listen(0, '127.0.0.1', r))
    const id = newIdentity(), url = `http://127.0.0.1:${open.server.address().port}/api/entries`
    const send = (name, payload) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signedDocument(id, { type: TYPES[name], payload })) })
    assert.equal((await send('join', { name: 'Tester' })).status, 201)
    assert.equal((await send('host', { label: 'No repos' })).status, 201)
    await open.stop()
  })
})

describe('linking when the host has not set it up', () => {
  let room, a
  before(async () => { room = await startRoom({ extra: { githubOauthClientId: '', githubOauthClientSecret: '' } }); a = await room.firstMember('Person A') })
  after(() => room.stop())

  test('the page is told plainly that this server has not set it up, and start says the same', async () => {
    const v = await room.call('/api/github/linking', { cookie: a.cookie })
    assert.equal(v.body.enabled, false); assert.match(v.body.note, /has not set up GitHub linking/); assert.match(v.body.note, /docs\/hosting\.md/)
    const s = await room.call('/api/github/start', { cookie: a.cookie })
    assert.equal(s.status, 503); assert.match(s.body.error, /has not set up GitHub linking/)
  })

  test('half set up is off too, and nothing can be linked, so no agent can join', async () => {
    const r = await startRoom({ extra: { githubOauthClientId: 'only-the-id', githubOauthClientSecret: '' } })
    try { const m = await r.firstMember('Person A'); assert.equal((await r.call('/api/github/linking', { cookie: m.cookie })).body.enabled, false); assert.equal((await r.say(m.id, 'host', { label: 'X', repos: ['a/b'] })).status, 403) } finally { await r.stop() }
  })
})
