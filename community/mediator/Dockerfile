# The mediator: NOT OpenVTC. Affinidi's affinidi-messaging-mediator, built from source at one full commit.
# Pinned to v0.50.0: the pinned OpenVTC's own Cargo.toml says its messaging library "goes with ... mediator 0.50"
# (verifiable-trust-infrastructure Cargo.toml:163-165 at c6964c4). The earlier pin, 0.48.0, is what the openvti
# starter kit verified against an OLDER OpenVTC (26d0da81); if a handshake fails here, that pair is the fallback.
# Read from the pinned mediator: the server binary is `mediator` and its default features are
# didcomm, tsp, redis-backend, jemalloc and vta (crates/affinidi-messaging-mediator/Cargo.toml): a build with
# --no-default-features and only `tsp` has no store and cannot start. `mediator-setup` writes the first config;
# it is built without the cloud secret stores (its secrets go in a file on this service's volume).
FROM rust:1.95.0-slim-bookworm@sha256:d7482085ff5b415f84dba5647ae71606650bdef00db7aeb69f4b3d170c3e4082 AS build
ARG MEDIATOR_REPO=https://github.com/affinidi/affinidi-messaging-mediator
ARG MEDIATOR_SHA=34bbdea4717e3a8dd1fdb190ad9c2ad2b33a3316
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates build-essential pkg-config libssl-dev libdbus-1-dev clang cmake && rm -rf /var/lib/apt/lists/*
RUN test -n "$MEDIATOR_SHA" || { echo "MEDIATOR_SHA must be one full 40-character commit" >&2; exit 1; }
RUN git init /src && cd /src && git remote add origin "$MEDIATOR_REPO" \
 && git fetch --depth 1 origin "$MEDIATOR_SHA" && git checkout --detach FETCH_HEAD \
 && [ "$(git rev-parse HEAD)" = "$MEDIATOR_SHA" ]
WORKDIR /src
SHELL ["/bin/bash","-o","pipefail","-c"]
RUN cargo build --locked --release -p affinidi-messaging-mediator 2>&1 | tail -n 200; exit ${PIPESTATUS[0]}
RUN cargo build --locked --release -p affinidi-messaging-mediator-setup --no-default-features 2>&1 | tail -n 200; exit ${PIPESTATUS[0]}

FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libssl3 libdbus-1-3 wget util-linux && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --home /var/lib/mediator mediator && install -d -o mediator -g mediator -m 0700 /var/lib/mediator
WORKDIR /app
# the Redis functions file the server loads, and the upstream's sample config (for reference in the image)
COPY --from=build /src/crates/affinidi-messaging-mediator/conf /app/conf
COPY --from=build /src/target/release/mediator /usr/local/bin/mediator
COPY --from=build /src/target/release/mediator-setup /usr/local/bin/mediator-setup
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
# Starts as root on purpose: the entrypoint fixes the volume owner, then drops to uid 10001.
ENV HOME=/var/lib/mediator
EXPOSE 7037
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
