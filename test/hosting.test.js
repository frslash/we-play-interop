// The one-server set-up (docker-compose.yml, deploy/Caddyfile, .env.example), read as TEXT.
// No Docker runs here (and none is needed to run this file), so this proves what the files SAY, not that they work:
// it catches the edits that would quietly undo the set-up (an unpinned image, a published room port, a caller-address
// setting left behind without the unpublished port that makes it safe). That the stack really starts, gets its
// certificate and answers is checked only by running `docker compose up` on a server (docs/hosting.md, "Check it works").
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'

const root = join(import.meta.dirname, '..')
const read = (p) => readFileSync(join(root, p), 'utf8')
const compose = read('docker-compose.yml'), caddyfile = read('deploy/Caddyfile'), envExample = read('.env.example')
const noComments = (t) => t.split('\n').map((l) => l.replace(/(^|\s)#.*$/, '')).join('\n')

// Compose's layout is fixed enough to read without a YAML parser: top-level keys at column 0, services at two spaces.
function blocks (text, top) {
  const lines = noComments(text).split('\n'), out = {}
  const start = lines.findIndex((l) => l === `${top}:`)
  assert.ok(start >= 0, `${top}: is in the compose file`)
  let name = null
  for (const l of lines.slice(start + 1)) {
    if (/^\S/.test(l)) break
    const m = /^ {2}([A-Za-z0-9_-]+):/.exec(l)
    if (m) { name = m[1]; out[name] = []; continue }
    if (name) out[name].push(l)
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.join('\n')]))
}
const services = blocks(compose, 'services'), volumes = blocks(compose, 'volumes')
const hasPorts = (block) => /^ {4}ports:/m.test(block)

describe('the compose file', () => {
  test('has the room and Caddy, and nothing else (no database with a fixed password)', () => {
    assert.deepEqual(Object.keys(services).sort(), ['caddy', 'room'])
  })
  test("Caddy's image is pinned by digest, to an exact version", () => {
    assert.match(services.caddy, /^ {4}image: caddy:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}\s*$/m)
  })
  test('only Caddy publishes ports, and only 80 and 443', () => {
    assert.equal(hasPorts(services.room), false, 'the room publishes no port')
    assert.equal(/^ {4}expose:/m.test(services.room), false, 'and does not widen what it shows the network')
    assert.equal(hasPorts(services.caddy), true)
    const published = [...services.caddy.matchAll(/^ {6}- "?(\d+:\d+)(?:\/\w+)?"?\s*$/gm)].map((m) => m[1])
    assert.deepEqual(published.sort(), ['443:443', '80:80'])
    assert.equal(/network_mode:\s*host/.test(compose), false, 'host networking would publish the room without a ports line')
  })
  test('the room has a named volume for its data, declared at the top', () => {
    const m = /^ {6}- ([a-z-]+):\/data\s*$/m.exec(services.room)
    assert.ok(m, 'the room mounts a named volume at /data (not a folder path)')
    assert.ok(m[1] in volumes, `${m[1]} is declared under volumes:`)
    assert.match(services.room, /^ {6}DATA_DIR: \/data\s*$/m)
  })
  test('the caller-address setting appears only in the room, which publishes no port', () => {
    const setting = /TRUSTED_CLIENT_IP_HEADER/
    const where = Object.entries(services).filter(([, b]) => setting.test(b)).map(([n]) => n)
    assert.deepEqual(where, ['room'], 'only the room carries it')
    assert.equal(hasPorts(services.room), false, 'and only while its port is unpublished')
    assert.match(services.room, /^ {6}TRUSTED_CLIENT_IP_HEADER: x-forwarded-for\s*$/m, 'it names the header Caddy writes')
    assert.match(compose, /SAFE ONLY WHILE THIS SERVICE PUBLISHES NO PORT/, 'the comment saying why stays')
    assert.equal(/^TRUSTED_CLIENT_IP_HEADER=\S/m.test(envExample), false, 'the example .env does not set it (the compose file does)')
  })
  test('the room is reached over https only, and Caddy gets the name from the same setting', () => {
    assert.match(services.room, /PUBLIC_URL: https:\/\/\$\{PUBLIC_HOST:\?/)
    assert.match(services.caddy, /PUBLIC_HOST: \$\{PUBLIC_HOST:\?/)
    assert.match(services.room, /^ {4}env_file: \.env\s*$/m)
  })
  test('every ${NAME} the compose file reads is in .env.example', () => {
    const wanted = new Set([...compose.matchAll(/\$\{([A-Z_]+)[:?}-]/g)].map((m) => m[1]))
    assert.ok(wanted.has('PUBLIC_HOST'))
    for (const name of wanted) assert.match(envExample, new RegExp(`^${name}=`, 'm'), name)
  })
})

describe('the Caddyfile', () => {
  const code = noComments(caddyfile)
  test('serves the public name and sends everything to the room on its port', () => {
    assert.match(code, /^\{\$PUBLIC_HOST\} \{/m)
    assert.match(code, /reverse_proxy room:3000/)
    assert.equal(/^\S*:\d+ \{/m.test(code), false, 'no plain-port site block that would serve without the name')
  })
  test('it SETS the caller address and the scheme, and trusts no earlier proxy', () => {
    assert.match(code, /header_up X-Forwarded-For \{remote_host\}\s*$/m)
    assert.match(code, /header_up X-Forwarded-Proto \{scheme\}\s*$/m)
    assert.equal(/trusted_proxies/.test(code), false)
  })
  test('its proxy target is the compose service that publishes nothing', () => {
    assert.ok('room' in services)
    assert.equal(hasPorts(services.room), false)
  })
})
