#!/bin/sh
# Boot the VTC. Same shape as the VTA (Security 12376 A, C): root only to fix the volume owner and put the
# passphrase on a tmpfs, then drop to uid 10001 with VTC_SECRETS_PASSPHRASE removed from the environment.
# The first admin is made here, inside the private network, before the service listens: the install/claim
# URL is never printed and never reachable through the proxy (Security's condition 1).
set -eu
umask 077
ulimit -c 0
: "${VTC_SECRETS_PASSPHRASE:?VTC_SECRETS_PASSPHRASE must be set as a sealed Railway variable}"
[ "${#VTC_SECRETS_PASSPHRASE}" -ge 22 ] || { echo "VTC_SECRETS_PASSPHRASE is too short (machine-made, 128 bits or more)" >&2; exit 78; }
[ "$(id -u)" = 0 ] || { echo "entrypoint must start as root to prepare the volume and the tmpfs, then drops itself" >&2; exit 78; }
DATA="${VTC_DATA_DIR:-/var/lib/vtc}"
CREDS="${VTC_CREDS_DIR:-/dev/shm/vtc-creds}"
CONF="$DATA/setup.toml"

# Step 10a6372f, checked first, before anything is touched: (1) no admin key is made before the room's log
# names who can read this Railway project's secrets (ROOM_ACCESS_LINE = that signed line's hash, public);
# (2) the community calls itself a test: its public name says TEST and its description says test keys.
if [ ! -f "$DATA/.initialised" ]; then
  printf '%s' "${ROOM_ACCESS_LINE:-}" | grep -Eqx '[0-9a-f]{64}' || { echo "ROOM_ACCESS_LINE is not set to the hash of the room's signed line naming who can read this project's secrets: no first admin before it" >&2; exit 78; }
  [ -f "$CONF" ] || { echo "no $CONF: the first-run setup has not provided it" >&2; exit 78; }
  grep -Eq '^vtc_name[[:space:]]*=[[:space:]]*"[^"]*TEST' "$CONF" || { echo "$CONF: vtc_name must say TEST (this is a test community)" >&2; exit 78; }
  grep -Eq '^vtc_description[[:space:]]*=[[:space:]]*"[^"]*test keys' "$CONF" || { echo "$CONF: vtc_description must say it runs on test keys" >&2; exit 78; }
fi

chown 10001:10001 "$DATA" && chmod 0700 "$DATA"

mkdir -p "$CREDS"
[ "$(stat -f -c %T "$CREDS")" = "tmpfs" ] || { echo "$CREDS is not a tmpfs: refusing to write the passphrase" >&2; exit 78; }
chown 10001:10001 "$CREDS" && chmod 0700 "$CREDS"
rm -f "$CREDS/secrets-passphrase"
printf '%s' "$VTC_SECRETS_PASSPHRASE" > "$CREDS/secrets-passphrase"
chown 10001:10001 "$CREDS/secrets-passphrase" && chmod 0400 "$CREDS/secrets-passphrase"

RUN_AS="setpriv --reuid=10001 --regid=10001 --clear-groups --no-new-privs"

if [ ! -f "$DATA/.initialised" ]; then
  [ -f "$CONF" ] || { echo "no $CONF: the first-run setup has not provided it" >&2; exit 78; }
  # The setup file's kek must point at $CREDS/secrets-passphrase (never an inline value).
  # Phase 1-3 of OpenVTC docs/03-vtc/non-interactive-setup.md. All output is withheld.
  env -u VTC_SECRETS_PASSPHRASE $RUN_AS vtc setup --from "$CONF" >/dev/null 2>&1 || { echo "vtc setup failed (output withheld: it can hold secrets)" >&2; exit 1; }
  : > "$DATA/.initialised"; chown 10001:10001 "$DATA/.initialised"
fi
exec env -u VTC_SECRETS_PASSPHRASE $RUN_AS vtc
