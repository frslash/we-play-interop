# community/: the room's test VTI host on Railway (project `wpi-community`)

Four services; only `proxy` is public. Anything here deploys on the next push to `main` (`.github/workflows/deploy-community.yml`), so it is release-path and waits for Faolan's tap, after Security has read it.

| Service | Source | Public |
|---|---|---|
| `vta` | OpenVTC `c6964c4612131089e1add0f47575894e1bd8a565`, built from source, hash checked | no; the proxy serves its DID files only |
| `vtc` | same commit, `vtc-service` without `keyring` or `admin-ui` | through the proxy only |
| `mediator` | **not OpenVTC**: Affinidi's, from source at one full commit | through the proxy only |
| `proxy` | nginx, default-deny | yes: `vtc.`, `vta.`, `mediator.inwove.org` |

Secrets never go in the repo or the logs. Each service makes its keys on its own volume at first start. The two passphrases are **sealed Railway variables** (`VTA_SEED_PASSPHRASE`, `VTC_SECRETS_PASSPHRASE`), never on the volume beside the file they lock.

## What a host needs (one screen, for someone outside)

Plain Dockerfiles, env-var config, volumes by path; nothing here needs Railway except `.github/workflows/deploy-community.yml`. **Test keys only** until Security's real-people gate opens.

| Container | Port | Public | Volume | Secret / config |
|---|---|---|---|---|
| `vta` | 8100 | no | `/var/lib/vta` | `VTA_SEED_PASSPHRASE` (sealed), `VTA_ADMIN_DID` |
| `vtc` | 8200 (a guess; check on first build) | no | `/var/lib/vtc` | `VTC_SECRETS_PASSPHRASE` (sealed) |
| `mediator` | 7037 | no | none | `DATABASE_URL` pointing at the Redis |
| `redis` | 6379 | no | none | `redis:7.4.6-alpine@sha256:3b73847e72874be07e6657b129a94761662b79bc0f679273757d4218573b2a98` |
| `proxy` | 8080 | **yes, the only one** | none | `VTC_UPSTREAM`, `VTA_UPSTREAM`, `MEDIATOR_UPSTREAM` (`host:port` of the three above, private network) |

- The two passphrases are different, machine-made (128 bits or more), runtime-only secrets: never a build argument or image `ENV`, never in a log. The host holds them, so whoever runs the host can open the test keys: fine for test keys, not for a real person's.
- Each service needs a private network between them; only `proxy` gets a public address (`vtc.`, `vta.`, `mediator.inwove.org` point at it).
- Each volume must survive restarts; losing one loses that service's keys.
- Right looks like: the proxy answers on its public name, the services answer only through it, and every other path is a 404.

## How the passphrases are held (Security 12376; test keys only)

Each of `vta` and `vtc` starts as root for two jobs only: `chown` its volume to uid 10001 (never `RAILWAY_RUN_UID=0`), and write its passphrase to a **tmpfs** file (`/dev/shm/{vta,vtc}-creds/`, dir 0700, file 0400, uid 10001; exit 78 if the directory is not a tmpfs). It then drops to uid 10001 with `setpriv` and `env -u`, so neither the service nor `/proc/<pid>/environ` carries the variable. The VTA's secrets backend is `encrypted_file` with `kek = { source = "passphrase", file = ... }` (VTI `docs/02-vta/secret-backends.md`); the VTC's `setup.toml` must point at `/dev/shm/vtc-creds/secrets-passphrase` the same way. Two different machine-made passphrases (128 bits or more, minimum length checked), each a sealed Railway variable, runtime only: never a build `ARG` or Dockerfile `ENV` (checked by `community/test-entrypoints.sh`, which also plants a fake passphrase and greps every output line and the volume for it).

**What this does and does not do:** it stops a leaked volume or backup from opening `seed.enc`. It does not stop anyone who can run code inside the service or read the Railway variable. That is acceptable for test keys only. Before a real person's key is held here, the passphrase moves to a system credential or a TPM/enclave: that is the real-people gate.

## Not finished, and why (read before the tap)

- **First-run step (partly done, block 12106).** The VTA now writes its own `setup.toml` (admin = the test `did:key` in `VTA_ADMIN_DID`, set by the deploy) and runs `vta setup --from`. **Still open:** (a) the VTA's `[secrets.encrypted_file]` keys are from the doc excerpt Emrys quoted: check them against `examples/vta-setup.example.toml` at c6964c4 on the first build; (b) the VTC's three steps (phase 1 `vtc setup --setup-key-out`, the grant `pnm contexts create ... --admin-expires 1h --admin-handoff` by a step holding the test admin key over the private network, phase 2 `vtc setup --from` with `setup_key_file`) are not scripted yet: `pnm` is not in these images and the test admin key's home is undecided. Phase 2's output (`vtc_did`, `admin_did`, `install_url`, `claim_code`) must go only to the sealed volume, never a log. The claim code reaches Faolan only through his own Railway login.
- **Unverified build facts**, taken from `docs/community-host-plan.md`: the `vtc-service` feature name `encrypted-file`, the VTA's port 8100, the VTC's port 8200 (a guess), the binary names.
- **Mediator.** Pinned: `affinidi/affinidi-messaging-mediator` at `e6e2c63654bb43bb7feb732834702cd940b2bcce` (0.48.0), features `tsp`, no `secrets-aws`; needs a redis (pin `redis:7.4.6-alpine@sha256:3b73847e72874be07e6657b129a94761662b79bc0f679273757d4218573b2a98`, the multi-arch index digest from Emrys's block 12287; not added as a service yet). If the handshake fails on VTI c6964c4, try `26d0da81`. Its ACL must be an allowlist (the VTC, the VTA, DIDs Faolan approved); its entrypoint does not yet check that.
- **Proxy paths** follow Security's condition 3. `/members/static/`, `/.well-known/did-witness.json` and the mediator paths are guesses to check on the first deploy. A path wrongly blocked shows as a 404, never as an opening.
- Variables the proxy needs: `VTC_UPSTREAM`, `VTA_UPSTREAM`, `MEDIATOR_UPSTREAM` (for example `vtc.railway.internal:8200`).
- Not run: no Docker daemon in the cloud session. The first build will be the real test.
- **Railway setup job (`.github/workflows/setup-community.yml`, `community/setup/setup.sh`), built, not yet run.** Manual `workflow_dispatch` of main, environment `railway-setup`, secret `RAILWAY_SETUP_TOKEN` (a workspace token holding only `wpi-community`). First call is a read; it stops unless the workspace holds exactly one project. Create-only and idempotent: 4 services + Redis, volumes at `/var/lib/vta` and `/var/lib/vtc`, proxy upstreams (8100 / 8200 / 7037), `DATABASE_URL=${{Redis.REDIS_URL}}` on the mediator, the proxy's domain on 8080, and the two passphrases made in the job (masked, never printed, only ever made together with their new service). It ends with "not yet sealed: <names>": Faolan seals both in the dashboard (3-dot menu, Seal) **before DNS points at the host**, then deletes the token, then runs `verify-setup-token-dead` (needs a 401). The Railway GraphQL field names are from Emrys's introspection (block 10768), not run against the live API: the first run is the real test, and it fails loudly with nothing created on a permission error. Stand-in test against a fake API: `bash community/setup/test-setup.sh`. Still unscripted: the VTC's phase 1/grant/phase 2 first-run (needs `pnm`).
- **Redis on this host is for test keys only (Security, block 10854).** No password, no volume, no public domain, no TCP proxy: reachable only on Railway's private network. (a) A real member's message through this host needs a password and a volume first, which is a new look from Security. (b) Nobody adds a domain or TCP proxy to Redis in the dashboard. (c) The queue is lost when Redis restarts; a vanished queue is not an attack.
- **Before the token goes in (Faolan's hand):** limit the `railway-setup` environment to `main` (Settings, Environments, railway-setup, Deployment branches: Selected branches, `main`) **before** adding `RAILWAY_SETUP_TOKEN`; the workflow's own main check runs after the secret is already loaded.
- Stand-in test: `sh community/test-entrypoints.sh` (root, util-linux `setpriv`, tmpfs `/dev/shm`). Not run against the real binaries.

- **Second proxy for the mediator's address (block 10973).** Hobby allows two custom domains per service, so `vtc.` and `vta.inwove.org` sit on `proxy` and `mediator.inwove.org` goes on `proxy-mediator`: the same nginx image and folder (`community/proxy`), deployed as its own service. Its server blocks are chosen by host name, so it only ever answers for names pointed at it; the other two blocks answer there too if a caller sends that Host header straight to its address, but that is the same allowlist already public on `proxy`, so it adds no exposure; anything else gets the default 404. Create it once from the Mac, with the same three upstream values as `proxy`, then deploy normally:
  `railway add --service proxy-mediator --variables "VTC_UPSTREAM=vtc.railway.internal:8200" --variables "VTA_UPSTREAM=vta.railway.internal:8100" --variables "MEDIATOR_UPSTREAM=mediator.railway.internal:7037"`
  `railway domain mediator.inwove.org --service proxy-mediator --port 8080`
  Needs Security's read (public exposure). It does not touch `setup-community.yml`: the setup token is held for deletion, so the service is made by hand once.

- **`/inbound` conditions (Security block 11114).** nginx: 96k body cap on `/mediator/v1/inbound`, and a per-address limit (2 req/s, burst 5; 5 connections on `/ws`) on both, each with a comment saying what it stands for. Mediator entrypoint refuses to start if `allow_unauthenticated_forwards` is true. **Not yet done, needs the real config:** writing `SEND_FORWARDED` off and `allow_unauthenticated_forwards = false` as explicit values (key names unverified from cloud). Keep the image on `--features tsp` only; no `didcomm-v1` without Security. First-deploy checks to report as status codes (test values only): (a) unauthenticated POST to `/inbound` refused, not 2xx; (b) malformed body from a signed-in test session gets 400; (c) a body over 96k gets 413; (d) repeated requests trip the limit (503).
