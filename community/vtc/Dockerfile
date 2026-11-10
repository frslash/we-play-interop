# The trust community (OpenVTC's `vtc`), built from source at the same commit as the trust agent.
# The build lines are pull request #117's, proven by a real build on GitHub. Read from that commit:
#   - `setup` gives `vtc setup` (without it the binary answers "Setup wizard not available": src/main.rs);
#   - `website` serves the join page; `tsp` stays because a community whose DID advertises TSP refuses to boot on a
#     binary without it (vtc-service/src/transport_capability.rs);
#   - no `admin-ui`: it needs a Node build, and it is also what mounts the member portal at /members
#     (src/routes/mod.rs:1471-1477), so this build has no /members (the proxy does not forward it);
#   - no `keyring`; the encrypted-file secret store needs no feature.
FROM rust:1.95.0-slim-bookworm@sha256:d7482085ff5b415f84dba5647ae71606650bdef00db7aeb69f4b3d170c3e4082 AS build
ARG VTI_SHA=c6964c4612131089e1add0f47575894e1bd8a565
ARG FEATURES="setup,website,tsp"
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates pkg-config libssl-dev libdbus-1-dev clang cmake && rm -rf /var/lib/apt/lists/*
RUN git init /src && cd /src && git remote add origin https://github.com/OpenVTC/verifiable-trust-infrastructure \
 && git fetch --depth 1 origin "$VTI_SHA" && git checkout --detach FETCH_HEAD \
 && [ "$(git rev-parse HEAD)" = "$VTI_SHA" ]
WORKDIR /src
SHELL ["/bin/bash","-o","pipefail","-c"]
RUN cargo build --locked --release -p vtc-service --bin vtc --no-default-features --features "$FEATURES" 2>&1 | tail -n 200; exit ${PIPESTATUS[0]}

FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
# Added to #117's runtime line for booting only (unproven until the image check runs on this change):
# nodejs serves the setup DID to the trust agent during first boot (serve-did.mjs, no dependencies); wget reads DID logs.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libdbus-1-3 wget nodejs && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --home /var/lib/vtc vtc && install -d -o vtc -g vtc -m 0700 /var/lib/vtc
COPY --from=build /src/target/release/vtc /usr/local/bin/vtc
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY serve-did.mjs /usr/local/lib/serve-did.mjs
# Starts as root on purpose: the entrypoint fixes the volume owner, then drops to uid 10001 (Security 12376 C).
ENV HOME=/var/lib/vtc
EXPOSE 8200
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
