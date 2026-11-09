// The public pull-request reader (src/server/code.js pullDiff) spends the room's GitHub allowance, which it also merges
// with: new lookups are capped per minute, while pull requests it already holds keep being served.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { githubCode } from '../src/server/code.js'

const fake = (calls) => async (method, path) => {
  calls.push(path)
  const m = /^\/repos\/example\/room\/pulls\/(\d+)(\/files.*)?$/.exec(path.split('?')[0] + (path.includes('/files') ? '/files' : ''))
  if (!m) throw new Error('unexpected ' + path)
  if (m[2]) return [{ filename: 'a.js', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n+x' }]
  return { number: Number(m[1]), title: `change ${m[1]}`, state: 'open', head: { sha: m[1].padStart(40, '0') }, base: { ref: 'main' } }
}

describe('the pull-request reader keeps the room’s GitHub allowance for merging', () => {
  test('at most so many new lookups a minute; held ones are still served; the cap says why', async () => {
    const calls = []
    const code = githubCode({ repo: 'example/room', gh: fake(calls), ttlMs: 60_000, pullsPerMinute: 2 })
    assert.match((await code.pullDiff(1)).text, /Pull request #1/)
    assert.match((await code.pullDiff(2)).text, /Pull request #2/)
    const used = calls.length
    await assert.rejects(code.pullDiff(3), (err) => err.status === 429 && /at most 2 pull requests a minute/.test(err.message))
    assert.equal(calls.length, used, 'a capped lookup asks GitHub nothing')
    assert.match((await code.pullDiff(1)).text, /Pull request #1/, 'one it holds is still served')
    assert.equal(calls.length, used)
  })
})
