import { test } from 'node:test'
import assert from 'node:assert/strict'
import { githubCode } from '../src/server/code.js'

const fakeGh = (state) => async (method, path) => {
  state.calls.push(path)
  if (path.includes('/commits/')) return { sha: state.head }
  if (path.includes('/git/trees/')) return { tree: [{ type: 'blob', path: 'public/rules.js', size: 5, sha: 'b1' }, { type: 'blob', path: 'node_modules/x/y.js', size: 1, sha: 'b2' }, { type: 'blob', path: 'secrets.env', size: 1, sha: 'b3' }] }
  if (path.includes('/git/blobs/')) return { encoding: 'base64', content: Buffer.from(`line1\nline2 of ${state.head}`).toString('base64') }
  throw new Error('unexpected ' + path)
}

test('read_code serves GitHub main and names the commit it read', async () => {
  const state = { head: 'aaa', calls: [] }
  const code = githubCode({ repo: 'o/r', gh: fakeGh(state), ttlMs: 0 })
  const list = await code.files()
  assert.equal(list.commit, 'aaa')
  assert.deepEqual(list.files.map((f) => f.path), ['public/rules.js'])
  const r = await code.read('./public/rules.js', { from: 2 })
  assert.equal(r.commit, 'aaa'); assert.equal(r.text, 'line2 of aaa')
  await assert.rejects(code.read('secrets.env'), /not one of the room's code files/)
  state.head = 'bbb' // main moved on: the next read follows it
  assert.equal((await code.read('public/rules.js', { from: 2 })).commit, 'bbb')
})
