// Choices that are a person's alone. The weaver puts most choices a step waits on to the agents in the room (room
// line 1446), but not one that touches a person's keys, money, time or name: no agent decides those for them. Such a
// choice is held for that person, stays open on the board, and only that person's own word (not their agent's)
// answers it. The words below are deliberately broad: a choice wrongly held waits for a person, which is safe; a
// choice wrongly given to the agents is not.

const KINDS = [
  ['keys', /\b(keys?|private[- ]key|seed[- ]phrase|recovery[- ]phrase|mnemonic|pass(word|phrase)s?|wallets?|credentials?|secrets?|tokens?|signing|logins?|accounts?)\b/i],
  ['money', /\b(money|pay|pays|paying|paid|payments?|buy|buys|buying|bought|purchase\w*|costs?|costing|price[sd]?|fees?|fund(s|ed|ing)?|invoices?|subscriptions?|budget|spend(s|ing)?|spent|donat\w*|billing|bill)\b|[$€£]\s?\d/i],
  ['time', /\b(meetings?|a call|calls? with|schedul\w*|calendar|availab(le|ility)|attend\w*|hours?|weekends?|(his|her|their|your|my|\w+['’]s) time)\b/i],
  ['name', /\b(in (his|her|their|your|my|someone['’]s) name|(his|her|their|your|my|\w+['’]s) (real |full |own )?name|on (his|her|their|your|my|someone['’]s) behalf|on behalf of|sign(ed)? (it )?as|speak(s|ing)? for (him|her|them|you|me)|publish(ed|es)? (it )?(as|under)|under (his|her|their|your|my) name|real names?|byline|endorse\w*)\b/i],
]

/** What of a person's a choice touches: some of "keys", "money", "time", "name"; empty when none. */
export function touchesPerson (text) {
  const t = String(text ?? '')
  return KINDS.filter(([, re]) => re.test(t)).map(([k]) => k)
}

/** The kinds in plain words: "keys and money", "keys, money and time". */
export const inWords = (kinds) => (kinds.length < 2 ? kinds.join('') : `${kinds.slice(0, -1).join(', ')} and ${kinds.at(-1)}`)

/**
 * Whether a line may answer the choice a step waits on. A choice held for a person: only a person, and when it names
 * one, only that person themself. Any other choice: whoever it was put to (the agents, or that person's side).
 */
export function mayAnswer (st, e, waitingOn, sameSide) {
  if (!waitingOn) return false
  if (waitingOn.personal) return st.isHuman(e.author) && e.author === e.onBehalfOf && (!waitingOn.who || e.author === waitingOn.who)
  return !waitingOn.who || sameSide(st, e.author, waitingOn.who)
}
