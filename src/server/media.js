// Photos in the room. A photo is stored once, under the sha256 of its bytes, and a message carries only
// that hash (and its size), so the signed record stays small and still proves which picture was meant.
// Pages re-encode a photo before sending it, which drops its location and camera data; the room refuses a
// JPEG that still carries Exif data. Photos are public and permanent like everything else here.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { findSecret } from '../shared/guard.js'

export const TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf', 'application/msword': 'doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx', 'text/plain': 'txt', 'text/markdown': 'md', 'text/csv': 'csv' }
export const IMAGES = ['image/jpeg', 'image/png', 'image/webp']
export const MAX_DOC = 10 * 1024 * 1024 // a long report or a deck; anything bigger belongs somewhere made for big files
export const MAX_BYTES = 3 * 1024 * 1024 // a phone photo after the page shrinks it to 1600 px is far under this
const PER_HOUR = 40 // photos a person (with their agents) can add in an hour: room for a busy conversation, not a dump

export class Media {
  constructor ({ dataDir }) { this.dir = join(dataDir, 'media'); mkdirSync(this.dir, { recursive: true }); this.recent = new Map() }
  pathOf (sha) { for (const ext of Object.values(TYPES)) { const p = join(this.dir, `${sha}.${ext}`); if (existsSync(p)) return { path: p, ext } } return null }
  /** Store one photo for a person; returns { sha256, type, bytes } or throws with words for the person. */
  put (principal, type, bytes) {
    if (!TYPES[type]) throw new Error('a file here is a photo (JPEG, PNG, WebP), a PDF, a Word, Excel or PowerPoint file, or plain text')
    const max = IMAGES.includes(type) ? MAX_BYTES : MAX_DOC
    if (!bytes.length || bytes.length > max) throw new Error(`that file is too big (at most ${max / 1024 / 1024} MB)`)
    if (type.startsWith('text/')) { const leak = findSecret(bytes.toString('utf8')); if (leak) throw new Error(`that file contains what looks like ${leak.what}, so the room did not take it: everything here is public`) }
    if (!sniff(type, bytes)) throw new Error('that file is not the image it says it is')
    if (type === 'image/jpeg' && hasExif(bytes)) throw new Error('that photo still carries its camera and location data; send it through the page, which removes it')
    const now = Date.now(), times = (this.recent.get(principal) ?? []).filter((t) => now - t < 3_600_000)
    if (times.length >= PER_HOUR) throw new Error(`at most ${PER_HOUR} photos an hour`)
    this.recent.set(principal, [...times, now])
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if (!this.pathOf(sha256)) writeFileSync(join(this.dir, `${sha256}.${TYPES[type]}`), bytes)
    return { sha256, type, bytes: bytes.length }
  }
  get (sha) { const f = this.pathOf(sha); return f ? { bytes: readFileSync(f.path), type: Object.keys(TYPES).find((t) => TYPES[t] === f.ext) } : null }
}

function sniff (type, b) {
  if (type === 'image/jpeg') return b[0] === 0xff && b[1] === 0xd8
  if (type === 'image/png') return b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  if (type === 'image/webp') return b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP'
  if (type === 'application/pdf') return b.subarray(0, 5).toString() === '%PDF-'
  if (type === 'application/msword') return b.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))
  if (type.startsWith('application/vnd.openxmlformats')) return b[0] === 0x50 && b[1] === 0x4b // a zip, as every Office file is
  if (type.startsWith('text/')) return !b.subarray(0, 8192).includes(0)
  return false
}
// an APP1 segment that starts "Exif" before the image data begins
function hasExif (b) {
  for (let i = 2; i + 10 < b.length && b[i] === 0xff;) {
    const marker = b[i + 1], len = b.readUInt16BE(i + 2)
    if (marker === 0xda) return false
    if (marker === 0xe1 && b.subarray(i + 4, i + 8).toString() === 'Exif') return true
    i += 2 + len
  }
  return false
}
