# community/: the room's TEST community on Railway (project `wpi-community`)

**This is a test community on test keys.** Its keys are made by boot scripts inside the services at first
start. Do not hold a real person's key or credential here; before the community is real, its keys are
replaced and its secrets move to a store a person can account for.

Anything here deploys on the next push to `main` (`.github/workflows/deploy-community.yml`).

| Service | Built from | Public |
|---|---|---|
| `vta` | OpenVTC `c6964c4612131089e1add0f47575894e1bd8a565`, `vta-service`, features `setup,rest,webvh`, hash checked | only its DID log, through the proxy |
| `vtc` | same commit, `vtc-service`, features `setup,website` (no keyring, no admin-ui), hash checked | through the proxy only |
| `mediator` | **not OpenVTC**: Affinidi's `affinidi-messaging-mediator` at `e6e2c63654bb43bb7feb732834702cd940b2bcce` (0.48.0) | through the proxy only |
| `proxy` | nginx, default-deny | yes: `vtc.`, `vta.`, `mediator.inwove.org` |

All Rust builds use `rust:1.95` (OpenVTC's and the mediator's `rust-version` at these commits).

## First start: who does the setup (the room's choice: a boot script)

No person runs `pnm` and no person's key becomes the root.

1. **VTA** (`vta/entrypoint.sh`): `vta setup --from` makes its seed (an `encrypted_file` store) and its
   `did:webvh` at `https://vta.inwove.org`. No super-admin is seeded. Its REST endpoint in its DID
   document is the private address `http://vta.railway.internal:8100`, so only services in the project
   can call it.
2. **VTC** (`vtc/entrypoint.sh`), phase 1: `vtc setup --setup-key-out` mints a one-time setup `did:key`
   on the VTC's volume. The VTC shows that public DID, and nothing else, at
   `http://vtc.railway.internal:8201/setup-did` until the VTA is up.
3. **VTA** grants it, offline and before its daemon listens:
   `vta contexts create --id community --admin-did <setup did> --admin-expires 1h --admin-handoff`.
   Only an Ed25519 `did:key` is accepted. Then the VTA starts.
4. **VTC**, phase 2: once the VTA answers `/health`, `vtc setup --from` (transport `rest`) has the VTA
   mint the community's DID and keys. The setup DID rolls over once to a VTA-minted admin; the key file
   is then deleted. The install URL and claim code go only to `/var/lib/vtc/install.out` (0600); only the
   community's DID is logged.

Each step leaves a marker on its volume (`.setup-done`, `.granted`, `.initialised`), so a restart picks
up where it stopped.

**What this means:** the community has no administrator until someone claims the install URL from the
VTC's volume. Whoever can open a shell in these Railway services can read the volumes and the sealed
variables, and so holds the test root. That is accepted for test keys only.

## Variables

| Service | Variable | What |
|---|---|---|
| `vta` | `VTA_SEED_PASSPHRASE` | sealed; machine-made, 22+ characters |
| `vtc` | `VTC_SECRETS_PASSPHRASE` | sealed; machine-made, 22+ characters, not the VTA's |
| `proxy` | `VTC_UPSTREAM`, `VTA_UPSTREAM`, `MEDIATOR_UPSTREAM` | e.g. `vtc.railway.internal:8200` |
| optional | `VTA_PUBLIC_URL`, `VTA_REST_URL`, `VTC_PUBLIC_URL`, `VTA_INTERNAL_URL`, `VTC_SETUP_DID_URL`, `COMMUNITY_CONTEXT` | defaults in the entrypoints |

Each passphrase goes to a tmpfs file (`/dev/shm/{vta,vtc}-creds/`, 0400, uid 10001) and is removed from
the service's environment before it starts (`env -u`, then `setpriv` to uid 10001). It is never a build
`ARG` or Dockerfile `ENV`. Each needs a Railway volume: `vta` at `/var/lib/vta`, `vtc` at `/var/lib/vtc`.

## The proxy

Default-deny; exact paths and methods only, 64 KB bodies, per-source limits. `vtc.inwove.org`:
`/.well-known/did.jsonl`, `/.well-known/did-witness.json`, `/health`, `/members/` (the join page,
`/members/?join`), `/members/assets/`, `POST /v1/join-requests`. `vta.inwove.org`: its DID log only.
Everything else, `/admin` included, is a 404.

## Not checked yet (the first deploy is the real test)

The boot scripts were checked against OpenVTC's code and docs at the pinned commit, and run with stand-in
binaries (`test/community-boot.test.js`). The real images were not built: the session that wrote them had
no Docker daemon and did not compile OpenVTC. On the first deploy, check:

- the images build (features `setup,rest,webvh` and `setup,website` with `--no-default-features`);
- the VTA serves its own log at `https://vta.inwove.org/.well-known/did.jsonl` and accepts an `http://`
  `public_url`;
- `busybox httpd` and both daemons are reachable over Railway's private network (the VTA binds `::`);
- the VTC's log is served at `/.well-known/did.jsonl` (OpenVTC says "a server-assigned path");
- the mediator is not wired: it stops with exit 78 until messaging (TSP/DIDComm) is added in its own step,
  with an allowlist ACL and a redis.
