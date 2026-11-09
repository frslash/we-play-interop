#!/bin/sh
# Boot the VTA. Everything secret is made here, on the volume, and never printed.
# The seed's passphrase is a sealed Railway service variable (VTA_SEED_PASSPHRASE): a key beside its
# lock is no lock, so it is never written to /var/lib/vta.
set -eu
umask 077
: "${VTA_SEED_PASSPHRASE:?VTA_SEED_PASSPHRASE must be set as a sealed Railway variable}"
DATA=/var/lib/vta
CONF="$DATA/setup.toml"
if [ ! -f "$DATA/.initialised" ]; then
  # First start: the headless setup from a TOML file (OpenVTC docs/02-vta/non-interactive-setup.md,
  # at the pinned commit). setup.toml is written by the first-run step of the host, 0600 on the volume.
  # Headless setup file (OpenVTC docs/02-vta/non-interactive-setup.md, "Quick start"), written here, 0600.
  # The admin is a fresh TEST did:key made by the deploy's boot step and handed in as VTA_ADMIN_DID (not a secret).
  if [ ! -f "$CONF" ]; then
    : "${VTA_ADMIN_DID:?VTA_ADMIN_DID (a fresh test did:key) must be set by the deploy}"
    cat > "$CONF" <<EOF
config_path = "$DATA/config.toml"
data_dir    = "$DATA/data"
public_url  = "${VTA_PUBLIC_URL:-https://vta.inwove.org}"
admin_did   = "$VTA_ADMIN_DID"
admin_label = "room-test-admin"

[secrets]
backend = "keyring"
service = "vta-room"
EOF
  fi
  vta setup --from "$CONF" >/dev/null 2>&1 || { echo "vta setup failed (output withheld: it can hold secrets)" >&2; exit 1; }
  : > "$DATA/.initialised"
fi
exec vta --config "$DATA/config.toml"
