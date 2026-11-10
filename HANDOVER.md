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
| **The room's signing key** (`WORKSPACE_KEY`) | The founder has chosen to **carry the record over**, so the key moves. Every entry in the record is countersigned by this one key, and the record only continues under it. It moves **only from the old host's sealed settings to the new host's sealed settings**: never through chat, email, the bus, a repository, a card, or a password manager's share between people. The exact steps are in "Moving the room's signing key" below. The old host's copy is then retired, and the date is written down here. |
| **The power to change the room's identity** | The room's DID (`did:webvh` at `inwove.org`) changes only with its update key. Project Weave makes a key on its own computer (`node agent/keygen.js`) and sends only the public half; the old host is given it as `ROOM_DID_UPDATE_KEY`, and on its next start the old room writes the entry that hands the update power over. The DID's log is public, so the new server just serves the same file. |

## Moving the room's signing key

The key has three lawful places and no others: the old host until it is retired; the new host's sealed settings; and one backup
copy wrapped to the recovery public key (step 8). It never appears in chat, email, the bus, a repository, a card, a log, a screenshot
or a person-to-person share. Nobody, the founder included, ever sees its value. Two one-time commands do the carrying, so no person
has to: `agent/import-workspace-key.js` (run on the new host: `init`, then `open`) and `agent/export-workspace-key.js` (run on the old
host). The key is never typed as an argument; the commands refuse one. Each prints only public values.

1. **Before anything** (Project Weave, with the founder). The new host is up with SSH by key only, two-factor sign-in on the provider
   account, the root console holder named, a restore of last night's backup proven on it (`docs/hosting.md`, section 6), and the
   passphrases sealed. *Done when:* those are written down with their dates, and the founder has said go, in chat or on a card.
2. **Freeze the old room** (the founder). Stop the old service once, so nothing is written during the move; write the time down. Take a
   last backup and restore it on the new host **before the key moves**. *Done when:* the restore starts, passes `verify-log.js`, and the
   old room is stopped.
3. **The new host makes a one-time wrapping key** (Project Weave). `node agent/import-workspace-key.js init /root/key-move` makes a
   fresh pair, keeps the private half in `/root/key-move/wrap-key` (readable only by its owner; it never leaves that host), and prints
   the public half and a 24-character fingerprint. *Done when:* those two lines are on the screen.
4. **Carry the public half to the old host** (Project Weave to the founder; a public value, so any route will do). On the old host:
   `node agent/export-workspace-key.js <public half> /root/wrapped-key --env-file <the old room's env file>`. It reads the key from
   the room's own settings, writes only ciphertext, and prints the file's name, the wrapping fingerprint and the key's public
   fingerprint (the room's `did:key`). *Done when:* the file exists and the two fingerprints are printed.
5. **Copy the file host to host, and compare** (the founder, with one person from Project Weave). Copy `/root/wrapped-key` to the new
   host with `scp` or `rsync` over SSH, key only: not by chat, not by email. The old host prints the fingerprint of the public half
   it was given; the person at the old host compares it, **by voice on a call**, with the fingerprint the new host showed (or both read
   out the whole public half). Do not compare by text or chat. The fingerprints are public, so saying them is safe. *Done when:* the wrapping fingerprint matches what step 3 printed,
   and both people have heard the key's `did:key` from the old host.
6. **The new host unwraps and seals** (Project Weave). Make the new room's env file readable only by its owner
   (`umask 077; touch /srv/inwove/.env`, if it is not there yet), then
   `node agent/import-workspace-key.js open /root/key-move /root/wrapped-key --env-file /srv/inwove/.env`. It writes `WORKSPACE_KEY=`
   into that one line of the env file, prints only the key's `did:key`, then overwrites and deletes the file and the wrapping private
   half. An overwrite is not a guarantee on every filesystem (journaling, copy-on-write and flash drives can keep old blocks); the
   encrypted disk is what covers that. If the new host's secrets are kept somewhere other than `.env`, the same line goes there by
   the same one command, never by hand. *Done when:* the printed `did:key` is the one from step 5 and both files are gone.
7. **Prove it** (Project Weave, with Security looking). Start the new room. It opens one old note and one old room entry, the test
   members', and `verify-log.js` gives the same head as before. Only then does DNS or the proxy move. *Done when:* the `did:key` from
   step 6 equals the old host's, and the entries open.
8. **One backup copy, and only one** (the founder and Project Weave). The key wrapped to the recovery public key from the recovery
   sitting (2 of 3 across Project Weave's people, owed before the cut-over; Security sends its exact steps separately). On the old
   host: the same export command with `--recovery <recovery public half>` writes a second file, `<out file>.recovery`; it is kept in the
   encrypted backup, and a person holding one share cannot open it. *Done when:* the file is in the backup and the sitting has proved it
   opens. The sitting itself is not built yet.
   **Do not write a recovery file anywhere until the 2-of-3 recovery sitting exists and has proved it opens**; the security reviewer writes that sitting's steps.
9. **Retire the old copy, with a date** (the founder). On the old host, delete the setting, the wrapped files and any env file or shell
   history that held the key; then take the host down or wipe its volume. Also name, for each of these, that it was deleted or that it is kept and why: the old computer's backups (for example Time Machine, and any cloud drive that syncs the folder), the tunnel's settings, and anything a script or person copied the room's settings into. The key register's row stays open until each is named, deleted, or said to be kept with the reason. Write into the key register: the key's name, its new holder,
   the date it moved, the date the old copy was destroyed, and the proof (the match in step 7). If the old host stays up for any
   reason, the register says so and why. *Done when:* the register row is full; write the date here too: `retired on ____-__-__`.
10. **Rotate the key within a week of the move** (Project Weave, made on the new host only). The key lived on a host Project Weave did
    not run, so a new key replaces it and the record is re-signed under it. **This needs code that does not exist yet:** a log entry
    that hands witnessing from the old key to a new one, which the verifier accepts. It goes to the security reviewer before it is
    built. Until it exists the room runs under the moved key, and that is stated, with the date, in the key register. *Done when:* the
    rotation entry is in the record and `verify-log.js` accepts it.

Note for whoever runs it: Node reads an `--env-file` written after a script's name for itself and stops if that file is missing. On the
new host `open` also takes `--into <path>` in its place, which Node leaves alone.

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
| 4 | Founder, with Security | Move `WORKSPACE_KEY` from the old host's sealed settings to the new host's sealed settings, and nowhere else, by the ten steps in "Moving the room's signing key" below. | Project Weave's server has it in its sealed settings; no copy exists in any chat, email, repository, card or shared password manager. |
| 5 | Project Weave | Export the record with a member's key, import it, copy the DID's log, start the room (`docs/hosting.md`, section 7). The person running it must be a member: a member's export holds the people-only lines too, so the file stays private and is deleted after. | `verify-log.js` gives the same head for both rooms. |
| 6 | Founder | Point `inwove.org` at the new server (DNS only, no proxy). Project Weave checks https, a passkey sign-in, and an agent's link. | A member signs in with their passkey on the new server. |
| 7 | Founder | Transfer the repository to `Project-Weave-Tech`, and the domain to Project Weave's accounts. | Both show Project Weave as owner. |
| 8 | Founder | Say yes to shutting the old host down; its data and its copy of `WORKSPACE_KEY` are retired and deleted, and the date is written here: `retired on ____-__-__`. | Nothing of the room is left on the old host. |

The other way, not taken: a fresh record under a new `WORKSPACE_KEY` made in Project Weave's own hands, with everyone invited again.

## Not settled yet (needs people, not code)

- Security reads the sign-in, invite, passkey and agent code before real people rely on it.
- Who holds the server's root console and the Hetzner account (both need two-factor sign-in, `docs/hosting.md`, "Locking the server down").
- The reviewer reads the first live check before real members rely on the room: one real passkey and one real GitHub OAuth App on the real server; the OAuth client secret set as a host secret and shown to be absent from the repository, the compose file and the logs; and `TRUSTED_CLIENT_IP_HEADER` set to the header Caddy writes.
- Who on Project Weave's side holds the DID update key's private half, the GitHub OAuth App and the model account.
- Whether any paper is needed for the gift (Legal and Governance have been asked).
- A public side of InWove, for builders who have no wallet: a suggestion, not built, in `docs/public-side.md`.
