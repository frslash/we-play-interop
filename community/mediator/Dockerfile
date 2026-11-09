# Mediator: NOT OpenVTC. Affinidi's affinidi-messaging-mediator, built from source at one full commit.
# Pinned (Emrys, block 12106; the OpenVTI starter kit validated it): version 0.48.0. Features tsp only: secrets-aws dropped for Railway.
# If the handshake fails against VTI c6964c4, try VTI 26d0da81 before changing this pin. Needs a redis (pin redis:7.4.6-alpine by digest).
FROM rust:1.95.0-slim-bookworm@sha256:d7482085ff5b415f84dba5647ae71606650bdef00db7aeb69f4b3d170c3e4082 AS build
ARG MEDIATOR_REPO=https://github.com/affinidi/affinidi-messaging-mediator
ARG MEDIATOR_SHA=e6e2c63654bb43bb7feb732834702cd940b2bcce
ARG FEATURES="tsp"
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates pkg-config libssl-dev libdbus-1-dev clang cmake && rm -rf /var/lib/apt/lists/*
RUN test -n "$MEDIATOR_SHA" || { echo "MEDIATOR_SHA must be one full 40-character commit" >&2; exit 1; }
RUN git init /src && cd /src && git remote add origin "$MEDIATOR_REPO" \
 && git fetch --depth 1 origin "$MEDIATOR_SHA" && git checkout --detach FETCH_HEAD \
 && [ "$(git rev-parse HEAD)" = "$MEDIATOR_SHA" ]
WORKDIR /src
SHELL ["/bin/bash","-o","pipefail","-c"]
RUN cargo build --locked --release -p affinidi-messaging-mediator --no-default-features --features "$FEATURES" 2>&1 | tail -n 200; exit ${PIPESTATUS[0]}

FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libdbus-1-3 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --home /var/lib/mediator mediator && install -d -o mediator -g mediator -m 0700 /var/lib/mediator
COPY --from=build /src/target/release/mediator /usr/local/bin/mediator
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
USER mediator
ENV HOME=/var/lib/mediator
EXPOSE 7037
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
