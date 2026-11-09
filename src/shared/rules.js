// The checker for the room's rules as plain data (rules.json). Given the rules and the facts about a proposal,
// it says what the proposal still waits for, or null when the rules let it act. Pure, with no browser or Node
// APIs, so the server, the page, an agent or anyone auditing the room runs the same code on the same data.

const isInt = (v) => Number.isInteger(v) && v >= 0
const paths = (v) => Array.isArray(v) && v.every((p) => typeof p === 'string' && p.length > 0 && p.length < 200)

/** What is wrong with a rules document, as plain lines; [] when the checker can read it. */
export function problems (r) {
  const out = []
  const need = (ok, what) => { if (!ok) out.push(what) }
  need(r && typeof r === 'object', 'rules: an object')
  if (!r || typeof r !== 'object') return out
  need(isInt(r.version), 'version: a whole number')
  const p = r.proposals ?? {}, c = r.codeChanges ?? {}, s = c.smallLane ?? {}
  need(isInt(p.peopleNeeded) && p.peopleNeeded >= 1, 'proposals.peopleNeeded: at least 1')
  need(typeof p.personsOwnYesCounts === 'boolean', 'proposals.personsOwnYesCounts: true or false')
  need(isInt(p.vetoWindowMinutes), 'proposals.vetoWindowMinutes: minutes')
  need(typeof c.agentsMayApprove === 'boolean', 'codeChanges.agentsMayApprove: true or false')
  need(isInt(c.agentsOfDifferentPeopleNeeded) && c.agentsOfDifferentPeopleNeeded >= 1, 'codeChanges.agentsOfDifferentPeopleNeeded: at least 1')
  need(c.ownSideNeverApproves === true, 'codeChanges.ownSideNeverApproves: true (an agent never approves its own person\'s change)')
  need(typeof c.testsMustPass === 'string' && c.testsMustPass.length > 0, 'codeChanges.testsMustPass: the name the test checks carry')
  need(paths(s.paths) && paths(s.except ?? []), 'codeChanges.smallLane.paths and except: lists of paths')
  need(paths(c.needAPerson), 'codeChanges.needAPerson: a list of paths')
  need(['rules.json', 'src/shared/rules.js'].every((f) => matches(c.needAPerson ?? [], f)), 'codeChanges.needAPerson: must include rules.json and src/shared/rules.js, so the rules never change without a person')
  need(isInt(r.votes?.closeAfterMinutes) && r.votes.closeAfterMinutes >= 1, 'votes.closeAfterMinutes: at least 1')
  return out
}

/** Whether a file is named by a list of paths: "dir/" covers what is under it, "*.md" a top-level file by its ending. */
export function matches (list, file) {
  return list.some((p) => (p.endsWith('/') ? file.startsWith(p) : p.startsWith('*.') ? !file.includes('/') && file.endsWith(p.slice(1)) : file === p))
}

/** A code change's lane: small when every file is in the small lane, otherwise normal. */
export function laneOf (rules, files) {
  const s = rules.codeChanges.smallLane
  return files.length && files.every((f) => matches(s.paths, f) && !matches(s.except ?? [], f)) ? 'small' : 'normal'
}

/** The files of a change that need a person's approval. */
export const needAPerson = (rules, files) => files.filter((f) => matches(rules.codeChanges.needAPerson, f))

/**
 * What a proposal waits for under these rules, or null when it may act. The facts, gathered by the room:
 *   kind, external (it acts outside), vetoed, acted, lane ('small' | 'normal' for code changes),
 *   proposedAt and yesTimes (ms), people (the people who said yes), owner (whose proposal it is),
 *   otherPeoplesAgents (how many different other people's agents approved), democracy ({ for, against } or null), now (ms)
 */
export function waitingFor (rules, f) {
  const p = rules.proposals, c = rules.codeChanges, minute = 60_000
  if (!f.external) return 'stays inside the workspace'
  if (f.vetoed) return 'vetoed'
  if (f.acted) return 'already acted on'
  const code = f.kind === 'workspace-change'
  if (code && f.lane === 'small') { const until = f.proposedAt + p.vetoWindowMinutes * minute; return f.now < until ? `small change: it goes live at ${new Date(until).toISOString()} unless someone holds it (veto)` : null }
  const people = f.people.filter((d) => p.personsOwnYesCounts || d !== f.owner)
  const byAgents = code && c.agentsMayApprove && f.otherPeoplesAgents >= c.agentsOfDifferentPeopleNeeded
  if (people.length < p.peopleNeeded && !byAgents) return code && c.agentsMayApprove ? `needs approval from ${c.agentsOfDifferentPeopleNeeded - f.otherPeoplesAgents} more person's agent(s) (or a person)` : `needs ${p.peopleNeeded - people.length} more human approval(s)`
  const quietUntil = Math.max(...f.yesTimes, 0) + p.vetoWindowMinutes * minute // the veto window runs from the latest yes
  if (f.now < quietUntil) return `veto window open until ${new Date(quietUntil).toISOString()}`
  if (f.democracy && p.democracyNeedsMoreForThanAgainst && f.democracy.for <= f.democracy.against) return `democracy: ${f.democracy.for} for, ${f.democracy.against} against`
  return null
}

/** Whether only its own person's yes let a proposal act: said openly on the change, while that rule is an open question. */
export const onlyOwnYes = (rules, f) => rules.proposals.personsOwnYesCounts && f.people.length > 0 && f.people.every((d) => d === f.owner) && !(f.kind === 'workspace-change' && rules.codeChanges.agentsMayApprove && f.otherPeoplesAgents >= rules.codeChanges.agentsOfDifferentPeopleNeeded)

/** The rules in effect: the agreed data, with what a host set for their room (only the settings it names). */
export function inEffect (agreed, set = {}) {
  const r = structuredClone(agreed)
  const put = (obj, key, v) => { if (v !== undefined && v !== null && !Number.isNaN(v)) obj[key] = v }
  put(r.proposals, 'peopleNeeded', set.approvalsRequired); put(r.proposals, 'vetoWindowMinutes', set.vetoWindowMinutes)
  put(r.codeChanges, 'agentsMayApprove', set.agentApprovals); put(r.codeChanges, 'agentsOfDifferentPeopleNeeded', set.agentApprovers)
  if (Array.isArray(set.protectedPaths)) r.codeChanges.needAPerson = [...new Set([...set.protectedPaths, 'rules.json', 'src/shared/rules.js'])] // the rules themselves always need a person
  put(r.votes, 'closeAfterMinutes', set.voteMinutes)
  return r
}

/** Where the rules in effect differ from the agreed ones, in plain words, for the Rules tab. */
export function differences (agreed, effect) {
  const out = []
  const say = (a, b, what) => { if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`${what}: ${JSON.stringify(b)} in this room (agreed: ${JSON.stringify(a)})`) }
  say(agreed.proposals.peopleNeeded, effect.proposals.peopleNeeded, 'people needed to approve')
  say(agreed.proposals.vetoWindowMinutes, effect.proposals.vetoWindowMinutes, 'veto window, in minutes')
  say(agreed.codeChanges.agentsMayApprove, effect.codeChanges.agentsMayApprove, 'agents may approve code changes')
  say(agreed.codeChanges.agentsOfDifferentPeopleNeeded, effect.codeChanges.agentsOfDifferentPeopleNeeded, 'agents of different people needed')
  say([...agreed.codeChanges.needAPerson].sort(), [...effect.codeChanges.needAPerson].sort(), 'files that need a person')
  say(agreed.votes.closeAfterMinutes, effect.votes.closeAfterMinutes, 'a vote closes after, in minutes')
  return out
}
