#!/bin/sh
# Boot the VTA. Starts as root only long enough to (1) fix the volume's owner and (2) put the seed's
# passphrase in a tmpfs file, then drops to uid 10001 with the passphrase REMOVED from the environment.
# Security 12376 (A, C): the VTA reads its passphrase only from a file (never config, never env), and the
# file must never sit on the volume beside seed.enc. Nothing here prints; no `set -x`.
set -eu
umask 077
ulimit -c 0
: "${VTA_SEED_PASSPHRASE:?VTA_SEED_PASSPHRASE must be set as a sealed Railway variable}"
[ "${#VTA_SEED_PASSPHRASE}" -ge 22 ] || { echo "VTA_SEED_PASSPHRASE is too short (machine-made, 128 bits or more)" >&2; exit 78; }
[ "$(id -u)" = 0 ] || { echo "entrypoint must start as root to prepare the volume and the tmpfs, then drops itself" >&2; exit 78; }
DATA="${VTA_DATA_DIR:-/var/lib/vta}"
CREDS="${VTA_CREDS_DIR:-/dev/shm/vta-creds}"
CONF="$DATA/setup.toml"

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
RUN_AS="setpriv --reuid=10001 --regid=10001 --clear-groups --no-new-privs"
VTA="env -u VTA_SEED_PASSPHRASE $RUN_AS vta"

if [ ! -f "$DATA/.initialised" ]; then
  # First start: headless setup (OpenVTC docs/02-vta/non-interactive-setup.md at the pinned commit).
  # The admin is a fresh TEST did:key handed in as VTA_ADMIN_DID (a public DID, not a secret).
  if [ ! -f "$CONF" ]; then
    : "${VTA_ADMIN_DID:?VTA_ADMIN_DID (a fresh test did:key) must be set by the deploy}"
    cat > "$CONF" <<EOF
config_path = "$DATA/config.toml"
data_dir    = "$DATA/data"
public_url  = "${VTA_PUBLIC_URL:-https://vta.inwove.org}"
admin_did   = "$VTA_ADMIN_DID"
admin_label = "room-test-admin"

[secrets]
backend = "encrypted_file"

[secrets.encrypted_file]
path = "$DATA/seed.enc"
kek = { source = "passphrase", file = "$CREDS/seed-passphrase" }
EOF
    chown 10001:10001 "$CONF"
  fi
  $VTA setup --from "$CONF" >/dev/null 2>&1 || { echo "vta setup failed (output withheld: it can hold secrets)" >&2; exit 1; }
  : > "$DATA/.initialised"; chown 10001:10001 "$DATA/.initialised"
fi
exec env -u VTA_SEED_PASSPHRASE $RUN_AS vta --config "$DATA/config.toml"
