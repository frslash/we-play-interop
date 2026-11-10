// What the room's own DID says right now, and the identity the room answers as. The room reads its DID log (the
// one /.well-known/did.jsonl serves) and keeps what it found for half a minute, so a busy page is one read, not
// many. The Trust Task door and the community read it for which DID to answer as (its did:webvh once that
// document carries the room's key, else its did:key) and whether the document names the door. Mounted as
// ctx.join, the name door.js reads. Holds nothing a person said; in memory only.
import { roomDidStatus } from './roomdid.js'

const STATUS_MS = 30_000 // how long a read of the room's DID log is trusted before it is read again: a log is read from disk and verified, so not on every request

export class RoomDidWatch {
  /** identity: the room's did:key identity (did, seed, verificationMethod). config: dataDir, didLogFile. */
  constructor ({ identity, config, now = Date.now }) {
    Object.assign(this, { identity, config, now })
    this.status = { did: null, trustTasks: null, roomKey: null, document: null, at: -Infinity }
    this.room = this.#as(identity.did)
  }

  #as (did) { return { did, seed: this.identity.seed, verificationMethod: did === this.identity.did ? this.identity.verificationMethod : `${did}#room` } }

  /** The DID the room speaks as: its did:webvh when it has a log, else its did:key. */
  get did () { return this.room.did }

  /** Re-reads the room's DID log at most every 30 s; a new DID (first mint) changes who the room speaks as. */
  async refresh (force = false) {
    if (!force && this.now() - this.status.at < STATUS_MS) return this.status
    const s = await roomDidStatus({ dataDir: this.config.dataDir, file: this.config.didLogFile })
    this.status = { ...s, at: this.now() }
    const did = s.did ?? this.identity.did
    if (did !== this.room.did) this.room = this.#as(did)
    return this.status
  }
}
