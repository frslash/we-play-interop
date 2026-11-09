#!/bin/sh
# Boot the mediator. First boot makes its own identity with `mediator-setup --from` (the recipe's fields are the
# pinned mediator's: tools/mediator-setup/src/recipe.rs), a did:webvh it serves itself at /.well-known/did.jsonl;
# later boots just serve. State lives on this service's volume: without one it would become a new mediator, with a
# new DID, on every restart, and the trust agent and community (set up with the old DID) would stop reaching it.
# The openvti starter kit's mediator-entrypoint.sh is the verified recipe this follows.
#
# WHO MAY USE IT: closed, and only closed (Security, bus block 11114 condition 1; Security's answer of 2026-11-09).
# A DID may exchange messages only where an access entry allows it. People are let in one at a time, by their own
# DID, with the admin key; that step is Security's to write, and nothing here builds a way in. Every boot refuses to
# start if the file or the environment would open it up, then exports the four values the mediator must run with.
# Facts, from the pinned v0.50.0 (crates/affinidi-messaging-mediator/):
#   - tools/mediator-setup/src/config_writer.rs:254-270: network mode `closed` writes mediator_acl_mode =
#     "explicit_allow" and global_acl_default = "DENY_ALL,LOCAL,SEND_MESSAGES,RECEIVE_MESSAGES"; `open`, and any typo,
#     writes "explicit_deny" and "ALLOW_ALL".
#   - affinidi-messaging-mediator-config/src/env.rs:60-112: the environment wins over the file (MEDIATOR_ACL_MODE,
#     GLOBAL_DEFAULT_ACL, ENABLE_INTER_MEDIATOR_RELAY, TRUST_TASK_VERIFICATION, ADMIN_DID, DID_WEB_SELF_HOSTED,
#     LOCAL_ENDPOINTS, CORS_ALLOW_ORIGIN).
#   - `allow_unauthenticated_forwards` lives only in [didcomm_v1] (config_writer.rs:199-211), which this image does not
#     compile (didcomm-v1 is not a default feature: Cargo.toml:23,86-94). It is refused anyway, in case that changes.
set -eu
umask 077
[ "$(id -u)" = 0 ] || { echo "entrypoint must start as root to prepare the volume, then drops itself" >&2; exit 78; }
CONF="${MEDIATOR_DATA_DIR:-/var/lib/mediator}"
CONFIG="$CONF/mediator.toml"
PUBLIC_URL="${MEDIATOR_PUBLIC_URL:-https://mediator.inwove.org}"
refuse() { echo "mediator: refusing to start: $*" >&2; exit 78; }

MODE="${MEDIATOR_NETWORK_MODE:-closed}"
case "$MODE" in
  closed) ;;
  open) refuse "MEDIATOR_NETWORK_MODE=open writes global_acl_default = \"ALLOW_ALL\" (any DID may message any other); it needs Security's yes, and this host runs closed only" ;;
  *) refuse "MEDIATOR_NETWORK_MODE must be closed (got something else; the setup tool would read a typo as open)" ;;
esac

# The admin. By default mediator-setup makes one at first boot: its key is printed (stdout is discarded here) and
# also kept in the mediator's own secrets file on this volume (tools/mediator-setup/src/main.rs:1647-1665), so whoever
# holds this host holds that admin; nobody else does. MEDIATOR_ADMIN_DID names an admin made somewhere else instead:
# a public DID only, never a key, so that admin's private key is never on this host. The generated one is then never
# made an account (only the configured admin_did is: src/server.rs:1424-1460), so its stored key opens nothing. The recipe's own `admin = "import"` is not built at v0.50.0 (recipe.rs:213-215,
# 626-628: "TODO: handle imported admin DID"), so the DID goes in through the mediator's ADMIN_DID override
# (env.rs:67), which every boot makes the root admin account (src/server.rs:1424-1460).
unset ADMIN_DID
ADMIN_SOURCE="generated at first boot (its key is only in this volume's secrets file)"
if [ -n "${MEDIATOR_ADMIN_DID:-}" ]; then
  # 512 characters stands for "an identifier, not a document or a key": a did:key is about 56, a did:peer:2 a few hundred.
  [ "${#MEDIATOR_ADMIN_DID}" -le 512 ] || refuse "MEDIATOR_ADMIN_DID is too long to be a DID"
  printf '%s' "$MEDIATOR_ADMIN_DID" | grep -Eqx 'did:[a-z0-9]+:[A-Za-z0-9._:%-]+' || refuse "MEDIATOR_ADMIN_DID must be a DID (did:<method>:<id>), and only a DID: never a key"
  export ADMIN_DID="did://$MEDIATOR_ADMIN_DID"
  ADMIN_SOURCE="$MEDIATOR_ADMIN_DID (from MEDIATOR_ADMIN_DID; its key is held elsewhere)"
fi

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
network_mode = "closed"
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
  # mediator-setup prints the admin's private key on stdout (tools/mediator-setup/src/main.rs:1917-1930): stdout never
  # reaches the logs, and the admin profile it writes (admin-monitor.json, a second copy of that key) is removed.
  ( cd "$CONF" && $AS mediator-setup --from "$T/recipe.toml" >/dev/null 2>"$T/setup.err" ) || { echo "mediator-setup failed:" >&2; sed -n '1,40p' "$T/setup.err" >&2; rm -rf "$T"; rm -f "$CONFIG"; exit 1; }
  rm -rf "$T"; rm -f "$CONF/admin-monitor.json"
  [ -s "$CONF/did.jsonl" ] || { echo "mediator-setup wrote no $CONF/did.jsonl (its did:webvh log)" >&2; rm -f "$CONFIG"; exit 1; }
  # the Redis functions file is looked up beside the config (mediator-setup normally writes it there too)
  [ -f "$CONF/atm-functions.lua" ] || cp /app/conf/atm-functions.lua "$CONF/atm-functions.lua"
  chown -R 10001:10001 "$CONF"; chmod 600 "$CONFIG"; chmod 644 "$CONF/did.jsonl"
  [ ! -f "$CONF/mediator-secrets.json" ] || chmod 600 "$CONF/mediator-secrets.json"
fi
[ -f "$CONFIG" ] || refuse "no $CONFIG"

# Before the exports: a value someone else put in the environment is refused, not silently replaced, so the
# setting that was meant is seen. Each of these four may be absent or already the value below.
want() { eval "cur=\${$1-}"; [ -z "${cur:-}" ] || [ "$cur" = "$2" ] || refuse "$1 is set to something other than $2"; }
want MEDIATOR_ACL_MODE explicit_allow
want GLOBAL_DEFAULT_ACL DENY_ALL,LOCAL,SEND_MESSAGES,RECEIVE_MESSAGES
want ENABLE_INTER_MEDIATOR_RELAY false
want TRUST_TASK_VERIFICATION enforce
# Who may use it: only DIDs an access entry allows (the closed mode's own value).
export MEDIATOR_ACL_MODE=explicit_allow
# What a new account may do by default: deliver locally, send and receive. No ALLOW_ALL, no SEND_FORWARDED (which
# would let anyone relay anonymously through /inbound: docs/acls.md).
export GLOBAL_DEFAULT_ACL=DENY_ALL,LOCAL,SEND_MESSAGES,RECEIVE_MESSAGES
# No relaying to other mediators: this host carries only its own members' messages.
export ENABLE_INTER_MEDIATOR_RELAY=false
# Trust Tasks that fail their acceptance checks are refused, not just logged (config_writer.rs:220).
export TRUST_TASK_VERIFICATION=enforce
# Where it answers and where its own DID log is (the generated file may leave these commented, or point at a
# relative path): set through the environment, which wins, instead of editing the generated file.
export LOCAL_ENDPOINTS="$PUBLIC_URL"
export DID_WEB_SELF_HOSTED="file://$CONF/did.jsonl"
# A browser may reach it only from the origin named here (the room's page); none by default.
if [ -n "${MEDIATOR_CORS_ALLOW_ORIGIN:-}" ]; then
  case "$MEDIATOR_CORS_ALLOW_ORIGIN" in *[!A-Za-z0-9:/.*-]*) refuse "MEDIATOR_CORS_ALLOW_ORIGIN may only hold letters, digits and : / . * - (one origin)" ;; esac
  export CORS_ALLOW_ORIGIN="$MEDIATOR_CORS_ALLOW_ORIGIN"
fi

# The start check, after the exports, on what the process will use: the environment, and the file beneath it.
settings=$(grep -v '^[[:space:]]*#' "$CONFIG" || true)
if printf '%s\n' "$settings" | grep -Eiq '^[[:space:]]*allow_unauthenticated_forwards[[:space:]]*=[[:space:]]*"?true'; then refuse "allow_unauthenticated_forwards is on in $CONFIG (an open relay)"; fi
if printf '%s\n' "$settings" | grep -Eq 'ALLOW_ALL|SEND_FORWARDED'; then refuse "$CONFIG grants ALLOW_ALL or SEND_FORWARDED"; fi
if env | grep -Eq '=.*(ALLOW_ALL|SEND_FORWARDED)'; then refuse "a setting in the environment grants ALLOW_ALL or SEND_FORWARDED"; fi
if env | grep -Eiq '^[^=]*ALLOW_UNAUTHENTICATED_FORWARDS[^=]*=[[:space:]]*"?true'; then refuse "allow_unauthenticated_forwards is on in the environment"; fi
[ "$MEDIATOR_ACL_MODE" = explicit_allow ] && [ "$ENABLE_INTER_MEDIATOR_RELAY" = false ] && [ "$TRUST_TASK_VERIFICATION" = enforce ] || refuse "the closed values did not take"

# What it runs with, readable in the service's log (settings only, no keys, no content).
echo "mediator: closed (acl_mode=$MEDIATOR_ACL_MODE default=$GLOBAL_DEFAULT_ACL relay=$ENABLE_INTER_MEDIATOR_RELAY trust_tasks=$TRUST_TASK_VERIFICATION); admin: $ADMIN_SOURCE" >&2
# relative paths in the config are read beside it (src/common/config/mod.rs:1255-1281); start from there too
cd "$CONF"
exec $AS mediator -c "$CONFIG"
