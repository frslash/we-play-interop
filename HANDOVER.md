# Handover: what Project Weave needs to run this room

The room is MIT-licensed code plus a signed public log. This file lists what has to move for the room to live under a new owner. It holds no secrets and names no accounts; every value below is set by whoever runs the host.

## What moves

1. **The code.** This repository. Nothing in it is tied to one person's account (`AGENTS.md`: configuration and secrets come only from the environment).
2. **The host.** One ordinary Linux server running the room and Caddy (automatic https) with `docker-compose.yml`, its data on an encrypted volume. [`docs/hosting.md`](docs/hosting.md) is the whole guide, from creating the server to backups. Health check: `/healthz`.
3. **The domain.** Set as `PUBLIC_URL`. The room's Mastodon account (`@room@<host>`) and links use it, so announce it only once it is fixed.
4. **The record.** Export from the old room, import into the new one:
   - `WPI_MEMBER_KEY_FILE=<file holding a member's key> node agent/export-log.js <old-url> > room-export.json` (both rooms are members-only: the tools sign in with a member's own key, never one given on the command line)
   - `node agent/import-log.js room-export.json <data-dir>` (clean, empty instance only; it refuses unless the whole chain verifies and the head matches)
   - Check with `WPI_MEMBER_KEY_FILE=<key file> node agent/verify-log.js <new-url>` that the chain head equals the old one.
   - On the new server these run inside the room's image: the exact commands are in section 7 of [`docs/hosting.md`](docs/hosting.md).
   A member sees people-only lines, so a member's export is the whole record. Notebooks, drafts, wake links and keys are not in the log, so not in it. Keep the file private.

## Secrets the new owner makes themselves (never committed)

| Name | What it is |
|---|---|
| `WORKSPACE_KEY` | The room's own signing key (`npm run keygen`). Keep it for the life of the log. Whoever holds it witnesses new log entries, so generate it in the new owner's hands, and say in the room when the witness key changes. |
| `ANTHROPIC_API_KEY` or `LLM_API_KEY` | The model account the weaver uses. The new owner brings their own. |
| `GITHUB_TOKEN` | A bot account's token for the narrow actions the README lists. Without it, actions are prepared as links. |
| `DATABASE_URL` | Leave empty: the compose file keeps the record in embedded storage in the encrypted volume. Set it only to use an outside Postgres that is encrypted at rest. |
| `ROOM_DID_UPDATE_KEY` | The public half of the key that may change the room's DID; the private half stays with the owner's people, never on the server (`docs/hosting.md`, section 8). |

All other settings are in `.env.example`. They go in the server's `.env`, which is never committed or put in a shared place.

## Order for a clean handover

1. New owner picks the domain and host, and generates `WORKSPACE_KEY` and the other secrets themselves.
2. Run the export from the old room; stand up the new one empty; import; verify the chain head.
3. Run the new room beside the old one. The old link keeps working until the cutover.
4. Cut over: point the domain, set `PUBLIC_URL`, tell the room.
5. Old owner deletes their copy of the data and revokes their tokens only after the new owner confirms.

## Not settled yet (needs people, not code)

- Who holds `WORKSPACE_KEY` and the model and GitHub accounts on Project Weave's side.
- The room's `did:webvh` for the permanent address (Railroad and Security are saying what a clean handover of its roles needs). Until it exists the room's DID is a `did:key`.
- Moving people's sealed notebooks: opt-in per person, with the old copy kept until they confirm. Real people's keys and notes stay out until Security has read the final code.
- Whether any paper is needed for the gift (Legal and Governance have been asked).
