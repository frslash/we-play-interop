# Mediator: NOT OpenVTC. Affinidi's affinidi-messaging-mediator, built from source at one full commit.
# Pinned as agreed in the room: version 0.48.0, features tsp only (secrets-aws dropped for Railway). It needs Rust 1.95
# (its Cargo.toml at this commit) and a redis (pin redis:7.4.6-alpine by digest) once messaging is wired.
FROM rust:1.95-slim-bookworm@sha256:d7482085ff5b415f84dba5647ae71606650bdef00db7aeb69f4b3d170c3e4082 AS build
ARG MEDIATOR_REPO=https://github.com/affinidi/affinidi-messaging-mediator
ARG MEDIATOR_SHA=e6e2c63654bb43bb7feb732834702cd940b2bcce
ARG FEATURES="tsp"
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
RUN test -n "$MEDIATOR_SHA" || { echo "MEDIATOR_SHA must be one full 40-character commit" >&2; exit 1; }
RUN git init /src && cd /src && git remote add origin "$MEDIATOR_REPO" \
 && git fetch --depth 1 origin "$MEDIATOR_SHA" && git checkout --detach FETCH_HEAD \
 && [ "$(git rev-parse HEAD)" = "$MEDIATOR_SHA" ]
WORKDIR /src
RUN cargo build --locked --release -p affinidi-messaging-mediator --no-default-features --features "$FEATURES"

FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --home /var/lib/mediator mediator && install -d -o mediator -g mediator -m 0700 /var/lib/mediator
COPY --from=build /src/target/release/affinidi-messaging-mediator /usr/local/bin/mediator
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
USER mediator
ENV HOME=/var/lib/mediator
EXPOSE 7037
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
