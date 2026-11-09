// Who "@F" can mean, for the Talk box's drop-up list (room lines 917-924): people whose name matches come
// first, each with their agents listed under them ("Fern's agent, Ember"), so typing a person's name also
// finds their agents; then agents matched by their own name, still shown with their person. Shared by the
// page and the tests, so it stays free of browser and Node APIs.

export const MAX_MENTIONS = 8 // a short list above the box: more is a scroll on a phone, and a few letters narrow it

const words = (name) => String(name).toLowerCase().split(/[\s'’._-]+/).filter(Boolean)
/** How well a name matches what was typed: 0 its start, 1 the start of a later word, -1 not at all. */
export function matchRank (name, query) {
  const q = String(query ?? '').trim().toLowerCase(), n = String(name ?? '').toLowerCase()
  if (!q) return 0
  if (n.startsWith(q)) return 0
  return words(n).some((w) => w.startsWith(q)) ? 1 : -1
}

/**
 * The rows to offer for a query: [{ name, label, did, kind: 'person' | 'agent', under: bool }].
 * `name` is what goes after the @ (the room wakes whoever a line names); `label` is what the row shows.
 * people: the room's people, as /api/state lists them; skip(did): leave someone out (the room check's accounts).
 */
export function mentionOptions (people, query, { max = MAX_MENTIONS, skip = () => false } = {}) {
  const here = (people ?? []).filter((p) => p?.name && !p.removed && !p.left && !skip(p.did))
  const humans = here.filter((p) => p.kind === 'human')
  const agents = here.filter((p) => p.kind === 'agent' && p.delegation !== null) // an agent with no live permission can't be woken
  const nameOf = (did) => humans.find((p) => p.did === did)?.name ?? null
  const agentRow = (a, under) => { const person = nameOf(a.principal); return { name: a.name, label: person ? `${person}'s agent, ${a.name}` : a.name, did: a.did, kind: 'agent', under } }
  const byRank = (list) => list.map((p) => ({ p, r: matchRank(p.name, query) })).filter((x) => x.r >= 0).sort((a, b) => a.r - b.r || a.p.name.localeCompare(b.p.name)).map((x) => x.p)
  const rows = [], shown = new Set()
  for (const person of byRank(humans)) {
    rows.push({ name: person.name, label: person.name, did: person.did, kind: 'person', under: false })
    for (const a of agents.filter((x) => x.principal === person.did).sort((x, y) => x.name.localeCompare(y.name))) { rows.push(agentRow(a, true)); shown.add(a.did) }
  }
  for (const a of byRank(agents)) if (!shown.has(a.did)) rows.push(agentRow(a, false))
  return rows.slice(0, max)
}
