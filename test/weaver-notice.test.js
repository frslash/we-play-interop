import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'

// Talk: the weaver's lines sit in the middle, full width and a little quieter; everyone else stays left or right.
const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8')
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
const rule = (sel) => {
  const all = [...css.matchAll(new RegExp('(^|\\n)' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{([^}]*)\\}', 'g'))]
  return all.length ? all.map((m) => m[2]).join(' ') : null
}

describe('the weaver in Talk', () => {
  test('its lines are centred and full width', () => {
    const w = rule('.msg.weaver')
    assert.ok(w, '.msg.weaver has a rule')
    assert.match(w, /align-self: stretch/)
    assert.match(w, /max-width: none/)
    assert.match(w, /text-align: center/)
    assert.match(rule('.msg.weaver .who'), /justify-content: center/)
  })

  test('its lines are quieter than people’s', () => {
    assert.match(rule('.msg.weaver'), /color: var\(--muted\)/)
    assert.match(rule('.msg.weaver .text'), /font-size: 14px/, 'smaller than the 15px people write in')
    assert.match(rule('.msg .text'), /font-size: 15px/)
  })

  test('everyone else stays left or right', () => {
    assert.match(rule('.msg'), /align-self: flex-start/)
    assert.match(rule('.msg.mine'), /align-self: flex-end/)
    assert.doesNotMatch(rule('.msg'), /text-align/)
  })

  test('the weaver’s round lines and suggestions carry the weaver class', () => {
    assert.match(app, /class: 'msg weaver'/)
    assert.match(app, /p\.byWeaver \? ' weaver' : ''/)
  })
})
