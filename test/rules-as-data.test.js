import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { differences, inEffect, laneOf, matches, needAPerson, onlyOwnYes, problems, waitingFor } from '../src/shared/rules.js'
import { config as baseConfig } from '../src/server/config.js'
import { createApp } from '../src/server/index.js'

// The room's rules as plain data that its checker reads (room lines 721, 727): rules.json, and src/shared/rules.js.
const AGREED = JSON.parse(readFileSync(new URL('../rules.json', import.meta.url), 'utf8'))
const MIN = 60_000, now = Date.parse('2026-11-09T12:00:00Z')
const facts = (over = {}) => ({ kind: 'workspace-change', external: true, vetoed: false, acted: false, lane: 'normal', proposedAt: now - 60 * MIN, yesTimes: [], people: [], owner: 'did:key:zOwner', otherPeoplesAgents: 0, democracy: null, now, ...over })

describe('the rules as data', () => {
  test('rules.json is readable by its checker, and the rules themselves always need a person', () => {
    assert.deepEqual(problems(AGREED), [])
    assert.ok(needAPerson(AGREED, ['rules.json', 'src/shared/rules.js']).length === 2)
    const loose = structuredClone(AGREED); loose.codeChanges.needAPerson = ['package.json']
    assert.match(problems(loose).join(), /must include rules\.json and src\/shared\/rules\.js/)
    assert.match(problems({ version: 1 }).join(), /peopleNeeded/)
  })

  test('the small lane is the page and the docs, never public/setup.js', () => {
    assert.equal(laneOf(AGREED, ['public/app.js', 'public/style.css']), 'small')
    assert.equal(laneOf(AGREED, ['README.md', 'docs/how.md']), 'small')
    assert.equal(laneOf(AGREED, ['public/setup.js']), 'normal')
    assert.equal(laneOf(AGREED, ['public/app.js', 'src/server/views.js']), 'normal')
    assert.equal(laneOf(AGREED, ['src/README.md']), 'normal', '*.md is a top-level file only')
    assert.equal(laneOf(AGREED, []), 'normal')
    assert.ok(matches(['sandbox/'], 'sandbox/keeper.sh')); assert.ok(!matches(['sandbox/'], 'sandboxes.md'))
  })

  test('the checker says what a proposal waits for, the way the room has decided it', () => {
    assert.equal(waitingFor(AGREED, facts({ external: false })), 'stays inside the workspace')
    assert.equal(waitingFor(AGREED, facts({ vetoed: true })), 'vetoed')
    assert.equal(waitingFor(AGREED, facts({ acted: true })), 'already acted on')
    assert.match(waitingFor(AGREED, facts()), /needs approval from 3 more person's agent\(s\) \(or a person\)/)
    assert.match(waitingFor(AGREED, facts({ kind: 'issue' })), /needs 1 more human approval/)
    // agents of three different people, then the quiet window from the latest yes
    assert.match(waitingFor(AGREED, facts({ otherPeoplesAgents: 3, yesTimes: [now - 2 * MIN] })), /veto window open until/)
    assert.equal(waitingFor(AGREED, facts({ otherPeoplesAgents: 3, yesTimes: [now - 11 * MIN] })), null)
    assert.equal(waitingFor(AGREED, facts({ people: ['did:key:zP'], yesTimes: [now - 11 * MIN] })), null, 'or a person')
    // the small lane: no vote, a window from the proposal
    assert.match(waitingFor(AGREED, facts({ lane: 'small', proposedAt: now - 2 * MIN })), /small change: it goes live at/)
    assert.equal(waitingFor(AGREED, facts({ lane: 'small', proposedAt: now - 11 * MIN })), null)
    assert.match(waitingFor(AGREED, facts({ kind: 'issue', people: ['did:key:zP'], yesTimes: [now - 11 * MIN], democracy: { for: 1, against: 1 } })), /democracy: 1 for, 1 against/)
  })

  test('whether a person\'s own yes counts is data: today it does, said openly; a vote could change it', () => {
    const own = facts({ people: ['did:key:zOwner'], yesTimes: [now - 11 * MIN] })
    assert.equal(waitingFor(AGREED, own), null); assert.equal(onlyOwnYes(AGREED, own), true)
    assert.equal(onlyOwnYes(AGREED, facts({ people: ['did:key:zOwner', 'did:key:zOther'] })), false)
    const changed = structuredClone(AGREED); changed.proposals.personsOwnYesCounts = false
    assert.match(waitingFor(changed, own), /needs approval/)
  })

  test('a host\'s settings for their room are applied, and shown beside the agreed ones', () => {
    const effect = inEffect(AGREED, { vetoWindowMinutes: 3, approvalsRequired: AGREED.proposals.peopleNeeded, protectedPaths: ['src/server/log.js'] })
    assert.equal(effect.proposals.vetoWindowMinutes, 3)
    assert.ok(effect.codeChanges.needAPerson.includes('rules.json'), 'a host can\'t take the rules out of a person\'s hands')
    const diff = differences(AGREED, effect)
    assert.ok(diff.some((d) => /veto window, in minutes: 3 in this room \(agreed: 10\)/.test(d)))
    assert.deepEqual(differences(AGREED, inEffect(AGREED, {})), [])
  })

  describe('in the running room', () => {
    let ctx, base, dir
    before(async () => {
      dir = mkdtempSync(join(tmpdir(), 'wpi-rules-'))
      const board = { generated: new Date().toISOString().slice(0, 10), projects: [], credentialProfiles: { profiles: {} }, runs: [] }
      ctx = await createApp({ ...baseConfig, dataDir: dir, databaseUrl: '', workspaceKey: '', production: false, githubToken: '', vetoWindowMinutes: 3, weaverIntervalMinutes: 0, weaverQuietMinutes: 0, ratePerMinute: 1000, publicUrl: 'https://interop.example', boardDataUrl: 'data:application/json,' + encodeURIComponent(JSON.stringify(board)), llm: { ...baseConfig.llm, apiKey: '' } }, { openRoom: true, awayGatherMs: 0, hostWelcomeMs: null })
      await new Promise((r) => ctx.server.listen(0, '127.0.0.1', r))
      base = `http://127.0.0.1:${ctx.server.address().port}`
    })
    after(async () => { await ctx.stop(); rmSync(dir, { recursive: true, force: true }) })

    test('anyone can read the agreed rules, and the room says which ones it runs on', async () => {
      assert.deepEqual(await (await fetch(`${base}/rules.json`)).json(), AGREED)
      const st = await (await fetch(`${base}/api/state`)).json()
      assert.equal(st.rules.data.inEffect.proposals.vetoWindowMinutes, 3)
      assert.ok(st.rules.data.differences.some((d) => /veto window/.test(d)))
      assert.equal(ctx.executor.rules().proposals.vetoWindowMinutes, 3, 'the checker runs on them')
    })
  })
})
