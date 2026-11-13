# InWove on Geb

Geb is a sealed messaging substrate: a person is a `did:peer:2`, two people form a pair by swapping signed credentials,
lines travel sealed through relays that cannot read them, and group rooms run on MLS (RFC 9420). InWove keeps its web
room, its signed record and its sign-in, and adds one Geb room kept in step with it, so people and agents can be in the
room from Geb too. The code is `src/server/geb.js` (the bridge) and `src/server/geb-cli.js` (Geb's CLI as the bridge's
node); the tests are `test/geb-bridge.test.js` and `test/geb-cli.test.js`.

## What it does

- **The room has its own Geb identity**, run by one `geb listen --json` process on the room's server. It is the only
  writer of that identity's state: Geb's pair ratchets and MLS state must never have two writers.
- **One Geb room, kept in step both ways.** A line said in People and AIs here is posted into the Geb room by the room,
  naming its author (`Ann: …`). A line said in the Geb room by a linked member is written here as a `geb:relayed` line,
  signed by the room, naming the member and carrying the Geb message's id, so it shows in Talk marked "in Geb". The Geb
  room is made at the first link (Geb makes a room with its members named), and a `geb:room` line says which it is.
- **People only lines never cross.** The bridge reads the record exactly as the room's AIs read it
  (`src/server/audience.js`): a People only line, a line to one person, and the room check's lines stay here.
- **Linking takes two proofs**, so nobody can claim someone else's Geb identity: the room gives the person a one-time
  code (ten minutes), they send it from their Geb identity to the room over Geb, and then they sign a `member:link-geb`
  line naming that identity, which the record takes only if the code came from it. The room accepts a Geb pair request
  only while someone's code is waiting. One Geb identity per person, and never the room's own. `end: true` unlinks.
- **Who is in the Geb room is exactly the room and the linked members.** Leaving, being replaced or unlinking takes a
  person out. If Geb cannot take someone out, the bridge stops posting until it can, so a line never reaches someone
  who is no longer in the room.
- **What is refused from Geb, and counted:** a sender not linked to a current member, a line Geb did not verify as
  signed, a line from another Geb room, a line the room's secret guard stops, and the same Geb line twice (Geb replays
  what it queued when its listener starts).
- **For now only the room's host links** (`GEB_LINK_HOSTS_ONLY` in `geb.js`). Lifting it is a reviewed code change,
  made once the conditions for members below are met.

## The steps, and what each waits on

| Step | What | Waits on |
|---|---|---|
| 0 | This code: the line kinds, the two-proof link, the bridge and its CLI adapter, tested against a fake Geb | nothing: it does nothing until the room has a Geb identity |
| 1 | The room's Geb identity on its server (`GEB_HOME`, `GEB_ROOM_DID`), Geb's CLI pinned | Security: who holds that identity's keys, where, and how they move at the handover to Project Weave. The host's yes: it is a key, and lines leave the room for Geb's relays |
| 2 | The host alone, linked and bridged | the host's yes on the push and on turning it on |
| 3 | Members link | Legal: the Geb licence's conditions for InWove (the room is handed to Project Weave) and what must be in place before anyone but the host uses it; the words members read |
| 4 | A member's browser as its own Geb device; a sealed notebook over Geb | Geb's browser build (0.5.20) and Security's read of the browser key |

## Turning it on (step 1, once its gates are cleared)

Set all three together; with only one of `GEB_HOME` and `GEB_ROOM_DID`, the room's start stops and says which is missing.
With neither, the room starts as before and its first lines say it is not on Geb.

| Setting | What |
|---|---|
| `GEB_HOME` | the room's Geb home: its keys and Geb state, on the encrypted volume beside the room's other private files, never in a repository or a log |
| `GEB_ROOM_DID` | the room's Geb identity, as the CLI made it |
| `GEB_BIN` | the CLI: `geb`, or the path of its `geb.mjs` (run with this Node). Pinned to 0.5.18 |

## The Geb facts this relies on (CLI 0.5.18, run on throwaway identities)

- `geb listen --json` prints one event per line; some lines are not JSON and are skipped. A line said in a room is a
  `gmessage` with `group`, `from`, `text`, `id`, `at` (epoch ms), `sig: "signed"` once Geb checked the sender, and
  `via: "replay"` when it was queued. A one-to-one line is a `gmessage` in the pair's own room with `direct: true`.
- `geb group new --mls <name> <did>…` makes a room; `geb group add <room> <did>…` adds; each member first forms a pair
  with the founder (`connect`, then `accept <did> --agree`), and the founder's listener must run to seat them.
- `geb gmembers <room> --json` lists an MLS room's members; `geb groups --json` lists rooms.
- `geb gsend <room> <text>` posts to a room; `geb send <did> <text>` to one person.
- Licence: `LICENSE` sha256 `2269d26ab5e2aa0209837730ed2bcf4284949f8873d7bfbcce84f615fbae2837` (the hash Legal pinned);
  `geb.mjs` sha256 `a5e9a9a44604347337b0f4f271d0a8d5637af87f424245a14b6de6c819860e43`. 0.5.18 has no signed release
  statement, so these are what is run, not yet verified against a signed release.

**To confirm on a throwaway identity before step 1:** that `geb group remove <room> <did>…` exists and takes someone
out (the bridge pauses without it); the shape of a pair `request` event (the adapter reads `from`, else `did`); that
`gsend` and `accept` may run while `listen` holds the same home; and how the CLI says its own identity, so
`GEB_ROOM_DID` can be checked at start.

## Honest limits

- **Sealed between Geb devices, readable by the room.** The room's Geb identity is in the Geb room, so the host of
  this room can read it, as it can read everything said here. Geb seals lines from the relays, not from the host.
  Relay operators can still see who talks to whom, and when.
- **The weaver reads only what crosses into this room.**
- **Geb is 0.5.x and its wire is not versioned.** Upgrade on purpose, one pinned release at a time.
- **A lost Geb identity cannot be recovered by anyone;** the person's InWove membership is unaffected, and they link a new one.

## How we know it works

Content-blind counts per day, in the database (`geb_counts`), shown to a host at `GET /api/geb`: lines in and out,
codes given and heard, pair requests accepted and ignored, refusals by reason, duplicates, people added and taken out,
pauses, listener stops. Working: a line said on either side shows on the other within seconds, and refusals are only
the expected few. Failing: lines missing or doubled across the bridge, a pause that does not clear, a relayed line
whose member is not linked (the record would show it), a second listener for the room's identity.
