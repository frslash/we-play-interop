# Joining the room's community from the room's page

When `COMMUNITY_DID` names a community, the "Membership passes" card on the You tab shows a button, "Join <community>
with your wallet", and what the community asks for. The button opens the community's own page in a new tab. The join
happens between the person's wallet and the community; the room's server is not in between and never sees the
person's key. The room then takes the pass as before (`POST /api/community/pass`).

## What the room does
- `GET /api/community` has a `join` part: `{ url, criteria, attributes, directoryDisclosure?, fetchedAt, problem?, problemCode? }`.
- To fill `criteria` the room sends the community's door one signed Trust Task
  (`https://trusttasks.org/spec/vtc/join-requests/manifest/0.4`, empty payload), signed by the room's own identity
  (it is the room asking, not a person). A community that turned public discovery off refuses an unidentified caller
  with `permissionDenied`; a signed one is answered.
- It keeps only what the page shows (per criterion: id, description, admission, invitation, a vetting summary; the
  attributes asked for; the community's directory disclosure as given, when it is under 16,000 characters) and
  nothing about members. The answer is kept for 10 minutes (it protects the community's door from one request per page
  view); at most one request is in flight; a failed read is remembered for one minute.
- When it cannot read the manifest, `problem` says so in words with the shared refusal code, never the network cause,
  and the page still shows the link and the rest of the card.
- Counts in `/api/info` under `community.join`: `manifestReads`, `manifestRefused` (by code), `cacheHits`.

## The link: `COMMUNITY_JOIN_URL`
An https address. When set, it is the link. When empty, the room uses the community's own sign-in portal from its DID
document (`SignInPortal`, with `?join`), and failing that `/members/?join` on the origin of its API address.
It is read from `config.communityJoinUrl` if the settings object has it, else from the environment. (README and
`.env.example` list it in brief 12; `src/server/config.js` is not changed here.)

## Not verified
- That `/members/` is on the same origin as the community's API for every community (the route exists in
  vtc-service, `routes/mod.rs:1478`, when it runs with its website). Hence the setting.
- The community's answer is not signature-checked: the address comes from the community's own DID document and is
  reached over https through the room's public fetch, and the answer is only displayed.
- Against a real community: `LIVE_COMMUNITY_DID=did:webvh:… node --test test/live/community-manifest-live.test.js`.
