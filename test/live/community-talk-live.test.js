// Reading, and saying one thing, in a REAL community's encrypted room through the person's real trust agent: the check the stand-ins cannot give.
// Skipped unless all of these are set:
//   LIVE_COMMUNITY_DID                         the community's DID (its DID document lists a VTCRest door)
//   VTA_CREDENTIAL (or VTA_CREDENTIAL_FILE)    the one line the person's trust agent hands an app; it must be registered as the person's own
//                                              client (a delegate is refused by rooms/keys/act). Optional: VTA_URL.
//   LIVE_PERSONA_DID                           the member DID the community addressed its offers to, already joined to the room
//                                              (test/live/community-room-live.test.js with LIVE_ACCEPT_ROOM, or `wpi-agent community-room accept`)
//   LIVE_TALK_ROOM                             the room's DID
// It reads the room and nothing else. It writes one test message only when LIVE_TALK_SAY=yes is also set: a message in a real
// community's room is read by every member and cannot be taken back from here.
// Optional: LIVE_COMMUNITY_URL (the door, when the DID's document lists none the machine can reach).
// Run:  node --test test/live/community-talk-live.test.js
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { Vta, readCredential } from '../../agent/vta.js'
import { CommunityRoom } from '../../agent/community-room.js'

const env = process.env
const ready = Boolean(env.LIVE_COMMUNITY_DID && (env.VTA_CREDENTIAL || env.VTA_CREDENTIAL_FILE) && env.LIVE_PERSONA_DID && env.LIVE_TALK_ROOM)
const dir = ready ? mkdtempSync(join(tmpdir(), 'community-talk-live-')) : null
after(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })
const room = () => new CommunityRoom({ vta: new Vta({ credential: readCredential(env), url: env.VTA_URL }), communityDid: env.LIVE_COMMUNITY_DID, member: env.LIVE_PERSONA_DID, ...(env.LIVE_COMMUNITY_URL ? { url: env.LIVE_COMMUNITY_URL } : {}), statePath: join(dir, 'state.json') })

describe('a real community\'s encrypted room', { skip: ready ? false : 'set LIVE_COMMUNITY_DID, VTA_CREDENTIAL (or VTA_CREDENTIAL_FILE), LIVE_PERSONA_DID and LIVE_TALK_ROOM to run this against a real community' }, () => {
  test('reads the room from the start: every message shown names its author and was signed for the place it was read from', async (t) => {
    const cr = room()
    await cr.catchUp(env.LIVE_TALK_ROOM)
    const r = await cr.read(env.LIVE_TALK_ROOM, { since: 0, limit: 50 })
    for (const m of r.messages) { assert.match(m.author, /^did:/); assert.equal(typeof m.text, 'string'); assert.ok(m.version >= 1) }
    t.diagnostic(`${r.messages.length} messages shown, ${r.more} left, not shown ${JSON.stringify(r.unreadable ?? {})}; counts ${JSON.stringify(cr.counts)}`)
  })
  test('says one test message, only when LIVE_TALK_SAY=yes, and reads it back as this member\'s own and "declared"', { skip: env.LIVE_TALK_SAY === 'yes' ? false : 'set LIVE_TALK_SAY=yes to write one message (every member reads it; it cannot be taken back from here)' }, async (t) => {
    const cr = room()
    await cr.catchUp(env.LIVE_TALK_ROOM)
    const said = await cr.say(env.LIVE_TALK_ROOM, `InWove test message ${new Date().toISOString()}: please ignore.`)
    const back = (await cr.read(env.LIVE_TALK_ROOM, { since: Math.max(0, said.version - 1) })).messages.find((m) => m.key === said.key)
    assert.ok(back, 'the message reads back'); assert.equal(back.author, env.LIVE_PERSONA_DID); assert.equal(back.basis, 'declared'); assert.equal(back.mine, true)
    t.diagnostic(`said version ${said.version}; counts ${JSON.stringify(cr.counts)}`)
  })
})
