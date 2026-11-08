// Each person's "never say" list, kept as salted hashes: the person's browser holds the words, the room
// holds only sha256(salt + phrase) for each, so it can refuse a line of theirs (or their agent's) that
// contains one, without the list itself ever being on the server as text. A short, common word can still
// be guessed by someone with the server and time; the safety card says so.
import { randomBytes } from 'node:crypto'
import { sha256, toHex } from '../shared/crypto.js'
import { phrases, textsOf } from '../shared/guard.js'

export const MAX_ENTRIES = 200
export const hashOf = (salt, key) => toHex(sha256(`${salt}\n${key}`))

export class NeverLists {
  constructor ({ db }) { this.db = db; this.lists = new Map() } // principal -> { salt, hashes:Set }
  async load () {
    const { rows } = await this.db.query('select principal, salt, hashes from never_say')
    for (const r of rows) this.lists.set(r.principal, { salt: r.salt, hashes: new Set(JSON.parse(r.hashes)) })
  }
  /** The person's salt (made on first ask) and how many entries the room holds for them. */
  async get (principal) {
    let l = this.lists.get(principal)
    if (!l) { l = { salt: toHex(randomBytes(16)), hashes: new Set() }; await this.save(principal, l) }
    return { salt: l.salt, count: l.hashes.size }
  }
  async set (principal, hashes) {
    const l = this.lists.get(principal) ?? { salt: toHex(randomBytes(16)), hashes: new Set() }
    l.hashes = new Set(hashes.slice(0, MAX_ENTRIES))
    await this.save(principal, l)
    return { salt: l.salt, count: l.hashes.size }
  }
  async save (principal, l) {
    this.lists.set(principal, l)
    await this.db.query('delete from never_say where principal = $1', [principal])
    await this.db.query('insert into never_say (principal, salt, hashes, set_at) values ($1, $2, $3, $4)', [principal, l.salt, JSON.stringify([...l.hashes]), new Date().toISOString()])
  }
  /** Why a line of this person's (or their agent's) must not be posted, or null. Names where, never what. */
  check (principal, payload) {
    const l = this.lists.get(principal)
    if (!l?.hashes.size) return null
    for (const t of textsOf(payload)) {
      for (const p of phrases(t)) {
        if (l.hashes.has(hashOf(l.salt, p.key))) return `This has something from your person's never-say list (word ${p.word}${p.n > 1 ? ` to ${p.word + p.n - 1}` : ''} of that text), so it was not posted. Say it without that and send it again.`
      }
    }
    return null
  }
}
