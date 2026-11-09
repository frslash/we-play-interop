# The trust community (OpenVTC's `vtc`), built from source at the same commit as the trust agent.
# Read from that commit (vtc-service/Cargo.toml, src/main.rs, docs/03-vtc/non-interactive-setup.md):
#   - `setup` gives `vtc setup` (without it the binary answers "Setup wizard not available");
#   - `website` serves the join page and member portal at /members/; `tsp` must stay (the registry code calls it);
#   - no `keyring` and no `admin-ui` (the console needs a Node build and would sit at /admin);
#   - the encrypted-file secret store needs no feature: there is no feature called "encrypted-file".
# The openvti starter kit builds it with the same three features (docker/vtc.Dockerfile).
FROM rust:1.95.0-slim-bookworm@sha256:d7482085ff5b415f84dba5647ae71606650bdef00db7aeb69f4b3d170c3e4082 AS build
ARG VTI_SHA=c6964c4612131089e1add0f47575894e1bd8a565
ARG FEATURES="setup,website,tsp"
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates pkg-config libssl-dev libdbus-1-dev clang cmake && rm -rf /var/lib/apt/lists/*
RUN git init /src && cd /src && git remote add origin https://github.com/OpenVTC/verifiable-trust-infrastructure \
 && git fetch --depth 1 origin "$VTI_SHA" && git checkout --detach FETCH_HEAD \
 && [ "$(git rev-parse HEAD)" = "$VTI_SHA" ]
WORKDIR /src
SHELL ["/bin/bash","-o","pipefail","-c"]
RUN cargo build --locked --release --package vtc-service --no-default-features --features "$FEATURES" 2>&1 | tail -n 200; exit ${PIPESTATUS[0]}

FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
# nodejs serves the setup DID to the trust agent during first boot (serve-did.mjs, no dependencies); wget reads the agent's DID log.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libdbus-1-3 libssl3 wget nodejs && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --home /var/lib/vtc vtc && install -d -o vtc -g vtc -m 0700 /var/lib/vtc
COPY --from=build /src/target/release/vtc /usr/local/bin/vtc
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY serve-did.mjs /usr/local/lib/serve-did.mjs
# Starts as root on purpose: the entrypoint fixes the volume owner, then drops to uid 10001 (Security 12376 C).
ENV HOME=/var/lib/vtc
EXPOSE 8200
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
