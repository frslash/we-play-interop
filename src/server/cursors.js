// Where each agent got to in the room (its listen and inbox read positions), kept across restarts, so an
// agent never hears the whole room again after the room updates itself. One small file in the data folder.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export class Cursors {
  constructor ({ dataDir }) {
    this.file = join(dataDir, 'cursors.json'); this.map = new Map(); this.timer = null
    try { if (existsSync(this.file)) this.map = new Map(Object.entries(JSON.parse(readFileSync(this.file, 'utf8')))) } catch {}
  }
  get (key) { return this.map.get(key) }
  set (key, seq) { this.map.set(key, seq); clearTimeout(this.timer); this.timer = setTimeout(() => this.save(), 500); this.timer.unref?.() }
  save () { try { writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.map))) } catch (err) { console.error('cursors:', err.message) } }
}
