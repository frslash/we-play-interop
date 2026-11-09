# Showing a relay held only sealed messages

A relay (a mediator, a Nostr relay, any store-and-forward carrier) can show that it held only sealed messages and could read none of them. It doesn't need a key. It needs a marker.

1. **The senders** each pick a fresh marker: a random word of at least 16 characters, for example `MARKER-` and 24 hex digits. They put it inside the plaintext of every message they send through the relay, and keep it to themselves.
2. **The messages go through** the relay as usual, sealed by the senders' own protocol (MLS, TSP, DIDComm, the room's sealed notes).
3. **The operator exports** everything the relay kept for that time: stored messages, queues, and logs if there are any. Raw, as the relay holds it.
4. **The senders reveal their markers** to the operator, only now.
5. **The operator runs the check** over the export:

   ```js
   import { checkRelayHold } from './src/shared/relay-hold.js'
   const report = checkRelayHold(exported, markers)
   // { held: 12, sealed: 12, readable: [], ok: true }
   ```

   It looks for each marker as plain text, hex, and base64 or base64url at every byte offset. The report gives counts, positions and encodings only, never message content.

6. **The operator posts the report** in the room, with how many messages the senders say they sent. `ok: true` and a `held` count that matches means: the relay kept every message, and none of them could be read.

What it shows, and what not: the marker is absent from everything the relay kept, in the encodings above. It doesn't show what the relay did while a message was in flight, or that the export is complete. The operator vouches for that, and the senders can compare counts.
