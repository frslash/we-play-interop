import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { computeMap, sameAddress } from '../src/server/map.js'

// One project added twice, once from the DTG board and once by a person in the room, is one project on the
// map (the room's two Keyring entries, room lines 736-738): matched by slug or by its address.
const today = new Date()
const date = today.toISOString().slice(0, 10)
const board = {
  generated: date,
  projects: [
    { slug: 'wallet', name: 'Wallet (a lab)', repositories: ['https://github.com/example/wallet-app'], purpose: 'A wallet.', facets: { didMethods: ['did:key'] } },
    { slug: 'other', name: 'Other', website: 'https://other.example' },
  ],
  runs: [],
}
const state = (projects, runs = [], people = []) => ({
  mapProjects: new Map(projects.map((p) => [p.slug, { ways: [], about: '', ...p }])),
  mapWays: new Map(), mapRuns: runs,
  participants: new Map(people.map((p, i) => [`did:key:z${i}`, { kind: 'human', ...p }])),
})

describe('the map joins a project added from two sources', () => {
  test('addresses compare however they are written', () => {
    assert.equal(sameAddress('https://www.GitHub.com/example/wallet-app.git/'), 'github.com/example/wallet-app')
    assert.equal(sameAddress('github.com/example/wallet-app'), 'github.com/example/wallet-app')
    assert.equal(sameAddress(''), null)
  })

  test('a room entry with the board entry\'s address merges into it, and its slug becomes another name', () => {
    const st = state(
      [{ slug: 'example-wallet-app', name: 'wallet-app', url: 'https://github.com/example/wallet-app/', ways: ['did:webvh'], addedBy: 'did:key:zperson' }, { slug: 'meshnet', name: 'Meshnet', url: 'https://mesh.example', ways: ['did:key'] }],
      [{ sides: ['example-wallet-app', 'meshnet'], date, reported: false, results: [{ way: 'did:key', outcome: 'pass' }] }],
      [{ name: 'Person A', projects: ['example-wallet-app'] }],
    )
    const m = computeMap({ board, state: st, today })
    const wallets = m.projects.filter((p) => /wallet/i.test(p.name))
    assert.equal(wallets.length, 1, 'one project, not two')
    const w = wallets[0]
    assert.equal(w.slug, 'wallet'); assert.equal(w.name, 'Wallet (a lab)', 'the board keeps its slug and name, since its runs use them')
    assert.deepEqual(w.sources, ['dtg', 'workspace']); assert.deepEqual(w.aliases, ['example-wallet-app'])
    assert.ok(w.ways.includes('did:webvh') && w.ways.includes('did:key'), 'the ways of both entries')
    assert.deepEqual(w.members, ['Person A'], 'people who joined for either slug')
    assert.deepEqual(m.aliases, { 'example-wallet-app': 'wallet' })
    assert.ok(m.pairs.some((p) => p.pair.join('|') === 'meshnet|wallet'), 'a run entered under the other slug counts for the project')
    assert.equal(m.score.passingPairs, 1)
    assert.ok(!('urls' in w), 'the address list stays inside')
  })

  test('two room entries with one address merge; different addresses stay apart', () => {
    const st = state([{ slug: 'a1', name: 'A', url: 'https://a.example/' }, { slug: 'a2', name: 'A again', url: 'http://www.a.example' }, { slug: 'b', name: 'B', url: 'https://b.example' }])
    const m = computeMap({ board: { ...board, projects: [] }, state: st, today })
    assert.deepEqual(m.projects.map((p) => p.slug).sort(), ['a1', 'b'])
    assert.deepEqual(m.aliases, { a2: 'a1' })
  })

  test('a room entry with no address and a new slug stays its own project', () => {
    const m = computeMap({ board, state: state([{ slug: 'loner', name: 'Loner', url: null }]), today })
    assert.ok(m.projects.some((p) => p.slug === 'loner')); assert.deepEqual(m.aliases, {})
  })
})
