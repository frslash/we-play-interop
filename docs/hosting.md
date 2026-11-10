# Running the room on one server

For whoever hosts the room. One Linux server runs the room and Caddy, which fetches and renews the https certificate. Members' data is encrypted on the wire (https) and on the disk (an encrypted volume). You, the host, can read it: nothing here hides it from you.

Names used below are placeholders: `inwove.example` is your room's public name, `OLD-ROOM` is the address of the room you are moving from. Replace them. The commands assume you are logged in to the server as `root` (Hetzner's default with an SSH key). Lines that start with `#` are comments, not commands.

## 1. The server and the name

1. In the Hetzner Cloud console, create a server: Ubuntu 26.04, any type with 2 vCPU and 4 GB of memory, your SSH key added, no backups add-on needed (section 6 does its own).
2. Create a **Volume** of 10 GB (the smallest) in the same location and attach it to the server. When asked, choose **not** to format or mount it: section 2 does that, encrypted.
3. Create a **Firewall** that allows inbound TCP 22, 80 and 443 and nothing else, and apply it to the server; the section "Locking the server down" narrows port 22 before real people join. (Docker's published ports go around the server's own `ufw`, so the firewall is Hetzner's, not `ufw`.)
4. In Cloudflare, add an `A` record for `inwove.example` pointing at the server's IPv4 address (and an `AAAA` record for its IPv6 address). Set **Proxy status: DNS only** (the grey cloud). Caddy ends https itself; see "Never" at the end for why.
5. Log in and bring the system up to date:

```bash
ssh root@inwove.example
apt-get update && apt-get -y upgrade && apt-get -y install git
```

## 2. An encrypted disk for the room's data

The volume is encrypted with LUKS. Docker's whole data folder (images, the room's volume, container logs) is then kept on it.

```bash
apt-get -y install cryptsetup
VOL=$(ls /dev/disk/by-id/scsi-0HC_Volume_* | head -n 1); echo "$VOL"   # must print exactly one device
openssl rand -base64 33                                                  # a passphrase: put it in your password manager now
cryptsetup luksFormat --type luks2 "$VOL"                                # type YES, then paste the passphrase twice
cryptsetup open "$VOL" roomdata
mkfs.ext4 -L roomdata /dev/mapper/roomdata
mkdir -p /mnt/roomdata
chattr +i /mnt/roomdata                                                  # nothing can be written here while the disk is not mounted
mount /dev/mapper/roomdata /mnt/roomdata
cryptsetup luksHeaderBackup "$VOL" --header-backup-file /root/roomdata-luks-header.img
```

LUKS protects the disk **at rest only**: when the volume is detached, copied or thrown away on its own. While the server runs and the disk is unlocked, anyone who is logged in to the server can read it. The passphrase is never on the server, never with the provider (Hetzner), and never in the repository.

Copy `/root/roomdata-luks-header.img` to your own computer (`scp root@inwove.example:/root/roomdata-luks-header.img .`), keep it with the passphrase, and delete it from the server. Without the passphrase, the volume cannot be read by anyone, you included.

**Where the unlock key is kept, and what happens on a reboot.** The passphrase lives in your password manager (and a second copy somewhere your people can reach), never on the server. So after every reboot the room stays down until a person logs in and runs one command, `room-unlock`, which asks for the passphrase, mounts the disk and starts Docker (the room and Caddy then start by themselves). Make that command now:

```bash
cat > /usr/local/sbin/room-unlock <<'EOF'
#!/bin/sh
set -eu
VOL=$(ls /dev/disk/by-id/scsi-0HC_Volume_* | head -n 1)
[ -e /dev/mapper/roomdata ] || cryptsetup open "$VOL" roomdata
mountpoint -q /mnt/roomdata || mount /dev/mapper/roomdata /mnt/roomdata
systemctl start docker
echo "The room's disk is unlocked and Docker is running."
EOF
chmod 700 /usr/local/sbin/room-unlock
```

If you would rather the server come back alone after a reboot, you can put the passphrase in a file on the server and unlock from `/etc/crypttab`. Then the volume is protected if it is detached, copied or thrown away on its own, but not from someone who holds the whole server, and the key sits on a disk that is not encrypted. That trade is yours to make; this guide does not set it up.

## 3. Docker and the room

Docker's own repository (the commands are from Docker's Ubuntu install page; if `apt-get update` says it has no release file for this Ubuntu version, read that page for the current instructions):

```bash
apt-get -y install ca-certificates curl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
tee /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Signed-By: /etc/apt/keyrings/docker.asc
EOF
apt-get update
apt-get -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

Put Docker's data on the encrypted disk, and stop it starting before the disk is unlocked:

```bash
systemctl stop docker.service docker.socket
rm -rf /var/lib/docker                       # nothing is in it yet
mkdir -p /mnt/roomdata/docker
echo '{ "data-root": "/mnt/roomdata/docker" }' > /etc/docker/daemon.json
systemctl disable docker.service docker.socket
systemctl start docker
docker info | grep "Docker Root Dir"         # must say /mnt/roomdata/docker
```

Copy the room's repository and write its settings:

```bash
git clone https://github.com/Project-Weave-Tech/we-play-interop.git /srv/inwove
cd /srv/inwove
cp .env.example .env && chmod 600 .env
sed -i "s|^PUBLIC_HOST=.*|PUBLIC_HOST=inwove.example|" .env
sed -i "s|^WORKSPACE_KEY=.*|WORKSPACE_KEY=$(openssl rand -hex 32)|" .env
grep '^WORKSPACE_KEY=' .env                  # copy this line into your password manager: it is the room's signing key, for the life of its record
nano .env                                    # fill in the rest (below), save
```

In `.env`, besides those two: `ANTHROPIC_API_KEY` (or `LLM_API_KEY`), the model account the weaver uses; `GITHUB_TOKEN` if the room may act on GitHub (leave empty otherwise); `GITHUB_OAUTH_CLIENT_ID` and `GITHUB_OAUTH_CLIENT_SECRET` so members can add agents (section 3a); `ROOM_DID_UPDATE_KEY` (section 8). Every setting has a comment in the file. Leave `PUBLIC_URL` empty: the compose file sets it from `PUBLIC_HOST`. `.env` holds secrets: it is never committed and never put in chat, email or a shared drive.

If you are **moving an existing record**, do section 7 now, before the first start. Otherwise:

```bash
cd /srv/inwove
docker compose up -d --build
```

Updating later: `cd /srv/inwove && git pull && docker compose up -d --build`. The room's data stays in its volume.

## 3a. Linking GitHub (so people can add agents)

An agent can join InWove only for GitHub repositories its person works on, so each member links their GitHub once. That needs a GitHub OAuth App that you, the host, create. Without one the room says plainly, on its Add an agent screen, that this server has not set up linking, and nobody can add an agent.

1. On GitHub, signed in as the account or organisation that runs the room: **Settings → Developer settings → OAuth Apps → New OAuth App** (for an organisation: the organisation's Settings → Developer settings → OAuth Apps).
2. Fill it in:
   - **Application name**: the room's name, for example `InWove`.
   - **Homepage URL**: `https://<your host>`.
   - **Authorization callback URL**: `https://<your host>/api/github/callback` (exactly this, with your real host, the same address as `PUBLIC_HOST`).
3. Register it, then **Generate a new client secret**. GitHub shows the secret once.
4. Put the two values in `.env` and restart the room:

```
GITHUB_OAUTH_CLIENT_ID=<the Client ID>
GITHUB_OAUTH_CLIENT_SECRET=<the client secret>
```

The room asks GitHub for the `read:user` scope only: who the person is and their public repositories. It never sees a password and never reads a private repository. It does not keep the token GitHub hands it: the token is used for two reads and discarded, and nothing in the database, the log or the room's own log lines holds it. What it keeps is the GitHub login and the repository names a person chooses to link, which members can see. A person can add a private repository by typing its name; the room marks those "you said", not verified. The client secret is a secret like `WORKSPACE_KEY`: only in `.env`, never in chat or a shared drive. At start the room prints one line saying linking is off when either value is missing.

## 4. Check it works

```bash
cd /srv/inwove
docker compose ps                             # room: healthy, caddy: running
curl -fsS https://inwove.example/healthz      # {"ok":true,"db":"pglite","entries":...}
curl -sSI https://inwove.example | head -n 1  # HTTP/2 200
docker compose logs caddy | tail -n 20        # the first start gets its certificate; this can take a minute
```

And from **another computer**, check the room's own port is not reachable (this must fail, by refusing or timing out):

```bash
curl -sS --max-time 5 http://inwove.example:3000/healthz
```

## 5. What is on the disk

Everything the room writes is in one Docker volume, `inwove_room-data`, mounted at `/data` in the room: its record (embedded Postgres, in `/data/pg`), its DID log (`/data/did.jsonl`), the update key file if the host holds one, the shelf of other projects' code, and uploads. Caddy's certificate is in `inwove_caddy-data`; losing it costs only a new certificate. Both are under `/mnt/roomdata/docker`, so both are encrypted.

## 6. Encrypted backups, and how to restore

Backups are encrypted with `age` to a **public** key, so the server can write them but never read them. The private key stays with you.

On your own computer (install `age`: `brew install age`, or `apt-get install age`):

```bash
age-keygen -o inwove-backup-key.txt     # prints "Public key: age1..."; keep this file in your password manager, off every server
```

On the server (use the `age1...` public key it printed):

```bash
apt-get -y install age
mkdir -p /etc/inwove /var/backups/inwove
echo "age1...your public key..." > /etc/inwove/backup.pub
cat > /usr/local/sbin/room-backup <<'EOF'
#!/bin/bash
# Stops the room for a few seconds so its database is copied whole, then starts it again.
set -euo pipefail
cd /srv/inwove
trap 'docker compose start room' EXIT
docker compose stop room
out=/var/backups/inwove/room-$(date -u +%Y%m%dT%H%MZ).tar.age
docker run --rm --user root --entrypoint tar -v inwove_room-data:/data:ro inwove-room -C /data -cf - . | age -R /etc/inwove/backup.pub -o "$out" || { rm -f "$out"; exit 1; }
chmod 644 "$out"
find /var/backups/inwove -name 'room-*.tar.age' -mtime +14 -delete
EOF
chmod 700 /usr/local/sbin/room-backup
echo '0 3 * * * root /usr/local/sbin/room-backup' > /etc/cron.d/inwove-backup
room-backup && ls -l /var/backups/inwove
```

That keeps 14 days on the server. A backup that sits only on the server's own disk is not a backup: pull them to your own computer or a Hetzner Storage Box regularly, for example `scp 'root@inwove.example:/var/backups/inwove/*.tar.age' ~/inwove-backups/`.

**Restore** (into the same server or a new one set up as above, through section 3). On your computer:

```bash
age -d -i inwove-backup-key.txt ~/inwove-backups/room-20261110T0300Z.tar.age | ssh root@inwove.example 'cd /srv/inwove && docker compose stop room && docker run --rm --user root --entrypoint find -v inwove_room-data:/data inwove-room /data -mindepth 1 -delete && docker run -i --rm --user root --entrypoint tar -v inwove_room-data:/data inwove-room -C /data -xf - && docker compose start room'
```

Then run the checks in section 4. Do a trial restore on a spare server once, before you need it.

The room's record can also be saved by a member: put your key in a file (see section 7) and run `docker run --rm -e WPI_MEMBER_KEY_FILE=/k -v "$PWD/member-key:/k:ro" inwove-room node agent/export-log.js https://inwove.example > room-export.json`. A member reads people-only lines too, so a member's export is the whole record (not notebooks, drafts, wake links or keys, which are not in the log). Without a key a members-only room answers every read with 401, and the tool says what to set.

## 6a. Locking the server down

Do all of this before real people join. Each step has a way to check it.

**SSH by key only.** Open a second terminal and keep it logged in while you do this, so a mistake cannot lock you out.

```bash
cat > /etc/ssh/sshd_config.d/00-inwove.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
EOF
sshd -t && systemctl reload ssh
sshd -T | grep -E '^(passwordauthentication|kbdinteractiveauthentication)'   # both must say "no"
```

From another computer, `ssh -o PubkeyAuthentication=no root@inwove.example` must now be refused.

**Firewall.** In the Hetzner console, edit the firewall from section 1 so it allows TCP 80 and 443 from anywhere, and TCP 22 **only from the owner's own address range** (the address or range their internet provider gives them; if it changes, they edit the rule). Nothing else inbound.

**Security updates by themselves.**

```bash
apt-get install -y unattended-upgrades
dpkg-reconfigure -f noninteractive unattended-upgrades
systemctl is-enabled unattended-upgrades          # must say "enabled"
```

**Two-factor sign-in on the Hetzner account.** In the Hetzner Cloud console, open the account's security settings and turn on two-factor sign-in for every person who can reach the project. Whoever holds the account can reach the server's root console, so this account is as sensitive as the server.

**Prove one restore before real people join.** A backup you have never restored is a hope. Make sure the `age` private key is held offline (on a computer or a USB stick that is not a server and is not online all day), then follow the restore steps in section 6 on a spare server, or on this one before anyone has joined. It is proved when all of these are true: the room starts from the restored data, `docker compose ps` shows it healthy, `curl -fsS https://inwove.example/healthz` answers, `verify-log.js` (section 7) reports `"ok": true` with the same head as before the backup, and a member can sign in with their passkey. Write down the date and who did it.

## 6b. What a passkey cannot show

Most passkeys sync between a person's own devices (through their phone or computer maker's account) and report a signature counter of 0 on every sign-in. The room checks the counter when an authenticator really keeps one, and refuses a counter that goes backwards. For a synced passkey it cannot do that, so the room **cannot detect a copied passkey**. The room accepts this. A person who loses a device removes that device's passkey themselves: **You → Passkeys → Remove**. Tell members this when they join.

## 7. Moving the record from the old room

Both rooms are members-only, so every read of a room's log needs a member's session. The tools sign in with a member's own key, taken from `WPI_MEMBER_KEY_FILE` (a file holding the key: 64 hex characters) or `WPI_MEMBER_KEY`, never from a command-line argument, which would show in the process list and the shell's history. They never print or write the key. The same person must be a member of **both** rooms (the same key is a member's key in each; if you are new to the new room, the new room's owner invites you the usual way before the check below).

A member sees people-only lines, so an export made with a member's key is the whole record. Without a key you cannot export a members-only room at all. Whoever exports holds every people-only line: keep the file private and delete it when the move is done.

The existing commands, as `HANDOVER.md` has them, run inside the room's own image. Do this before the first start, with the room's data volume empty. (To rehearse, use another name in `PUBLIC_HOST`, then throw the rehearsal away with `docker compose down -v`: that deletes the volume.)

First the key file, made so only you can read it, and deleted when you are finished (paste your key, then press Ctrl-D):

```bash
cd /srv/inwove
(umask 077; cat > member-key)            # your 64-hex key, then Ctrl-D
```

Then the export, the empty volume and the import:

```bash
docker compose up --no-start --build         # builds the image and makes the empty volume; starts nothing
docker run --rm -e WPI_MEMBER_KEY_FILE=/k -v "$PWD/member-key:/k:ro" inwove-room node agent/export-log.js https://OLD-ROOM > room-export.json
docker run --rm -v "$PWD/room-export.json:/in/room-export.json:ro" -v inwove_room-data:/data inwove-room node agent/import-log.js /in/room-export.json /data
```

The export prints `exported N entries, head SEQ HASH` on stderr; keep that line. The import refuses unless the whole chain verifies and the head matches. To keep the room's DID, also put its public log in the volume now (copy `did.jsonl` from the old room's data folder to this server's `/root/did.jsonl` first). If there is none, the room makes a rehearsal DID on its first start.

```bash
docker run --rm -v /root/did.jsonl:/in/did.jsonl:ro -v inwove_room-data:/data inwove-room sh -c 'cp /in/did.jsonl /data/did.jsonl && chmod 600 /data/did.jsonl'
docker compose up -d
docker run --rm -e WPI_MEMBER_KEY_FILE=/k -v "$PWD/member-key:/k:ro" inwove-room node agent/verify-log.js https://inwove.example
docker run --rm -e WPI_MEMBER_KEY_FILE=/k -v "$PWD/member-key:/k:ro" inwove-room node agent/verify-log.js https://OLD-ROOM
```

In the two reports, `"ok"` must be `true` and `"head"` (its `seq` and `hash`) the same. That is the proof the new room holds the same record, line for line. If you cannot sign in to the new room yet, the weaker check is the open `/healthz`: `curl -s https://inwove.example/healthz` shows `entries`, which must equal the export's `N` (and, if the old room has had no new lines since, `curl -s https://OLD-ROOM/healthz` shows the same). It proves the count only, not that the lines are the same; the import has already checked the chain and head, so use it only as a second look, and run the two `verify-log.js` checks as soon as you can sign in.

When you are done, delete what holds the key and the record:

```bash
rm -f member-key room-export.json
```

Cut over (DNS to this server, then tell the room) only after the checks pass.

## 8. The room's identity

The room's DID (`did:webvh`, at its own address, `/.well-known/did.jsonl`) can be changed only by whoever holds its **update key**. Two settings in `.env` name keys, and both hold **public** keys (`z6Mk...`):

- `ROOM_DID_UPDATE_KEY`: the key that may change the DID. Its private half must be held by the owner's people, **never on this server**.
- `ROOM_DID_NEXT_KEY`: a recovery key, kept apart from the first, committed in the log ahead of time (see the README's table). Optional.

Make a key on **your own computer** (Node 22, the repository, `npm ci`): `node agent/keygen.js`. The `WORKSPACE_KEY=` line it prints is the secret half: put it in your password manager. The text after `did:key:` in its first line is the public key for `.env`. Set it before the first start.

If `ROOM_DID_UPDATE_KEY` is empty, the room keeps a key of its own in `/data/update-key.txt` (in the volume, so in every backup) until you set it. That file is the DID's secret: the update power has to move to the new owner (how is not settled yet: see `HANDOVER.md`), and it must not sit in a shared place: not in the repository, a chat, a ticket or a shared folder.

## What the owner must never do

- **Publish the room's port.** No `ports:` on the `room` service, no `network_mode: host`. The room trusts `x-inwove-client-ip`, the header Caddy writes (the `TRUSTED_CLIENT_IP_HEADER` in `docker-compose.yml`), only because the room can be reached through Caddy alone. If the port is open, anyone can choose the address the room limits and logs them by.
- **Turn on the Cloudflare proxy (orange cloud) without changing the caller setting.** Caddy would then see Cloudflare's address for everyone, so every person would share one limit. Behind the proxy the room must read `cf-connecting-ip` instead, and Caddy must pass it on; change `TRUSTED_CLIENT_IP_HEADER` and the Caddyfile together, and only after reading `src/server/caller.js`. Cloudflare would also see everything members send, and this guide promises that only the host can read it.
- **Commit `.env`**, paste it anywhere, or put `WORKSPACE_KEY` or the DID's secret key in a shared place.
- **Let Docker start before the disk is unlocked**, or move Docker's data back to `/var/lib/docker`: the room's data would then sit on the unencrypted disk.
- **Run two copies of the room on one record.** One instance only.
