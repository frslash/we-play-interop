# Mediator: NOT OpenVTC. Affinidi's affinidi-messaging-mediator, built from source at one full commit.
# Set MEDIATOR_REPO / MEDIATOR_SHA when the room picks the exact 0.48-0.50 commit; the build refuses an empty SHA.
FROM rust:1.83-slim-bookworm@sha256:540c902e99c384163b688bbd8b5b8520e94e7731b27f7bd0eaa56ae1960627ab AS build
ARG MEDIATOR_REPO=https://github.com/affinidi/affinidi-tdk-rs
ARG MEDIATOR_SHA=
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
RUN test -n "$MEDIATOR_SHA" || { echo "MEDIATOR_SHA must be one full 40-character commit" >&2; exit 1; }
RUN git init /src && cd /src && git remote add origin "$MEDIATOR_REPO" \
 && git fetch --depth 1 origin "$MEDIATOR_SHA" && git checkout --detach FETCH_HEAD \
 && [ "$(git rev-parse HEAD)" = "$MEDIATOR_SHA" ]
WORKDIR /src
RUN cargo build --locked --release -p affinidi-messaging-mediator

FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --home /var/lib/mediator mediator && install -d -o mediator -g mediator -m 0700 /var/lib/mediator
COPY --from=build /src/target/release/affinidi-messaging-mediator /usr/local/bin/mediator
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
USER mediator
ENV HOME=/var/lib/mediator
EXPOSE 7037
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
