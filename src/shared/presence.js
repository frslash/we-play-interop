// Who is in the room, and which lines are for a person. Shared by the page, the server and the tests, so it
// stays free of browser and Node APIs.
import { NAME_OF } from './types.js'

/** An agent is in the room once it has been heard; before that it is being set up (room lines 570-573). */
export const heard = (p) => p?.kind !== 'agent' || Boolean(p.firstSaid)

/** Whether text names someone: "Ada", "@Ada", any case, as a whole word (the server's own rule for waking). */
export function namesIn (text, name) {
  if (!name) return false
  const esc = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^\\p{L}\\p{N}])@?${esc}(?![\\p{L}\\p{N}])`, 'iu').test(String(text ?? ''))
}

/**
 * Whether a line is for this person: addressed to them, answering a line of theirs, or naming them.
 * person: { did, name }; parentAuthor: who wrote the line it answers (or null).
 */
export function lineIsFor (e, person, parentAuthor = null) {
  if (!person?.did || e.author === person.did || !['note', 'propose'].includes(NAME_OF[e.type])) return false
  const d = e.document, p = d.payload ?? {}
  if (d.recipient) return d.recipient === person.did // a line to someone, for them only
  if (e.onBehalfOf === person.did) return false // their own agent speaking for them, not to them (it reports to them privately)
  if (parentAuthor === person.did) return true
  return namesIn(`${p.text ?? ''} ${p.title ?? ''}`, person.name)
}

/** What a seat shows while its agent is awake but holds a line for its person's OK ("Ask me first"). */
export const WAITING_FOR_PERSON = 'awake, waiting for its person'
/**
 * Whether an agent is awake but waiting on its person: it has at least one line waiting for their OK. It is not
 * absent: it spoke, and its person has the next move (room line 2329).
 */
export const waitsForPerson = (p) => p?.kind === 'agent' && !p.removed && Number(p.waiting ?? 0) > 0
