# Joining a community from your own machine

`wpi-agent join-community` lets you join a trust community (OpenVTC's "VTC") as your own persona. Your own trust
agent signs everything as that persona; the community's door is the only place anything is sent. The room's server
sees none of it and holds no key.

## What it does, in order

1. Reads the community's DID document and finds its door (the `VTCRest` service; plain public https only, unless you name
   the address with `COMMUNITY_URL`).
2. Asks for the community's join manifest (criteria, and the attributes it asks for). The question is signed as your
   persona, so a community that has turned public discovery off still answers.
3. Prints what will be sent and waits for you to type `yes` (or `--yes`): the criterion, the attributes, whether you
   consent to registry publication (off unless `--registry-consent`), the credentials in the presentation, and that your own
   membership credential will be made and sent once you are approved.
4. Submits the application, signed by your persona, and follows the verdict. It stops, and says what to do, when the
   community refers it to a queue (it names the queue), asks for more (it names what), or refuses (it names the code and reason).
5. Polls the community's status, first after 5 seconds and then at doubling waits up to a minute, for at most ten
   minutes. Past that it ends and says to run it again; running it again resumes the same request.
6. Finds the membership pass and role credential the community pushed into **your own vault** and checks them with the room's
   own reader (`src/shared/dtg.js`). If the community says it has not had them acknowledged, it asks for them again once per run.
7. Makes your own membership credential (issued by your persona, about the community, bound to the pass by its digest),
   has your trust agent sign it, and sends it with the request number, which closes the join.

`--show-pass` then makes the pass check the room's `POST /api/community/pass` takes (signed by your persona, addressed
to the room, carrying your pass) and sends it to the room named by `WPI_URL` only if you say yes. The room keeps what
it keeps today; nothing new is stored there.

## Settings

| Setting | Meaning |
|---|---|
| `COMMUNITY_DID` | the community's DID (required) |
| `COMMUNITY_PERSONA` | the member DID that applies; your trust agent must hold a key for it (required, except for `--status`) |
| `VTA_CREDENTIAL` or `VTA_CREDENTIAL_FILE`, `VTA_URL` | your trust agent, as for the notebook (see `agent/vta.js`) |
| `COMMUNITY_URL` | the community's door, if you want to name it yourself (https, or http on this machine) |

Options: `--yes`, `--registry-consent`, `--criterion <id or digest>`, `--attr <type>=<value>` (repeatable), `--status`, `--show-pass`.

## Where it stands: `--status`

Prints the stage, the last verdict (effect and code), whether the community says your credentials were delivered, and counts:
`submitted`, `polled`, `resends`, `passesFound`, `answersSent`, `refusedBy` (by code). The small state file is beside the bridge's key
(`~/.config/we-play-interop/community-<16 hex>.json`, mode 0600): the stage, the request number, times and those counts. It holds no
credential bodies, no attributes and no DIDs.

## What is not verified

- Everything here is checked against a stand-in community (`test/helpers/fake-vtc-join.js`) that follows the wire shapes of OpenVTC's
  bundles and source at the pin. `test/live/community-join-live.test.js` is the check against a real community (a test member on a
  test community); it has not been run.
- The pass is pushed by the community over TSP, DIDComm or REST to your trust agent. The stand-in calls the trust agent's vault
  receive directly; whether a real trust agent deposits the push in the vault in the time the polling allows is not verified.
- The digest in your own membership credential (`credentialSubject.digestMultibase`) is the room's `dtgDigest` (SHA-256 of the pass without its
  proof, canonicalised): the form OpenVTC's comments describe (`vtc-service/src/credentials/ingress.rs`). Its implementation (the
  `dtg-credentials` library) is not in the sources here, and a community compares it strictly.
- The VP carries `verifiableCredential: []` when the criterion asks for none; the community's reading of an empty list is from its
  comments, not run.
- Hidden vetting (challenges bound to a proof) and supplementing an application are not done here.

## Left to you

What you tell a community (attributes), whether you consent to registry publication, and the member credential: making it is your act,
which is why the command asks every time. Whether a community admits, refers or refuses you is the community's.
