// The DTG context address: which one the room writes and which ones it reads.
// Three are in use among the projects here, second in a credential's @context:
//   registry-v1       https://registry.trustoverip.org/dtg/context/v1  the published one (OpenVTC accepts only this;
//                     Geb, and RLTP's encounter credentials: lib/src/encounter.ts line 25 at commit 48c5efb)
//   firstperson-wd01  https://firstperson.network/credentials/dtg/v1   the first draft's (RLTP's membership
//                     credentials, vouch and admission: lib/src/membership.ts line 28 at commit 48c5efb)
//   trustoverip-v1    https://trustoverip.org/dtg/credentials/v1        TrustStackers'
// Agreed in the room: read all three, write the registry one.
// Shared by the page, the server and agents: no Node-only or browser-only APIs.

export const DTG_CONTEXT = 'https://registry.trustoverip.org/dtg/context/v1'
export const DTG_CONTEXTS = Object.freeze({
  [DTG_CONTEXT]: 'registry-v1',
  'https://firstperson.network/credentials/dtg/v1': 'firstperson-wd01',
  'https://trustoverip.org/dtg/credentials/v1': 'trustoverip-v1',
})

// Looks like a DTG context address (so it must be one of the three): any address with a /dtg/ part.
const LOOKS_DTG = /\/dtg\//i

/** The DTG context a @context list carries, as { address, name, current }, or null when it carries none. */
export function dtgContextOf (ctx) {
  if (!Array.isArray(ctx)) return null
  const address = ctx.find((x) => typeof x === 'string' && Object.hasOwn(DTG_CONTEXTS, x))
  return address ? { address, name: DTG_CONTEXTS[address], current: address === DTG_CONTEXT } : null
}

/** What is wrong with the DTG part of a @context list, in words, or null: at most one DTG address, and one of the three. */
export function dtgContextProblem (ctx) {
  if (!Array.isArray(ctx)) return null
  const dtg = ctx.filter((x) => typeof x === 'string' && (Object.hasOwn(DTG_CONTEXTS, x) || LOOKS_DTG.test(x)))
  const unknown = dtg.find((x) => !Object.hasOwn(DTG_CONTEXTS, x))
  if (unknown) return `@context: ${unknown} is not a DTG context address the room reads (${Object.keys(DTG_CONTEXTS).join(', ')})`
  if (dtg.length > 1) return '@context: one DTG context address at most'
  return null
}
