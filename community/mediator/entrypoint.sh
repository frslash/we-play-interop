#!/bin/sh
# The mediator's ACL is NOT open: it allows the VTC, the VTA and the DIDs Faolan approved (Security's condition 2).
# The ACL lives in the config the first-run step writes; checking it from here waits until that file's shape is known.
set -eu
umask 077
CONF=/var/lib/mediator/conf/mediator.toml
[ -f "$CONF" ] || { echo "no $CONF: the first-run setup has not provided it" >&2; exit 78; }
# Security 11114 cond 1: anonymous forwards stay refused, or /inbound is an open relay. Refuse to start if the
# config turns them on. The explicit SEND_FORWARDED-off value itself waits on the config's real key names
# (first-run output); until then this only catches the one flag we know the name of.
if grep -Eiq '^[[:space:]]*allow_unauthenticated_forwards[[:space:]]*=[[:space:]]*true' "$CONF"; then
  echo "allow_unauthenticated_forwards is on: refusing to start (open relay)" >&2; exit 78
fi
exec mediator
