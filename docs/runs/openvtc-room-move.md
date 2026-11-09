# Run: move an OpenVTC data room from host A to host B

Step `d668749070c432de0e4f3ce8b4d786cd6bcd3b752ea02bfa9628ecda328b113a`.

This is a runbook, not a result. The room's builder runs inside this repository
only. It has no host and no domain to serve a `did:webvh` log from, so it could
not run the step itself. Whoever runs the two hosts can follow this and post what
it prints as the run's evidence.

All references are to OpenVTC's public
[`docs/02-vta/data-rooms.md`](https://github.com/OpenVTC/verifiable-trust-infrastructure/blob/main/docs/02-vta/data-rooms.md).

## What is needed

- Two room hosts, A and B: two `room-host` processes (§8.1) or two VTCs (§8.2),
  each with its own DID and URL. They can be throwaway.
- A `did:webvh` server that can publish an update to the room's DID (§5.1).
  `did:peer` won't do: its controller and service entry can't change.
- An owner VTA and at least one member VTA, each with `pnm`.

## Steps

1. **Mint the room's DID** with the `room` template, its service entry pointing
   at host A (§5.1). Keep the `DID:` and `Signing key:` it prints.
2. **Register the room on host A** with `rooms/create/0.2`, `attributed` (§5.2).
3. **Issue the owner's credentials** (§5.3), form the MLS group (§5.4), and
   **add one member** (§6). Write two records, one from the owner and one from
   the member. Note the room epoch.
4. **Bring the room up on host B**: register the same `roomId` there, and carry
   the records and epoch chain across (or have B mirror A and then become the
   primary, §2 "Read mirrors").
5. **Move it**: publish a `did:webvh` update to the room's DID that replaces the
   service entry for host A with host B's. Nothing else in the DID changes.
6. **Check membership survived**: with the credentials from step 3, unchanged,
   the member reads both records from host B and writes a third. No
   `issue-membership` or `issue-authority` runs after step 3.
7. **Erase at host A**: as `admin`, send `rooms/epoch/prune/0.2` to host A
   with `--before-epoch` one above the current epoch (§10.4):

   ```sh
   pnm rooms prune --room <room-did> --host <host-A-url> --host-did <host-A-did> \
                   --before-epoch <current+1> --reason "moved to host B"
   ```

   If host A refuses with `notAhead`, the epoch has to advance first
   (`pnm rooms owner group-renew`, §10.1), and then the prune is sent again.
8. **Host A's operator shows it**: the audited `room.epoch.prune` entry, and a
   `rooms/epoch/chain/0.2` response from host A whose epoch floor covers every
   epoch and serves no rungs.

## Evidence to post (what "done" means)

- The room's DID log before and after step 5. The resolved DID document shows
  host B's service entry.
- The member's read and write on host B (step 6), with the credential ids
  showing they were issued before the move.
- Host A's audit line and its chain response (step 8).

Per the map's rules, a side records the run. Here that's OpenVTC, or whoever
ran the hosts. Anyone else's report stays "reported" until a side confirms it.

## What this does not show

- Pruning erases the **epoch key chain** at host A, not the records. Host A
  still holds the ciphertext until record retention removes it (§10.4,
  `rooms/records/prune/0.2`). If the step should also show "A holds no records",
  run `rooms/records/prune` on A as well, and say so.
- Nothing a member has already read is recalled.
