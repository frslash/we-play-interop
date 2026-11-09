// What a new line changes on the room's page, so the page asks the server again only for what the line itself can't
// tell it. Shared by the page and the tests, so it stays free of browser and Node APIs.
import { heard } from './presence.js'
import { NAME_OF } from './types.js'

/** The fewest milliseconds between two fetches of the room's whole state while lines keep coming. */
export const STATE_GAP_MS = 4000

// What a plain line of talk carries: its words, what's attached to them, and whether the room answered for an away
// agent (auto). A note with any other field (a closer look, a step on the board, the facilitator's record) changes the
// room's state, so the page asks for it again: a field added later asks too, until it's listed here.
const PLAIN_NOTE = new Set(['text', 'kind', 'tech', 'media', 'files', 'pair', 'scenario', 'auto'])
// Lines that never change the map (board.map and views.graph read people, projects, ways, runs, rounds and the score).
// A type that isn't listed, including one added later, asks for the map too.
const MAP_SAME = new Set(['note', 'propose', 'vote', 'approve', 'veto', 'result', 'mode', 'step', 'wake', 'away', 'hosted', 'host', 'revoke', 'link', 'vouch', 'resource', 'change'])

/** The author as the page knows them: a person or agent it lists, the weaver, or null for someone new. */
const authorOf = (S, did) => (did && did === S?.workspace ? { kind: 'workspace' } : S?.people?.find((p) => p.did === did) ?? null)

/**
 * What the page must fetch again after a new line: { state, map }. A plain note from someone the page already knows
 * changes only the feed, the counts and when its author last spoke, and the page applies those itself (see take).
 * Every other line asks for the state, and lines that can change the map ask for that too. Someone the page has
 * never heard (a new agent's first line) asks for both, since it joins the room's lists and its person's map card.
 */
export function refetchFor (S, e) {
  const name = NAME_OF[e?.type], p = e?.document?.payload ?? {}, by = authorOf(S, e?.author)
  const known = Boolean(by && heard(by))
  if (name === 'note' && known && Object.keys(p).every((k) => PLAIN_NOTE.has(k))) return { state: false, map: false }
  return { state: true, map: !known || !name || !MAP_SAME.has(name) }
}

// on the page's copy: the head it was fetched at, and the lines applied to it since (a fresh copy starts over)
const LOCAL = Symbol('lines applied since the state was fetched')

/**
 * Apply what a line says on its own to the page's copy of the room's state (what the server's fold does for it):
 * the room's head, the count of its type, and when an agent first and last spoke. A line the fetched copy already
 * holds, or one applied before, changes nothing, so a line heard twice is never counted twice; a line that comes
 * late (after the next one) still counts.
 */
export function take (S, e) {
  if (!S || !e) return false
  const local = S[LOCAL] ??= { base: S.head?.seq ?? -1, hashes: new Set() }
  if (e.seq <= local.base || local.hashes.has(e.hash)) return false
  local.hashes.add(e.hash)
  const name = NAME_OF[e.type]
  if (!S.head || e.seq > S.head.seq) S.head = { seq: e.seq, hash: e.hash }
  if (name) S.counts = { ...S.counts, [name]: (S.counts?.[name] ?? 0) + 1 }
  const by = S.people?.find((p) => p.did === e.author)
  if (by?.kind === 'agent') { by.firstSaid ??= e.timestamp; by.lastSaid = e.timestamp }
  return true
}

/**
 * Paces the fetches of the state. soon(map) asks for one: the first ask after a quiet spell waits firstMs, and asks
 * that keep coming share one fetch at most every gapMs (no ask is ever dropped: the next fetch covers it). now() runs a
 * waiting fetch at once (a step of your own), or hands back the one on its way. mark() records a fetch made another way.
 * run(map) does the fetch; map is true when any ask since the last fetch wanted the map too.
 */
export function pacer (run, { gapMs = STATE_GAP_MS, firstMs = 250, clock = Date, timers = globalThis } = {}) {
  let last = -Infinity, timer = null, busy = null, map = false
  const fire = () => {
    timers.clearTimeout(timer); timer = null
    const m = map; map = false; last = clock.now()
    const p = busy = Promise.resolve().then(() => run(m)).catch(() => {})
    p.then(() => { if (busy === p) busy = null })
    return p
  }
  return {
    soon (wantMap = false) { map ||= Boolean(wantMap); if (!timer) timer = timers.setTimeout(fire, Math.max(firstMs, last + gapMs - clock.now())) },
    now () { return timer ? fire() : busy },
    mark () { last = clock.now() },
    get waiting () { return Boolean(timer) },
    get last () { return last },
  }
}
