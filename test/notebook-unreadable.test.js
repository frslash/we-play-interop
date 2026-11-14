// A stored notebook that can't be opened is refused, never read as empty (the next note used to wipe it).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Notebooks } from '../src/server/notebook.js'
import { TaskError } from '../src/server/log.js'

function fakeDb () {
  const rows = new Map()
  return {
    rows,
    async query (sql, args) {
      if (sql.startsWith('select')) return { rows: rows.has(args[0]) ? [rows.get(args[0])] : [] }
      if (sql.startsWith('delete')) { rows.delete(args[0]); return { rows: [] } }
      if (sql.startsWith('insert')) { rows.set(args[0], { notes_enc: args[1], read_up_to: args[3] }); return { rows: [] } }
      if (sql.startsWith('update')) { const r = rows.get(args[0]); if (r) r.read_up_to = args[1]; return { rows: [] } }
      throw new Error('unexpected sql ' + sql)
    },
  }
}
const goodSealer = { seal: (t) => 'ok:' + t, open: (s) => { if (!s.startsWith('ok:')) throw new Error('bad tag'); return s.slice(3) } }
const wrongKey = { seal: goodSealer.seal, open: () => { throw new Error('unable to authenticate data') } }

test('a notebook the key cannot open is refused on read and on add, and the stored copy is untouched', async () => {
  const db = fakeDb()
  const first = new Notebooks({ db, sealer: goodSealer })
  await first.add('agent-1', 'person', 'one')
  await first.add('agent-1', 'agent', 'two')
  const stored = db.rows.get('agent-1').notes_enc

  const after = new Notebooks({ db, sealer: wrongKey }) // e.g. a restart with a different WORKSPACE_KEY
  await assert.rejects(after.get('agent-1'), (e) => e instanceof TaskError && e.code === 'notebookUnreadable' && e.status === 503)
  await assert.rejects(after.add('agent-1', 'person', 'three'), (e) => e instanceof TaskError && e.code === 'notebookUnreadable')
  assert.equal(db.rows.get('agent-1').notes_enc, stored, 'the earlier notes are still stored')
  assert.ok(!/one|two/.test(String((await after.get('agent-1').catch((e) => e)).message)), 'the refusal names no content')

  const back = new Notebooks({ db, sealer: goodSealer }) // the right key again: everything is there
  assert.deepEqual((await back.get('agent-1')).map((n) => n.text), ['one', 'two'])
})

test('no stored notebook still starts empty', async () => {
  const nb = new Notebooks({ db: fakeDb(), sealer: wrongKey })
  assert.deepEqual(await nb.get('agent-new'), [])
})

test('adding a note is one write: if it fails, the notebook stored before it is still whole', async () => {
  const db = fakeDb(), seen = []
  const query = db.query.bind(db)
  db.query = async (sql, args) => { seen.push(sql.split(' ')[0]); return query(sql, args) }
  const nb = new Notebooks({ db, sealer: goodSealer })
  await nb.add('did:key:zAgent', 'person', 'first')
  assert.deepEqual(seen.filter((w) => w !== 'select'), ['insert'], 'no delete before the write')
  const stored = db.rows.get('did:key:zAgent').notes_enc
  db.query = async (sql, args) => { if (sql.startsWith('insert')) throw new Error('connection dropped'); return query(sql, args) }
  await assert.rejects(nb.add('did:key:zAgent', 'person', 'second'))
  assert.equal(db.rows.get('did:key:zAgent').notes_enc, stored, 'the earlier notebook is untouched')
})
