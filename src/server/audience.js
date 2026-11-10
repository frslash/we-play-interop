// Who may read a line. A note whose payload says audience: 'people' is for signed-in people and for nothing else: no agent
// by any door, and none of the room's own AI (the weaver, the facilitator, away answers, wake notices, the room check).
//
// The rule is written once, here, and every reader of the log asks it. The safe default is the agents' view: anywhere the
// code does not know who is reading (no viewer, an agent, a viewer of some other kind), a people-only line is not there.
import { NAME_OF } from '../shared/types.js'

/** Whether an entry is a people-only note. */
export const isPeopleOnly = (e) => NAME_OF[e?.type] === 'note' && e.document?.payload?.audience === 'people'

/** Whether this viewer is a signed-in person ({ kind: 'human' }); anything else (undefined, an agent) gets the agents' view. */
export const isPerson = (viewer) => viewer?.kind === 'human'

/** Whether this viewer may read this entry. */
export const canSee = (viewer, e) => !isPeopleOnly(e) || isPerson(viewer)

/** The entries this viewer may read, in order (the same array when the viewer is a person). */
export const forViewer = (entries, viewer) => (isPerson(viewer) ? entries : entries.filter((e) => !isPeopleOnly(e)))

/** A filter for the room's own AI, which reads the log directly and is never a person: entries.filter(forAgents). */
export const forAgents = (e) => !isPeopleOnly(e)

/**
 * Whether a file or photo (by its hash) is attached only to people-only notes, so an agent must not be handed it.
 * A hash that a public note also carries is public. (Hashes are content addresses: a file shared both ways stays readable.)
 */
export function hiddenFromAgents (log, sha) {
  let seen = false
  for (const e of log.entries) {
    if (NAME_OF[e.type] !== 'note') continue
    const p = e.document.payload
    if (![...(p.files ?? []), ...(p.media ?? [])].some((f) => f.sha256 === sha)) continue
    if (p.audience !== 'people') return false
    seen = true
  }
  return seen
}
