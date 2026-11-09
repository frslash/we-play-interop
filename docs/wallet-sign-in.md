# Signing in with a wallet

A person scans a code on the room's page with their wallet and approves it there. After that the room knows which DID is at that page. The page never holds the person's own key: it holds a key it made a minute ago, which the person's wallet signed for.

This is the room's side of OpenVTC's wallet sign-in (the `auth/oob` Trust Tasks, started by a "trigger link"). It was built from OpenVTC's code at the commit the room builds from, not from a description of it: `vti-oob-server` (the exchange), `vtc-service` (how a community hosts it, and its page), `vta-service/src/operations/vault/oob_sign_in.rs` (what a wallet's key holder checks before it signs), and `vtc-client/src/signin.rs` (a starter that is not a browser).

**What it is not, yet.** A sign-in does not join anyone to the room and cannot say, propose or vote. The room can answer "who approved this browser key, and until when", and nothing more. [What it would take](#proposed-letting-a-signed-in-browser-write) is written out at the end, for the room's people to decide.

**Not the same as the other QR code.** The You tab also shows "Join on your phone": a short link a phone's camera opens, carrying a DIDComm invitation in `?_oob=`. Nothing in OpenVTC's code read here scans that one, and its design note says a trigger link "is not a variant of the DIDComm out-of-band encoding". It stays until the room's people decide otherwise. The two codes are labelled on the page.

## The exchange

Three keys take part. `K_b` is made by the browser for this one sign-in. `K_a` is made by the wallet for this one scan. The third is the person's own DID, which stays in their wallet.

| Step | Who sends it, signed by | What the room answers |
|---|---|---|
| `auth/oob/request/0.2` | the page, `K_b` | a request id, and when the code runs out (two minutes) |
| `auth/oob/claim/0.2` | the wallet, `K_a`, with the request id as `parentThreadId` | **step 1**, signed by the room: who the room is, the page's origin, what for, and when the decision window closes (two more minutes) |
| `auth/oob/redeem/0.2` | the page, `K_b` | "not yet", with a two-digit number once a wallet has scanned. The page shows it. |
| `auth/oob/prove/0.3` carrying `identify/0.1` | the wallet, `K_a`; inside it the person's DID states the request, `K_a` and the number they typed | **step 2**, signed by the room: step 1 again, plus `K_b`, the browser's family and system, whether it is on the wallet's network, and the DID that was identified |
| `auth/oob/respond/0.3` carrying `grant/0.3` | the wallet, `K_a`; inside it the person's DID approves or declines, naming `K_b`, `K_a`, the origin, an end time and the digest of step 2 | `approved` or `declined`, signed by the room |
| `auth/oob/redeem/0.2` | the page, `K_b` | who is signed in and until when. Once. |
| `auth/oob/cancel/0.1` | the page or the wallet that scanned | `cancelled`, signed by the room |

The rules, each kept as OpenVTC has it:

- Both `K_b` and `K_a` must be Ed25519 `did:key`s. Anything else is refused before a signature is read or a DID looked up.
- `request` is taken only over https and only from the room's own page (the `Origin` header must be the origin of `PUBLIC_URL`). `redeem` only over https. The room's own addition, a deliberate departure from the schema (which allows an `https://` origin only) for local trial: a room that is not in production also answers on `localhost` or `127.0.0.1`, and then step 1's `origin` is `http://…`. A real wallet refuses that origin (its key holder signs a grant only for an `https://` origin), so nobody finishes a real sign-in there. In production the room never answers an `http://` origin, whatever `PUBLIC_URL` or the `Origin` header says.
- The first wallet to scan holds the request. A second one hears "already used" and nothing else.
- One attempt at the number. A wrong number, a statement that does not verify, or a person the room does not let in ends the request. The wallet is told only "not authorised", except for the wrong number.
- The person's statement must be signed for `authentication`, the grant for `assertionMethod`. Each must be addressed to the room's DID, fresh, and is used once.
- The grant must name this request, the key that scanned, `K_b`, the page's origin, and the digest of step 2 exactly as the room signed it (`"z"` + base58btc of `0x12 0x20` + SHA-256 of its canonical JSON, proof included). Anything else is "does not match", and the request ends.
- Only `K_b` learns the number, and only `K_b` can collect. Collecting happens once.
- The room's four answers to the wallet (step 1, step 2, the outcome, a cancel) are signed for `assertionMethod`, by the key the room's DID lists for that. A wallet refuses an answer that is not.

Limits, and what each protects: five unscanned codes per address (one script cannot fill the store with codes nobody will scan); eight held polls per address, each up to 25 seconds; 5,000 requests remembered at once, about 10 MB, with a new code refused for a minute past that rather than an older sign-in dropped; an ended request kept ten minutes so a late document hears how it ended; a session at most twelve hours whatever the grant says (a tab left open on a shared computer should not still be you tomorrow). All of it is in memory and gone with a restart.

## The code

```
https://link.trustoverip.org/t#_from=<the room's DID>&_id=<request id>&_exp=<seconds since 1970>&_type=/vti/flow/sign-in/0.1
```

Plain ASCII, at most 251 bytes (what a QR code at level M holds; the room draws at level M). In `_from` only `&`, `=`, `#` and `%` are percent-encoded. Everything is in the fragment, which a browser never sends to the link host.

**`_from`** is the room's `did:webvh` when it has one, otherwise its `did:key`. With the usual link host the DID may be 143 bytes. The room's is about 67. A port in the DID costs two more bytes, because its `%3A` is encoded again. If the DID is too long the room opens no requests, and `/api/signin/config` and `/api/info` say so with the numbers. It does not fall back to its `did:key`: a wallet could not find a `did:key`'s door anyway.

**`_type`** is `/vti/flow/sign-in/0.1`, though the room is not a community. The flow names the exchange a wallet should start, not the kind of service. The crate that defines the exchange has one constant for it and is written to be used by any service (its README names a community and OpenVTC's network service); a running community's own `GET /v1/member/sign-in/config` answers this value, and its test and its page's tests assert exactly that. The value `vtc-sign-in`, which appears in two client tests, is a made-up answer inside those tests and is never sent by a service.

**The link host** is `link.trustoverip.org` unless `SIGNIN_LINK_HOST` says otherwise. It must be a public DNS name and must not be the room's own domain or under it: a link to the page's own domain opens in the browser, not the wallet.

## What a wallet has to find

A wallet takes nothing from the link but the DID. It resolves that DID and reads two services from its document. Without both it shows "This code can't be used", and the room never hears of it.

| Service `type` | What the wallet does with it | The room |
|---|---|---|
| `TrustTaskHTTPS` | posts every document to `<serviceEndpoint>/trust-tasks` | the Trust Task door publishes this; sign-in only checks that it leads to the door |
| `SignInPortal` | compares its origin with the origin in step 1, and refuses a mismatch | `<origin of PUBLIC_URL>/`, added to the room's DID document by this change, for an https address only |

It also needs the room's signing key listed under `assertionMethod` (the room's document lists `#room` there).

`/api/info` (`signIn.didDocument`) and `/api/signin/config` report what the **published** document lacks: `{ "status": "ok" }` or `{ "status": "missing", "missing": [...] }`. Where something is missing the page offers no code, and says why in the Technical view.

For a program that starts a sign-in without a browser (OpenVTC's `vtc-client` and `vtc-mcp` do), the same answer is served at `<any base>/member/sign-in/config`, with the room's DID also under the name that client reads, `vtcDid`.

## What the room keeps, and says

- `GET /api/signin/session?key=<K_b>`: who approved that key, until when, and the person's signed grant, so anyone can check it without the room's word. `mayWrite` is `false`.
- `GET /api/signin/config`: what a page needs to draw the code.
- `GET /api/info` → `signIn`: whether it is on, and if not why; the link host and flow; what a wallet would trip over; and counts with nobody's key, DID or address in them: how many requests reached each stage (`requested`, `claimed`, `proved`, `approved`, `declined`, `redeemed`, `cancelled`, `expired`, `proofFailed`), how often each refusal was given, and why requests were declined.

Reading the counts: `requested` far above `claimed` means codes are shown and not scanned (a wallet that cannot read them, or cannot find the room). `claimed` above `proved`, with reasons under `declinedFor`, says which check stops people. `approved` above `redeemed` means pages are not collecting in time.

## Who may sign in

OpenVTC leaves this to each service. The room's rule, for now: anyone whose DID the room can read (`did:key`, `did:webvh`, long-form `did:peer:4`), joined or not. Never the room's own DID, an agent's DID, or an account that was replaced by a new key. The check runs before the DID is looked up, again once it is proved, again at the decision, and again when the page collects. A room that wants members only changes one function (`gate`).

## The page's key

Where the browser can, `K_b` is made by WebCrypto as an Ed25519 key that cannot be read out: script can ask it to sign and nothing else. That needs a secure page (https or localhost) and a browser with Ed25519 in WebCrypto (tried here in Chrome 152; OpenVTC's own page does the same). The room's signing is otherwise synchronous, so the page signs these documents through a small asynchronous path of its own (`signWith` in `src/shared/signin.js`), producing the same proof.

What could not be done: on plain http, or in a browser without Ed25519 in WebCrypto, there is no such key, and the page falls back to an ordinary key held in memory, never stored, and says so in the Technical view. The key is not kept across a reload either way. A WebCrypto key can be stored in IndexedDB without becoming readable, and OpenVTC's page does that; it was left out here because a session does nothing yet that is worth keeping.

## Proposed: letting a signed-in browser write

Not built. It changes `src/server/log.js`, `src/shared/types.js`, `src/shared/chain.js` and `rules.json`, which need a person's approval. This is the change, so it can be proposed as it stands.

**The idea.** The room already has a way for one key to write for a person: an agent writes with `onBehalfOf` (its person) and `delegation` (the log line where the person gave permission), and the room checks every such write against that permission. A wallet's grant is the same thing from another direction: the person's DID signing "let this key act as me at this origin until then". So a signed-in browser key is treated as a delegate of the person, with the grant as its permission.

1. **A new line, `session/open`** (`src/shared/types.js`), written and signed by `K_b`. Payload: `{ grant, endsAt }`. `grant` is the `auth/oob/grant/0.3` document exactly as the wallet signed it. `endsAt` is the end the room gave at `redeem`, never later than the grant's `sessionEndsAt`. Step 2 is not put in the log: it says what browser and system the person used, and the log is public and permanent.
2. **Checked once, when it is appended** (`src/server/log.js`, beside `#checkCredential`). The line's signer is an Ed25519 `did:key` that is no one in the room. The grant verifies against its issuer's DID for `assertionMethod`; its `decision` is `approve`; its `sessionKey` is the line's signer; its `origin` is the room's; its `recipient` is the room's DID (so a grant signed for another service that claimed the room's origin is refused); `endsAt` is no later than its `sessionEndsAt`; the room itself collected this grant (`ctx.signIn.session(K_b)` holds it), and no earlier line carries the same grant id.
3. **What the room then keeps** (`src/server/state.js`): an entry in the existing `delegations` map, `{ issuer: the grant's issuer, delegate: K_b, scope, expiresAt: endsAt, session: true }`. `K_b` does not become a participant: it is not an agent, has no name, and is never woken.
4. **Writes** are the agent form, unchanged: signed by `K_b`, with `onBehalfOf` the person and `delegation` the hash of the `session/open` line. In `accept()` the existing checks apply as they are (from this person to this key, not revoked, not expired, the scope covers the kind, the person's rate limit). Two differences from an agent: a session may write `member/join` (see below), and `isHuman(onBehalfOf)` is not required for that one kind.
5. **Joining.** A person who has only a wallet cannot sign `member/join` with their own key from the page. So `member/join` under a session, signed by `K_b` on behalf of the person, is how they join. `state.js` reads the joiner from `e.author` today; it has to read `e.onBehalfOf` (the same DID whenever a person signs for themselves, so nothing else changes).
6. **Scope.** The wallet copies the room's offer (`signingScope` in step 2) into the grant, and the room holds the two equal, so the offer is the scope. It is a list of at most eight task families, each a prefix of whole segments of a type's slug. The room would offer the kinds an agent can be let do, plus joining: `member/join`, `member/card`, `input/note`, `proposal/open`, `proposal/vote`, `map` (projects, ways, runs, resources). A wallet's key holder refuses to sign a grant that delegates `auth`, `acl`, `consent`, `task-consent` or `confirm`, and the room never offers them (`SignIn` refuses to start with one).
7. **Ending.** At `endsAt`. Earlier by a `session/close` line signed by `K_b`; by `delegation/revoke` from the person's own key, which already works on anything in `delegations`; and when the person leaves or their account is replaced.
8. **Checking the log without the room** (`src/shared/chain.js`). `verifyChain` treats `session/open` as it treats `delegation/grant`: it verifies the carried grant against the person's DID, records the delegation with `endsAt`, and then checks every write under it as it checks an agent's. Nothing in the check trusts the room.
9. **The rule as data** (`rules.json`, `src/shared/rules.js`): `signIn: { sessionsMayWrite: true, scope: [...], sessionMaxHours: 12 }`, so the offer and the limit are the room's agreed rules and not a setting.
10. **The page**: after `redeem`, send `session/open`; then sign with `K_b` whenever there is no key of the person's own in the browser.

**The decision this leaves to people.** Approving, vetoing, giving an agent permission, changing the mode, vouching, replacing an account and leaving are for a person's own key today, never an agent's. Under this proposal they stay that way, so a person with only a wallet could join, speak, propose and vote from the page, and could not approve, veto or bring an agent. Two ways to change that: offer those families to a session too (the person's approval in the wallet then covers them for the session), or have the wallet sign each such document itself. The first is a change to who may do the room's most guarded acts; the second depends on what wallets will sign, which the code read here does not settle.

## Not built: RLTP's shared-connect

RLTP's cross-app connect uses the same link with `_type=/vti/flow/shared-connect/0.1`. The room's reader recognises the flow (`readTriggerLink`) and does nothing with it. To take part the room would need what RLTP's reader and ceremony ask for: a `_from` that is a `did:peer:2` or a long-form `did:peer:4` (it refuses a `did:webvh`), carrying its own relay entries (`TSPTransport`, `DIDCommMessaging` or a Nostr relay); a second, pairwise `did:key` that signs the credential; and the `vrc/relationships/propose/0.1` and `issue/0.1` Trust Tasks, in which the scanner speaks first and each side issues the other a relationship credential. That is a way for two people to connect, not a way to sign in, and it needs a messaging transport the room does not have.

## What is not verified

- **No real wallet has scanned the room's code.** The tests play the wallet with this repository's own (`test/helpers/wallet.js`), which sends the documents OpenVTC's code says a wallet sends and checks what that code says a wallet checks. That shows the room is consistent with those shapes. It does not show a wallet accepts the room.
- **The wallet's own reader is not among the sources read.** What a wallet does between scanning and its first document (how it shows the room before the person continues, whether it wants proof that the room's domain and DID belong together, how it decides the room is somewhere this person may sign in) comes from OpenVTC's design note and server code, not from a wallet's code. The chapter that defines the link (the VTI specification's Trigger Links chapter) was not among the sources either.
- **The wallet's key holder signs only for a service the person's entry already names.** `oob_sign_in.rs` refuses a document whose `recipient` is not a DID "the vault entry targets". How a person's wallet comes to hold such an entry for the room was not found in the code read.
- **The HTTP status of "not yet".** The room's door picks it (422 for a refusal a task declares). OpenVTC's clients go by the document's type, not the status; its own code answers 422 to any extended (declared) code, which is the room's choice too (`vtc-service/tests/it/install_claim.rs` says so for its own extended codes, and its 403 is for an authorization denial, not for "not yet"). A browser logs either as a failed request in its console; that is how the exchange is defined.
