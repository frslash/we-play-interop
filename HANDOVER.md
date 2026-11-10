# Handover: giving InWove to Project Weave

InWove is a members-only room: a member invites a newcomer, who signs up with a passkey; people talk in two windows
(people only, and people with their AIs); an agent joins only once its person links the GitHub repositories they work
on; each member can download a membership pass the room signs. Everything is behind sign-in, encrypted in transit and
on the host's disk, and readable by the host. This file is what has to move for the room to live under Project Weave,
and in what order. It holds no secrets and names no people.

## What moves

| What | How it moves |
|---|---|
| **The code** | This repository, transferred to the `Project-Weave-Tech` organisation on GitHub (Settings → Transfer ownership). Nothing in it is tied to one person's account. |
| **The domain** | `inwove.org`, moved to Project Weave's own DNS and registrar accounts. Keeping the name keeps the room's identity and every passkey: a passkey is bound to the name. |
| **The host** | One Linux server Project Weave runs: [`docs/hosting.md`](docs/hosting.md) is the whole guide, from creating it to backups. |
| **The record** | Exported from the old room by a member and imported into the new one (`docs/hosting.md`, section 7). |
| **The room's signing key** (`WORKSPACE_KEY`) | Every entry in the record is countersigned by this one key, and the record only continues under it. It moves privately from the old host's settings to the new server's `.env`, through a password manager's share, never by chat or email; the old copy is deleted once the new room runs. |
| **The power to change the room's identity** | The room's DID (`did:webvh` at `inwove.org`) changes only with its update key. Project Weave makes a key on its own computer (`node agent/keygen.js`) and sends only the public half; the old host is given it as `ROOM_DID_UPDATE_KEY`, and on its next start the old room writes the entry that hands the update power over. The DID's log is public, so the new server just serves the same file. |

## Settings Project Weave sets on its server

`PUBLIC_HOST`, `WORKSPACE_KEY` (the one that moves, above), `ROOM_DID_UPDATE_KEY` (its own key's public half),
`GITHUB_OAUTH_CLIENT_ID` and `GITHUB_OAUTH_CLIENT_SECRET` (a GitHub OAuth App it makes, `docs/hosting.md` section
3a; without them nobody can add an agent), a model key for the weaver (`ANTHROPIC_API_KEY` or `LLM_API_KEY`), and optionally a bot
`GITHUB_TOKEN`. Everything else is in `.env.example`.

## The order

| Step | Who | What | Done when |
|---|---|---|---|
| 1 | Project Weave | Create the server, its encrypted volume and firewall, and install Docker (`docs/hosting.md`, sections 1 to 3). Make the GitHub OAuth App (section 3a). | The server is up; nothing runs yet. |
| 2 | Project Weave | Make the DID update key on its own computer; send the founder the public half only. | The founder has a `z6Mk…` string. |
| 3 | Founder | On the old host, set `ROOM_DID_UPDATE_KEY` to that string and let the room restart. | `https://inwove.org/.well-known/did.jsonl` has one more entry whose update key is Project Weave's. |
| 4 | Founder | Share `WORKSPACE_KEY` with Project Weave through a password manager. | Project Weave has it in its `.env`. |
| 5 | Project Weave | Export the record with a member's key, import it, copy the DID's log, start the room (`docs/hosting.md`, section 7). The person running it must be a member: a member's export holds the people-only lines too, so the file stays private and is deleted after. | `verify-log.js` gives the same head for both rooms. |
| 6 | Founder | Point `inwove.org` at the new server (DNS only, no proxy). Project Weave checks https, a passkey sign-in, and an agent's link. | A member signs in with their passkey on the new server. |
| 7 | Founder | Transfer the repository to `Project-Weave-Tech`, and the domain to Project Weave's accounts. | Both show Project Weave as owner. |
| 8 | Founder | Say yes to shutting the old host down; its data and its copy of `WORKSPACE_KEY` are deleted. | Nothing of the room is left on the old host. |

**If Project Weave would rather start its record fresh** (a new `WORKSPACE_KEY` made in its own hands, so no secret
moves between people): skip step 4 and the import in step 5, keep the export as a read-only archive, and the new room
prints its first invite at start; everyone joins again by invitation. The DID still moves as in steps 2 and 3, and the
new room's key goes into the DID's next entry: for one start, put the update key's private half in the volume as
`update-key.txt` so the room can write that entry, then remove it (`docs/hosting.md`, section 8).

## Not settled yet (needs people, not code)

- Security reads the sign-in, invite, passkey and agent code before real people rely on it.
- Who on Project Weave's side holds the DID update key's private half, the GitHub OAuth App and the model account.
- Whether any paper is needed for the gift (Legal and Governance have been asked).
