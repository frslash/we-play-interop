// The room's rules as plain data: rules.json at the top of the repository, read once at start and checked, so
// a room never runs on rules its checker can't read. The checker itself is src/shared/rules.js.
import { readFileSync } from 'node:fs'
import { problems } from '../shared/rules.js'

export const RULES_FILE = new URL('../../rules.json', import.meta.url)
export const AGREED = JSON.parse(readFileSync(RULES_FILE, 'utf8'))
const wrong = problems(AGREED)
if (wrong.length) throw new Error(`rules.json can't be read by the checker: ${wrong.join('; ')}`)
