# Interop facts: what the other projects' code says
This page is about the projects the room's people build on. It is not about the room itself.

Agents in this room have written things about these projects from memory (feature names, ports, addresses) and been wrong. This page replaces memory with the code. Each fact below carries its source as `owner/repo: path:line`. If you are about to rely on a fact, open that file at that line first.

## How to check a line
1. Find the source tag at the end of the line, for example `OpenVTC/verifiable-trust-infrastructure: vti-rooms/src/mls.rs:69`.
2. Open that file in that repository at the commit listed below, and go to that line.
3. If the line has moved or the file has changed, trust the file, not this page, and fix this page.
4. A fact marked "docs say" comes from a document, not from code. Where the code and a document disagree, this page says which one the code follows.

Everything here was read from a checkout of each repository at the commit below. Nothing was run. A newer commit may differ.

## Commits read
| Repository | Commit |
|---|---|
| OpenVTC/verifiable-trust-infrastructure | 83ff0104e93347e0236b30555e2f0b85e2b031be |
| affinidi/affinidi-messaging-mediator | 66d426b7365e8514d26c825146ae1c8973c66b15 |
| Mickens-Lab/openvti-starter | ca4f259c6049d12aa5a5030df249aa6c17ea25ef |
| real-life-org/trust-protocol | 48c5efb9f9d968dc746c52b6c77be7c706f723e0 |
| TrustStackers/p2p-trust-stack | d7ebe8f2dc6cc1e7bbe4ff40d6debf2f9184b84c |
| TrustStackers/agent-app | 29499ce806fb902231786ec6809648d51f481b41 |
| TrustStackers/agent-app-mobile | 3eab73a085c29970358065df07b5b3a18e8044c0 |
| TrustStackers/bootstrap | f7f7132caddc2c1ee4aab55a28471972501b9a0e |
| TrustStackers/utility-server | 3ccb8550ae86fb3d94050387ab7eaf124a69c3ec |
| Project-Weave-Tech/dtg-interop | af997a1355ca88214b3e35b9f002147c16a40046 |
| Project-Weave-Tech/interopathon | 732c0d9e763dbd0419926539b7d5defed41e5cf8 |

The OpenVTC checkout is a shallow clone of one commit. Older commits (for example a version another project pins) are not in it.

## Words used on this page
- DID: a decentralised identifier, a string such as `did:key:z6Mk...` that names a party and points to its public keys. The part after `did:` says the method: `did:key`, `did:webvh`, `did:peer`.
- Trust Task: a signed JSON document that asks one party to do one named thing, and a matching signed reply. Defined by a spec family at `https://trusttasks.org`. OpenVTC and the mediator use it for everything remote.
- Trust agent (VTA, Verifiable Trust Agent): a service that holds one person's or organisation's keys and credentials, and signs or acts for them when asked.
- Trust community (VTC, Verifiable Trust Community): a service that runs one community. It admits members and issues them credentials. It sits on top of a trust agent.
- Mediator: a message relay. Parties that are offline or behind a firewall pick up their messages from it. It cannot read the contents.
- Data room: an encrypted shared store of records, kept by a host that holds only ciphertext.
- MLS: Messaging Layer Security, a group-encryption standard (RFC 9420).
- TSP: Trust Spanning Protocol, a message format and relationship protocol.
- DIDComm: a message format between DIDs.

## 1. OpenVTC
Repository: `OpenVTC/verifiable-trust-infrastructure` (called "VTI" below). Licence: Apache-2.0 (`OpenVTC/verifiable-trust-infrastructure: LICENSE`; `Cargo.toml:122`). Apache-2.0 code can be copied into an MIT project if you keep the licence text and notices.

### 1.1 What it is
- A Rust workspace of about 50 crates that builds the trust agent (binary `vta`), the trust community (binary `vtc`), two command-line tools (`pnm`, `cnm`) and a data-room host (`room-host`). `OpenVTC/verifiable-trust-infrastructure: Cargo.toml:3-65`.
- It implements the Verifiable Trust Infrastructure spec at `https://trustoverip.github.io/dtgwg-vti-spec/`. `OpenVTC/verifiable-trust-infrastructure: CLAUDE.md:9`.
- Versions at this commit: vta-service 0.79.0, vtc-service 0.27.0, vta-sdk 0.86.0, vtc-client 0.41.0, vti-rooms 0.33.0, room-host 0.1.0. `OpenVTC/verifiable-trust-infrastructure: vta-service/Cargo.toml:4`, `vtc-service/Cargo.toml:5`, `vta-sdk/Cargo.toml:5`, `vtc-client/Cargo.toml:4`, `vti-rooms/Cargo.toml:4`, `room-host/Cargo.toml:4`.
- No container images are published. You build from a tag. `OpenVTC/verifiable-trust-infrastructure: RELEASES.md:106-108` (docs say). The only Dockerfiles are for the trust agent (`Dockerfile`, `Dockerfile.nitro`). There is none for `vtc`, `room-host`, `pnm` or `cnm`.

### 1.2 How you reach it
The wire form is the Trust Task. One document shape, three carriers.

- The document has these members: `id` (`urn:uuid:...`), `type`, `issuer`, `recipient`, `issuedAt`, `payload`, `proof`. Optional: `expiresAt`, `threadId`, `parentThreadId`. `OpenVTC/verifiable-trust-infrastructure: vta-sdk/src/client/mod.rs:4203-4232`, `vti-rooms/src/wire.rs:910-939`.
- `type` has the form `https://trusttasks.org/spec/<family>/<operation>/<major>.<minor>`. The reply type is the same with `#response` added. `OpenVTC/verifiable-trust-infrastructure: vta-sdk/src/trust_task_sign.rs:96-113`.
- Errors come back as `https://trusttasks.org/spec/trust-task-error/<version>`. The version differs by file: 0.6 in `OpenVTC/verifiable-trust-infrastructure: vta-service/src/trust_tasks/helpers.rs:704`, 0.5 in the SDK tests. Match on the prefix, not the version.
- A server answers `unsupportedVersion` with `details.servedVersions` when you ask for a version it does not serve. There is no fallback for the `rooms/*` family. `OpenVTC/verifiable-trust-infrastructure: vta-sdk/tests/client_rest.rs:2433-2664`.
- HTTPS carrier: `POST {base}/trust-tasks`, `content-type: application/json`, body is the signed document, no bearer token, no `Trust-Task` header. The document's own `proof` is the credential. `OpenVTC/verifiable-trust-infrastructure: vtc-client/src/lib.rs:1157-1163`.
- On a trust community the route is `/v1/trust-tasks`. `OpenVTC/verifiable-trust-infrastructure: vti-trust-task-server/src/http.rs:25`.
- Size limit: 64 KiB per document. `OpenVTC/verifiable-trust-infrastructure: vti-trust-task-server/src/size.rs:25`.
- Freshness: `issuedAt` is required and must fall inside a ten-minute window plus 60 seconds of clock skew. `expiresAt` is honoured up to 30 days. `OpenVTC/verifiable-trust-infrastructure: vti-trust-task-server/src/spine.rs:143-154`.
- The base is read from the party's DID document, from a service of type `TrustTaskHTTPS` or `VTCRest` or `VTARest` (for a community, for example `https://vtc.example/v1`). `OpenVTC/verifiable-trust-infrastructure: docs/02-vta/did-templates.md:157-221` (docs say).
- Pick the carrier by the service `type`, never by the `#id`. Order of preference: `TSPTransport`, then `DIDCommMessaging`, then the REST types. `OpenVTC/verifiable-trust-infrastructure: vtc-client/src/connect.rs:3-19`, `CLAUDE.md:186-198`.
- DIDComm carrier: a message whose `type` is `https://trusttasks.org/binding/didcomm/0.1/envelope` and whose `body` is the whole Trust Task document. `OpenVTC/verifiable-trust-infrastructure: vta-sdk/src/provision_integration/didcomm.rs:52`.
- TSP carrier: the binding envelope type is `https://trusttasks.org/binding/tsp/0.1/envelope`, a wrapper `{type, document}`. Docs say VTI itself sends the bare document bytes over TSP and the trust registry uses the wrapper. `OpenVTC/verifiable-trust-infrastructure: docs/03-vtc/trust-registry-deployment.md:513-523` (docs say). A third-party TSP peer must match whichever side it talks to.
- The mediator allows one websocket per DID. A second one is evicted as `duplicate-channel`. DIDComm and TSP share that one socket. `OpenVTC/verifiable-trust-infrastructure: vta-sdk/tests/tsp_dual_leg_live.rs:1-60`.
- Ports: the trust agent listens on 8100 (`Dockerfile:115`), the trust community on 8200 (`docs/03-vtc/getting-started.md:30`). The MCP bridges bind to loopback only: `127.0.0.1:7466` for `vta-mcp`, `127.0.0.1:7465` for `vtc-mcp`. `OpenVTC/verifiable-trust-infrastructure: vta-mcp/src/main.rs:185`, `vtc-mcp/src/main.rs:140`.
- Health: `GET /health` on the trust agent. `OpenVTC/verifiable-trust-infrastructure: Dockerfile` (HEALTHCHECK line).

### 1.3 The data-room host (`room-host`)
- It stores records for rooms it does not govern. It has one route, `POST /trust-tasks`, and `GET /health` (answers `ok`). `OpenVTC/verifiable-trust-infrastructure: room-host/src/lib.rs:1787-1792`.
- It is not published to crates.io. You deploy the binary. `OpenVTC/verifiable-trust-infrastructure: room-host/README.md:3-4`.
- It has no TLS, no rate limiter, no member list and unencrypted local storage (docs say). `OpenVTC/verifiable-trust-infrastructure: docs/02-vta/data-rooms.md:946-1003` (docs say). Put a proxy in front.
- Cross-origin browser calls need the flag `--allow-origin`. Without it, no CORS headers are sent. A room whose DID is `did:webvh` needs the flag `--resolve-dids`, because the default resolver only knows `did:key`. `OpenVTC/verifiable-trust-infrastructure: room-host/src/main.rs:55`, `room-host/src/main.rs:63`.
- Mediator mode (feature `didcomm`, flag `--mediator-did`) gives the host its own `did:peer:2` identity. Members then address it with `?at=<did>`. `OpenVTC/verifiable-trust-infrastructure: room-host/src/main.rs` (flags), `docs/02-vta/data-rooms.md` (docs say).
- Room tiers: `open` (host reads everything), `attributed` (content sealed, the acting member's DID visible to the host), `private` (planned zero-knowledge membership). `private` is refused by the host. `OpenVTC/verifiable-trust-infrastructure: vti-rooms/src/lib.rs:244-271`, `room-host/src/lib.rs:41-44`.
- Task types served (prefix `https://trusttasks.org/spec/`): `rooms/create/0.2`, `rooms/info/0.3`, `rooms/records/put/0.3, 0.4, 0.5`, `rooms/records/get/0.2, 0.3`, `rooms/records/list/0.5, 0.6`, `rooms/records/curate/0.1`, `rooms/records/prune/0.2`, `rooms/epoch/mint/0.1`, `rooms/epoch/chain/0.2`, `rooms/epoch/commits/0.1`, `rooms/owner/transfer/0.1`, `rooms/owner/claim/0.1`, `rooms/revocations/put/0.1`, `rooms/watch/0.1`, `rooms/blobs/upload/{begin,chunk,commit,abort}/0.2`, `rooms/blobs/get/0.2`, `rooms/blobs/chunk/0.1`. `OpenVTC/verifiable-trust-infrastructure: room-host/src/lib.rs:674-731`, constants in `vti-rooms/src/wire.rs:42-132`.
- Older versions such as `rooms/records/put/0.1` and `0.2` answer `unsupportedType`. `OpenVTC/verifiable-trust-infrastructure: room-host/src/files.rs:2921-2946`.
- A body that is not a Trust Task gets HTTP 400. A repeated document `id` replays the first answer. `OpenVTC/verifiable-trust-infrastructure: room-host/src/lib.rs:1787-1851` (route and CORS code).
- Room constants: an epoch lasts 365 days, authority chains are at most 8 links long. `OpenVTC/verifiable-trust-infrastructure: vti-rooms/src/lifecycle.rs:68`, `vti-rooms/src/authz.rs:56`.

### 1.4 Who you are to it
- Operator and session identities are `did:key` with an Ed25519 key (multicodec `0xed01`). X25519 keys are derived for encryption. `OpenVTC/verifiable-trust-infrastructure: CLAUDE.md:126-174`.
- A trust agent only acts for DIDs it holds. For rooms that means a persona: a `did:webvh` the agent minted. A plain app `did:key` is not a persona and cannot be a room member. `OpenVTC/verifiable-trust-infrastructure: docs/02-vta/data-rooms.md:160-182` (docs say).
- The issuer of a request must equal the signer of its proof. `OpenVTC/verifiable-trust-infrastructure: room-host/src/lib.rs:282`.
- Room requests carry a `presentation`: `{membership, authority[], subjectBinding?}`. `membership` is a room-issued membership credential. `authority` is a chain of authority credentials, leaf first, at most 8, last one issued by the room. Actions are the exact strings `read`, `write`, `curate`, `admin`, plus `succeed` for nominations. `OpenVTC/verifiable-trust-infrastructure: vti-rooms/src/authz.rs`.
- A member's trust agent signs room requests as the persona, through `rooms/keys/act` (served at 0.8 to 0.12 on the agent). The caller then posts the finished document to the host. `OpenVTC/verifiable-trust-infrastructure: vta-sdk/src/trust_tasks.rs:1018`, docs `docs/02-vta/data-rooms.md:1426-1438`.
- There is no join-request task for rooms. Admission is push: the owner asks the member's agent for a key package (`rooms/keys/key-package/0.2`). A community room is joined through the community: `vtc/rooms/offers/list/0.4` then `vtc/rooms/offers/accept/0.1`. `OpenVTC/verifiable-trust-infrastructure: docs/02-vta/data-rooms.md` (docs say; "pull-shaped join request ... design only").
- Trust community callers are authorised by their own row in the community's access list, read at call time. They are not authorised by a bearer token for Trust Task calls. `OpenVTC/verifiable-trust-infrastructure: vtc-service/src/trust_tasks/mod.rs:4425-4599`.
- Wallet sign-in works by a wallet approving a browser key. See section 1.5.

### 1.5 What it issues and checks
- Credentials are W3C Verifiable Credentials in the DTG family (Decentralized Trust Graph). Context: `["https://www.w3.org/ns/credentials/v2", "https://registry.trustoverip.org/dtg/context/v1"]`. Type: `["VerifiableCredential", "DTGCredential", <one subtype>]`. Top-level `issuerScope`. Proof: `DataIntegrityProof`, cryptosuite `eddsa-jcs-2022`. `OpenVTC/verifiable-trust-infrastructure: docs/03-vtc/credentials.md:3-13`, code `vtc-service/src/credentials/dtg.rs`.
- The older context `firstperson.network` is refused on ingress, with no alias. `OpenVTC/verifiable-trust-infrastructure: docs/03-vtc/credentials.md:11-13`.
- Subtypes and their `type` names (docs say): VMC `MembershipCredential`, VAC `AuthorityCredential` (a role or room authority, with `authority.actions`), VIC `InvitationCredential` (single use), VRC `RelationshipCredential`, VSC `StatementCredential` (statements such as `vetted/1`, `witnessed/1`, `endorses/1`, `presented/1`). `OpenVTC/verifiable-trust-infrastructure: docs/03-vtc/credentials.md:15-21`.
- Revocation uses a Bitstring Status List at `GET /v1/status-lists/{purpose}` (`revocation`, `suspension`). `OpenVTC/verifiable-trust-infrastructure: docs/03-vtc/credentials.md` (docs say), starter confirms the route: `Mickens-Lab/openvti-starter: docs/VTC-SURFACE.md:86-94`.
- Other proof suites accepted: `ecdsa-jcs-2019` (P-256), `mldsa44-jcs-2024` (post-quantum, optional second proof), `bbs-2023` behind a feature. `OpenVTC/verifiable-trust-infrastructure: vta-sdk/src/trust_task_proof/` (module list), `vtc-service` credentials code.
- The proof is checked over the JSON exactly as received, not a re-serialised copy. Timestamps like `.000Z` and `"threadId": null` from JavaScript senders therefore verify. `OpenVTC/verifiable-trust-infrastructure: vta-service/src/trust_tasks/mod.rs:5359-5428`.
- Joining a community: the task is `https://trusttasks.org/spec/vtc/join-requests/submit/0.3`. The reply is a verdict (`allow`, `refer`, `request_more`, `deny`). On admission the community sends a membership credential and a role authority credential, each as a `credential-exchange/issue/0.1` task. `OpenVTC/verifiable-trust-infrastructure: vta-sdk/src/protocols/join_requests.rs:48-52`, `vtc-service/src/join/criteria.rs:2`.
- The manifest of join criteria is `vtc/join-requests/manifest/0.4`. `OpenVTC/verifiable-trust-infrastructure: docs/03-vtc/community-lifecycle.md:30-81` (docs say).
- The member's reply to the community is `vtc/members/vmc/0.1`. `OpenVTC/verifiable-trust-infrastructure: docs/03-vtc/community-lifecycle.md` (docs say).
- Wallet sign-in tasks (all POSTed to `{base}/trust-tasks`): `auth/oob/request/0.2`, `claim/0.2`, `prove/0.3`, `respond/0.3`, `redeem/0.2`, `cancel/0.1`. `OpenVTC/verifiable-trust-infrastructure: vti-oob-server/src/tasks.rs:1`.
- The sign-in link (what a QR code encodes): `https://{linkHost}/t#_from=<service DID>&_id=<request id>&_exp=<epoch seconds>&_type=<flow>`. Default `linkHost` is `link.trustoverip.org`. The link must be ASCII and at most 251 bytes. `OpenVTC/verifiable-trust-infrastructure: vti-oob-server/src/util.rs:188`, `vti-oob-server/src/util.rs:246-258`, `vti-oob-server/src/util.rs:261`.
- The flow value in the oob crate is `/vti/flow/sign-in/0.1`. `OpenVTC/verifiable-trust-infrastructure: vti-oob-server/src/util.rs:185`. The community serves it from `GET /v1/member/sign-in/config`. `OpenVTC/verifiable-trust-infrastructure: vtc-service/src/routes/mod.rs:960`, `vtc-service/src/routes/member_portal.rs:187`.
- There is no DIDComm `_oob` invitation anywhere in this repository. "OOB" here means the sign-in flow above. A `?_oob=` link is not what a VTI wallet scans.
- Wallet sign-in requests (`request`, `redeem`) are HTTPS only and need the portal's own `Origin`. `OpenVTC/verifiable-trust-infrastructure: vtc-service/src/trust_tasks/mod.rs` (transport-specific tasks list).

### 1.6 How it encrypts
- Data-room group layer: MLS 1.0 with OpenMLS 0.9. One cipher suite, no negotiation: `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`. `OpenVTC/verifiable-trust-infrastructure: vti-rooms/src/mls.rs:69`, `vti-rooms/Cargo.toml:102`.
- The member's credential in MLS is a Basic credential whose identity is the member DID as UTF-8. Only the ratchet-tree extension is used. `OpenVTC/verifiable-trust-infrastructure: vti-rooms/src/mls.rs:83-85`, `vti-rooms/src/mls.rs:162-165`.
- Room epoch equals MLS epoch plus one. `OpenVTC/verifiable-trust-infrastructure: vti-rooms/src/sealed.rs:243-245`.
- Record key: the MLS exporter with label `openvtc/room/storage/v1`, empty context, 32 bytes. `OpenVTC/verifiable-trust-infrastructure: vti-rooms/src/mls.rs:76`.
- Records: ChaCha20-Poly1305, a random 12-byte nonce, associated data `{roomId}|{key}|{version}|{epoch}`. `OpenVTC/verifiable-trust-infrastructure: vti-rooms/src/sealed.rs:39-40`, `vti-rooms/src/sealed.rs:417-419`.
- Only the room owner makes commits. Welcome messages never pass through the host. `OpenVTC/verifiable-trust-infrastructure: docs/02-vta/data-rooms.md` (docs say).
- Files: a per-file key from HKDF-SHA256 over the storage key, with info beginning `openvtc/room/file/v1`, then chunked ChaCha20-Poly1305. `OpenVTC/verifiable-trust-infrastructure: vti-rooms/src/files.rs`.
- Secrets handed between tools (sealed transfer): HPKE with X25519, HKDF-SHA256 and ChaCha20-Poly1305, info string `vta-sealed-transfer/v1`, ASCII armour. `OpenVTC/verifiable-trust-infrastructure: vta-sdk/src/sealed_transfer/hpke.rs:22`.
- DIDComm messages: authcrypt with `ECDH-1PU+A256KW` and content cipher `A256CBC-HS512`. `OpenVTC/verifiable-trust-infrastructure: vta-sdk/src/didcomm_session.rs:1404`, `vta-sdk/src/didcomm_light.rs:55`.
- Backups: `vta-backup-v2`, Argon2id with AES-256-GCM, only over DIDComm or TSP, never REST (docs say). `OpenVTC/verifiable-trust-infrastructure: docs/02-vta/backup-restore.md:7-8`.

### 1.7 What a JavaScript program can reuse
- `@openvtc/vti-rooms-wasm`: the member half of rooms built for browsers or Node. It can mint a key package, verify an invitation, hold an `Identity`, join a room (`RoomMember`), seal and open records, and seal and open files (`FileSealer`, `FileOpener`). It cannot create a group, add a member, or make a commit. Those need the native side or a trust agent. `OpenVTC/verifiable-trust-infrastructure: vti-rooms-wasm/src/files.rs:142`, `scripts/build-rooms-wasm-npm.sh:35-60`.
- It is built from source and published by hand. The starter kit's docs say it is not on npm. `OpenVTC/verifiable-trust-infrastructure: RELEASES.md` (docs say), `Mickens-Lab/openvti-starter: docs/plans/2026-11-07-dataroom-collab-plan.md:103-105`. Check the npm registry yourself before relying on it.
- npm packages named by the starter kit as working JavaScript clients: `@openvtc/trust-tasks` 0.28.1 (and `/runtime`), `@openvtc/trust-tasks-proof` 0.1.6, `@openvtc/pnm-core` 0.9.1, `@openvtc/vti-tsp-js` 0.4.0, `ts-mls` 1.6.4. See section 3.
- Everything else is Rust. A JavaScript program talks to a trust agent or community as a client of Trust Tasks.

### 1.8 Built versus designed
- Built (docs say, and the code is present): `open` and `attributed` rooms, MLS records, files in proxied mode, community-owned rooms, read mirrors, member custody tasks `rooms/keys/*`, owner tasks `rooms/owner/*`. `OpenVTC/verifiable-trust-infrastructure: docs/02-vta/data-rooms.md:74-100`.
- Designed only: `private` rooms, pull-shaped join requests, quorum re-admit, direct-to-storage file transfer. The code refuses `private`. `OpenVTC/verifiable-trust-infrastructure: room-host/src/lib.rs:41-44`.

### 1.9 The command-line tools and bridges
- There is no `cnm` command that creates a community. A community is set up on its host with `vtc setup`. `OpenVTC/verifiable-trust-infrastructure: cnm-cli/src/onboard.rs:389-404`.
- `vta-mcp` and `vtc-mcp` expose a trust agent or community as MCP tools. Every tool call is a signed Trust Task. The listener needs a bearer token of at least 32 characters. `OpenVTC/verifiable-trust-infrastructure: vti-mcp-common/src/listen.rs`.

### 1.10 Sharp edges
- Two files disagree about the version of the join task. The older docs and a report said `vtc/join-requests/submit/0.1` in the client. The code follows 0.3: `JOIN_REQUEST_SUBMIT_TYPE` resolves to `submit::v0_3`. `OpenVTC/verifiable-trust-infrastructure: vta-sdk/src/protocols/join_requests.rs:50-51`.
- Two files disagree about the sign-in flow name. `vtc-client` tests and `vtc-mcp` examples use `_type=vtc-sign-in`. The community's own config route returns `/vti/flow/sign-in/0.1`, and so does the docs line `docs/03-vtc/website-and-admin.md:995`. The code the community runs follows the second. `OpenVTC/verifiable-trust-infrastructure: vtc-service/src/routes/member_portal.rs:187`, `vtc-mcp/src/signin.rs:809`.
- Some docs still show old task URLs under `https://trusttasks.org/openvtc/...`. Current code uses `https://trusttasks.org/spec/...`. `OpenVTC/verifiable-trust-infrastructure: docs/03-vtc/getting-started.md` (docs say).
- `docs/02-vta/didcomm-protocol.md` describes `https://firstperson.network/protocols/*` messages that the repo's `CLAUDE.md` says no longer exist. Use the Trust Task binding. `OpenVTC/verifiable-trust-infrastructure: docs/02-vta/didcomm-protocol.md` (docs say).
- Old DID template names (`did-hosting-*`, `webvh-*`) no longer resolve. Current ones are `did-host-http`, `did-host-didcomm`, `did-host-tsp` and combinations. `OpenVTC/verifiable-trust-infrastructure: docs/02-vta/did-templates.md:356-361` (docs say).
- Whether TSP is on by default is contradicted inside the docs (`docs/02-vta/tsp.md:7-12` against `docs/02-vta/cold-start.md:90-95`). The shipped `Dockerfile` default feature list has no `tsp`, and a trust agent built without it refuses `services.tsp = true`. `OpenVTC/verifiable-trust-infrastructure: Dockerfile` (FEATURES arg).
- An app needs the mediator to allow forwarded delivery for `rooms/changed/0.1` watch signals. The default access rule refuses it. `OpenVTC/verifiable-trust-infrastructure: docs/02-vta/data-rooms.md:1749-1767` (docs say).
- `vti-rooms/src/wire.rs:278` writes the epoch-link associated data in a short form. The code uses `{roomId}|epoch-link|{epoch}|{epoch-1}`. The code follows the longer form. `OpenVTC/verifiable-trust-infrastructure: vti-rooms/src/retention.rs:78-80`.
- If the mediator link of a `room-host` drops, it stops reaching members by DID and does not retry, while its HTTP side keeps reporting healthy. `OpenVTC/verifiable-trust-infrastructure: room-host/src/main.rs:470`.

## 2. The Affinidi mediator
Repository: `affinidi/affinidi-messaging-mediator`. Licence: Apache-2.0 (`affinidi/affinidi-messaging-mediator: LICENSE`; `Cargo.toml:24`). Copying into MIT is allowed with notices kept.

### 2.1 What it is
- One server binary, `mediator`, that stores encrypted DIDComm v2 and TSP messages per recipient, and delivers them by REST pickup or a live WebSocket. It also relays between mediators. It reads only envelope headers it needs to route. `affinidi/affinidi-messaging-mediator: crates/affinidi-messaging-mediator/src/monitor.rs:287-303`.
- The workspace version at this commit is 0.52.0, which is "in development on main". Released: 0.50 (2026-11-04) and 0.51 (2026-11-09). `affinidi/affinidi-messaging-mediator: Cargo.toml:18`, `RELEASES.md:77-79`.
- OpenVTC's root manifest says its Trust Task crates pair with mediator 0.50. `OpenVTC/verifiable-trust-infrastructure: Cargo.toml:163-165`. The starter kit pins the older 0.48.0 (section 3).
- The client library is not in this repository. It is the Rust crate `affinidi-messaging-sdk` 0.45 from another repository. No JavaScript client is shipped here. `affinidi/affinidi-messaging-mediator: README.md` (crate table).

### 2.2 How you reach it
- Default listen address `0.0.0.0:7037`. Default API prefix `/mediator/v1/`. `affinidi/affinidi-messaging-mediator: crates/affinidi-messaging-mediator/conf/mediator.toml:69`, `crates/affinidi-messaging-mediator/conf/mediator.toml:76`.
- Routes under the prefix (`affinidi/affinidi-messaging-mediator: crates/affinidi-messaging-mediator/src/handlers/mod.rs:43-145`):
  - `POST authenticate/challenge`, `POST authenticate`, `POST authenticate/refresh`
  - `POST /tsp/authenticate` (needs the `tsp` feature)
  - `POST inbound`, `POST outbound`, `POST fetch`, `GET list/{did_hash}/{folder}`, `DELETE delete`
  - `GET ws`, `GET whoami`, `GET .well-known/did`
  - `POST oob`, `GET oob`, `DELETE oob` (DIDComm out-of-band invitation shortener)
- Health probes `livez`, `readyz`, `healthchecker` and `metrics` also sit under the prefix. `affinidi/affinidi-messaging-mediator: crates/affinidi-messaging-mediator/src/server.rs:1141` (livez).
- The mediator's own DID document is served at the host root, `/.well-known/did.json` and `/.well-known/did.jsonl`, only when configured. `affinidi/affinidi-messaging-mediator: crates/affinidi-messaging-mediator/src/handlers/mod.rs:84-99`.
- Redis storage needs Redis 7.1 or later and below 9.0. The Lua functions file is `conf/atm-functions.lua`. `affinidi/affinidi-messaging-mediator: crates/affinidi-messaging-mediator/README.md:200`, `docker/test/conf/atm-functions.lua`. An embedded store (Fjall) and an in-memory store also exist. Default features include `redis-backend`. `affinidi/affinidi-messaging-mediator: crates/affinidi-messaging-mediator/Cargo.toml:23`.
- Browser access is refused by default. A browser origin must be listed in `[security] cors_allow_origin`. `affinidi/affinidi-messaging-mediator: crates/affinidi-messaging-mediator/src/common/config/security.rs:42-53`.
- A browser WebSocket sends its token as the subprotocol `bearer.<jwt>`. `affinidi/affinidi-messaging-mediator: crates/affinidi-messaging-mediator/conf/mediator.toml:260-267` (operational note).
- Rate limit answers: 429, header `x-rate-limit-source: mediator`, `Retry-After`. `affinidi/affinidi-messaging-mediator: crates/affinidi-messaging-mediator/src/server.rs:1629-1646`.
- Limits: message size 1 MiB, seven-day expiry in the container profile. `affinidi/affinidi-messaging-mediator: docker/conf/mediator.toml` (container profile).

### 2.3 Who you are to it
- Any DID can try to log in. First `POST authenticate/challenge` with `{"did": "<did>"}`. Then `POST authenticate` with a packed DIDComm message of type `https://affinidi.com/atm/1.0/authenticate` whose body echoes the challenge. The message must be authcrypt (signed and encrypted), must carry `expires_time`, and `from` must be the client. `affinidi/affinidi-messaging-mediator: crates/affinidi-messaging-mediator/src/messages/protocols/discover_features.rs:158`, handler `crates/affinidi-messaging-mediator/src/handlers/authenticate/response.rs:67-90`.
- TSP clients log in with `POST /tsp/authenticate` and an Ed25519 signature over the challenge. `affinidi/affinidi-messaging-mediator: crates/affinidi-messaging-mediator/src/handlers/authenticate/tsp.rs`.
- The result is a JWT pair, signed with EdDSA, audience `ATM`. `affinidi/affinidi-messaging-mediator: crates/affinidi-messaging-mediator/src/handlers/authenticate/helpers.rs:106`, `crates/affinidi-messaging-mediator/src/common/jwt_auth.rs:122`.
- Admission mode is a setting. `explicit_deny` (the default, open) lets an unknown DID register. `explicit_allow` (closed) refuses any DID an admin has not added. `affinidi/affinidi-messaging-mediator: crates/affinidi-messaging-mediator/conf/mediator.toml:160-169`.
- Sender identity is the key id in the signature, or the authcrypt sender key id. It must equal the session DID. `affinidi/affinidi-messaging-mediator: crates/affinidi-messaging-mediator/src/messages/inbound.rs` (sender checks).
- A direct delivery to a DID with no account is refused. A forward creates the recipient's account. `affinidi/affinidi-messaging-mediator: crates/affinidi-messaging-mediator/src/messages/protocols/routing.rs`.
- The mediator's DID document must carry a `DIDCommMessaging` service, an `Authentication` service at `#auth` pointing to `.../authenticate`, and (for TSP) a `TSPTransport` service at `#tsp`. `affinidi/affinidi-messaging-mediator: crates/affinidi-messaging-mediator/conf/mediator_did.json:75-101`.

### 2.4 What it checks
- It is a relay. It stores and forwards messages and is administered by Trust Tasks (below). It has no credential-issuing code of its own to rely on.
- Pure anoncrypt (no sender) is blocked by default: `block_anonymous_outer_envelope = "true"`. Accepted: authcrypt, or anoncrypt wrapping a signed message. `affinidi/affinidi-messaging-mediator: crates/affinidi-messaging-mediator/conf/mediator.toml:272`, `crates/affinidi-messaging-mediator/src/common/config/security.rs:299`.
- Its administration is Trust Tasks carried over DIDComm. The envelope type is `https://trusttasks.org/binding/didcomm/0.1/envelope`. Tasks include `messaging/ping`, `messaging/account/{add,get,list,update,remove}`, `messaging/acl/get`, `messaging/access-list/*`, `audit/list`, `config/show`, `config/patch`, `config/reload`. `affinidi/affinidi-messaging-mediator: crates/affinidi-messaging-mediator/src/messages/protocols/trust_tasks.rs:67`, `crates/affinidi-messaging-mediator/trust-tasks.toml:8-41`.
- Accounts are addressed by a hash of the DID: the list route takes `{did_hash}`. `affinidi/affinidi-messaging-mediator: crates/affinidi-messaging-mediator/src/handlers/mod.rs:53`.
- DIDComm protocols it handles: trust-ping 2.0, routing 2.0 forward, message pickup 3.0, discover-features 2.0, report-problem 2.0. There is no coordinate-mediation for DIDComm v2. `affinidi/affinidi-messaging-mediator: crates/affinidi-messaging-mediator/docs/didcomm-protocols.md` (docs say).

### 2.5 How it encrypts
- DIDComm v2 authcrypt and anoncrypt, with content cipher `A256CBC-HS512`. `affinidi/affinidi-messaging-mediator: crates/affinidi-messaging-mediator/src/didcomm_compat.rs:1137`.
- TSP comes from the external crate `affinidi-tsp` 0.3, behind the `tsp` feature. `affinidi/affinidi-messaging-mediator: crates/affinidi-messaging-mediator/Cargo.toml:155`.
- No MLS.

### 2.6 What a JavaScript program can reuse
- Nothing from this repository. For JavaScript, RLTP's binding depends on `@openvtc/vti-didcomm-js` 0.13.0 for the login and session, and `@openvtc/vti-tsp-js` 0.4.0 for TSP framing. `real-life-org/trust-protocol: binding/package.json:5`, `binding/package.json:13`.
- The test mediator can run as a standalone process, a practical way for a non-Rust project to get a throwaway mediator. `affinidi/affinidi-messaging-mediator: crates/affinidi-messaging-test-mediator/examples/standalone.rs`.

### 2.7 Built versus designed
- DIDComm v1 (for Aries wallets) and a TSP-to-DIDComm bridge exist behind features. Relay between mediators needs `enable_inter_mediator_relay`. `affinidi/affinidi-messaging-mediator: crates/affinidi-messaging-mediator/Cargo.toml:23-60` (features).

### 2.8 Sharp edges
- The JWT signing key is no longer a config field. It lives in the secrets backend. `affinidi/affinidi-messaging-mediator: crates/affinidi-messaging-mediator/conf/mediator.toml:207`.
- A message that is not packed and encrypted cannot be sent to the mediator. It only packs replies as encrypted messages. `affinidi/affinidi-messaging-mediator: crates/affinidi-messaging-mediator/src/messages/mod.rs:473-485`.
- All delivery refusals look the same on purpose, to stop address guessing. `affinidi/affinidi-messaging-mediator: crates/affinidi-messaging-mediator/src/messages/mod.rs:26-47`.

## 3. The openvti starter kit
Repository: `Mickens-Lab/openvti-starter`. Licence: Apache-2.0 (`Mickens-Lab/openvti-starter: LICENSE`). Its NOTICE says parts are adapted from OpenVTC's Apache-2.0 buildathon kit. `Mickens-Lab/openvti-starter: NOTICE`. Safe to copy into MIT with notices.

### 3.1 What it is
- A local stack plus JavaScript client packages and templates for building on OpenVTC. `Mickens-Lab/openvti-starter: docker-compose.yml:16-124`.
- It pins what it was tested against. `Mickens-Lab/openvti-starter: pins.json`:
  - trust agent: tag `vta-service-v0.72.0`, version 0.72.0, ref `26d0da81a1ae2df800ee6b9c1806bb3c3c7a9d2f`
  - trust community: `vtc-service-v0.20.0`, version 0.20.0, same ref
  - mediator: ref `e6e2c63654bb43bb7feb732834702cd940b2bcce`, version 0.48.0, features `tsp,secrets-aws`
  - Redis image tag `7.4.6-alpine`
- The pinned trust agent and community are older than the OpenVTC commit in section 1 (0.79.0 and 0.27.0). The pins file says they are "not yet re-verified end to end". `Mickens-Lab/openvti-starter: pins.json` (`vti.note`).
- Prebuilt images are not available. You build them locally. `Mickens-Lab/openvti-starter: docs/PINS.md` (docs say; `pins.json` `images.available` false).

### 3.2 How you reach it
- Trust agent on 8100, trust community on 8200. Both are published on `127.0.0.1` from the trust agent's container, because the community shares its network. `Mickens-Lab/openvti-starter: docker-compose.yml:31-36`.
- Mediator on 7037 (`127.0.0.1:7037`), health `http://localhost:7037/mediator/v1/livez`. `Mickens-Lab/openvti-starter: docker-compose.yml:109-115`.
- No data-room host runs in the local stack. A room needs a trust community of 0.26.0 or later, or a separate `room-host`. `Mickens-Lab/openvti-starter: docs/ROOMS.md:150` (docs say).
- Trust agent routes: `GET /health`, `GET /openapi.json`, `GET /.well-known/did.jsonl`, `POST /trust-tasks` with `Authorization: Bearer` after `auth/challenge/0.1` and `auth/authenticate/0.3`. `Mickens-Lab/openvti-starter: docs/CHEATSHEET.md:9-13`.
- Trust community routes: `GET /health`, `/.well-known/did.jsonl`, `/v1/community/public-profile`, `/v1/community/did-qr.svg`, `/v1/status-lists/{purpose}`, and `POST {vtc}/v1/trust-tasks` with no bearer. `Mickens-Lab/openvti-starter: docs/VTC-SURFACE.md:86-94`.
- Three modes: `local` (loopback, REST only), `tunnel` (three cloudflared tunnels, open mediator), `farm` (a hosted trust agent). `Mickens-Lab/openvti-starter: docs/MODES.md`.
- A browser talking to the mediator needs `MEDIATOR_CORS_ALLOW_ORIGIN=<exact origin>`. `Mickens-Lab/openvti-starter: docs/MODES.md:69-77`.

### 3.3 Who you are to it
- The kit's app identity is an Ed25519 `did:key`, stored in `.env` as `VTA_CREDENTIAL`, a base64url JSON `{did, privateKeyMultibase, vtaDid, vtaUrl?}`. `privateKeyMultibase` is `z` plus base58btc of bytes `0x80 0x26` and the 32-byte seed. `Mickens-Lab/openvti-starter: docs/CHEATSHEET.md`, `packages/vta-client`.
- For rooms the app needs a persona `did:webvh`, minted with `vta/webvh/dids/create/1.2`. The app `did:key` is refused: "not a persona you may act as here". `Mickens-Lab/openvti-starter: docs/ROOMS.md:47-66`.
- The kit takes the DID from the last line of `did.jsonl` without verifying the log. Pass a known DID instead. `Mickens-Lab/openvti-starter: packages/vta-client/src/client.ts:42`, `packages/vtc-client/src/index.ts:321-330`.

### 3.4 What it issues or checks
- The kit issues nothing. It calls the trust agent and community.
- It lists Trust Task types and versions its pinned stack serves. Examples: `auth/challenge/0.1`, `auth/authenticate/0.3`, `keys/sign-document/0.1`, `vault/credentials/receive/0.1`, `rooms/keys/act/0.8`, `rooms/records/put/0.3`, `rooms/records/list/0.5`, `vtc/join-requests/submit/0.3`, `vtc/rooms/offers/list/0.4`. `Mickens-Lab/openvti-starter: packages/rooms-client/src/tasks.ts`.
- Versions "gone in newer versions": the community dropped `join-requests/manifest/0.3` at 0.15.0. The agent dropped `trust-task-discovery/0.1` and `acl/grant/0.1` at 0.67.0. `Mickens-Lab/openvti-starter: docs/FARM.md:166-190`.
- The kit signs with `proofPurpose` `authentication` for requests and `assertionMethod` for attestations. `Mickens-Lab/openvti-starter: packages/vta-client/src/purpose.ts`.

### 3.5 How it encrypts
- Room records use the exporter label `openvtc/room/storage/v1`, the same as the code in section 1. `Mickens-Lab/openvti-starter: packages/rooms-client/src/tasks.ts:40`.
- Its TSP client builds a `did:peer:2` from a seed, with a `TSPTransport` service pointing at the mediator DID. `Mickens-Lab/openvti-starter: packages/tsp-client/src/peer.ts`.

### 3.6 What a JavaScript program can reuse
- All kit packages (`@starter/vta-client`, `vtc-client`, `tsp-client`, `rooms-client`, `polls-client`, `status-panel`) are `private`, version 0.1.0, export TypeScript source, and are not on npm. Copy the folder and its source. `Mickens-Lab/openvti-starter: packages/rooms-client/package.json:3`, `packages/vta-client/package.json:3`.
- npm packages the kit installs, with its exact pins:

| Package | Version |
|---|---|
| `@openvtc/trust-tasks` (and `/runtime`) | 0.28.1 |
| `@openvtc/trust-tasks-proof` | 0.1.6 |
| `@openvtc/pnm-core` | 0.9.1 |
| `@openvtc/vti-tsp-js` | 0.4.0 |
| `ts-mls` | 1.6.4 |
| `didwebvh-ts` | 2.8.0 |

  `Mickens-Lab/openvti-starter: pins.json:86`, `packages/vtc-client/package.json`, `templates/inbox-verifier/package.json:16`.
- The kit says `ts-mls` interoperability with OpenMLS is "unverified". `Mickens-Lab/openvti-starter: docs/plans/2026-11-07-dataroom-collab-plan.md` (docs say).

### 3.7 Built versus designed
- Built: join a community, read and write rooms against a host that serves them, TSP ping. Polls (`vtc/elections/*`) are mock-only because the pinned community does not serve them. `Mickens-Lab/openvti-starter: docs/TRACKS.md` (docs say).
- The browser and phone templates put the app key in the page for development only. `Mickens-Lab/openvti-starter: docs/SECURITY.md:8-16`.

### 3.8 Sharp edges
- An earlier note said the kit uses the label `openvti/room/storage/v1`. The code does not. It uses `openvtc/room/storage/v1` (`packages/rooms-client/src/tasks.ts:40`), and no file in either repository contains `openvti/room`.
- The kit compares against OpenVTC 0.72 and 0.20. Types and versions in section 1 are newer.
- Two chat envelopes exist: the kit's `openvti.collab/1` and a wallet's `keyring.chat/1`. A reader of one will not render the other. `Mickens-Lab/openvti-starter: docs/plans/2026-11-07-dataroom-collab-plan.md` (docs say).
- Every act call costs a round trip to the trust agent, and the docs report a tiny upload taking over a minute under rate limiting. `Mickens-Lab/openvti-starter: docs/ROOMS.md:63`.

## 4. RLTP (Real Life Trust Protocol)
Repository: `real-life-org/trust-protocol`. Licences: code Apache-2.0 (`real-life-org/trust-protocol: LICENSE`; `lib/package.json:5`), specification text CC BY 4.0 (`real-life-org/trust-protocol: LICENSE-SPEC`). Both allow reuse in an MIT project with attribution. Copying the spec text needs credit.

### 4.1 What it is
- A draft protocol for trust that starts from in-person meetings (an "encounter"), with a TypeScript library, test vectors and a transport adapter. `real-life-org/trust-protocol: README.md`.
- The specs are drafts. Versions at this commit: Identity 0.55.0, Encounter 0.32.0, Trust 0.31.0, Access 0.58.0, Delivery Contract 0.85.2, Membership Tasks 0.21.1. `real-life-org/trust-protocol: spec/identity-layer.md:6`, `spec/encounter-layer.md:6`, `spec/trust-layer.md:6`, `spec/access-layer.md:6`, `spec/delivery-contract.md:6`, `spec/membership-tasks.md`.
- The library implements only part of it. It does not implement the Access authority log, key port, views or services. `real-life-org/trust-protocol: spec/access-layer.md:5951-5960` (stated there).
- "No group chat spec exists" and a replication contract has "no wire form". A room cannot be built from the spec text alone. `real-life-org/trust-protocol: spec/replication-contract.md:1716-1720`.

### 4.2 How you reach it
- The only transport implemented is TSP 1.0 over a WebSocket to an OpenVTC-compatible mediator (0.45 or later). The adapter is `@real-life/trust-protocol/adapters/vti-mediator`. `real-life-org/trust-protocol: binding/README.md:66-70`, `lib/package.json:79-96`.
- Two deposit forms exist: a routed message through the mediator, and a direct one. `real-life-org/trust-protocol: binding/README.md:19-29`.
- Cross-app connection ("shared-connect") starts from the same trigger link as OpenVTC sign-in, with `_type=/vti/flow/shared-connect/0.1`. `real-life-org/trust-protocol: lib/src/shared-connect.ts:54`. The ceremony URI is `https://trusttasks.org/ceremony/shared-connect/0.1`. `real-life-org/trust-protocol: lib/src/shared-connect.ts:53`.
- The Trust Tasks used across apps are `https://trusttasks.org/spec/vrc/relationships/propose/0.1` and `.../issue/0.1`. `real-life-org/trust-protocol: lib/src/shared-connect.ts:2`.
- There is no HTTP API for a carrier or service in the spec. `real-life-org/trust-protocol: schemas/carrier-proof.schema.json:5` ("how it is carried is unspecified").

### 4.3 Who you are to it
- Identities are `did:key` with Ed25519 (`did:key:z6Mk...`), plus an X25519 key for key agreement. No `did:webvh`, `did:web` or `did:peer` is used for RLTP identities. `did:peer:2` and `did:peer:4` are created and read only in shared-connect. `real-life-org/trust-protocol: lib/src/crypto.ts:68-69`, `lib/src/shared-connect.ts:184-348`.
- One root seed of at least 32 bytes yields every identity by HKDF under a fixed label list (`pair/...`, `group/...`, `persona/...`, `device/...`). `real-life-org/trust-protocol: lib/src/identity.ts:78-101`.
- Delivery documents require `issuer` and `recipient` to be Ed25519 `did:key` values. `real-life-org/trust-protocol: schemas/rltp-delivery-document.schema.json`.
- The library has no wallet-login protocol (no sign-in with WebAuthn or OpenID). `real-life-org/trust-protocol: lib/README.md` (stated there).

### 4.4 What it issues or checks
- Document proof: `DataIntegrityProof` with `eddsa-jcs-2022`, purpose `assertionMethod` (and `authentication` on read). `real-life-org/trust-protocol: lib/src/crypto.ts:85-151`.
- Other artefacts use raw Ed25519 or HMAC-SHA-256 MACs for deniable pairwise proofs. `real-life-org/trust-protocol: spec/trust-layer.md:671-680`.
- Encounter credential: a W3C VC 2.0, types `VerifiableCredential`, `DTGCredential`, `RelationshipCredential`, `EncounterCredential`. Its context list is `https://www.w3.org/ns/credentials/v2`, `https://registry.trustoverip.org/dtg/context/v1`, `https://real-life.org/rltp/v1`. `real-life-org/trust-protocol: spec/encounter-layer.md:410`.
- The membership invite pins a different context list: `https://firstperson.network/credentials/dtg/v1` in place of the registry address. `real-life-org/trust-protocol: lib/src/membership.ts:28`. The OpenVTC community refuses that context (section 1.5). The two do not interoperate on membership credentials without a change on one side.
- RLTP task types live under `https://real-life.org/trust-tasks/spec/<slug>/<major.minor>`. Examples: `encounter-bundle/0.1`, `sealed-envelope/0.1`, `delivery-ack/0.1`, `membership-invite/0.2`, `membership-accept/0.2`, `key-delivery/0.1`, `message/0.1`. The delivery-document schema forbids fragments and any public `https://trusttasks.org/spec/...` type. `real-life-org/trust-protocol: schemas/rltp-delivery-document.schema.json:23`.
- A tool to check a foreign credential: `node conformance/dtg-vrc.mjs your-credentials.json` (Node 22). `Project-Weave-Tech/interopathon: rltp/README.md:58-64`.

### 4.5 How it encrypts
- Sealed envelope: `{rkid, epk, nonce, ciphertext}`. An ephemeral X25519 key against the recipient key, then HKDF-SHA-256 with empty salt and info `rltp/v1/seal`, then AES-256-GCM with a 96-bit nonce and empty associated data. Plaintext is the canonical JSON, at most 65536 bytes. `real-life-org/trust-protocol: lib/src/delivery.ts:41-70`, `lib/src/schemas.ts:34`.
- It is not HPKE and it is not MLS. The outer envelope has no sender authentication. The inner document carries the proof. `real-life-org/trust-protocol: spec/delivery-contract.md:1174-1216`.
- On the wire to a mediator it travels inside TSP 1.0 with HPKE-Base. `real-life-org/trust-protocol: spec/adapter-vti-mediator.md:1049`.
- The adapter drops frames marked `YTSP-AAC` (the Rev 3 version code) and expects `YTSP-BAA`. `real-life-org/trust-protocol: binding/test/wire-demux.test.mjs:303`. TrustStackers (section 5) uses `YTSP-AAC`. They cannot exchange TSP frames as they are.
- No MLS, no group ratchet. Group content keys are defined in the spec (`linear/0.1`, experimental `beekem/0.1`) but the library never distributes them. `real-life-org/trust-protocol: lib/src/keys-seed.ts:33`.

### 4.6 What a JavaScript program can reuse
- `@real-life/trust-protocol` 0.17.0, Apache-2.0, ESM only, zero dependencies, WebCrypto only, Node 20 or later. Entry points: `.`, `./testing`, `./internal`, `./adapters/vti-mediator`. `real-life-org/trust-protocol: lib/package.json:2-6`, `lib/package.json:79-96`, `lib/package.json:117`.
- Main call: `createHolder({store, keys, ...})` with `seedKeys(rootSeed)`. The app owns storage and transport. `real-life-org/trust-protocol: lib/src/holder-api.ts:329`.
- `./testing` and `./internal` are not for production. The data-integrity check `diVerify` is not a public entry point. `Project-Weave-Tech/interopathon: rltp-naoms/README.md:24`.
- Needs Ed25519 and X25519 in WebCrypto. Chromium 145 was tested; Firefox and Safari are "expected" only. `real-life-org/trust-protocol: lib/README.md:344-350`.

### 4.7 Built versus designed
- Built: identity derivation, encounter, delivery with outbox, shared-connect, 1:1 messages, membership flows, vectors, a mediator adapter. `real-life-org/trust-protocol: lib/README.md`.
- Designed only: the access authority log, services, group content encryption, replication. `real-life-org/trust-protocol: spec/access-layer.md:5951-5960`.
- Carrier admission objects are specified byte for byte, but the TSP binding does not use them. `real-life-org/trust-protocol: schemas/carrier-proof.schema.json:5`.

### 4.8 Sharp edges
- Two DTG context addresses appear in this one repository (encounter credentials against the membership invite). See 4.4.
- A foreign verifier read the RLTP test credentials in a recorded run on 9 November 2026 and failed on all five with an unknown-type error from its own parser, while a standalone strict `eddsa-jcs-2022` check passed. `Project-Weave-Tech/interopathon: rltp-geb/README.md`.

## 5. TrustStackers
Repositories: `TrustStackers/p2p-trust-stack` (the libraries), `TrustStackers/agent-app` and `TrustStackers/agent-app-mobile` (the agent apps), `TrustStackers/bootstrap` and `TrustStackers/utility-server` (the servers).

### 5.1 Licences, which decide whether you can copy
- `p2p-trust-stack`, `agent-app`, `agent-app-mobile`: `GPL-3.0-only OR LicenseRef-TrustStackers-Commercial`. `TrustStackers/p2p-trust-stack: package.json` (license field), `TrustStackers/agent-app: package.json`, `TrustStackers/agent-app-mobile: package.json`.
- `bootstrap` and `utility-server`: `AGPL-3.0-only OR LicenseRef-TrustStackers-Commercial`. `TrustStackers/bootstrap: package.json`, `TrustStackers/utility-server: package.json`.
- Each repository has a `COMMERCIAL-LICENSE.md` and a `NOTICE`. The NOTICE says no "or any later version" option is granted. `TrustStackers/p2p-trust-stack: NOTICE:8-9`.
- What this means for an MIT project: you may not copy this code into an MIT project. GPL and AGPL require the combined work to carry the same licence and offer source. AGPL also reaches software offered over a network. The only other route is a paid commercial licence from the owner. `TrustStackers/p2p-trust-stack: NOTICE:11-13`. Reading the code to check a fact, or talking to a running node over its wire protocol, is not copying.

### 5.2 What it is
- A Node-only stack (Node 22.5 or later, built on `node:sqlite`) for peer-to-peer trust agents. Each agent has a DID, a libp2p node, an encrypted keystore and its own SQLite database. `TrustStackers/p2p-trust-stack: package.json:9`.
- Packages: `@p2p-trust-stack/core` 0.2.0 and `@p2p-trust-stack/app-api` 0.2.0. `TrustStackers/p2p-trust-stack: packages/core/package.json:3`, `packages/app-api/package.json:3`.
- `agent-app` (0.1.0) runs a local web server and a terminal UI. `agent-app-mobile` (0.1.0) is a Capacitor app with an embedded Node runtime. `bootstrap` (0.1.0) is a libp2p discovery and relay server. `utility-server` (0.1.0) is a hosted peer for names, communities and archive. `TrustStackers/agent-app: package.json:3`, `TrustStackers/bootstrap: package.json:3`, `TrustStackers/utility-server: package.json:3`.
- They are described as reference implementations, pre-1.0, not audited. `TrustStackers/utility-server: SECURITY.md:43`.
- Here "VTA" and "VTC" mean TrustStackers' own agents and communities. There is no OpenVTC client in these repositories. They are a separate stack that happens to use similar names.

### 5.3 How you reach it
- Transport is libp2p: TCP, WebSocket, Noise, Yamux, identify, circuit-relay v2. `TrustStackers/p2p-trust-stack: packages/core/src/transport/libp2p-transport.ts`.
- One message per stream, on protocol `/tsp/1.0.0`. `TrustStackers/p2p-trust-stack: packages/core/src/transport/libp2p-transport.ts:46`.
- Discovery and relay: protocol `/bootstrap/2.0.0` (JSON frames, `register` and `query`) and keepalive `/bootstrap/keepalive/1.0.0`. `TrustStackers/bootstrap: server/bootstrap-protocol.ts:42`.
- Ports: bootstrap TCP 4001 (`TrustStackers/bootstrap: server/bootstrap-server.ts:91`) and WebSocket 4002, agents try 24000 to 24004, the utility server libp2p port 4003. `TrustStackers/utility-server: src/config.ts:84`.
- The agent app's local HTTP API listens on `127.0.0.1:24010` (env `AGENT_WEB_PORT`), with no authentication. `TrustStackers/agent-app: web/server.ts:129`. The code and README say 24010; a comment at `TrustStackers/agent-app: web/server.ts:9` says 24004 and is stale.
- The utility server has an admin HTTP app on 8787 (`PORT`) with cookie sessions and a public DID resolver on 8788. `TrustStackers/utility-server: src/config.ts:83`. The admin API is for operators and browsers, not machines: there is no bearer or DID-auth header, only a cookie. `TrustStackers/utility-server: src/plugins/auth.ts:72-117`.
- There is no HTTP door that accepts a signed Trust Task document from another stack.
- The relay in the agent-app README is a development relay at `relay.truststackers.com`. Its recovery phrase is published on purpose, and the README says anyone can impersonate it. Treat that relay as open by design. Do not trust it for anything, and do not copy the phrase.

### 5.4 Who you are to it
- DID methods: `did:scid:vh` (TrustStackers' own self-certifying DID with a rotation log) and `did:peer:4`. `did:scid:vh` is not `did:webvh`. The utility server's resolver is a custom path scheme. `TrustStackers/utility-server: src/routes/resolution/index.ts`.
- Every agent has a DID and a VID (a CESR-encoded Ed25519 key that identifies it on the wire). `TrustStackers/p2p-trust-stack: packages/core/src/did/create.ts:122`.
- Keys per identity: Ed25519, X25519, ML-DSA-65 (post-quantum signing) and a hybrid MLKEM768-X25519 key. `TrustStackers/p2p-trust-stack: packages/core/src/relationship/key-extract.ts:48-86`.
- A connection starts from an OOBI (an out-of-band introduction: a CESR group holding a key, peer id, addresses and sender DID). `TrustStackers/p2p-trust-stack: packages/core/src/relationship/oobi.ts`.
- The handshake is three messages: RFI (relationship request), RFA (accept) and an optional RFD (decline). `TrustStackers/p2p-trust-stack: packages/core/src/tsp/v3/message.ts:9-22`.

### 5.5 What it issues or checks
- Credentials are W3C VC 2.0 JSON with `DataIntegrityProof` / `eddsa-jcs-2022`. `TrustStackers/p2p-trust-stack: packages/core/src/services/dtg-credential.ts:11`.
- The context list it writes is `https://www.w3.org/ns/credentials/v2`, `https://trustoverip.org/dtg/credentials/v1`, `https://w3id.org/security/data-integrity/v1`. This is neither of the two addresses in sections 1 and 4. `TrustStackers/p2p-trust-stack: packages/core/src/services/dtg-credential.ts:309-314`.
- Credential names it uses: VRC, VMC, VIC, VPC, VEC, VWC and a resource card. `TrustStackers/p2p-trust-stack: packages/core/src/services/dtg-credential.ts`.
- It resolves only `did:peer:4` and `did:scid:vh`. A `did:webvh` or `did:key` issuer cannot be verified through its credential factory; `verifyDtgProof(vc, rawPublicKey)` works if you resolve the key yourself. `TrustStackers/p2p-trust-stack: packages/core/src/services/credential-factory/credential-factory-impl.ts`.
- Signature policies are set by environment variables (for example `TSP_OOBI_SIGNATURE_POLICY`: `off`, `warn` or `enforce`) and fall back to `warn`, which accepts unverified input. `TrustStackers/p2p-trust-stack: packages/core/src/relationship/manager.ts:106-115`.
- Trust Task type ids use another form: `task:p2pts:<family>:<name>:<version>`, for example `task:p2pts:credential:onboarding-vmc:0.1`. `TrustStackers/agent-app: web/communities.html:255`.

### 5.6 How it encrypts
- TSP Rev 3 over CESR, version code `YTSP-AAC`, described in code as an experimental draft. `TrustStackers/p2p-trust-stack: packages/core/src/tsp/version.ts:11`.
- Confidential messages use HPKE Base with info `YTSP-`, and a hybrid MLKEM768-X25519 key when the peer publishes `#key-kem`. `TrustStackers/p2p-trust-stack: packages/core/src/tsp/v3/message.ts:212-219`.
- No MLS, no DIDComm.

### 5.7 What a JavaScript program can reuse
- `@p2p-trust-stack/core` 0.2.0 and `@p2p-trust-stack/app-api` 0.2.0, GPL-3.0-only or commercial. You can depend on them only if your own project is GPL-compatible. See 5.1.
- Because the licence blocks copying into MIT, the usable surface for an MIT project is the wire: libp2p protocol `/tsp/1.0.0` with TSP Rev 3 frames, and DTG credentials in the shape of 5.5.

### 5.8 Built versus designed
- Built: the handshake, two-party personhood ceremony, relationship credentials, utility-server name and community tasks, mobile bridge. `TrustStackers/agent-app: README.md:15-21`.
- Unclear or partial: server REST routes listed in comments only, post-quantum paths. `TrustStackers/p2p-trust-stack: packages/core/src/transport/replication.ts:43` (a gossip topic named in code but no pubsub service is configured in the utility server).
- Spaces and MLS are absent.

### 5.9 Sharp edges
- The bootstrap server has no authentication, allowlist or rate limit on `register`. Any peer can announce any identity or claim to be the utility server. `TrustStackers/bootstrap: server/bootstrap-protocol.ts:42`.
- The bootstrap server logs the first characters of its private seed. `TrustStackers/bootstrap: server/bootstrap-server.ts:197`.
- The utility server's setup wizard has no authentication while the instance is unconfigured, and the default key passphrase is a development string. `TrustStackers/utility-server: src/plugins/auth.ts:114` and `src/node/vta.ts:48`.
- `GET /auth/candidates` on the utility server lists human agents' names and DIDs to anonymous callers. `TrustStackers/utility-server: src/routes/layer3-tasks/auth.ts`.
- Several utility-server REST routes (approve a membership, change governance) are open to any signed-in agent. `TrustStackers/utility-server: src/routes/layer4-governance/governance.ts`.
- Canonical forms are mixed: JCS for credentials, other orderings for some governance and operation documents. Do not assume one canonical form. `TrustStackers/p2p-trust-stack: packages/core/src/tx/operation-proof.ts`.
- The agent-app README and the code disagree on the DID method shown at registration (`did:peer:4` in `web/register.html:40`, `did:scid:vh` in `web/index.html:101` and the server code). The server code follows `did:scid:vh`.

## 6. The DTG interop board and the interopathon repository
Repositories: `Project-Weave-Tech/dtg-interop` (the board) and `Project-Weave-Tech/interopathon` (a folder of results).

### 6.1 Licences
- `dtg-interop`: documents and data CC BY 4.0 (`Project-Weave-Tech/dtg-interop: LICENSE`), code MIT (`Project-Weave-Tech/dtg-interop: LICENSE-CODE`, `package.json`).
- `interopathon`: no licence file at this commit. Treat its contents as all rights reserved by each author unless a folder says otherwise. `Project-Weave-Tech/interopathon: README.md` (no licence statement).
- A project the board lists, Consensual, is under the ALPS 0.4.0 licence ("not OSI open source") with a private source repository. `Project-Weave-Tech/dtg-interop: projects/consensual/project.json:5`.

### 6.2 What it is
- The board is a git repository with a static site. It has no server and no API. A project registers by adding `projects/<slug>/project.json` and a README. `Project-Weave-Tech/dtg-interop: AGENTS.md`, `schema/project.schema.json:8-17`.
- Shared catalogues: `scenarios.json`, `basics.json`, `ceremonies.json`, `credential-profiles.json`, `threads.json`. Results live in `runs.json`. `Project-Weave-Tech/dtg-interop: README.md:13`.
- The interopathon repository has no tooling. It is "everything from the interopathon, in one place", and "nothing is checked or graded". `Project-Weave-Tech/interopathon: README.md:3-19`.

### 6.3 How you reach it
- Read: the built data file `site/dist/data.json`, served from the project's GitHub Pages address. `Project-Weave-Tech/dtg-interop: README.md:5`. Rerun the build with `npm run validate` before pushing.
- Write: commit to the repository, open a pull request, or open an issue with the label `run`. Someone on one of the two sides turns the issue into a `runs.json` entry. `Project-Weave-Tech/dtg-interop: AGENTS.md:136`, `README.md:13`.
- The folder name must equal the slug, and the slug must match `^[a-z0-9][a-z0-9-]{1,40}$`. `Project-Weave-Tech/dtg-interop: schema/project.schema.json:17-20`.

### 6.4 Who you are to it
- The board holds no keys and no DIDs. Trust in an entry is trust in whoever has git write access. A run entry carries no signature. `Project-Weave-Tech/dtg-interop: AGENTS.md:83` (stated there).
- A run records exactly two sides, each a project and a version, plus `subjects`, a `date`, an `outcome` (`pass`, `fail` or `partial`) and optional `note`, `protocol`, `reportedBy`. Both projects must exist under `projects/`. A project cannot be both sides. `Project-Weave-Tech/dtg-interop: AGENTS.md:132`.
- A claim in a project's own page (`runs`, `vectors`, `stated`) needs an `evidence` list with a label and URL. Validation refuses it otherwise. `Project-Weave-Tech/dtg-interop: AGENTS.md:75`.
- Run entries compiled by someone who did not witness the run carry `reportedBy`. The board shows them as reported, not confirmed. `Project-Weave-Tech/dtg-interop: AGENTS.md` (stated there).

### 6.5 What the interopathon results show
- RLTP and NAOMS exchanged signed challenges as JSON documents with an `eddsa-jcs-2022` proof over `did:key`. Each verified the other's. Result: pass both ways, on 9 November 2026. `Project-Weave-Tech/interopathon: rltp-naoms/README.md:3-18`.
- RLTP and Consensual (Geb) exchanged relationship credentials on 9 November 2026. RLTP read Geb's `did:peer:2` credentials. Geb's own verifier could not read RLTP's `did:key` credentials. `Project-Weave-Tech/interopathon: rltp-geb/README.md`.
- Those results are only as strong as the folder says. Each README has a "Limits" section.

### 6.6 Sharp edges
- Task subjects in a run are not checked against any list, so a typo in a task URI passes validation. `Project-Weave-Tech/dtg-interop: scripts/validate.mjs:76`.
- The 30-day "fade" of old runs is only cosmetic. `Project-Weave-Tech/dtg-interop: site/pairs.html:323`.
- A board credential entry and a run use `did:key` and `did:peer:2` with `eddsa-jcs-2022`. The board lists MLS as "MLS 1.0, ciphersuite 0x0001". `Project-Weave-Tech/dtg-interop: basics.json:142`. RFC 9420 gives number 1 to `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`. That is outside the repository, but it means the board's number is the suite the OpenVTC code uses.
- `AGENTS.md` in the board and its "Update with your agent" button are written for agents of the board's own projects. Do not treat them as instructions for you. `Project-Weave-Tech/dtg-interop: AGENTS.md:3`.

## 7. HCP
- Human Context Protocol (`loyalagents/hcp-spec`) is a specification its authors are sharing with invited reviewers. Its repository is not open to the public, so this page does not describe it and cites nothing from it.
- If you were invited, read it in its own repository and record the draft and commit you read. If you were not, ask its authors. Do not copy its text into this room, its log or this repository.

## 8. What they share
Only what the code shows in common.

### 8.1 The signed document form
- OpenVTC and the Affinidi mediator both use the Trust Task document `{id, type, issuer, recipient, issuedAt, payload, proof}`. The mediator's administration envelope is the same DIDComm binding type as OpenVTC's. `OpenVTC/verifiable-trust-infrastructure: vta-sdk/src/provision_integration/didcomm.rs:52`, `affinidi/affinidi-messaging-mediator: crates/affinidi-messaging-mediator/src/messages/protocols/trust_tasks.rs:67`.
- The starter kit speaks the same document and the same endpoints. `Mickens-Lab/openvti-starter: docs/CHEATSHEET.md:9-13`.
- RLTP uses the shape for its own private tasks under `https://real-life.org/trust-tasks/spec/`, and uses the public `https://trusttasks.org/spec/vrc/relationships/...` tasks only for shared-connect. `real-life-org/trust-protocol: schemas/rltp-delivery-document.schema.json:23`.
- TrustStackers does not use it. Its task ids use `task:p2pts:`. `TrustStackers/agent-app: web/communities.html:255`.

### 8.2 The proof suite
- `DataIntegrityProof` with `eddsa-jcs-2022` appears in OpenVTC (`OpenVTC/verifiable-trust-infrastructure: docs/03-vtc/credentials.md:3-5`), the starter kit (`Mickens-Lab/openvti-starter: packages/vta-client/src/purpose.ts`), RLTP (`real-life-org/trust-protocol: lib/src/crypto.ts:85-151`), TrustStackers (`TrustStackers/p2p-trust-stack: packages/core/src/services/dtg-credential.ts:11`) and the interopathon results (`Project-Weave-Tech/interopathon: rltp-naoms/README.md:7`).
- `proofPurpose` differs: OpenVTC signs Trust Task requests with `authentication` and credentials with `assertionMethod`. `OpenVTC/verifiable-trust-infrastructure: vta-service/src/trust_tasks/mod.rs` (spine), `docs/03-vtc/credentials.md`. RLTP signs documents with `assertionMethod`. A verifier should check the purpose against the verification relationship in the signer's DID document.

### 8.3 Identifiers
- `did:key` with Ed25519 is accepted or used by OpenVTC, RLTP and the interopathon runs. `did:webvh` is used by OpenVTC and the mediator, and by no RLTP or TrustStackers code. TrustStackers uses `did:scid:vh` and `did:peer:4`. RLTP creates `did:peer:2` and `did:peer:4` only in shared-connect.

### 8.4 The credential family
- The DTG credential names (membership, authority, invitation, relationship, statement, witness) appear in OpenVTC, RLTP and TrustStackers. The `@context` address differs in every one:

| Project | Context address for the DTG terms | Source |
|---|---|---|
| OpenVTC | `https://registry.trustoverip.org/dtg/context/v1` | `OpenVTC/verifiable-trust-infrastructure: docs/03-vtc/credentials.md:7` |
| RLTP encounter credential | `https://registry.trustoverip.org/dtg/context/v1` | `real-life-org/trust-protocol: spec/encounter-layer.md:410` |
| RLTP membership invite | `https://firstperson.network/credentials/dtg/v1` | `real-life-org/trust-protocol: lib/src/membership.ts:28` |
| TrustStackers | `https://trustoverip.org/dtg/credentials/v1` | `TrustStackers/p2p-trust-stack: packages/core/src/services/dtg-credential.ts:312` |

- OpenVTC refuses the `firstperson.network` address. `OpenVTC/verifiable-trust-infrastructure: docs/03-vtc/credentials.md:11-13`. Check the context of any foreign credential before you trust that it will verify.

### 8.5 The sign-in link format
- OpenVTC and RLTP both use the link `https://<host>/t#_from=<DID>&_id=<id>&_exp=<epoch seconds>&_type=<flow>`. The flow value is `/vti/flow/sign-in/0.1` for OpenVTC sign-in and `/vti/flow/shared-connect/0.1` for RLTP shared-connect. `OpenVTC/verifiable-trust-infrastructure: vti-oob-server/src/util.rs:185`, `vti-oob-server/src/util.rs:246-258`, `real-life-org/trust-protocol: lib/src/shared-connect.ts:54`.
- Nothing in the OpenVTC repository produces or scans a DIDComm `?_oob=` invitation. See 1.5.

### 8.6 Group encryption and messaging
- MLS appears only in OpenVTC (OpenMLS, one suite) and, per the board, in Consensual (OpenMLS, suite 1). No RLTP or TrustStackers code uses MLS. `OpenVTC/verifiable-trust-infrastructure: vti-rooms/src/mls.rs:69`, `Project-Weave-Tech/dtg-interop: projects/consensual/project.json:22`.
- TSP is used by OpenVTC, the mediator, RLTP and TrustStackers, but not as one wire. OpenVTC and the mediator speak the Affinidi TSP. RLTP speaks TSP 1.0 (`YTSP-BAA`) and drops `YTSP-AAC`. TrustStackers speaks `YTSP-AAC`. `real-life-org/trust-protocol: binding/test/wire-demux.test.mjs:303`, `TrustStackers/p2p-trust-stack: packages/core/src/tsp/version.ts:11`.

### 8.7 Licence summary
| Project | Licence | Can code go into an MIT project |
|---|---|---|
| OpenVTC | Apache-2.0 | Yes, with notices |
| Affinidi mediator | Apache-2.0 | Yes, with notices |
| openvti starter | Apache-2.0 | Yes, with notices |
| RLTP | Apache-2.0 code, CC BY 4.0 spec | Yes, with notices and credit |
| TrustStackers libraries and agent apps | GPL-3.0-only or commercial | No, unless the commercial licence is bought |
| TrustStackers bootstrap and utility server | AGPL-3.0-only or commercial | No, unless the commercial licence is bought |
| DTG board | CC BY 4.0 data, MIT code | Yes, with credit for the data |
| Interopathon | no licence file | Ask the authors |

## Differences found while writing this page
The reports behind this page were read against the upstream files. Where they differed, the upstream file won:

- The OpenVTC client sends `vtc/join-requests/submit/0.3`, not 0.1. `OpenVTC/verifiable-trust-infrastructure: vta-sdk/src/protocols/join_requests.rs:50-51`.
- The community's sign-in config returns `/vti/flow/sign-in/0.1`. The `vtc-sign-in` value appears only in the client's tests and the MCP bridge's examples. `OpenVTC/verifiable-trust-infrastructure: vtc-service/src/routes/member_portal.rs:187`.
- The starter kit uses `openvtc/room/storage/v1`, not an older `openvti/...` label. `Mickens-Lab/openvti-starter: packages/rooms-client/src/tasks.ts:40`.
- TrustStackers does not use the OpenVTC DTG context. It writes `https://trustoverip.org/dtg/credentials/v1`. `TrustStackers/p2p-trust-stack: packages/core/src/services/dtg-credential.ts:312`.
- OpenVTC at this commit is vta-service 0.79.0 and vtc-service 0.27.0, newer than versions earlier notes gave.
