// Wallet sign-in against a RUNNING room: the browser's half and the wallet's half, over real HTTP.
// Skipped unless LIVE_ROOM_URL is set. Run it with:
//   LIVE_ROOM_URL=https://<the room's address> node --test test/live/signin-live.test.js
//
// What it needs from the room: the Trust Task door running with the six auth/oob tasks on it; for an https room, a
// did:webvh whose published document lists TrustTaskHTTPS (a base whose /trust-tasks is the door), SignInPortal (on
// the room's own origin) and the room's signing key under assertionMethod. It resolves that DID over the network,
// from the room's host, exactly as a wallet would. For a room on this machine (http://127.0.0.1:<port> or
// http://localhost:<port>, not in production) it is told the door's address instead.
//
// What it leaves behind: one sign-in of a key and a DID made here and thrown away, good for five minutes, counted in
// /api/info. It writes nothing to the room's log.
//
// What it does NOT show: that a real wallet accepts the room. The wallet here is this repository's own
// (test/helpers/wallet.js), which sends the documents OpenVTC's code says a wallet sends and checks what that code
// says a wallet checks. A real wallet build, scanning the page's code, is the only test of that.
import { test } from 'node:test'
import { playSignIn } from '../helpers/play.js'

const url = process.env.LIVE_ROOM_URL

test('a wallet signs a browser in to the running room', { skip: url ? false : 'set LIVE_ROOM_URL to a running room\'s address' }, async () => {
  const done = await playSignIn({ url })
  console.log(`signed in to ${done.config.serviceDid} as ${done.session.subject} until ${done.session.sessionEndsAt}; the browser's key was ${done.kept === 'webcrypto' ? 'one that cannot be read out' : 'held in memory'}`)
})
