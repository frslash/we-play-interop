# The mediator: NOT OpenVTC. Affinidi's affinidi-messaging-mediator, built from source at one full commit.
# Starts from pull request #117's lines (proven by a real build: the apt packages, the binary name `mediator`).
# Changed from #117 only where booting needs it, each unproven until the image check runs on this change:
#   - the pin moves to v0.50.0: the pinned OpenVTC's own Cargo.toml says its messaging library "goes with ...
#     mediator 0.50" (verifiable-trust-infrastructure Cargo.toml:163-164 at c6964c4). 0.48.0 is what the openvti
#     starter kit verified against an OLDER OpenVTC (26d0da81); if a handshake fails here, that pair is the fallback.
#   - default features instead of `tsp` only: a store backend is a feature, and "At least one must be enabled for
#     the binary to function" (crates/affinidi-messaging-mediator/Cargo.toml:59-68); the defaults are didcomm, tsp,
#     redis-backend, jemalloc, vta (:23). `didcomm-v1` is not a default, so it is not compiled.
#   - build-essential: jemalloc's build needs make and cc (upstream's docker/mediator.Dockerfile:22-28 says so).
#   - `mediator-setup` is built too: the entrypoint makes the first config with it. Built the way upstream's own
#     image builds it (docker/mediator.Dockerfile:38-39); its `file://` secret store needs no feature.
#   - no `USER`: the entrypoint starts as root to fix the volume owner, then drops to uid 10001.
FROM rust:1.95.0-slim-bookworm@sha256:d7482085ff5b415f84dba5647ae71606650bdef00db7aeb69f4b3d170c3e4082 AS build
ARG MEDIATOR_REPO=https://github.com/affinidi/affinidi-messaging-mediator
ARG MEDIATOR_SHA=34bbdea4717e3a8dd1fdb190ad9c2ad2b33a3316
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates build-essential pkg-config libssl-dev libdbus-1-dev clang cmake && rm -rf /var/lib/apt/lists/*
RUN printf '%s' "$MEDIATOR_SHA" | grep -Eqx '[0-9a-f]{40}' || { echo "MEDIATOR_SHA must be one full 40-character commit" >&2; exit 1; }
RUN git init /src && cd /src && git remote add origin "$MEDIATOR_REPO" \
 && git fetch --depth 1 origin "$MEDIATOR_SHA" && git checkout --detach FETCH_HEAD \
 && [ "$(git rev-parse HEAD)" = "$MEDIATOR_SHA" ]
WORKDIR /src
SHELL ["/bin/bash","-o","pipefail","-c"]
RUN cargo build --locked --release -p affinidi-messaging-mediator 2>&1 | tail -n 200; exit ${PIPESTATUS[0]}
RUN cargo build --locked --release -p affinidi-messaging-mediator-setup --no-default-features --features secrets-aws,publish-aws 2>&1 | tail -n 200; exit ${PIPESTATUS[0]}

FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libdbus-1-3 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --home /var/lib/mediator mediator && install -d -o mediator -g mediator -m 0700 /var/lib/mediator
WORKDIR /app
# the Redis functions file the server loads (mediator-setup also writes one beside the config)
COPY --from=build /src/crates/affinidi-messaging-mediator/conf /app/conf
COPY --from=build /src/target/release/mediator /usr/local/bin/mediator
COPY --from=build /src/target/release/mediator-setup /usr/local/bin/mediator-setup
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
ENV HOME=/var/lib/mediator
EXPOSE 7037
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
