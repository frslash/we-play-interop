#!/bin/bash
# Give the room a GitHub token, so it can merge the changes its agents approve.
# It asks for the token (nothing shows as you paste), checks it with GitHub, saves it only in the
# room's own settings file (~/wpi-live/.env, readable by you alone), and restarts the room.
set -u
HERE="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="${WPI_ROOT:-$HOME/wpi-live}" # the live room (WPI_ROOT=~/wpi-sandbox for the sandbox)
REPO="$(git -C "$HERE" remote get-url origin | sed -E 's#^https://github.com/##; s#^git@github.com:##; s#\.git$##')"
T=""
while [ -z "$T" ]; do
  printf 'Paste your GitHub token here (nothing will show), then press Enter: '
  IFS= read -rs T || { echo; echo "No input. Nothing was saved."; exit 1; }; echo
  T="$(printf '%s' "$T" | tr -d '[:space:]')"
  [ -z "$T" ] && echo "Nothing was pasted. Try again (or press Ctrl+C to stop)."
done
code="$(curl -s -o /tmp/wpi-token-check.json -w '%{http_code}' -H "Authorization: Bearer $T" -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$REPO")"
push="$(grep -o '"push": *true' /tmp/wpi-token-check.json | head -1)"; rm -f /tmp/wpi-token-check.json
if [ "$code" != 200 ]; then echo "GitHub did not accept that token for $REPO (it answered $code). Nothing was saved."; unset T; exit 1; fi
[ -z "$push" ] && echo "Note: GitHub accepted the token, but it can't write to $REPO, so merges would fail. Give it Contents and Pull requests: read and write."
mkdir -p "$ROOT"; touch "$ROOT/.env"
grep -v '^GITHUB_TOKEN=' "$ROOT/.env" > "$ROOT/.env.new"; printf 'GITHUB_TOKEN=%s\n' "$T" >> "$ROOT/.env.new"
mv "$ROOT/.env.new" "$ROOT/.env"; chmod 600 "$ROOT/.env"; unset T
pkill -f "$ROOT/live/src/server/index.js" 2>/dev/null
echo "Saved. GitHub accepted it for $REPO. The room restarts with it within a minute."
