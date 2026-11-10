// The same notebook, against a REAL trust agent and a REAL room host: the check that the stand-in cannot give.
// Skipped unless all three are set (the same three the bridge takes):
//   VTA_CREDENTIAL (or VTA_CREDENTIAL_FILE)   the one line the person's trust agent hands an app
//   NOTEBOOK_ROOM                              the DID of a sealed (attributed) room the person's persona is a member of,
//                                              with read and write, whose keys their trust agent holds
//   NOTEBOOK_HOST_DID                          the DID of the host that room is registered at
// Optional: VTA_URL (when the credential carries no address), NOTEBOOK_HOST_URL (when the host's DID lists no https door),
// WPI_AGENT_KEY (64 hex: the agent whose notebook this is; a fresh one otherwise),
// VTA_CREDENTIAL_OUTSIDER (a second credential at the same trust agent that may NOT act in that room: checks the refusal).
// It WRITES to the room: two small notes that say they are a test, and one "read up to here" record. Nothing is deleted.
// Run:  node --test test/live/vti-notebook-live.test.js
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { identityFromSeedHex, newIdentity } from '../../src/shared/did.js'
import { VtiError } from '../../agent/vta.js'
import { notebookFromEnv } from '../../agent/vti-notebook.js'

const env = process.env
const ready = Boolean((env.VTA_CREDENTIAL || env.VTA_CREDENTIAL_FILE) && env.NOTEBOOK_ROOM && env.NOTEBOOK_HOST_DID)
const agent = env.WPI_AGENT_KEY ? identityFromSeedHex(env.WPI_AGENT_KEY) : newIdentity()
const MARK = 'we-play-interop live check ' + Buffer.from(crypto.getRandomValues(new Uint8Array(6))).toString('hex')

describe('a notebook in a real sealed room', { skip: ready ? false : 'set VTA_CREDENTIAL, NOTEBOOK_ROOM and NOTEBOOK_HOST_DID to run this against a real trust agent and room host' }, () => {
  const nb = ready ? notebookFromEnv(env, { agent }) : null

  test('the trust agent signs this credential in and holds keys for the room', async (t) => {
    const mine = (await nb.vta.list()).filter((r) => r.roomId === env.NOTEBOOK_ROOM)
    assert.equal(mine.length, 1, 'the trust agent holds group state for that room, for exactly one member this credential acts as')
    t.diagnostic(`member ${mine[0].member}, room epoch held ${mine[0].epoch}, earliest readable ${mine[0].earliestReadableEpoch}`)
  })

  test('the host answers a request completed as the member, and the room is a sealed one', async (t) => {
    const info = await nb.host.info(env.NOTEBOOK_ROOM)
    assert.ok(['attributed', 'private'].includes(info.visibility), `the room is ${info.visibility}`)
    t.diagnostic(`door ${await nb.host.door()}, tier ${info.visibility}, room epoch ${info.epoch}, answers signed by the host: ${nb.host.counts.signedAnswers > 0}`)
  })

  test('add a note, read it back, and read it from a second device', async (t) => {
    await nb.add(`${MARK} (a test note, safe to remove)`)
    assert.ok((await nb.get()).notes.some((n) => n.text.includes(MARK) && n.from === 'agent'))
    const second = notebookFromEnv(env, { agent }) // signs in again: the first session is superseded and has to renew itself below
    assert.ok((await second.get()).notes.some((n) => n.text.includes(MARK)), 'a fresh sign-in fetched and opened it')
    await nb.add(`${MARK} second (a test note, safe to remove)`)
    assert.ok((await second.get()).notes.some((n) => n.text.includes(`${MARK} second`)))
    t.diagnostic(`versions answered: ${JSON.stringify(Object.fromEntries(nb.vta.stepped))}; host tasks at ${JSON.stringify(nb.host.gen)}; resealed ${nb.counts.resealed}, catch-ups ${nb.counts.catchUps}, sign-ins ${nb.vta.counts.signIns}, refreshes ${nb.vta.counts.refreshes}`)
  })

  test('"read up to here" is kept in the room and found again', async () => {
    await nb.markRead()
    assert.deepEqual(await notebookFromEnv(env, { agent }).unread(), [])
  })

  test('a credential that may not act in that room is refused', { skip: env.VTA_CREDENTIAL_OUTSIDER ? false : 'set VTA_CREDENTIAL_OUTSIDER to check this' }, async () => {
    const out = notebookFromEnv({ ...env, VTA_CREDENTIAL: env.VTA_CREDENTIAL_OUTSIDER, VTA_CREDENTIAL_FILE: '' }, { agent })
    await assert.rejects(out.get(), (e) => e instanceof VtiError && ['rooms/keys/act:notAMember', 'permissionDenied'].includes(e.code))
  })
})
