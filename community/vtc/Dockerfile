# VTC (vtc-service, binary vtc): no keyring, no admin-ui; encrypted-file secrets, passphrase from a sealed variable.
FROM rust:1.83-slim-bookworm@sha256:540c902e99c384163b688bbd8b5b8520e94e7731b27f7bd0eaa56ae1960627ab AS build
ARG VTI_SHA=c6964c4612131089e1add0f47575894e1bd8a565
ARG FEATURES="encrypted-file"
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates pkg-config libssl-dev libdbus-1-dev && rm -rf /var/lib/apt/lists/*
RUN git init /src && cd /src && git remote add origin https://github.com/OpenVTC/verifiable-trust-infrastructure \
 && git fetch --depth 1 origin "$VTI_SHA" && git checkout --detach FETCH_HEAD \
 && [ "$(git rev-parse HEAD)" = "$VTI_SHA" ]
WORKDIR /src
RUN cargo build --locked --release -p vtc-service --bin vtc --no-default-features --features "$FEATURES"

FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libdbus-1-3 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --home /var/lib/vtc vtc && install -d -o vtc -g vtc -m 0700 /var/lib/vtc
COPY --from=build /src/target/release/vtc /usr/local/bin/vtc
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
USER vtc
ENV HOME=/var/lib/vtc
EXPOSE 8200
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
