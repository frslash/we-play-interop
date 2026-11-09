#!/bin/sh
# Boot the trust community. Same shape as the trust agent (Security 12376 A, C): root only to fix the volume
# owner and put the passphrase on a tmpfs, then drop to uid 10001 with VTC_SECRETS_PASSPHRASE removed from the
# environment.
#
# First boot is OpenVTC's two-phase headless setup (docs/03-vtc/non-interactive-setup.md and
# examples/vtc-setup.example.toml at the pinned commit; the openvti starter kit's vtc-entrypoint.sh is the
# verified recipe): phase 1 mints a one-time setup key; the trust agent grants it (its first-boot helper reads
# the key's DID from this service on the private network); phase 2 is retried until that grant lands.
# What phase 2 prints (the community's DID, the first admin's DID, the install link and claim code) goes to a
# 0600 file on the volume, never to a log: the claim code reaches a person only through their own host login.
set -eu
umask 077
ulimit -c 0
: "${VTC_SECRETS_PASSPHRASE:?VTC_SECRETS_PASSPHRASE must be set as a sealed Railway variable}"
[ "${#VTC_SECRETS_PASSPHRASE}" -ge 22 ] || { echo "VTC_SECRETS_PASSPHRASE is too short (machine-made, 128 bits or more)" >&2; exit 78; }
[ "$(id -u)" = 0 ] || { echo "entrypoint must start as root to prepare the volume and the tmpfs, then drops itself" >&2; exit 78; }
DATA="${VTC_DATA_DIR:-/var/lib/vtc}"
CREDS="${VTC_CREDS_DIR:-/dev/shm/vtc-creds}"
CONFIG="$DATA/config.toml"
KEY="$DATA/setup-key.json"
CONTEXT="${VTC_CONTEXT:-vtc}"

chown 10001:10001 "$DATA" && chmod 0700 "$DATA"

mkdir -p "$CREDS"
[ "$(stat -f -c %T "$CREDS")" = "tmpfs" ] || { echo "$CREDS is not a tmpfs: refusing to write the passphrase" >&2; exit 78; }
chown 10001:10001 "$CREDS" && chmod 0700 "$CREDS"
rm -f "$CREDS/secrets-passphrase"
printf '%s' "$VTC_SECRETS_PASSPHRASE" > "$CREDS/secrets-passphrase"
chown 10001:10001 "$CREDS/secrets-passphrase" && chmod 0400 "$CREDS/secrets-passphrase"

# The agent's REST door is on the private network (never through the proxy), so this service may call a private
# address named in the agent's DID document (vta-sdk reads VTA_ALLOW_PRIVATE_ENDPOINTS: src/resolver.rs), but only
# over https, or plain http to loopback (vta-sdk/src/http.rs, guard_vta_endpoint): on Railway, where the agent's
# door is http://vta.railway.internal, phase 2 is refused until that door is https (see README, "Known to fail").
export VTA_ALLOW_PRIVATE_ENDPOINTS="${VTA_ALLOW_PRIVATE_ENDPOINTS:-1}"
export VTC_CONFIG_PATH="$CONFIG"
AS="env -u VTC_SECRETS_PASSPHRASE setpriv --reuid=10001 --regid=10001 --clear-groups --no-new-privs"
MEDIATOR_URL="${MEDIATOR_INTERNAL_URL-http://mediator.railway.internal:7037}"
CORS="${VTC_CORS_ORIGINS-\"https://inwove.org\"}"
first_did() { grep -o '"id":"did:[^"#]*"' "$1" | head -1 | sed 's/"id":"\(.*\)"/\1/'; }

if [ ! -f "$DATA/.initialised" ]; then
  BASE_URL="${VTC_PUBLIC_URL:-https://vtc.inwove.org}"
  VTA="${VTA_INTERNAL_URL:-http://vta.railway.internal:8100}"
  # Phase 1: the one-time setup key (kept across restarts so the same DID is granted once).
  [ -f "$KEY" ] || $AS vtc setup --setup-key-out "$KEY" --context "$CONTEXT" >/dev/null 2>&1 || { echo "vtc setup phase 1 failed (output withheld)" >&2; exit 1; }
  $AS node "${VTC_SERVE_DID:-/usr/local/lib/serve-did.mjs}" "$KEY" "${VTC_HANDOFF_PORT:-8201}" &
  SRV=$!
  echo "waiting for the trust agent's DID at $VTA" >&2
  n=0; until wget -qO "$CREDS/vta.jsonl" "$VTA/.well-known/did.jsonl" 2>/dev/null && [ -n "$(first_did "$CREDS/vta.jsonl")" ]; do
    n=$((n+1)); [ "$n" -lt 360 ] || { echo "the trust agent did not serve its DID in 30 minutes" >&2; exit 1; }
    sleep 5
  done
  MESSAGING=""
  if [ -n "$MEDIATOR_URL" ] && wget -qO "$CREDS/mediator.jsonl" "$MEDIATOR_URL/.well-known/did.jsonl" 2>/dev/null && [ -n "$(first_did "$CREDS/mediator.jsonl")" ]; then
    MESSAGING="
[messaging]
mediator_did = \"$(first_did "$CREDS/mediator.jsonl")\"
transports   = [\"tsp\", \"didcomm\"]
mediator_url = \"${MEDIATOR_PUBLIC_URL:-https://mediator.inwove.org}\"
"
  fi
  cat > "$CREDS/vtc-setup.toml" <<TOML
config_path    = "$CONFIG"
base_url       = "$BASE_URL"
vta_did        = "$(first_did "$CREDS/vta.jsonl")"
context        = "$CONTEXT"
setup_key_file = "$KEY"
provision_transport = "rest"
single_admin_mode = ${VTC_SINGLE_ADMIN:-true}
$MESSAGING
[secrets]
backend = "encrypted-file"

[secrets.encrypted_file]
path = "$DATA/secret.enc"
kek  = { source = "passphrase", file = "$CREDS/secrets-passphrase" }
TOML
  chown 10001:10001 "$CREDS/vtc-setup.toml"
  # Phase 2 fails until the trust agent has granted the setup DID; it is retried for up to an hour (the grant's own life).
  echo "waiting for the trust agent's grant of the setup DID; retrying phase 2 every 5 s" >&2
  n=0; until $AS vtc setup --from "$CREDS/vtc-setup.toml" > "$DATA/first-run.out" 2>/dev/null; do
    n=$((n+1)); [ "$n" -lt 720 ] || { kill "$SRV" 2>/dev/null || true; echo "vtc setup phase 2 did not succeed within an hour (output withheld). Delete this service's and the trust agent's volumes to start over." >&2; exit 1; }
    sleep 5
  done
  kill "$SRV" 2>/dev/null || true
  chown 10001:10001 "$DATA/first-run.out"; chmod 0600 "$DATA/first-run.out"
  rm -f "$KEY" "$CREDS/vtc-setup.toml" "$CREDS/vta.jsonl" "$CREDS/mediator.jsonl"
  # the room's page may call this community from a browser: exact origins only (setup writes an empty list)
  [ -z "$CORS" ] || sed -i "s|^allowed_origins = \[\]\$|allowed_origins = [$CORS]|" "$CONFIG"
  # the test admin may approve joins from the start (an offline write, before the service listens)
  [ -z "${VTC_ADMIN_DID:-}" ] || $AS vtc --config "$CONFIG" acl add --did "$VTC_ADMIN_DID" --role admin --label room-test-admin >/dev/null 2>&1 || echo "could not add VTC_ADMIN_DID to the community's access list (claim the install link instead)" >&2
  : > "$DATA/.initialised"; chown 10001:10001 "$DATA/.initialised"
fi
# both services build their address as "<host>:<port>" (src/server.rs), so an IPv6 host is written in brackets;
# [::] also takes IPv4, and is what a private network that is IPv6 inside (Railway) needs
export VTC_SERVER_HOST="${BIND_HOST:-[::]}"
exec $AS vtc --config "$CONFIG"
