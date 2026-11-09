// The community's offers against a REAL community and the person's real trust agent: the check the stand-ins cannot give.
// Skipped unless all of these are set:
//   LIVE_COMMUNITY_DID                         the community's DID (its DID document lists a VTCRest door)
//   VTA_CREDENTIAL (or VTA_CREDENTIAL_FILE)    the one line the person's trust agent hands an app; it must be registered as the
//                                              person's own client (a delegate is refused by rooms/keys/act). Optional: VTA_URL.
//   LIVE_PERSONA_DID                           the member DID the community addressed its offers to
// It lists the offers and nothing else. It accepts only when LIVE_ACCEPT_ROOM=<roomId> is also set: accepting is the person's
// act, it spends the invitation and adds this member to the room's group, and it cannot be undone from here.
// Optional: LIVE_COMMUNITY_URL (the door, when the DID's document lists none the machine can reach).
// Run:  node --test test/live/community-room-live.test.js
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { Vta, readCredential } from '../../agent/vta.js'
import { CommunityRoom } from '../../agent/community-room.js'

const env = process.env
const ready = Boolean(env.LIVE_COMMUNITY_DID && (env.VTA_CREDENTIAL || env.VTA_CREDENTIAL_FILE) && env.LIVE_PERSONA_DID)
const dir = ready ? mkdtempSync(join(tmpdir(), 'community-room-live-')) : null
after(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })
const room = () => new CommunityRoom({ vta: new Vta({ credential: readCredential(env), url: env.VTA_URL }), communityDid: env.LIVE_COMMUNITY_DID, member: env.LIVE_PERSONA_DID, ...(env.LIVE_COMMUNITY_URL ? { url: env.LIVE_COMMUNITY_URL } : {}), statePath: join(dir, 'state.json') })

describe('a real community\'s offers', { skip: ready ? false : 'set LIVE_COMMUNITY_DID, VTA_CREDENTIAL (or VTA_CREDENTIAL_FILE) and LIVE_PERSONA_DID to run this against a real community' }, () => {
  test('the offers list reads, and every offer names this community as its host', async (t) => {
    const cr = room()
    const offers = await cr.offers()
    for (const o of offers) { assert.equal(o.host, env.LIVE_COMMUNITY_DID); assert.equal(o.credentials, undefined) }
    t.diagnostic(`${offers.length} offers (${offers.map((o) => `${o.visibility}/${o.state}`).join(', ') || 'none'}); counts ${JSON.stringify(cr.counts)}`)
  })
  test('accepts one room, only when LIVE_ACCEPT_ROOM names it', { skip: env.LIVE_ACCEPT_ROOM ? false : 'set LIVE_ACCEPT_ROOM=<roomId> to accept (the person\'s act: it spends the invitation)' }, async (t) => {
    const cr = room()
    const st = await cr.accept(env.LIVE_ACCEPT_ROOM)
    assert.equal(st.roomId, env.LIVE_ACCEPT_ROOM)
    if (st.visibility !== 'open') assert.ok(Number.isInteger(st.mlsEpoch) && st.roomEpoch === st.mlsEpoch + 1, 'the trust agent is at the room\'s epoch')
    t.diagnostic(`joined ${st.visibility} room at room epoch ${st.roomEpoch}; counts ${JSON.stringify(cr.counts)}`)
  })
})
