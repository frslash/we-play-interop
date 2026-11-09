#!/bin/sh
# Boot the VTA of the room's TEST community (test keys, not for real people).
#
# The room chose a boot script for the first setup (no person runs `pnm` or holds the root):
#   1. `vta setup --from` makes the seed and the VTA's did:webvh on this volume. No super-admin is
#      seeded, so no person and no key outside this service holds the VTA's root.
#   2. It waits for the VTC to publish its one-time setup did:key on the private network (a public
#      DID, no secret), then grants it, offline and before the daemon listens, with OpenVTC's own
#      `vta contexts create --admin-did ... --admin-expires 1h --admin-handoff`.
#   3. It starts the daemon. The VTC's setup DID rolls over once to a VTA-minted admin; the grant
#      expires after an hour if it is never used.
#
# Root only long enough to fix the volume owner and put the seed passphrase on a tmpfs, then
# uid 10001 with the passphrase removed from the environment. Nothing here prints a secret; no `set -x`.
set -eu
umask 077
ulimit -c 0
: "${VTA_SEED_PASSPHRASE:?VTA_SEED_PASSPHRASE must be set as a sealed Railway variable}"
[ "${#VTA_SEED_PASSPHRASE}" -ge 22 ] || { echo "VTA_SEED_PASSPHRASE is too short (machine-made, 128 bits or more)" >&2; exit 78; }
[ "$(id -u)" = 0 ] || { echo "entrypoint must start as root to prepare the volume and the tmpfs, then drops itself" >&2; exit 78; }
DATA="${VTA_DATA_DIR:-/var/lib/vta}"
CREDS="${VTA_CREDS_DIR:-/dev/shm/vta-creds}"
CONF="$DATA/setup.toml"
CONTEXT="${COMMUNITY_CONTEXT:-community}"
SETUP_DID_URL="${VTC_SETUP_DID_URL:-http://vtc.railway.internal:8201/setup-did}"
WAIT="${VTA_WAIT_SECONDS:-1800}"

chown 10001:10001 "$DATA" && chmod 0700 "$DATA"

mkdir -p "$CREDS"
[ "$(stat -f -c %T "$CREDS")" = "tmpfs" ] || { echo "$CREDS is not a tmpfs: refusing to write the passphrase" >&2; exit 78; }
chown 10001:10001 "$CREDS" && chmod 0700 "$CREDS"
rm -f "$CREDS/seed-passphrase"
printf '%s' "$VTA_SEED_PASSPHRASE" > "$CREDS/seed-passphrase"
chown 10001:10001 "$CREDS/seed-passphrase" && chmod 0400 "$CREDS/seed-passphrase"

RUN_AS="setpriv --reuid=10001 --regid=10001 --clear-groups --no-new-privs"
VTA="env -u VTA_SEED_PASSPHRASE $RUN_AS vta"
mark() { : > "$DATA/$1"; chown 10001:10001 "$DATA/$1"; }

# Step 1: seed, store and DID (OpenVTC docs/02-vta/non-interactive-setup.md and
# docs/02-vta/examples/vta-setup.example.toml at the pinned commit).
if [ ! -f "$DATA/.setup-done" ]; then
  cat > "$CONF" <<EOF
config_path     = "$DATA/config.toml"
overwrite_config = true
data_dir        = "$DATA/data"
data_dir_exists = "delete"
vta_name        = "wpi-test-community-vta"
public_url      = "${VTA_REST_URL:-http://vta.railway.internal:8100}"

[services]
rest    = true
didcomm = false
tsp     = false

[server]
host = "::"
port = 8100

[log]
level  = "info"
format = "json"

[secrets]
backend = "encrypted_file"
path    = "$DATA/seed.enc"
kek     = { source = "passphrase", file = "$CREDS/seed-passphrase" }

[messaging]
kind = "skip"

[vta_did]
kind = "create_webvh"
url  = "${VTA_PUBLIC_URL:-https://vta.inwove.org}"
EOF
  chown 10001:10001 "$CONF"
  $VTA setup --from "$CONF" >/dev/null 2>&1 || { echo "vta setup failed (output withheld: it can hold secrets)" >&2; exit 1; }
  mark .setup-done
  echo "vta: test community VTA set up (no super-admin seeded)"
fi

# Step 2: grant the VTC's one-time setup DID, offline, before the daemon listens.
if [ ! -f "$DATA/.granted" ]; then
  echo "vta: waiting for the VTC's setup DID at $SETUP_DID_URL (up to ${WAIT}s)"
  did=""; waited=0
  while [ "$waited" -lt "$WAIT" ]; do
    did=$(curl -fsS --max-time 5 "$SETUP_DID_URL" 2>/dev/null | tr -d ' \r\n' || true)
    [ -n "$did" ] && break
    sleep 5; waited=$((waited + 5))
  done
  # Only a plain Ed25519 did:key is accepted: anything else on the private network is refused.
  printf '%s' "$did" | grep -Eqx 'did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{40,60}' \
    || { echo "vta: no valid setup did:key from the VTC; will retry on the next start" >&2; exit 1; }
  $VTA --config "$DATA/config.toml" contexts create --id "$CONTEXT" --name "Test community" \
    --admin-did "$did" --admin-label "vtc-setup" --admin-expires 1h --admin-handoff >/dev/null 2>&1 \
    || { echo "vta: granting the VTC's setup DID failed (output withheld)" >&2; exit 1; }
  mark .granted
  echo "vta: granted $did admin of context '$CONTEXT' for 1h, one hand-off"
fi

exec env -u VTA_SEED_PASSPHRASE $RUN_AS vta --config "$DATA/config.toml"
