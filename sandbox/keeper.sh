#!/bin/bash
# The sandbox room's keeper. It runs a second room whose code the agents change by themselves:
#  - the room runs inside macOS's sandbox (sandbox-exec), which shuts it out of the rest of your home
#    folder: agent-written code can read and write only the sandbox's own folder;
#  - it gets its own address (a Cloudflare quick tunnel) and holds no real people's data;
#  - every minute it looks at the sandbox branch; a new commit is installed and tested inside the
#    sandbox first, then switched in; if the new version does not come up healthy, the last good one
#    comes back.
# Run it from the repo:  bash sandbox/keeper.sh      (stop it: kill the pid in ~/wpi-sandbox/keeper.pid)
# Secrets for the sandbox (only GITHUB_TOKEN, if you want its approved changes merged) go in
# ~/wpi-sandbox/.env, one NAME=value per line.
set -u
HERE="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="${WPI_SANDBOX:-$HOME/wpi-sandbox}"
REPO="${WPI_SANDBOX_REPO:-$(git -C "$HERE" remote get-url origin)}"
BRANCH="${WPI_SANDBOX_BRANCH:-sandbox}"
PORT="${WPI_SANDBOX_PORT:-3200}"
LIVE="$ROOT/live"; STAGE="$ROOT/stage"; LOG="$ROOT/keeper.log"
mkdir -p "$ROOT/data" "$ROOT/home" "$ROOT/.npm"
echo $$ > "$ROOT/keeper.pid"
log () { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >> "$LOG"; }

PROFILE="$ROOT/room.sb"
cat > "$PROFILE" <<EOF
(version 1)
(allow default)
(deny file-read* file-write* (subpath "$HOME"))
(allow file-read-metadata (literal "$HOME"))
(allow file-read* file-write* (subpath "$ROOT"))
EOF
# run something inside the sandbox, from a folder of the sandbox
boxed () { local dir="$1"; shift; (cd "$dir" && HOME="$ROOT/home" npm_config_cache="$ROOT/.npm" exec sandbox-exec -f "$PROFILE" "$@"); }

tunnel () {
  if [ -n "${TUNNEL_PID:-}" ] && kill -0 "$TUNNEL_PID" 2>/dev/null && [ -n "${URL:-}" ]; then return; fi
  : > "$ROOT/tunnel.log"
  cloudflared tunnel --no-autoupdate --url "http://localhost:$PORT" >> "$ROOT/tunnel.log" 2>&1 &
  TUNNEL_PID=$!
  for _ in $(seq 1 60); do URL="$(grep -o -m1 'https://[a-z0-9-]*\.trycloudflare\.com' "$ROOT/tunnel.log")"; [ -n "$URL" ] && break; sleep 1; done
  echo "$URL" > "$ROOT/address"
  log "address $URL"
  ROOM_PID= # a new address means the room starts again with it
}

stop_room () { [ -n "${ROOM_PID:-}" ] && kill "$ROOM_PID" 2>/dev/null; pkill -f "$LIVE/src/server/index.js" 2>/dev/null; ROOM_PID=; sleep 1; }
start_room () {
  stop_room
  set -a; [ -f "$ROOT/.env" ] && . "$ROOT/.env"; set +a
  (cd "$LIVE" && HOME="$ROOT/home" SANDBOX=1 PORT="$PORT" DATA_DIR="$ROOT/data" PUBLIC_URL="$URL" WORKSPACE_NAME="We Play Interop sandbox" \
    WORKSPACE_REPO="$(echo "$REPO" | sed -E 's#^https://github.com/##; s#\.git$##')" WORKSPACE_BRANCH="$BRANCH" VETO_WINDOW_MINUTES=2 APPROVALS_REQUIRED=1 \
    exec sandbox-exec -f "$PROFILE" node "$LIVE/src/server/index.js") >> "$ROOT/room.log" 2>&1 &
  ROOM_PID=$!
  for _ in $(seq 1 40); do curl -sf "http://localhost:$PORT/healthz" >/dev/null && { log "room up at $(git -C "$LIVE" rev-parse --short HEAD)"; return 0; }; sleep 0.5; done
  log "room did not come up at $(git -C "$LIVE" rev-parse --short HEAD)"; return 1
}

if [ ! -d "$LIVE/.git" ]; then
  git clone -q --branch "$BRANCH" "$REPO" "$LIVE" || { log "could not clone $BRANCH"; exit 1; }
  boxed "$LIVE" npm ci --no-audit --no-fund --loglevel=error >> "$LOG" 2>&1 || { log "first install failed"; exit 1; }
fi
log "keeper starting"
tunnel; start_room

while sleep 60; do
  tunnel
  if [ -z "${ROOM_PID:-}" ] || ! kill -0 "$ROOM_PID" 2>/dev/null; then start_room; fi
  git -C "$LIVE" fetch -q origin "$BRANCH" 2>>"$LOG" || continue
  cur="$(git -C "$LIVE" rev-parse HEAD)"; new="$(git -C "$LIVE" rev-parse "origin/$BRANCH")"
  [ "$cur" = "$new" ] && continue
  log "new commit ${new:0:7}: testing it inside the sandbox"
  git -C "$LIVE" worktree remove --force "$STAGE" 2>/dev/null; rm -rf "$STAGE"
  git -C "$LIVE" worktree add -q --detach "$STAGE" "$new" 2>>"$LOG"
  if boxed "$STAGE" npm ci --no-audit --no-fund --loglevel=error >> "$LOG" 2>&1 && boxed "$STAGE" npm test >> "$ROOT/tests.log" 2>&1; then
    git -C "$LIVE" checkout -q --detach "$new" && boxed "$LIVE" npm ci --no-audit --no-fund --loglevel=error >> "$LOG" 2>&1
    if start_room; then log "updated to ${new:0:7}"; else
      log "rolling back to ${cur:0:7}"; git -C "$LIVE" checkout -q --detach "$cur"; boxed "$LIVE" npm ci --no-audit --no-fund --loglevel=error >> "$LOG" 2>&1; start_room
    fi
  else
    log "tests failed on ${new:0:7}: staying on ${cur:0:7} (see tests.log)"
  fi
  git -C "$LIVE" worktree remove --force "$STAGE" 2>/dev/null
done
