// The guard: what must never enter the room's permanent record. Everything here is public and can never
// be taken back, so a line that looks like a key, a token or a private link is refused before it is
// written, and its author (a person, or an agent through its tool) is told what to take out and rewrite.
// The page runs it before signing; the room runs it again on every line it is sent.
// A person's own "never say" list is not here: it is kept as salted hashes (see neverHashes), so the room
// can check a line against it without ever holding the words themselves.

const SECRETS = [
  ['an API key', /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{20,}/],
  ['a GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/],
  ['a cloud access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{35}\b/],
  ['a chat-app token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['a login token', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['an agent’s private connector link', /\/mcp\/a\/[A-Za-z0-9_-]{16,}/],
  ['a link with a secret in it', /[?&#](?:token|key|secret|password|passwd|sig|signature|access_token|api_key|apikey|auth)=[^\s&#]{8,}/i],
  ['a password', /\b(?:password|passwd|passcode)\s*[:=]\s*\S{6,}/i],
]

/** The first thing in the text that looks like a secret: { what, at }, or null. */
export function findSecret (text) {
  const s = String(text ?? '')
  for (const [what, re] of SECRETS) { const m = re.exec(s); if (m) return { what, at: m.index } }
  return null
}

/** Every piece of a document's payload that people read: the text fields, and lists of them. */
export function textsOf (payload) {
  const out = []
  const walk = (v, depth = 0) => {
    if (depth > 3 || v == null) return
    if (typeof v === 'string') out.push(v)
    else if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1))
    else if (typeof v === 'object') Object.values(v).forEach((x) => walk(x, depth + 1))
  }
  walk(payload)
  return out
}

/** Why a document must not be posted, in words for its author, or null. */
export function secretIn (payload) {
  for (const t of textsOf(payload)) {
    const hit = findSecret(t)
    if (hit) return `This looks like ${hit.what}, so it was not posted: everything in this room is permanent and every member reads it. Take it out (or describe it without the secret part) and send it again.`
  }
  return null
}

// ---------- a person's never-say list, as salted hashes ----------
export const NEVER_MAX_WORDS = 4 // the longest phrase a list entry can be; a line is checked in runs of up to this many words
const words = (text) => String(text ?? '').toLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}]+/u).filter(Boolean)

/** One entry (a word, a name, a short phrase) as the words it is matched on. */
export const neverKey = (entry) => words(entry).slice(0, NEVER_MAX_WORDS).join(' ')

/** The runs of 1..NEVER_MAX_WORDS words in a text, each with where it starts (its word number). */
export function phrases (text) {
  const w = words(text), out = []
  for (let i = 0; i < w.length; i++) for (let n = 1; n <= NEVER_MAX_WORDS && i + n <= w.length; n++) out.push({ key: w.slice(i, i + n).join(' '), word: i + 1, n })
  return out
}
