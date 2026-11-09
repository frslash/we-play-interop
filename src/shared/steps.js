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
  }
  return null
}
