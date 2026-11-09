#!/bin/sh
# Boot the VTC of the room's TEST community (test keys, not for real people).
#
# First start, by boot script (the room's choice; OpenVTC docs/03-vtc/non-interactive-setup.md):
#   phase 1   `vtc setup --setup-key-out` mints a one-time setup did:key on this volume.
#   phase 1½  the VTC shows only that public DID on the private network (port 8201) until the VTA
#             has granted it; the private key never leaves this volume. The VTC never grants itself.
#   phase 2   once the VTA answers, `vtc setup --from` has the VTA mint the community's DID and keys.
#             Its output (install URL, claim code) goes only to a 0600 file on this volume, never a log.
# The community then has no administrator until someone with access to this volume claims the
# install URL: on test keys that is accepted, and said in community/README.md.
#
# Root only long enough to fix the volume owner and put the passphrase on a tmpfs, then uid 10001
# with VTC_SECRETS_PASSPHRASE removed from the environment. Nothing here prints a secret; no `set -x`.
set -eu
umask 077
ulimit -c 0
: "${VTC_SECRETS_PASSPHRASE:?VTC_SECRETS_PASSPHRASE must be set as a sealed Railway variable}"
[ "${#VTC_SECRETS_PASSPHRASE}" -ge 22 ] || { echo "VTC_SECRETS_PASSPHRASE is too short (machine-made, 128 bits or more)" >&2; exit 78; }
[ "$(id -u)" = 0 ] || { echo "entrypoint must start as root to prepare the volume and the tmpfs, then drops itself" >&2; exit 78; }
DATA="${VTC_DATA_DIR:-/var/lib/vtc}"
CREDS="${VTC_CREDS_DIR:-/dev/shm/vtc-creds}"
CONF="$DATA/setup.toml"
KEY="$DATA/setup-key.json"
CONTEXT="${COMMUNITY_CONTEXT:-community}"
VTA_INTERNAL="${VTA_INTERNAL_URL:-http://vta.railway.internal:8100}"
WAIT="${VTC_WAIT_SECONDS:-1800}"
SHOW_PORT="${VTC_SETUP_DID_PORT:-8201}"

chown 10001:10001 "$DATA" && chmod 0700 "$DATA"

mkdir -p "$CREDS"
[ "$(stat -f -c %T "$CREDS")" = "tmpfs" ] || { echo "$CREDS is not a tmpfs: refusing to write the passphrase" >&2; exit 78; }
chown 10001:10001 "$CREDS" && chmod 0700 "$CREDS"
rm -f "$CREDS/secrets-passphrase"
printf '%s' "$VTC_SECRETS_PASSPHRASE" > "$CREDS/secrets-passphrase"
chown 10001:10001 "$CREDS/secrets-passphrase" && chmod 0400 "$CREDS/secrets-passphrase"

RUN_AS="setpriv --reuid=10001 --regid=10001 --clear-groups --no-new-privs"
VTC="env -u VTC_SECRETS_PASSPHRASE $RUN_AS vtc"
mark() { : > "$DATA/$1"; chown 10001:10001 "$DATA/$1"; }

if [ ! -f "$DATA/.initialised" ]; then
  # Phase 1: the one-time setup key (kept across restarts until phase 2 has used it).
  if [ ! -f "$KEY" ]; then
    $VTC setup --setup-key-out "$KEY" --context "$CONTEXT" >/dev/null 2>&1 \
      || { echo "vtc: phase 1 failed (output withheld)" >&2; exit 1; }
  fi
  did=$(jq -r '.did // empty' "$KEY")
  printf '%s' "$did" | grep -Eqx 'did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{40,60}' || { echo "vtc: the setup key file has no did:key" >&2; exit 1; }

  # Phase 1½: show the public setup DID, and nothing else, on the private network.
  SHOW="$DATA/show"; rm -rf "$SHOW"; mkdir -p "$SHOW"
  printf '%s\n' "$did" > "$SHOW/setup-did"
  chown -R 10001:10001 "$SHOW"; chmod 0755 "$SHOW"; chmod 0444 "$SHOW/setup-did"
  env -u VTC_SECRETS_PASSPHRASE $RUN_AS busybox httpd -f -p "[::]:$SHOW_PORT" -h "$SHOW" >/dev/null 2>&1 &
  shown=$!
  echo "vtc: showing setup DID $did on :$SHOW_PORT until the VTA has granted it"

  # The VTA grants before its daemon listens, so a healthy VTA means the grant is in.
  waited=0
  until curl -fsS --max-time 5 -o /dev/null "$VTA_INTERNAL/health" 2>/dev/null; do
    [ "$waited" -lt "$WAIT" ] || { kill "$shown" 2>/dev/null || true; echo "vtc: the VTA did not come up within ${WAIT}s" >&2; exit 1; }
    sleep 5; waited=$((waited + 5))
  done
  kill "$shown" 2>/dev/null || true; rm -rf "$SHOW"

  # The VTA's DID, read from its own log (the last entry's state.id).
  vta_did=$(curl -fsS --max-time 10 "$VTA_INTERNAL/.well-known/did.jsonl" | tail -n 1 | jq -r '.state.id // empty')
  printf '%s' "$vta_did" | grep -Eq '^did:webvh:' || { echo "vtc: could not read the VTA's did:webvh" >&2; exit 1; }

  # Phase 2.
  cat > "$CONF" <<EOF
config_path         = "$DATA/config.toml"
base_url            = "${VTC_PUBLIC_URL:-https://vtc.inwove.org}"
vta_did             = "$vta_did"
context             = "$CONTEXT"
setup_key_file      = "$KEY"
provision_transport = "rest"

[secrets]
backend = "encrypted-file"

[secrets.encrypted_file]
path = "$DATA/secret.enc"
kek  = { source = "passphrase", file = "$CREDS/secrets-passphrase" }
EOF
  chown 10001:10001 "$CONF"
  OUT="$DATA/install.out"
  ( umask 077; $VTC setup --from "$CONF" > "$OUT" 2>&1 ) || { echo "vtc: phase 2 failed (output withheld: it can hold secrets)" >&2; exit 1; }
  chown 10001:10001 "$OUT"; chmod 0600 "$OUT"
  rm -f "$KEY"   # the one-time hand-off is spent
  # Only the community's DID is public; the install URL and claim code stay in $OUT.
  sed -n 's/^vtc_did=\(did:[A-Za-z0-9:._%-]*\)$/vtc: test community DID \1/p' "$OUT"
  mark .initialised
fi

exec env -u VTC_SECRETS_PASSPHRASE $RUN_AS vtc --config "$DATA/config.toml"
