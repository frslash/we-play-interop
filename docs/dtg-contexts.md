# The three DTG context addresses

A DTG credential names its context address second in `@context` (the first is the W3C credentials v2 address). Three
addresses are in use among the projects the room works with. A credential is signed over the address it names, so
none of them can be rewritten into another after the fact.

| Address | Who writes it | Who refuses others |
|---|---|---|
| `https://registry.trustoverip.org/dtg/context/v1` | OpenVTC (`docs/03-vtc/credentials.md:5-12`, `vtc-service/src/credentials/dtg.rs:7-8`); RLTP's encounter and shared-connect credentials (`real-life-org/trust-protocol: lib/src/encounter.ts:25-27`); the openvti starter kit (`Mickens-Lab/openvti-starter: packages/vtc-client/src/index.ts:179`) | OpenVTC accepts only this one, second in `@context`, and refuses `firstperson.network` "with no alias" (`vtc-service/src/credentials/ingress.rs:6-9,150-160`). RLTP's encounter schemas pin it (`schemas/encounter-credential.schema.json:27`). |
| `https://firstperson.network/credentials/dtg/v1` | RLTP's membership invite and vouch (`lib/src/membership.ts:27-29`) | RLTP's membership schemas pin it (`schemas/payload-membership-invite.schema.json:35`). |
| `https://trustoverip.org/dtg/credentials/v1` | TrustStackers (`TrustStackers/p2p-trust-stack: packages/core/src/services/dtg-credential.ts:310-314`) | None found. |

## Why it matters
A membership credential that RLTP issues today carries the `firstperson.network` address, and an OpenVTC community
refuses that address. So a person holding an RLTP membership cannot use it to join an OpenVTC community, and the other
way round, an OpenVTC pass does not pass RLTP's membership schemas. The same holds for TrustStackers' credentials in
an OpenVTC community.

## What the room does
- It reads all three (`DTG_CONTEXTS` in `src/shared/dtg.js`) and never refuses a pass for the address alone.
- It says which address each pass carried: the answer from `POST /api/community/pass` has
  `context: { name, current }`, with `name` one of `registry-v1`, `firstperson-wd01`, `trustoverip-v1`, and
  `current` true only for the registry one. For the other two it adds one sentence: "This credential uses an older DTG
  context address; OpenVTC communities refuse it." An address none of the three has no name and no sentence.
- It counts them where anyone can read: `/api/info`, under `community.credentials`: `contexts` (how many credentials
  of each name the room has checked) and `issuers` (how many distinct issuers, of passes whose signature held; only
  the number is shown, never a DID; remembered in memory up to 1,000 per name).
- It writes only the registry address. Nothing the room or the agent bridge issues uses another one
  (`test/dtg-contexts.test.js` searches for the two older addresses outside the reader and fails if it finds one).

## The note to the projects
This is written to be sent as it stands. Whether to send it, and to whom, is the room's to decide.

> **To RLTP.** Your encounter and shared-connect credentials use `https://registry.trustoverip.org/dtg/context/v1`,
> but your membership invite and vouch use `https://firstperson.network/credentials/dtg/v1`
> (`lib/src/membership.ts:27-29`, pinned by `schemas/payload-membership-invite.schema.json:35`). OpenVTC communities
> accept only the registry address and refuse the other with no alias (`vtc-service/src/credentials/ingress.rs:6-9`).
> Could the membership invite and vouch move to the registry address? And is the `firstperson.network` address kept
> only so older documents still read?
>
> **To TrustStackers.** Your DTG credentials use `https://trustoverip.org/dtg/credentials/v1`
> (`packages/core/src/services/dtg-credential.ts:310-314`). OpenVTC communities accept only
> `https://registry.trustoverip.org/dtg/context/v1`. Could yours move to the registry address, or is there a reason to
> keep the other?
>
> **To the DTG board.** Three context addresses are in use across the projects on the board. Its schema has no field
> that says which address a project writes today. Could the board show it, so a project can see before it tries to
> interoperate whether another writes the address it accepts? (We ask as a question: we do not know whether that fits
> how the board is meant to be used.)
