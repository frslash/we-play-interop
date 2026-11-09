# Marking the community as a test, and naming who can read its secrets

Step `10a6372f2249…`. Two things must be true before the community's boot script
makes its first admin keys:

1. The room's log holds a signed line naming everyone who can read the Railway
   project's secrets.
2. The community's join page and DID document say it is a test community on test keys.

## Why neither is in this pull request

- **The access list** is known only to whoever holds the Railway project's account. No
  agent or builder can see it, and it must not be guessed. That person (or their agent)
  posts it as an ordinary signed line in the room. No code change is needed for that:
  every line in the log is already signed.
- **The test marking** has nothing to change on `main` yet. `main` has no `community/`
  folder: no boot script, no join page and no DID document. The services now exist as a
  draft on the branch `claude/wpi-build-community-services` (the plan from pull request
  #45), not merged. Anything put under `community/` deploys as soon as it reaches `main`,
  so this pull request does not add a copy of it.

## Where the marking goes on that branch

- `community/vtc/entrypoint.sh` runs `vtc setup --from $DATA/setup.toml`, but does not
  write that file: it waits for the first-run step, which is not scripted yet. The
  `vtc_name` and `vtc_description` below belong in that file, so they land with the
  first-run step (or the entrypoint writes them, as the VTA's entrypoint already writes
  its own `setup.toml`).
- `community/vta/entrypoint.sh` writes the VTA's `setup.toml` with
  `admin_label = "room-test-admin"`. Nothing there names it a test in public.
- A small guard fits there too: the VTC entrypoint refuses to run its first setup unless
  `setup.toml` has a `vtc_name` containing `TEST`. Then no admin key is made under a
  name that does not say test.

## How to mark it, once the services exist

Checked in OpenVTC at commit `c6964c4612131089e1add0f47575894e1bd8a565`:

- `vtc-service/src/config.rs` has `vtc_name` and `vtc_description` (old names:
  `community_name`, `community_description`). They are the community's public name and
  description, served on its public profile and used when it introduces itself
  (`trust_tasks/oob_tasks.rs`). Administrators can change them later through
  `spec/vtc/community/profile/update/0.1`.
- So the VTC's setup TOML should start with something like:

  ```toml
  vtc_name = "We Play Interop community (TEST, test keys)"
  vtc_description = "A test community. Its keys are test keys and it may be wiped. Do not rely on anything here."
  ```

- **Not checked:** whether the join page at `/members/?join` shows the description, and
  how to put a test label into the DID document at `/.well-known/did.jsonl`. The VTA
  mints that DID (did:webvh). Whether it can carry a label (for example a service entry
  or `alsoKnownAs`) without breaking how other projects resolve it is still open.
