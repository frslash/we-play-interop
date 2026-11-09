// The relay operator's check: only sealed messages held, none readable (marker absent).
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { checkRelayHold, markerForms } from '../src/shared/relay-hold.js'
import { newRoomKey, sealNote } from '../src/shared/sealed.js'
import { randomBytes, toHex, utf8 } from '../src/shared/crypto.js'

const marker = () => 'MARKER-' + toHex(randomBytes(12))
const b64 = (s) => btoa(String.fromCharCode(...utf8(s)))

describe('relay hold check', () => {
  test('sealed messages: every one held, none readable', async () => {
    const key = newRoomKey(), m = marker()
    const held = []
    for (let i = 0; i < 5; i++) held.push(await sealNote(key, { room: 'did:key:room', recordId: 'r' + i, epoch: 0 }, `message ${i} ${m}`))
    held.push({ kind: 1059, content: b64(await sealNote(key, { room: 'did:key:room', recordId: 'x', epoch: 0 }, m)) })
    const r = checkRelayHold(held, [m])
    assert.deepEqual(r, { held: 6, sealed: 6, readable: [], ok: true })
  })

  test('a readable message is caught in plain text, hex, base64 at every offset, base64url, bytes and JSON', () => {
    const m = marker()
    const held = [
      'hello ' + m,
      toHex(utf8('x' + m)),
      toHex(utf8(m)).toUpperCase(),
      b64(m), b64('a' + m), b64('ab' + m),
      b64('abc?>' + m).replaceAll('+', '-').replaceAll('/', '_'),
      utf8('bytes ' + m),
      { content: 'note: ' + m },
    ]
    const r = checkRelayHold(held, [m])
    assert.equal(r.ok, false)
    assert.equal(r.sealed, 0)
    assert.deepEqual(r.readable.map((x) => x.index), held.map((_, i) => i))
  })

  test('the report names positions and encodings, never content or the marker', () => {
    const m = marker()
    const r = checkRelayHold(['secret words ' + m, 'ffff'], [m])
    const s = JSON.stringify(r)
    assert.ok(!s.includes(m) && !s.includes('secret'))
    assert.deepEqual(r.readable, [{ index: 0, marker: 0, encoding: 'plain' }])
    assert.equal(r.sealed, 1)
  })

  test('an empty hold or no markers shows nothing, so it does not pass', () => {
    assert.equal(checkRelayHold([], [marker()]).ok, false)
    assert.throws(() => checkRelayHold(['x'], []))
    assert.throws(() => markerForms('short'))
  })
})
