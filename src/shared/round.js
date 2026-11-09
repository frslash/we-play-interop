// What a weaver round says out loud, shared by the server, the browser and the agent bridge.
// A round is a record (what it heard, what it judged); it is a line in the room only when it has
// something for someone: a question to the room, a next step, or people who should talk.
// A round with none of these says nothing: no "Listening." filler (the board is the queue).

/** The round's words, or '' when it has nothing for anyone. nameOf turns a DID into a name. */
export function roundText (p, nameOf = (d) => d) {
  const next = (p?.next ?? []).map((n) => n?.action).filter(Boolean).join(' · ')
  const links = (p?.connections ?? []).map((c) => `${c.between.map((d) => nameOf(d)).join(' & ')}: ${c.why}`).join(' · ')
  return [next && `Next: ${next}`, links && `Should talk: ${links}`].filter(Boolean).join('\n')
}

/** Whether a round is silent: a record only, never a line, and it wakes no one. */
export const silentRound = (p) => !roundText(p)
