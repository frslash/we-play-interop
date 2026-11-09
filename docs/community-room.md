# Entering the community's encrypted room

A member's agent bridge can accept the community's offer of its encrypted room and join the room's group. Every step that
touches a key is done inside the person's own trust agent. The bridge only carries three things between the community and
that trust agent: the offer (with its credentials), a KeyPackage and a Welcome. There is no MLS code in JavaScript.

Code: `agent/community-room.js` (class `CommunityRoom`). Tests: `test/community-room.test.js` (against stand-ins),
`test/live/community-room-live.test.js` (against a real community, skipped unless set up).

## Who does what

| Step | Who | Task |
|---|---|---|
| list what is offered | the person's trust agent completes it as the member | `vtc/rooms/offers/list/0.4` through `rooms/keys/act` |
| keep the three credentials | the person's vault | `vault/credentials/receive/0.1` |
| make a KeyPackage (private half stays) | the person's trust agent | `rooms/keys/key-package/0.2`, needs the invitation |
| accept, get a Welcome | the community (its own trust agent builds the Welcome) | `vtc/rooms/offers/accept/0.1`, completed by `rooms/keys/act` |
| join the group | the person's trust agent | `rooms/keys/welcome/0.1` |
| catch up on commits | the host (the community) and the person's trust agent | `rooms/epoch/commits/0.1`, `rooms/keys/commit/0.1` |

After that the room is read and written the way any sealed room is (`agent/room-host.js`, `agent/vti-notebook.js`), with the
community's door as the host: `new RoomHost({ vta, hostDid: <community DID> })` finds it through the community's `VTCRest`
service. So anyone whose keys are in an OpenVTC trust agent, from the agent bridge or from Keyring, can be in one group with
anyone else in it. A person whose MLS client is not an OpenVTC trust agent joins only if that app speaks these same three steps.

## Using it

```js
const cr = new CommunityRoom({ vta, communityDid, member, resolver, fetch })
await cr.offers()          // [{ roomId, host, label, visibility, actions, validUntil, offeredAt, state }], no credential strings
await cr.accept(roomId)    // stores credentials, key-package, accept, welcome, catch up; answers state()
await cr.catchUp(roomId)   // { applied, epoch }: apply the host's commits the trust agent has not seen
await cr.state(roomId)     // { roomId, visibility, roomEpoch, mlsEpoch, joinedAt }
```

`accept` can be called again at any point and picks up where the last call stopped: a trust agent that already holds the place
is only caught up; an acceptance begun elsewhere is finished by asking for the KeyPackage again (the trust agent returns the
same one while it is outstanding) and accepting again, which the community answers with the Welcome it kept. An `open` room
has no group: it is accepted with no KeyPackage. `offers()` also reads `renewals` (admissions already held) into
`cr.renewals`; nothing acts on them. There is no command line here: the command comes in a later change.

## What it keeps, and where to see it work

- State file: `~/.config/we-play-interop/community-room.json` (mode 0600), the stage of each room (`stored`, `accepted`,
  `joined`), its visibility and epochs. Never a credential, a KeyPackage or a Welcome.
- `cr.counts`: `offersRead`, `renewalsSeen`, `ignored` (offers that did not read or named another host), `accepted`, `welcomes`,
  `commitsApplied`, `refusedBy{code: n}`. `cr.last`: `{ ok, task, code?, at }`. Counts and codes only.
- Failures are thrown as `Entering the community's room did not work: <plain words> (<code>)`, with `.code` set.

## Settled from the upstream files

- The credential strings in an offer are JSON text (`serde_json::to_string` of the signed credential,
  `vta-service/src/operations/room_issuance.rs`), so they are sent to the vault as JSON (`credential`). A string that is
  base64url of JSON is decoded first (the trust agent reads both for an invitation); anything else goes as `credentialBase64`.
  The invitation is always handed to `key-package` and `welcome` exactly as the community sent it.
- `host` in an offer is "this community": an offer naming another host is ignored.

## Left for a person

Accepting an offer is the person's act: it spends the invitation. Making the room and offering it to members is the
community administrators' (decisions file, D2).
