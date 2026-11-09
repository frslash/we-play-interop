#!/bin/sh
# Mediator of the room's TEST community. Not wired yet: the VTA and VTC are set up without messaging
# (REST only), so nothing depends on it for the community's DID or join page. Its ACL must be an
# allowlist (the VTC, the VTA and DIDs the room approved), never open; the config that says so comes
# in the step that wires TSP/DIDComm. Until then it refuses to start rather than run open.
set -eu
umask 077
CONF=/var/lib/mediator/conf/mediator.toml
[ -f "$CONF" ] || { echo "mediator: no $CONF yet (messaging is not wired for the test community)" >&2; exit 78; }
exec mediator
