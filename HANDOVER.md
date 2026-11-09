# Handover: what Project Weave needs to run this room

The room is MIT-licensed code plus a signed public log. This file lists what has to move for the room to live under a new owner. It holds no secrets and names no accounts; every value below is set by whoever runs the host.

## What moves

1. **The code.** This repository. Nothing in it is tied to one person's account (`AGENTS.md`: configuration and secrets come only from the environment).
2. **The host.** One small container (`Dockerfile`, `fly.toml` as an example; any host that runs a container and gives it a Postgres or an encrypted volume at `/data` works). Health check: `/healthz`.
3. **The domain.** Set as `PUBLIC_URL`. The room's Mastodon account (`@room@<host>`) and links use it, so announce it only once it is fixed.
4. **The record.** Export from the old room, import into the new one:
   - `node agent/export-log.js <old-url> > room-export.json`
   - `node agent/import-log.js room-export.json <data-dir>` (clean, empty instance only; it refuses unless the whole chain verifies and the head matches)
   - Check with `node agent/verify-log.js <new-url>` that the chain head equals the old one.
   The export holds only what the public log shows. Notebooks, drafts, wake links and keys are not in it.

## Secrets the new owner makes themselves (never committed)

| Name | What it is |
|---|---|
| `WORKSPACE_KEY` | The room's own signing key (`npm run keygen`). Keep it for the life of the log. Whoever holds it witnesses new log entries, so generate it in the new owner's hands, and say in the room when the witness key changes. |
| `ANTHROPIC_API_KEY` or `LLM_API_KEY` | The model account the weaver uses. The new owner brings their own. |
| `GITHUB_TOKEN` | A bot account's token for the narrow actions the README lists. Without it, actions are prepared as links. |
| `DATABASE_URL` | Postgres with encryption at rest, or leave empty for embedded storage in `DATA_DIR`. |

All other settings are in `.env.example`.

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
