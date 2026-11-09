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
| `vta` | the trust agent: holds the community's keys and signs for it | OpenVTC `c6964c4612131089e1add0f47575894e1bd8a565` (`vta-service` 0.78.0), features `setup,rest,didcomm,tsp,cli-synthesis,webvh` | 8100 | its DID log only, through the proxy |
| `vtc` | the trust community: admits members, issues their passes, hosts community rooms | same commit (`vtc-service` 0.26.0), features `setup,website,tsp` | 8200 | through the proxy only |
| `mediator` | carries messages between agents, communities and wallets (DIDComm v2 and TSP) | **not OpenVTC**: Affinidi's, `34bbdea4717e3a8dd1fdb190ad9c2ad2b33a3316` (v0.50.0), default features | 7037 | through the proxy only |
| `Redis` | the mediator's queues | `redis:7.4.6-alpine@sha256:3b73847e72874be07e6657b129a94761662b79bc0f679273757d4218573b2a98` | 6379 | no |
| `proxy` | nginx, default-deny | `community/proxy` | 8080 | **yes, the only one**: `vtc.`, `vta.`, `mediator.inwove.org` |

Why these pins: the room's agents asked for OpenVTC `c6964c4`; that commit's own `Cargo.toml` (lines 163-165) says
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
| `mediator` | `MEDIATOR_NETWORK_MODE` | `closed` (the default) or `open`. **A decision for a person, with Security**: see below. It takes effect at first boot only. |
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

## The one open decision: who may use the mediator

- `closed` (the default here, Security's condition 2): a DID may exchange with another only where an access entry
  allows it. With no entries, the trust agent and the community cannot reach each other or a wallet through it and
  fall back to REST: joining still works over https, but a pass cannot be pushed to a wallet and a community room
  cannot be keyed.
- `open` (what the openvti starter kit runs, and the only setup it verified): any DID may register and message any
  other. The wallet journey needs this, or a closed mediator with an entry for every participant (which needs an
  admin key for the mediator that nobody holds here). The proxy's per-source limits stand in front of it.

The starter kit's own note (`docs/MODES.md:105-108`): a closed mediator answers 403 to the trust agent "and the
VTA then silently falls back to REST only".

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
- `.github/workflows/community-stack.yml`, on every pull request that touches `community/`: builds the three
  images from the pinned sources, runs the mediator's first boot against its real setup tool, boots the trust
  agent and the community together (`compose.ci.yml`, the starter kit's local mode: loopback DIDs, REST only),
  and has the room's own code ask the community for its join manifest (`smoke.mjs`). **Its first run is the first
  time these files have met the real binaries.**
- **Not checked anywhere until the first deploy**, because they need the real names and the proxy: the trust
  agent's `did:webvh` at `vta.inwove.org` with its REST door at a private address (a combination the starter kit
  does not use: it runs both at one public address); the community reaching the agent with
  `VTA_ALLOW_PRIVATE_ENDPOINTS=1`; the mediator's two generated settings on v0.50.0 (the kit patched them on
  0.45); `/members/` with the `website` feature and no console build; and the proxy's forwarded-address header on
  Railway (`proxy/common.inc`). A path wrongly blocked shows as a 404, never as an opening.
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
| the mediator built `--no-default-features --features tsp`, copied a binary called `affinidi-messaging-mediator` | that build has no store and cannot start; the binary is `mediator`; first boot needs `mediator-setup` |
| the mediator had no volume and expected a config nothing wrote | it makes its identity at first boot and must keep it |
| the proxy forwarded `/v1/join-requests`, `/members/static/`, `/.well-known/did-witness.json` | the community's door is `POST /v1/trust-tasks`; the other two are not routes |
| services bound to `0.0.0.0` | Railway's private network is IPv6 inside: `[::]` |
| mediator 0.48.0 beside OpenVTC `c6964c4` | that OpenVTC goes with mediator 0.50 |
