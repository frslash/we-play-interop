import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { MAX_MENTIONS, matchRank, mentionOptions } from '../src/shared/mentions.js'

// The Talk box's @ list (room lines 917-924): typing "@F" shows Fern and, under him, "Fern's agent, Ember".
const people = [
  { did: 'p1', kind: 'human', name: 'Fern' },
  { did: 'a1', kind: 'agent', name: 'Ember', principal: 'p1', delegation: 'h1' },
  { did: 'p2', kind: 'human', name: 'Arlo' },
  { did: 'a2', kind: 'agent', name: 'Echo', principal: 'p2', delegation: 'h2' },
  { did: 'p3', kind: 'human', name: 'Mika' },
  { did: 'a3', kind: 'agent', name: "Mika's Claude", principal: 'p3', delegation: 'h3' },
  { did: 'a4', kind: 'agent', name: 'Old helper', principal: 'p1', removed: true },
  { did: 'a5', kind: 'agent', name: 'Fading bot', principal: 'p2', delegation: null },
  { did: 'c1', kind: 'human', name: 'Room check' },
]

describe('the @ list', () => {
  test('a person comes first, with their agents under them', () => {
    const rows = mentionOptions(people, 'F')
    assert.deepEqual(rows.map((r) => r.label), ['Fern', "Fern's agent, Ember"])
    assert.deepEqual(rows.map((r) => r.name), ['Fern', 'Ember'], 'picking the agent row names the agent, which wakes it')
    assert.deepEqual(rows.map((r) => r.under), [false, true])
  })

  test('an agent found by its own name is still shown with its person', () => {
    assert.deepEqual(mentionOptions(people, 'em').map((r) => r.label), ["Fern's agent, Ember"])
    assert.deepEqual(mentionOptions(people, 'claude').map((r) => r.label), ["Mika's agent, Mika's Claude"], 'a later word matches too')
  })

  test('people first, then agents found by their own name, removed or switched-off agents and left-out accounts never', () => {
    const rows = mentionOptions(people, 'e')
    assert.deepEqual(rows.map((r) => r.label), ["Arlo's agent, Echo", "Fern's agent, Ember"])
    assert.ok(!mentionOptions(people, 'old').length, 'a removed agent is not offered')
    assert.ok(!mentionOptions(people, 'fading').length, 'an agent with no live permission is not offered')
    assert.ok(!mentionOptions(people, 'room', { skip: (did) => did === 'c1' }).length, 'the room check\'s accounts are left out')
  })

  test('a bare @ lists everyone, people with their agents, at most eight rows', () => {
    const many = [...people, ...Array.from({ length: 10 }, (_, i) => ({ did: `x${i}`, kind: 'human', name: `Person ${i}` }))]
    const rows = mentionOptions(many, '')
    assert.equal(rows.length, MAX_MENTIONS); assert.equal(MAX_MENTIONS, 8)
    assert.equal(rows[0].label, 'Arlo'); assert.equal(rows[1].label, "Arlo's agent, Echo")
  })

  test('the start of a name ranks above the start of a later word', () => {
    assert.equal(matchRank('Fern', 'fe'), 0); assert.equal(matchRank("Mika's Claude", 'cl'), 1); assert.equal(matchRank('Arlo', 'z'), -1)
    const rows = mentionOptions([{ did: 'q1', kind: 'human', name: 'Mara Lee' }, { did: 'q2', kind: 'human', name: 'Lee Park' }], 'lee')
    assert.deepEqual(rows.map((r) => r.label), ['Lee Park', 'Mara Lee'])
  })
})
