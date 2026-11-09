#!/bin/sh
# Planted-fake test for the VTA and VTC entrypoints (Security 12376 A5): run the whole start with a made-up
# passphrase, using stand-in binaries, then grep every output line and the data volume for it, and check
# the service's environment never carried it. Needs root, util-linux setpriv and a tmpfs at /dev/shm.
set -eu
[ "$(id -u)" = 0 ] || { echo "skip: needs root"; exit 0; }
HERE=$(cd "$(dirname "$0")" && pwd)
W=$(mktemp -d); trap 'rm -rf "$W" /dev/shm/t-vta-creds /dev/shm/t-vtc-creds' EXIT
FAKE="PLANTED-FAKE-$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
mkdir -p "$W/bin" "$W/vta" "$W/vtc"
cat > "$W/bin/stub" <<S
#!/bin/sh
# stand-in service: records its uid, whether the passphrase is in its env, and the passphrase file's mode
echo "\$0 \$* uid=\$(id -u) envhit=\$(tr '\0' '\n' < /proc/\$\$/environ | grep -c PASSPHRASE || true)" >> "$W/seen"
f=\$(ls /dev/shm/t-v*-creds/* 2>/dev/null | head -1); stat -c '%a %u' "\$f" >> "$W/seen"; true
S
chmod +x "$W/bin/stub"; ln -s stub "$W/bin/vta"; ln -s stub "$W/bin/vtc"
touch "$W/seen"; chmod 666 "$W/seen"; printf 'x' > "$W/vtc/setup.toml"; chmod 755 "$W" "$W/bin" "$W/vta" "$W/vtc"
run() { # name var datadir credsdir
  ( env -i PATH="$W/bin:/usr/bin:/bin" "$2=$FAKE" VTA_ADMIN_DID=did:key:zTEST \
      VTA_DATA_DIR="$W/vta" VTA_CREDS_DIR=/dev/shm/t-vta-creds VTC_DATA_DIR="$W/vtc" VTC_CREDS_DIR=/dev/shm/t-vtc-creds \
      sh "$HERE/$1/entrypoint.sh" ) > "$W/out-$1" 2>&1 || { echo "FAIL: $1 exited non-zero"; cat "$W/out-$1" | sed "s/$FAKE/<fake>/g"; exit 1; }
}
run vta VTA_SEED_PASSPHRASE; run vtc VTC_SECRETS_PASSPHRASE
if grep -rqF "$FAKE" "$W/out-vta" "$W/out-vtc" "$W/vta" "$W/vtc"; then echo "FAIL: planted passphrase found in output or volume"; exit 1; fi
grep -q 'envhit=0' "$W/seen" && ! grep -q 'envhit=[1-9]' "$W/seen" || { echo "FAIL: passphrase reached a service's environment"; exit 1; }
grep -q 'uid=10001' "$W/seen" || { echo "FAIL: service did not drop to uid 10001"; exit 1; }
echo "ok: no planted passphrase in output or volume; services run as 10001 without it in their environment"
# Security 12376 A4: a sealed variable is runtime only: never a build ARG or a Dockerfile ENV.
if grep -nE '^(ARG|ENV)[[:space:]].*(PASSPHRASE|SECRET|ADMIN_KEY)' "$HERE"/*/Dockerfile; then echo "FAIL: a secret is named in a Dockerfile ARG/ENV"; exit 1; fi
echo "ok: no secret in any Dockerfile ARG/ENV"
