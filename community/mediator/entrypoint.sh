#!/bin/sh
# Boot the mediator. First boot makes its own identity with `mediator-setup --from` (the recipe's fields are the
# pinned mediator's: tools/mediator-setup/src/recipe.rs), a did:webvh it serves itself at /.well-known/did.jsonl;
# later boots just serve. State lives on this service's volume: without one it would become a new mediator, with a
# new DID, on every restart, and the trust agent and community (set up with the old DID) would stop reaching it.
# The openvti starter kit's mediator-entrypoint.sh is the verified recipe this follows.
#
# WHO MAY USE IT is MEDIATOR_NETWORK_MODE:
#   closed (the default here: Security's condition 2) - a DID may exchange with another only where an access
#          entry allows it. The trust agent and community then cannot reach each other or a wallet through it
#          until entries exist, and they fall back to REST only: joining still works over https, but a pass
#          cannot be pushed to a wallet and community rooms cannot be keyed.
#   open   (what the starter kit runs and verified) - any DID may register and message any other. Needed for the
#          wallet journey; the proxy's per-source limits stand in front of it.
# The choice is a person's, with Security: it is not flipped here.
set -eu
umask 077
[ "$(id -u)" = 0 ] || { echo "entrypoint must start as root to prepare the volume, then drops itself" >&2; exit 78; }
CONF="${MEDIATOR_DATA_DIR:-/var/lib/mediator}"
CONFIG="$CONF/mediator.toml"
PUBLIC_URL="${MEDIATOR_PUBLIC_URL:-https://mediator.inwove.org}"
MODE="${MEDIATOR_NETWORK_MODE:-closed}"
case "$MODE" in open|closed) ;; *) echo "MEDIATOR_NETWORK_MODE must be open or closed" >&2; exit 78 ;; esac
: "${DATABASE_URL:?DATABASE_URL (the Redis this mediator keeps its queues in) must be set}"
chown 10001:10001 "$CONF" && chmod 0700 "$CONF"
AS="setpriv --reuid=10001 --regid=10001 --clear-groups --no-new-privs"

if [ ! -f "$CONFIG" ]; then
  T=$(mktemp -d); chown 10001:10001 "$T"
  cat > "$T/recipe.toml" <<TOML
[deployment]
type = "server"
protocols = ["didcomm", "tsp"]
use_vta = false

[identity]
did_method = "did:webvh"
public_url = "$PUBLIC_URL"

[secrets]
storage = "file://$CONF/mediator-secrets.json"

[security]
ssl = "none"
admin = "generate"
jwt_mode = "generate"
network_mode = "$MODE"
cors = "none"

[database]
url = "$DATABASE_URL"

[output]
config_path = "$CONFIG"
listen_address = "${BIND_ADDRESS:-[::]:7037}"
api_prefix = "/mediator/v1/"

[install]
enabled = false
TOML
  chown 10001:10001 "$T/recipe.toml"
  # mediator-setup prints the admin's private key on stdout: stdout never reaches the logs, and the admin profile it
  # writes is removed (nobody holds an admin key for this test mediator).
  ( cd "$CONF" && $AS mediator-setup --from "$T/recipe.toml" >/dev/null 2>"$T/setup.err" ) || { echo "mediator-setup failed:" >&2; sed -n '1,40p' "$T/setup.err" >&2; rm -rf "$T"; rm -f "$CONFIG"; exit 1; }
  rm -rf "$T"; rm -f "$CONF/admin-monitor.json"
  [ -s "$CONF/did.jsonl" ] || { echo "mediator-setup wrote no $CONF/did.jsonl (its did:webvh log)" >&2; rm -f "$CONFIG"; exit 1; }
  # Two settings the generated file may leave commented out (seen by the starter kit on 0.45): the public address
  # it answers at, and where its own DID log is. Each is set only if still missing, then checked.
  grep -q '^local_endpoints = ' "$CONFIG" || sed -i "s|^# *local_endpoints = .*|local_endpoints = [\"$PUBLIC_URL\"]|" "$CONFIG"
  grep -q '^local_endpoints = ' "$CONFIG" || { echo "could not set local_endpoints in $CONFIG" >&2; rm -f "$CONFIG"; exit 1; }
  sed -i "s|^#* *did_web_self_hosted = .*|did_web_self_hosted = \"file://$CONF/did.jsonl\"|" "$CONFIG"
  grep -q "^did_web_self_hosted = \"file://$CONF/did.jsonl\"\$" "$CONFIG" || { echo "could not set did_web_self_hosted in $CONFIG" >&2; rm -f "$CONFIG"; exit 1; }
  # the Redis functions file is looked up beside the config
  [ -f "$CONF/atm-functions.lua" ] || cp /app/conf/atm-functions.lua "$CONF/atm-functions.lua"
  chown -R 10001:10001 "$CONF"; chmod 600 "$CONF/mediator-secrets.json" "$CONFIG"; chmod 644 "$CONF/did.jsonl"
fi
# A browser may reach it only from the origins named here (the room's page); none by default.
if [ -n "${MEDIATOR_CORS_ALLOW_ORIGIN:-}" ]; then
  case "$MEDIATOR_CORS_ALLOW_ORIGIN" in *[!A-Za-z0-9:/.*-]*) echo "MEDIATOR_CORS_ALLOW_ORIGIN may only hold letters, digits and : / . * - (one origin)" >&2; exit 78 ;; esac
  sed -i "s|^#* *cors_allow_origin = .*|cors_allow_origin = \"$MEDIATOR_CORS_ALLOW_ORIGIN\"|" "$CONFIG"
fi
echo "mediator network mode asked for: $MODE (it takes effect at first boot only; see community/README.md)" >&2
cd /app
exec $AS mediator -c "$CONFIG"
