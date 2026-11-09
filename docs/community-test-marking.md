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
- **The test marking** has nothing to change yet. This repository has no `community/`
  folder: no boot script, no join page and no DID document. Those come from OpenVTC's
  `vtc-service`, and the services that would run it are still only a plan in pull
  request #45, which is blocked on who does the first setup. Anything put under
  `community/` deploys as soon as it reaches `main`, so it should not be started here.

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
