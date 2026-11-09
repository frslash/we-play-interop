# VTA (OpenVTC verifiable-trust-infrastructure), built from source at one full commit, hash checked.
# Private network only: nothing public points here; the proxy serves its DID files and nothing else.
FROM rust:1.95.0-slim-bookworm@sha256:d7482085ff5b415f84dba5647ae71606650bdef00db7aeb69f4b3d170c3e4082 AS build
ARG VTI_SHA=c6964c4612131089e1add0f47575894e1bd8a565
ARG FEATURES="setup,rest,didcomm,webvh,cli-synthesis"
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates pkg-config libssl-dev libdbus-1-dev clang cmake && rm -rf /var/lib/apt/lists/*
RUN git init /src && cd /src && git remote add origin https://github.com/OpenVTC/verifiable-trust-infrastructure \
 && git fetch --depth 1 origin "$VTI_SHA" && git checkout --detach FETCH_HEAD \
 && [ "$(git rev-parse HEAD)" = "$VTI_SHA" ]
WORKDIR /src
SHELL ["/bin/bash","-o","pipefail","-c"]
RUN cargo build --locked --release --bin vta --no-default-features --features "$FEATURES" 2>&1 | tail -n 200; exit ${PIPESTATUS[0]}

FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libdbus-1-3 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --home /var/lib/vta vta && install -d -o vta -g vta -m 0700 /var/lib/vta
COPY --from=build /src/target/release/vta /usr/local/bin/vta
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
# Starts as root on purpose: the entrypoint fixes the volume owner, then drops to uid 10001 (Security 12376 C).
ENV HOME=/var/lib/vta
EXPOSE 8100
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
