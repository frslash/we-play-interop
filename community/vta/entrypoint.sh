#!/bin/sh
# Boot the trust agent. Starts as root only long enough to (1) fix the volume's owner and (2) put the seed's
# passphrase in a tmpfs file, then drops to uid 10001 with the passphrase REMOVED from the environment.
# Security 12376 (A, C): the agent reads its passphrase only from a file (never config, never env), and the file
# must never sit on the volume beside seed.enc. Nothing here prints a secret; no `set -x`.
#
# First boot follows OpenVTC's docs/02-vta/non-interactive-setup.md and examples/vta-setup.example.toml at the
# pinned commit, and the openvti starter kit's vta-entrypoint.sh (the verified recipe):
#   - `[vta_did] kind = "create_webvh"`: without a DID of its own the agent refuses to start;
#   - in a SETUP file the encrypted-file fields sit directly in [secrets] (the sub-table form is only what the
#     agent writes into its own config.toml afterwards);
#   - `[[staff]]` names the first-boot helper's throwaway key admin of the one context the community lives in,
#     so it can sign the community's one-time hand-off grant (see handoff.mjs) and then be deleted.
set -eu
umask 077
ulimit -c 0
: "${VTA_SEED_PASSPHRASE:?VTA_SEED_PASSPHRASE must be set as a sealed Railway variable}"
[ "${#VTA_SEED_PASSPHRASE}" -ge 22 ] || { echo "VTA_SEED_PASSPHRASE is too short (machine-made, 128 bits or more)" >&2; exit 78; }
[ "$(id -u)" = 0 ] || { echo "entrypoint must start as root to prepare the volume and the tmpfs, then drops itself" >&2; exit 78; }
DATA="${VTA_DATA_DIR:-/var/lib/vta}"
CREDS="${VTA_CREDS_DIR:-/dev/shm/vta-creds}"
CONFIG="$DATA/config.toml"
PORT="${VTA_PORT:-8100}"
CONTEXT="${VTC_CONTEXT:-vtc}"
HELPER="${VTA_HANDOFF_HELPER:-/usr/local/lib/handoff.mjs}"
# The agent builds its address as "<host>:<port>" (vta-service/src/server.rs), so an IPv6 host is written in brackets;
# [::] also takes IPv4, and is what a private network that is IPv6 inside (Railway) needs.
BIND="${BIND_HOST:-[::]}"
# Where the mediator and the community answer on the private network. Set either to empty to run without it.
MEDIATOR_URL="${MEDIATOR_INTERNAL_URL-http://mediator.railway.internal:7037}"
HANDOFF_URL="${VTC_HANDOFF_URL-http://vtc.railway.internal:8201/setup-did}"

# C: the volume belongs to the service user; no RAILWAY_RUN_UID=0.
chown 10001:10001 "$DATA" && chmod 0700 "$DATA"

# A1-A2: the passphrase file, on a tmpfs only, 0700 dir / 0400 file, owned by 10001.
mkdir -p "$CREDS"
[ "$(stat -f -c %T "$CREDS")" = "tmpfs" ] || { echo "$CREDS is not a tmpfs: refusing to write the passphrase" >&2; exit 78; }
chown 10001:10001 "$CREDS" && chmod 0700 "$CREDS"
rm -f "$CREDS/seed-passphrase"
printf '%s' "$VTA_SEED_PASSPHRASE" > "$CREDS/seed-passphrase"
chown 10001:10001 "$CREDS/seed-passphrase" && chmod 0400 "$CREDS/seed-passphrase"

# A3: the service starts from a root process, so the variable is dropped with env -u, not just unset here.
AS="env -u VTA_SEED_PASSPHRASE setpriv --reuid=10001 --regid=10001 --clear-groups --no-new-privs"
first_did() { grep -o '"id":"did:[^"#]*"' "$1" | head -1 | sed 's/"id":"\(.*\)"/\1/'; } # the DID itself: the first id with no #fragment

if [ ! -f "$DATA/.setup-done" ]; then
  # The admin is a TEST did:key the room's people hold (a public DID, not a secret; its private key is never on this
  # host). With it the agent is sealed: only signed requests change it. Without it the agent has no admin and stays
  # unsealed, so whoever can open a shell on this host can still change it offline: fine for a test, said out loud.
  ADMIN=""
  if [ -n "${VTA_ADMIN_DID:-}" ]; then ADMIN="admin_did        = \"$VTA_ADMIN_DID\"
admin_label      = \"room-test-admin\""; else echo "VTA_ADMIN_DID is not set: this trust agent starts with no admin and is NOT sealed (test only)" >&2; fi
  PUBLIC_URL="${VTA_PUBLIC_URL:-https://vta.inwove.org}"            # where its DID log is published (through the proxy)
  REST_URL="${VTA_REST_URL:-http://vta.railway.internal:$PORT}"     # its REST door: the private network only, never the proxy
  MESSAGING='kind = "skip"'; SERVICES='didcomm = false
tsp     = false'
  if [ -n "$MEDIATOR_URL" ]; then
    M="$MEDIATOR_URL"; n=0
    echo "waiting for the mediator's DID at $M" >&2
    until wget -qO "$CREDS/mediator.jsonl" "$M/.well-known/did.jsonl" 2>/dev/null && [ -n "$(first_did "$CREDS/mediator.jsonl")" ]; do
      n=$((n+1)); [ "$n" -lt 120 ] || { echo "the mediator did not serve its DID in 10 minutes; set MEDIATOR_INTERNAL_URL to empty to run without messaging" >&2; exit 1; }
      sleep 5
    done
    MESSAGING="kind = \"existing\"
did  = \"$(first_did "$CREDS/mediator.jsonl")\""
    SERVICES='didcomm = true
tsp     = true'
  fi
  NAME="${VTA_NAME:-We Play Interop VTA, TEST, test keys}"
  [ -f "$DATA/bootstrap.json" ] || $AS node "$HELPER" keygen "$DATA/bootstrap.json" >/dev/null
  BOOT_DID=$($AS node "$HELPER" did "$DATA/bootstrap.json")
  cat > "$CREDS/setup.toml" <<TOML
config_path      = "$CONFIG"
overwrite_config = true
data_dir         = "$DATA/data"
data_dir_exists  = "delete"
vta_name         = "$NAME"
public_url       = "$REST_URL"
$ADMIN

[server]
host = "$BIND"
port = $PORT

[log]
level  = "info"
format = "json"

[secrets]
backend = "encrypted_file"
path    = "$DATA/seed.enc"
kek     = { source = "passphrase", file = "$CREDS/seed-passphrase" }

[messaging]
$MESSAGING

[services]
rest    = true
$SERVICES

[vta_did]
kind = "create_webvh"
url  = "$PUBLIC_URL"

[[staff]]
did     = "$BOOT_DID"
context = "$CONTEXT"
label   = "first-boot hand-off helper, its key is deleted after one use"
role    = "admin"
TOML
  chown 10001:10001 "$CREDS/setup.toml"
  $AS vta setup --from "$CREDS/setup.toml" >/dev/null 2>&1 || { echo "vta setup failed (output withheld: it can hold secrets). A half-finished setup is wiped and retried on the next start." >&2; exit 1; }
  rm -f "$CREDS/setup.toml" "$CREDS/mediator.jsonl"
  : > "$DATA/.setup-done"; chown 10001:10001 "$DATA/.setup-done"
fi

if [ ! -f "$DATA/.handoff-done" ] && [ -f "$DATA/bootstrap.json" ] && [ -n "$HANDOFF_URL" ]; then
  # Beside the running agent: wait for the community's setup DID, sign its one-time grant, delete the helper's key.
  ( n=0; until wget -qO "$CREDS/self.jsonl" "http://127.0.0.1:$PORT/.well-known/did.jsonl" 2>/dev/null; do n=$((n+1)); [ "$n" -lt 60 ] || exit 1; sleep 2; done
    SELF=$(first_did "$CREDS/self.jsonl")
    SUBJECT=$($AS node "$HELPER" wait-did "$HANDOFF_URL" 3600) || { echo "hand-off: no community asked within the hour; restart this service to wait again" >&2; exit 1; }
    $AS node "$HELPER" grant "$DATA/bootstrap.json" "http://127.0.0.1:$PORT" "$SELF" "$SUBJECT" "$CONTEXT" >&2 || { echo "hand-off: the grant was refused; restart this service to try again" >&2; exit 1; }
    rm -f "$DATA/bootstrap.json" "$CREDS/self.jsonl"; : > "$DATA/.handoff-done"; chown 10001:10001 "$DATA/.handoff-done"
  ) &
fi
exec $AS vta --config "$CONFIG"
