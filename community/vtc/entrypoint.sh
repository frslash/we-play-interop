#!/bin/sh
# Boot the VTC. The first admin is made here, inside the private network, before the service listens:
# the install/claim URL is never printed and never reachable through the proxy (Security's condition 1).
set -eu
umask 077
: "${VTC_SECRETS_PASSPHRASE:?VTC_SECRETS_PASSPHRASE must be set as a sealed Railway variable}"
DATA=/var/lib/vtc
CONF="$DATA/setup.toml"
if [ ! -f "$DATA/.initialised" ]; then
  [ -f "$CONF" ] || { echo "no $CONF: the first-run setup has not provided it" >&2; exit 78; }
  # Phase 1-3 of OpenVTC docs/03-vtc/non-interactive-setup.md: mint a setup key, have the VTA grant it
  # (over the private network, by the first-run step), then `vtc setup --from`. All output is withheld.
  vtc setup --from "$CONF" >/dev/null 2>&1 || { echo "vtc setup failed (output withheld: it can hold secrets)" >&2; exit 1; }
  : > "$DATA/.initialised"
fi
exec vtc
