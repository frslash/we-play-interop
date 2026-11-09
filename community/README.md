# community/: the room's test host (a trust agent, a trust community, a mediator and a proxy)

**Test keys only.** This is where the room tries the open trust infrastructure the projects here build: a person
joins a community with a wallet, gets a membership pass, and enters an encrypted room. Nothing here may hold a
real person's key until Security's gate for real people opens.

Every name in these files (a feature, a binary, a port, a setting, a path) was read from the code they build, at
the commits pinned below. The room's projects shelf (`projects`, `search_code`, `read_code`) lets any agent check
them. The first version of this folder was written without that access, and guessed; "What was wrong" at the end
lists what the guesses got wrong, so nobody repeats them.

| Service | What it is | Built from | Listens | Public |
|---|---|---|---|---|
| `vta` | the trust agent: holds the community's keys and signs for it | OpenVTC `c6964c4612131089e1add0f47575894e1bd8a565` (`vta-service` 0.78.0), features `setup,rest,didcomm,webvh,cli-synthesis` (no TSP) | 8100 | its DID log only, through the proxy |
| `vtc` | the trust community: admits members, issues their passes, hosts community rooms | same commit (`vtc-service` 0.26.0), features `setup,website,tsp` | 8200 | through the proxy only |
| `mediator` | carries messages between agents, communities and wallets (DIDComm v2 and TSP) | **not OpenVTC**: Affinidi's, `34bbdea4717e3a8dd1fdb190ad9c2ad2b33a3316` (v0.50.0), default features | 7037 | through the proxy only |
| `Redis` | the mediator's queues | `redis:7.4.6-alpine@sha256:3b73847e72874be07e6657b129a94761662b79bc0f679273757d4218573b2a98` | 6379 | no |
| `proxy` | nginx, default-deny | `community/proxy` | 8080 | **yes, the only one**: `vtc.`, `vta.`, `mediator.inwove.org` |

Why these pins: the room's agents asked for OpenVTC `c6964c4`; that commit's own `Cargo.toml` (lines 163-164) says
its messaging library "goes with ... mediator 0.50", so the mediator moved from 0.48.0 to v0.50.0. The openvti
starter kit verified an older pair (OpenVTC `26d0da81` with mediator 0.48.0, `e6e2c63`) on 2026-11-05: that pair
is the fallback if these two do not shake hands.

## How it comes up, in order

Nothing below needs a person, a terminal or a copied value. Each service makes its own keys on its own volume.

1. **mediator** (needs Redis and its volume): first boot runs `mediator-setup --from` with a recipe (fields from
   the mediator's `tools/mediator-setup/src/recipe.rs`). It makes its own `did:webvh` for `mediator.inwove.org`
   and serves the log itself.
2. **vta**: first boot reads the mediator's DID on the private network, then runs `vta setup --from` with a setup
   file (OpenVTC `docs/02-vta/non-interactive-setup.md`): its seed in an encrypted file, its own `did:webvh` at
   `vta.inwove.org`, and a `[[staff]]` entry naming a throwaway key admin of one context, `vtc`.
3. **vtc**: first boot runs phase 1 of OpenVTC's two-phase setup (`vtc setup --setup-key-out`), which makes a
   one-time setup key, and offers that key's DID (a public value) on the private network, port 8201.
4. **vta again**: its first-boot helper (`vta/handoff.mjs`) reads that DID, signs the one grant a community needs
   (admin of the `vtc` context for an hour, marked as a one-time hand-off: only a signed request can write that
   mark), and deletes its throwaway key.
5. **vtc again**: phase 2 (`vtc setup --from`), retried every 5 seconds until the grant lands. The trust agent
   mints the community's DID and keys. What phase 2 prints (the community's DID, the first admin's DID, the
   install link and its claim code) goes to `/var/lib/vtc/first-run.out` (0600), never to a log.
6. **proxy**: forwards only the paths in `proxy/nginx.conf.template`.

A first run that fails half way is started over by deleting the `vta` and `vtc` volumes and redeploying (a
`did:webvh` is bound to its host and its first keys, so a half-made one cannot be repaired).

## What each service needs set

| Service | Variable | What |
|---|---|---|
| `vta` | `VTA_SEED_PASSPHRASE` | sealed, machine-made, 128 bits or more: opens the seed file. Runtime only. |
| `vta` | `VTA_ADMIN_DID` | optional. A test `did:key` the room's people hold. Set: that key is the agent's admin and the agent is sealed (only signed requests change it). Not set: no admin, not sealed, and the start-up log says so. |
| `vtc` | `VTC_SECRETS_PASSPHRASE` | sealed, machine-made, different from the agent's. |
| `vtc` | `VTC_ADMIN_DID` | optional. A test `did:key` that may approve joins from the start. Without it, the first admin claims the install link in `first-run.out`. |
| `mediator` | `DATABASE_URL` | the Redis (`${{Redis.REDIS_URL}}`). |
| `mediator` | `MEDIATOR_NETWORK_MODE` | `closed`, the default and the only value it starts with; anything else stops it (see below). |
| `mediator` | `MEDIATOR_ADMIN_DID` | optional. The DID of an admin made somewhere else (a public DID, never a key). Set: that DID is the mediator's admin, and its key is never on this host. Not set: the admin made at first boot, whose key stays only in the mediator's secrets file on its volume. |
| `mediator` | `MEDIATOR_CORS_ALLOW_ORIGIN` | optional: one origin (the room's page) allowed to reach it from a browser. None by default. |
| `proxy` | `VTC_UPSTREAM`, `VTA_UPSTREAM`, `MEDIATOR_UPSTREAM` | `host:port` of the three on the private network. |

Volumes: `/var/lib/vta`, `/var/lib/vtc`, `/var/lib/mediator`. Losing one loses that service's identity. **The
mediator's volume is new**: the one-time Railway setup job (`setup/setup.sh`) now creates it, and the mediator
needs it before its first start (without it, it would be a new mediator with a new DID on every restart).

Addresses the services use for each other, each with a default for Railway's private network and settable for
any other host: `MEDIATOR_INTERNAL_URL` (`http://mediator.railway.internal:7037`; empty: run without messaging),
`VTA_INTERNAL_URL` (`http://vta.railway.internal:8100`), `VTC_HANDOFF_URL`
(`http://vtc.railway.internal:8201/setup-did`), `VTA_REST_URL` (`http://vta.railway.internal:8100`),
`VTA_PUBLIC_URL`, `VTC_PUBLIC_URL`, `MEDIATOR_PUBLIC_URL` (the three `https://….inwove.org` names), `BIND_HOST`
(`[::]`).

## Who may use the mediator: closed, only closed

Security's condition (block 11114, and its answer of 2026-11-09): a DID may exchange messages only where an access
entry allows it. The room's owner agreed that people are let in one at a time, by their own DID, added with the admin key;
Security writes that step, and nothing here builds a way in. On every boot the entrypoint:

- refuses `MEDIATOR_NETWORK_MODE=open` (at v0.50.0 the setup tool writes `ALLOW_ALL` for it, and for any typo:
  `tools/mediator-setup/src/config_writer.rs:254-270`);
- refuses to start if its file or its environment grants `ALLOW_ALL` or `SEND_FORWARDED` (anonymous relay through
  `/inbound`), turns on `allow_unauthenticated_forwards`, or sets any of the four values below to something else;
- exports `MEDIATOR_ACL_MODE=explicit_allow`, `GLOBAL_DEFAULT_ACL=DENY_ALL,LOCAL,SEND_MESSAGES,RECEIVE_MESSAGES`,
  `ENABLE_INTER_MEDIATOR_RELAY=false` and `TRUST_TASK_VERIFICATION=enforce` (the environment wins over the file:
  `affinidi-messaging-mediator-config/src/env.rs:60-112`), checks them again, and logs one line saying what it runs
  with (settings only).

What follows, plainly: until someone is let in, the trust agent and the community cannot reach each other or a
wallet through it, and fall back to REST: joining still works over https, but a pass cannot be pushed to a wallet
and a community room cannot be keyed. The starter kit's own note (`docs/MODES.md:105-108`): a closed mediator answers
403 to the trust agent "and the VTA then silently falls back to REST only".

## How the passphrases are held (Security 12376; test keys only)

Each of `vta` and `vtc` starts as root for two jobs only: `chown` its volume to uid 10001, and write its
passphrase to a **tmpfs** file (`/dev/shm/{vta,vtc}-creds/`, dir 0700, file 0400, uid 10001; exit 78 if the
directory is not a tmpfs). It then drops to uid 10001 with `setpriv` and `env -u`, so neither the service nor
`/proc/<pid>/environ` carries the variable. The agent's setup file names the passphrase file directly in
`[secrets]` (`kek = { source = "passphrase", file = … }`); the community's uses `[secrets.encrypted_file]`. The
setup files themselves are written to the tmpfs and deleted after use.

**What this does and does not do:** it stops a leaked volume or backup from opening the seed. It does not stop
anyone who can run code inside the service or read the Railway variable. That is acceptable for test keys only.

## What is checked, and what is not yet

- `npm test` (`test/community.test.js`): the features exist, the pins are full commits, the setup files have the
  shape the setup tools read, the proxy is default-deny, and the hand-off helper's signatures verify with the
  room's own code.
- `.github/workflows/community-images.yml` (from pull request #117), on every pull request that touches `community/`:
  builds the four images. #117's lines for the three Rust images were proven by a real build; the changes made since
  for booting (the mediator's pin, its default features and `mediator-setup`, `nodejs` and `wget` in the agent and
  community images) are proven only when it runs on the change that makes them. With the images it just built (no
  second build) it then checks that the binaries answer, that the proxy's template is valid nginx, the mediator's
  first boot against its real setup tool with the closed values and each refusal, and boots the trust agent and the
  community together (`compose.ci.yml`, the starter kit's local mode: loopback DIDs, REST only) so the room's own
  code can ask the community for its join manifest (`smoke.mjs`). **Its first run with these steps is the first time
  these files have met the real binaries at start-up.** No secrets, no `RAILWAY_TOKEN`.
- **Not checked anywhere until the first deploy**, because they need the real names and the proxy: the trust
  agent's `did:webvh` at `vta.inwove.org` with its REST door at a private address (a combination the starter kit
  does not use: it runs both at one public address); the community reaching the agent with
  `VTA_ALLOW_PRIVATE_ENDPOINTS=1`; the mediator serving with its settings from the environment on v0.50.0; and
  the proxy's forwarded-address header on Railway (`proxy/common.inc`). A path wrongly blocked shows as a 404,
  never as an opening.
- **Known to fail on Railway as written (found by reading, not yet fixed):** the community's setup reads the trust
  agent's REST address from the agent's DID, and OpenVTC refuses a plain `http://` address unless it is loopback
  (`vta-sdk/src/http.rs`: "only a loopback host ... may use http://; advertise an https:// endpoint"). The agent
  advertises `http://vta.railway.internal:8100`, so phase 2 will be refused there. The check on GitHub passes
  because it uses `localhost`. The ways out (an https door for the agent, or setting the community up over the
  mediator instead of REST) change what is public, so they are Security's and the room owner's to choose.
- `sh community/test-entrypoints.sh` (root, `setpriv`, tmpfs): plants a fake passphrase and checks it reaches no
  output, no volume and no service environment.

## What a host needs (one screen, for someone outside)

Plain Dockerfiles, settings from the environment, volumes by path; nothing here needs Railway except
`.github/workflows/deploy-community.yml` and `setup/`. Five containers on one private network, three volumes, two
sealed passphrases, and three public names pointing at the proxy. `compose.ci.yml` runs the agent and the
community on one machine with Docker.

## What was wrong before (so it is not repeated)

| The earlier file said | The code says |
|---|---|
| `vta` built with `setup,rest,didcomm,webvh` | the `vta` binary needs `cli-synthesis` too, or cargo refuses to build it |
| `vtc` built with the feature `encrypted-file` | there is no such feature; the encrypted file store is always there. Without `setup`, `vtc setup` answers "not available" |
| the agent's setup file used `[secrets.encrypted_file]` | in a setup file the fields sit in `[secrets]`; unknown fields stop the parse |
| the agent's setup file had no `[vta_did]` | without a DID of its own the agent refuses to start |
| the community's `setup.toml` was "provided by first-run", which nothing wrote | the entrypoint writes it, after phase 1 and the hand-off |
| `vtc` started with no config path | `--config`, else `VTC_CONFIG_PATH`, else `./config.toml` |
| the mediator built `--no-default-features --features tsp` | that build compiles (pull request #117 proved it) but has no store and cannot start; first boot needs `mediator-setup` |
| the mediator had no volume and expected a config nothing wrote | it makes its identity at first boot and must keep it |
| the proxy forwarded `/v1/join-requests`, `/members/static/`, `/.well-known/did-witness.json` | the community's door is `POST /v1/trust-tasks`; the other two are not routes |
| services bound to `0.0.0.0` | Railway's private network is IPv6 inside: `[::]` |
| `/members/` comes with the `website` feature | the member portal is mounted only with `admin-ui` (`vtc-service/src/routes/mod.rs:1471-1477`) |
| mediator 0.48.0 beside OpenVTC `c6964c4` | that OpenVTC goes with mediator 0.50 |

## Railway, and Security's standing conditions

- **Railway setup job (`.github/workflows/setup-community.yml`, `community/setup/setup.sh`), built, not yet run.** Manual `workflow_dispatch` of main, environment `railway-setup`, secret `RAILWAY_SETUP_TOKEN` (a workspace token holding only `wpi-community`). First call is a read; it stops unless the workspace holds exactly one project. Create-only and idempotent: 4 services + Redis, volumes at `/var/lib/vta`, `/var/lib/vtc` and `/var/lib/mediator`, proxy upstreams (8100 / 8200 / 7037), `DATABASE_URL=${{Redis.REDIS_URL}}` on the mediator, the proxy's domain on 8080, and the two passphrases made in the job (masked, never printed, only ever made together with their new service). It ends with "not yet sealed: <names>": the owner seals both in the dashboard (3-dot menu, Seal) **before DNS points at the host**, then deletes the token, then runs `verify-setup-token-dead` (needs a 401). The Railway GraphQL field names are from Emrys's introspection (block 10768), not run against the live API: the first run is the real test, and it fails loudly with nothing created on a permission error. Stand-in test against a fake API: `bash community/setup/test-setup.sh`. Still unscripted: the VTC's phase 1/grant/phase 2 first-run (needs `pnm`).
- **Redis on this host is for test keys only (Security, block 10854).** No password, no volume, no public domain, no TCP proxy: reachable only on Railway's private network. (a) A real member's message through this host needs a password and a volume first, which is a new look from Security. (b) Nobody adds a domain or TCP proxy to Redis in the dashboard. (c) The queue is lost when Redis restarts; a vanished queue is not an attack.
- **Before the token goes in (the owner's hand):** limit the `railway-setup` environment to `main` (Settings, Environments, railway-setup, Deployment branches: Selected branches, `main`) **before** adding `RAILWAY_SETUP_TOKEN`; the workflow's own main check runs after the secret is already loaded.

- **Second proxy for the mediator's address (block 10973).** Hobby allows two custom domains per service, so `vtc.` and `vta.inwove.org` sit on `proxy` and `mediator.inwove.org` goes on `proxy-mediator`: the same nginx image and folder (`community/proxy`), deployed as its own service. Its server blocks are chosen by host name, so it only ever answers for names pointed at it; the other two blocks answer there too if a caller sends that Host header straight to its address, but that is the same allowlist already public on `proxy`, so it adds no exposure; anything else gets the default 404. Create it once from the Mac, with the same three upstream values as `proxy`, then deploy normally:
  `railway add --service proxy-mediator --variables "VTC_UPSTREAM=vtc.railway.internal:8200" --variables "VTA_UPSTREAM=vta.railway.internal:8100" --variables "MEDIATOR_UPSTREAM=mediator.railway.internal:7037"`
  `railway domain mediator.inwove.org --service proxy-mediator --port 8080`
  Needs Security's read (public exposure). It does not touch `setup-community.yml`: the setup token is held for deletion, so the service is made by hand once.

- **`/inbound` conditions (Security block 11114), all in place.** nginx: 96k body cap on `/mediator/v1/inbound`, a per-address limit (2 req/s, burst 5; 5 connections on `/ws`) on both, `/ws` GET-only, each with a comment saying what it stands for. The mediator entrypoint runs closed only and refuses to start on `ALLOW_ALL`, `SEND_FORWARDED` or `allow_unauthenticated_forwards = true` in its file or its environment, then exports the four explicit values (see "Who may use the mediator"). No `didcomm-v1` in the image. First-deploy checks to report as status codes (test values only): (a) unauthenticated POST to `/inbound` refused, not 2xx; (b) malformed body from a signed-in test session gets 400; (c) a body over 96k gets 413; (d) repeated requests trip the limit (503).
