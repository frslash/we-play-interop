// A relay operator's check: "I held only sealed messages, and could read none of them."
// The senders put a fresh marker (a random word only they know until the check) inside the
// plaintext of each message they send through the relay. Afterwards the operator runs this
// over everything the relay kept: every stored message, and its logs if it has them. If no
// marker shows up in any common encoding, the relay held nothing it could read.
// It reports counts, positions and encodings only, never message content.
// It does not know any relay's format: it reads whatever the operator exports (strings,
// bytes or JSON objects). Plain module, shared by the browser, the server and the bridge.
import { fromUtf8, toHex, utf8 } from './crypto.js'

export const MIN_MARKER_CHARS = 16

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
/** Base64 of whole 3-byte groups only (a trailing partial group is dropped: it depends on what follows). */
function base64Groups (bytes) {
  let out = ''
  for (let i = 0; i + 3 <= bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63]
  }
  return out
}

/** Every way a marker could appear in a stored message if the relay could read it. */
export function markerForms (marker) {
  if (typeof marker !== 'string' || marker.length < MIN_MARKER_CHARS) throw new Error(`a marker is a string of at least ${MIN_MARKER_CHARS} characters`)
  const bytes = utf8(marker), hex = toHex(bytes)
  const forms = [['plain', marker], ['hex', hex], ['HEX', hex.toUpperCase()]]
  // In base64 the marker's text depends on where it falls in a 3-byte group: try all three.
  for (let i = 0; i < 3; i++) {
    const b = base64Groups(bytes.slice(i))
    forms.push(['base64', b], ['base64url', b.replaceAll('+', '-').replaceAll('/', '_')])
  }
  return forms
}

const asText = (m) => typeof m === 'string' ? m : m instanceof Uint8Array ? fromUtf8(m) + '\n' + toHex(m) : JSON.stringify(m)

/**
 * held: everything the relay kept (array of strings, Uint8Arrays or JSON values).
 * markers: the senders' markers, revealed to the operator only after the messages went through.
 * Returns { held, sealed, readable: [{ index, marker, encoding }], ok }. `marker` is the marker's
 * position in the list, not its text; nothing from a message is copied into the report.
 */
export function checkRelayHold (held, markers) {
  if (!Array.isArray(held)) throw new Error('held is the list of everything the relay kept')
  if (!Array.isArray(markers) || markers.length === 0) throw new Error('at least one marker is needed, or the check shows nothing')
  const forms = markers.map(markerForms)
  const readable = []
  held.forEach((m, index) => {
    const text = asText(m)
    forms.forEach((fs, marker) => {
      const hit = fs.find(([, f]) => f && text.includes(f))
      if (hit) readable.push({ index, marker, encoding: hit[0] })
    })
  })
  const bad = new Set(readable.map((r) => r.index))
  return { held: held.length, sealed: held.length - bad.size, readable, ok: held.length > 0 && readable.length === 0 }
}
