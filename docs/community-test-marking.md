# Marking the community as a test, and naming who can read its secrets

Step `10a6372f2249…`. Two things must be true before the community's boot script
makes its first admin keys:

1. The room's log holds a signed line naming everyone who can read the Railway
   project's secrets.
2. The community's join page and DID document say it is a test community on test keys.

## What is built (in `community/`)

- **No first admin before the access line.** On first start, `community/vta/entrypoint.sh`
  and `community/vtc/entrypoint.sh` refuse to run (exit 78, before touching anything) unless
  `ROOM_ACCESS_LINE` holds a 64-hex log hash. It is the hash of the room's signed line that
  names who can read the project's secrets. It is public, not a secret. The account holder
  sets it as a Railway variable after posting that line. Once the service is set up, the
  check no longer runs.
- **The VTC calls itself a test.** On first start the VTC entrypoint refuses a `setup.toml`
  whose `vtc_name` does not say `TEST` or whose `vtc_description` does not say `test keys`.
  Checked in OpenVTC at commit `c6964c4612131089e1add0f47575894e1bd8a565`:
  `vtc-service/src/config.rs` has `vtc_name` and `vtc_description`, the community's public
  name and description. The first-run step that writes this file should use:

  ```toml
  vtc_name = "We Play Interop community (TEST, test keys)"
  vtc_description = "A test community. Its keys are test keys and it may be wiped. Do not rely on anything here."
  ```

- **The VTA calls itself a test.** Its generated `setup.toml` now has
  `vta_name = "We Play Interop VTA (TEST, test keys)"` (`vta_name` is the VTA's
  human-readable name in `docs/02-vta/non-interactive-setup.md`).
- **The join page says it.** The proxy adds a banner to `/members/` ("TEST community on
  test keys…") with `sub_filter` before `</head>`, whatever the VTC serves.
- **Every answer says it.** The proxy adds the header
  `X-Community-Status: test community, test keys` to every response, DID files included.

## What is still open

- **The access line itself.** Only the Railway project's account holder knows who has
  access. They post it as an ordinary signed line in the room (every line in the log is
  already signed, so no code is needed), then set `ROOM_ACCESS_LINE` to its hash. No names
  are written here.
- **The DID document's own content.** The VTA's DID is a did:webvh log. That log is signed,
  so the proxy must not change it. A header goes with it, but the document itself does not
  say "test" yet. Not checked: whether `create_webvh` can add a label (a service entry or
  `alsoKnownAs`) without breaking how other projects resolve it.
- **Not run against the real services.** There is no Docker daemon in the cloud session.
  Check on the first deploy: that the banner shows (the VTC's page must have a `</head>`
  and its CSP must allow an inline `<style>`), and that `vta_name` is accepted.
