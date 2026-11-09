# The community host: a plan, waiting on one choice

This is the draft for `community/vta`, `community/vtc`, `community/mediator` and
`community/proxy`, the four Railway services that `.github/workflows/deploy-community.yml`
deploys. It is a document, not the services: anything under `community/` deploys the
moment it reaches `main`, and the stack below cannot come up on its own yet.

Source: OpenVTC, Verifiable Trust Infrastructure, at commit
`c6964c4612131089e1add0f47575894e1bd8a565` (MIT/Apache, public).

## What was checked in OpenVTC's code at that commit

- **VTA.** There is a plain Docker image (`Dockerfile`, binary `vta`, port 8100, health
  at `/health`, data in `/var/lib/vta`). It sets itself up headlessly from a TOML file
  (`docs/02-vta/non-interactive-setup.md`). Its seed needs a store. On a host with no
  keyring or cloud secret store (Railway), the choice is `encrypted_file`, with a key
  read from a file. Without a DID the `vta` binary will not start.
- **VTC.** The crate is `vtc-service` (binary `vtc`). It has no Dockerfile, so one must
  be written. Setup comes in two phases (`docs/03-vtc/non-interactive-setup.md`):
  1. `vtc setup --setup-key-out` mints a temporary `did:key`.
  2. Someone who holds **VTA admin** grants that key with
     `pnm contexts create … --admin-did … --admin-handoff`. OpenVTC says the VTC never
     grants itself.
  3. `vtc setup --from <toml>` asks the VTA to mint the community's DID, then writes
     `config.toml`, `did.jsonl`, the key bundle and a one-time install URL.

  Until that install URL is claimed, or the access list is seeded offline
  (`docs/03-vtc/bootstrap-runbook.md`), the community has no administrator. The join
  page is served at `/members/?join`, and the DID at `/.well-known/did.jsonl`.
- **Mediator.** OpenVTC has no mediator code at this commit. Its `Cargo.toml` pins
  clients for Affinidi's `affinidi-messaging-mediator` (0.47 to 0.50), which is a
  different project in a different repository. "Built from OpenVTC's code" cannot
  cover it.
- **Proxy.** The workflow calls it an "allowlist proxy", and its outside check expects
  `/admin` to answer 404. Nothing in the room or in OpenVTC says which paths and hosts
  it lets through.

## Draft shape (once the choices below are made)

| Service | Built from | Public | Keeps |
|---|---|---|---|
| `vta` | OpenVTC `Dockerfile` at the pinned commit, `FEATURES="setup,rest,didcomm,webvh"` | no (private network only) | seed (`encrypted_file`), data, on a Railway volume |
| `vtc` | a new Dockerfile building `vtc-service` at the pinned commit, no `keyring` feature | through `proxy` only | key bundle (`encrypted-file`), data, on a volume |
| `mediator` | to be decided (see below) | yes, for TSP and DIDComm | its own keys, on a volume |
| `proxy` | a small Caddy or nginx config | `vtc.inwove.org` | nothing |

Each Dockerfile would fetch OpenVTC by its full commit hash and check that hash before
building, so no other code can come in. No key, seed, passphrase or claim code goes in the
repository. Each one is generated on the service's own volume at first boot, or comes from
Railway variables.

## The choices that are still open

1. **Who does the one-time setup and holds the first admin keys?** One way is a boot
   script inside the services: the VTA seeds its own super-admin on its volume and grants
   the VTC's setup key over the private network. Then no person holds the root, but the
   VTA's admin key sits next to a running service. The other way is a named person with
   `pnm`, who then also claims the install URL. Until this is decided, the community has
   no DID to resolve.
2. **Which mediator?** Affinidi's `affinidi-messaging-mediator` at a pinned version, built
   from its own repository? Or the VTA's `create_mediator` template, which only mints a
   mediator *DID* and still needs a mediator to run?
3. **What does the proxy allow?** A guess: `/.well-known/did.jsonl`, `/members/*`,
   `/v1/join-requests*`, `/health` and the website. Everything else, `/admin` included,
   gets a 404.
4. **Hostnames** for the mediator (and the VTA, if it should be reachable from outside).
   The workflow names only `vtc.inwove.org`.
