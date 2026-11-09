import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { newIdentity } from '../src/shared/did.js'
import { checkLine, createRecord, lineHash, makeLine, sameLine } from '../src/shared/line.js'

// A relay run by a third party: it only stores and hands on bytes, and may tamper with them.
function relay ({ tamper } = {}) {
  const boxes = new Map()
  return {
    put (to, bytes) { boxes.set(to, [...(boxes.get(to) ?? []), tamper ? tamper(bytes) : bytes]) },
    take (to) { const got = boxes.get(to) ?? []; boxes.delete(to); return got },
  }
}

test('a line sent through a third-party relay shows the same hash in both records', () => {
  const ann = newIdentity(), ben = newIdentity()
  const r = relay(), annRec = createRecord(ann.did), benRec = createRecord(ben.did)
  const line = makeLine(ann, { to: ben.did, text: 'hello from Ann’s agent' })
  const sent = annRec.add(line, { via: 'relay.example' })
  assert.equal(sent.ok, true)
  r.put(ben.did, JSON.stringify(line))
  const [bytes] = r.take(ben.did)
  const took = benRec.add(JSON.parse(bytes), { via: 'relay.example' })
  assert.equal(took.ok, true)
  assert.equal(took.hash, sent.hash)
  assert.equal(took.row.direction, 'took')
  const same = sameLine(annRec.rows(), benRec.rows(), sent.hash)
  assert.equal(same.ok, true, same.reason)
  assert.equal(same.from, ann.did)
  assert.equal(same.to, ben.did)
})

test('a relay that changes a line is caught', () => {
  const ann = newIdentity(), ben = newIdentity()
  const r = relay({ tamper: (b) => b.replace('pay 1', 'pay 100') })
  r.put(ben.did, JSON.stringify(makeLine(ann, { to: ben.did, text: 'pay 1' })))
  const got = createRecord(ben.did).add(JSON.parse(r.take(ben.did)[0]))
  assert.equal(got.ok, false)
  assert.match(got.reason, /signature/)
})

test('a line signed by someone other than its issuer is refused', () => {
  const ann = newIdentity(), ben = newIdentity(), eve = newIdentity()
  const forged = { ...makeLine(eve, { to: ben.did, text: 'hi' }), issuer: ann.did }
  assert.equal(checkLine(forged).ok, false)
})

test('a record keeps a line once, and only its own lines', () => {
  const ann = newIdentity(), ben = newIdentity(), cy = newIdentity()
  const line = makeLine(ann, { to: ben.did, text: 'once' })
  const rec = createRecord(ben.did)
  assert.equal(rec.add(line).ok, true)
  assert.equal(rec.add(line).already, true)
  assert.equal(rec.rows().length, 1)
  assert.equal(createRecord(cy.did).add(line).ok, false)
})

test('sameLine recomputes hashes and needs one sender and one taker', () => {
  const ann = newIdentity(), ben = newIdentity()
  const line = makeLine(ann, { to: ben.did, text: 'check me' })
  const a = createRecord(ann.did), b = createRecord(ben.did)
  const h = a.add(line).hash
  b.add(line)
  assert.equal(h, lineHash(line))
  const lying = b.rows().map((row) => ({ ...row, line: { ...row.line, payload: { text: 'other' } } }))
  assert.equal(sameLine(a.rows(), lying, h).ok, false)
  assert.equal(sameLine(a.rows(), a.rows(), h).ok, false)
  assert.equal(sameLine(a.rows(), [], h).ok, false)
})

test('the command line tool: say on one side, take on the other, same on both', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wpi-line-'))
  const ann = newIdentity(), ben = newIdentity()
  const run = (who, args, input) => execFileSync(process.execPath, ['agent/line.js', ...args], {
    input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, WPI_AGENT_KEY: who.seedHex, WPI_LINES: join(dir, who === ann ? 'ann.jsonl' : 'ben.jsonl') },
  })
  assert.equal(run(ann, ['me']).trim(), ann.did)
  const line = run(ann, ['say', '--to', ben.did, '--text', 'hello Ben', '--via', 'relay.example'])
  writeFileSync(join(dir, 'carried.json'), line)
  const took = run(ben, ['take', join(dir, 'carried.json'), '--via', 'relay.example'])
  const hash = lineHash(JSON.parse(line))
  assert.match(took, new RegExp(`took line ${hash}`))
  assert.match(run(ben, ['same', join(dir, 'ann.jsonl'), hash]), /^yes: both copies show line/)
  assert.match(run(ann, ['same', join(dir, 'ben.jsonl'), hash]), /^yes/)
  assert.match(run(ben, ['show']), new RegExp(`${hash} took from ${ann.did}`))
  assert.equal(readFileSync(join(dir, 'ben.jsonl'), 'utf8').trim().split('\n').length, 1)
})
