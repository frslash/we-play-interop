# community/: the room's test VTI host on Railway (project `wpi-community`)

Four services; only `proxy` is public. Anything here deploys on the next push to `main` (`.github/workflows/deploy-community.yml`), so it is release-path and waits for Faolan's tap, after Security has read it.

| Service | Source | Public |
|---|---|---|
| `vta` | OpenVTC `c6964c4612131089e1add0f47575894e1bd8a565`, built from source, hash checked | no; the proxy serves its DID files only |
| `vtc` | same commit, `vtc-service` without `keyring` or `admin-ui` | through the proxy only |
| `mediator` | **not OpenVTC**: Affinidi's, from source at one full commit | through the proxy only |
| `proxy` | nginx, default-deny | yes: `vtc.`, `vta.`, `mediator.inwove.org` |

Secrets never go in the repo or the logs. Each service makes its keys on its own volume at first start. The two passphrases are **sealed Railway variables** (`VTA_SEED_PASSPHRASE`, `VTC_SECRETS_PASSPHRASE`), never on the volume beside the file they lock.

## Not finished, and why (read before the tap)

- **First-run step (partly done, block 12106).** The VTA now writes its own `setup.toml` (admin = the test `did:key` in `VTA_ADMIN_DID`, set by the deploy) and runs `vta setup --from`. **Still open:** (a) the VTA's secrets backend: the doc's quick start says `keyring`, which needs a keyring in the container; the file/env backend's name and keys are not in the excerpt, so check `examples/vta-setup.example.toml` at c6964c4 on the first build; (b) the VTC's three steps (phase 1 `vtc setup --setup-key-out`, the grant `pnm contexts create ... --admin-expires 1h --admin-handoff` by a step holding the test admin key over the private network, phase 2 `vtc setup --from` with `setup_key_file`) are not scripted yet: `pnm` is not in these images and the test admin key's home is undecided. Phase 2's output (`vtc_did`, `admin_did`, `install_url`, `claim_code`) must go only to the sealed volume, never a log. The claim code reaches Faolan only through his own Railway login.
- **Unverified build facts**, taken from `docs/community-host-plan.md`: the `vtc-service` feature name `encrypted-file`, the VTA's port 8100, the VTC's port 8200 (a guess), the binary names.
- **Mediator.** Pinned: `affinidi/affinidi-messaging-mediator` at `e6e2c63654bb43bb7feb732834702cd940b2bcce` (0.48.0), features `tsp`, no `secrets-aws`; needs a redis (pin `redis:7.4.6-alpine@sha256:3b73847e72874be07e6657b129a94761662b79bc0f679273757d4218573b2a98`, the multi-arch index digest from Emrys's block 12287; not added as a service yet). If the handshake fails on VTI c6964c4, try `26d0da81`. Its ACL must be an allowlist (the VTC, the VTA, DIDs Faolan approved); its entrypoint does not yet check that.
- **Proxy paths** follow Security's condition 3. `/members/static/`, `/.well-known/did-witness.json` and the mediator paths are guesses to check on the first deploy. A path wrongly blocked shows as a 404, never as an opening.
- Variables the proxy needs: `VTC_UPSTREAM`, `VTA_UPSTREAM`, `MEDIATOR_UPSTREAM` (for example `vtc.railway.internal:8200`).
- Not run: no Docker daemon in the cloud session. The first build will be the real test.
