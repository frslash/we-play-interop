// What a line can say about a step on the facilitator's board. Shared by the room (server/facilitator.js), the agents'
// step tool and the page, so each gives the same reason before anything is sent.

/** Whether a line gives the exact thing: a link, a command or code, a number or test value, a file. */
export const exact = (...texts) => texts.some((t) => /https?:\/\/\S+|`[^`]+`|\b[\w./-]+\.(js|ts|json|md|py|sh|rs|go|yaml|yml|toml)\b|\b\d+(\.\d+)?\b|\b[0-9a-f]{12,}\b/i.test(String(t ?? '')))

/**
 * Why `who` can't say `s.say` about `step` (null: they can). personOf(did) is the person a DID acts for (itself for a
 * person), so an agent and its person count as one side: only another side checks a result (room lines 1093, 1094).
 */
export function whyNot (step, s, who, personOf, ownerName = 'its owner') {
  if (!step) return 'no step with that id on the board (the steps tool lists them)'
  if (step.state === 'checked') return 'that step is done: it was checked'
  const mine = Boolean(step.owner) && personOf(step.owner) === personOf(who)
  switch (s.say) {
    case 'claim': return step.state === 'open' || step.aside ? null : mine ? 'it is already yours' : `${ownerName} has it; if it goes quiet, the room offers it on by itself`
    case 'update': case 'release': return mine ? null : 'only its owner (or their person) can do that'
    case 'result': return !mine ? 'only its owner (or their person) posts its result; claim it first if nobody has it' : step.state === 'open' ? 'claim it first' : null
    case 'check': return step.state !== 'result posted' ? 'there is no result to check yet' : mine ? 'someone of another person’s side checks it, not its owner’s' : null
    case 'blocked': return !step.owner || mine ? null : 'only its owner says what it waits on'
    case 'edit': case 'undo': return null // anyone may ask for new words, or undo an edit: every edit is a signed line
    case 'confirm': {
      if (personOf(who) === who) return 'an agent of another person confirms a held edit, not a person'
      const held = (step.pendingEdits ?? []).filter((x) => !s.edit || x.id === s.edit || (s.edit.length >= 6 && x.id.startsWith(s.edit)))
      if (!held.length) return 'no edit of this step is waiting to be confirmed'
      return held.every((x) => personOf(x.by) === personOf(who)) ? 'an agent of another person than the one who asked for it confirms it' : null
    }
  }
  return null
}

/**
 * Whether new words for a step wait for a confirmation: any change to a goal's check (a step with a done-test number), and
 * any change to what a step's check asks (done). The code can't tell whether new words ask less, so every such change is
 * held until an agent of a different person confirms it. Rewording an ordinary step's title applies at once.
 */
export const held = (step, fields) => Boolean(step?.test) || Object.hasOwn(fields ?? {}, 'done')
