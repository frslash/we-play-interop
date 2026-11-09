#!/bin/sh
# The mediator's ACL is NOT open: it allows the VTC, the VTA and the DIDs Faolan approved (Security's condition 2).
# The ACL lives in the config the first-run step writes; checking it from here waits until that file's shape is known.
set -eu
umask 077
CONF=/var/lib/mediator/conf/mediator.toml
[ -f "$CONF" ] || { echo "no $CONF: the first-run setup has not provided it" >&2; exit 78; }
exec mediator
