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

- **First-run step.** The entrypoints expect `setup.toml` on the volume and stop (exit 78) without it. The step that writes it, and that has the VTA grant the VTC's setup key over the private network, is not here: it needs OpenVTC's `non-interactive-setup.md` command lines, which this session could not read. Until it exists the services build but do not come up, and the check at the end of the deploy fails loudly.
- **Unverified build facts**, taken from `docs/community-host-plan.md`: the `vtc-service` feature name `encrypted-file`, the VTA's port 8100, the VTC's port 8200 (a guess), the binary names.
- **Mediator.** `MEDIATOR_SHA` is empty on purpose: the build refuses until someone picks the exact commit (0.48–0.50). The repository and crate name are a guess. Its ACL must be an allowlist (the VTC, the VTA, DIDs Faolan approved); its entrypoint does not yet check that.
- **Proxy paths** follow Security's condition 3. `/members/static/`, `/.well-known/did-witness.json` and the mediator paths are guesses to check on the first deploy. A path wrongly blocked shows as a 404, never as an opening.
- Variables the proxy needs: `VTC_UPSTREAM`, `VTA_UPSTREAM`, `MEDIATOR_UPSTREAM` (for example `vtc.railway.internal:8200`).
- Not run: no Docker daemon in the cloud session. The first build will be the real test.
