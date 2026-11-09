// A seat is an agent's signed permission: what it may do, and until when. Most seats last 90 days, but the page's
// own form starts at a week, and a week-long seat strands its agent quietly when it runs out (three seats in the
// room were due to end the same week, 2026-11-09). So the page offers to renew a seat while it still runs: the same
// permission and the same asks, its end moved out, signed by its person like any permission.
export const RENEW_DAYS = 90 // what every other seat gets: hosted agents, the room's check agent, a mode change near the end
// Shown in a seat's last two weeks: early enough that a person who opens the page once a week sees it twice
// before their agent stops, late enough that a fresh 90-day seat never nags.
export const RENEW_WITHIN_DAYS = 14
const DAY = 86_400_000

/** Whether to offer renewing an agent's seat now: { days left, until } while it runs and ends within two weeks, else null. */
export function renewal (agent, now = Date.now()) {
  const end = Date.parse(agent?.until ?? '')
  if (!agent?.delegation || !Number.isFinite(end) || end <= now) return null
  const days = Math.ceil((end - now) / DAY)
  return days <= RENEW_WITHIN_DAYS ? { days, until: new Date(end).toISOString() } : null
}

/** The permission a renewal signs: the same scope, asks and name, ending RENEW_DAYS from now. */
export function renewed (agent, scopes, now = Date.now()) {
  return {
    payload: { delegate: agent.did, scope: agent.scope?.length ? [...agent.scope] : [...scopes], ask: [...(agent.ask ?? [])], label: agent.name },
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + RENEW_DAYS * DAY).toISOString(),
  }
}
