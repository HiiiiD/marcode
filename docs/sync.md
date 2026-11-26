# Device sync

Marcode can sync between your machines through a server **you** run. The server stores only
encrypted data: it never sees a transcript, a digest, a key or a pairing secret.

This release covers the server, pairing and device management. Syncing memory and sessions
builds on it in the following releases.

## Run the server

Pick one:

```sh
marcode sync-server --data ~/marcode-sync --port 8787            # the marcode binary
node dist/sync-server.js --data ~/marcode-sync --port 8787       # after `yarn run compile`
docker build -f Dockerfile.sync-server -t marcode-sync .         # after `yarn run compile`
docker run -d -p 8787:8787 -v marcode-sync:/data marcode-sync
```

It listens on `127.0.0.1` by default; pass `--host 0.0.0.0` to accept other machines.

**Put HTTPS in front of it.** The server speaks plain HTTP. Clients refuse `http://` except on
loopback, LAN (`10/8`, `172.16/12`, `192.168/16`), Tailscale (`100.64/10`) and `*.local` addresses.
Caddy (`reverse_proxy 127.0.0.1:8787`) or `tailscale serve` are the easy ways.

While no device is enrolled, every start prints a one-time **bootstrap code** (`MRB-…`).

## Pair your machines

```sh
marcode sync setup https://sync.example.com MRB-XXXXXX-…   # first device; creates the encryption key
marcode sync pair                                           # on a paired device: prints a join command
marcode sync join https://sync.example.com MRC-XXXXXX-…    # on the new device
```

A pairing code works once and expires after 15 minutes. It carries the secret that unlocks the
encryption keys, so send it over something you trust. The server only ever sees its first part.

Pass `--name <name>` to `setup` or `join` to name the device; the default is the hostname.

## What syncs

Your **memory**: once you close a session (the pane's X, or unchecking it in the roster), its digest,
its searchable text and the start of its transcript are uploaded, encrypted. Every other paired
machine imports them, and recall and priming in any clone or worktree of the **same repository**
find them, even while the machine they came from is switched off. Reopening or deleting a session
withdraws it everywhere.

What does not sync: sessions in a repository without a git remote, repositories marked "Keep
separate", and project ids listed in `sync.excludeProjects`. Sessions you closed before pairing
upload the first time each workspace is opened afterwards.

One host per machine does the uploading and downloading (a lease in `~/.marcode/sync/`); if that
window or daemon exits, another takes over within half a minute. Work done while offline waits in
`~/.marcode/sync/state.sqlite` and goes up when the server is back.

## From the panel

Everything above also works from the sidebar and the TUI: run **Marcode: Set up sync** from the
Command Palette, or type `/sync` in a composer. The dialog joins a server with a pairing code (or sets
up a new one), lists your devices with Revoke, shows a pairing code with a live expiry when you add a
device, and lets you choose per repository whether its memory is shared with your other checkouts.

Nothing about sync shows while it is healthy. When the server cannot be reached, or this device was
removed on another one, a small "Sync offline" / "Sync: device removed" note appears under the usage
strip; it opens the dialog.

## Manage devices

```sh
marcode sync devices          # name, id, last seen, which one is this device
marcode sync revoke <id>      # a unique prefix of the id is enough
marcode sync status
marcode sync leave            # remove this device
```

Revoking a device (or leaving) rotates the encryption key: records written afterwards use a key
the removed device never had. What it already downloaded stays with it.

## What the server can and cannot do

It cannot read anything: records, keys and pairing secrets are encrypted on your devices. It also
cannot slip itself in: devices only hand keys to device entries another device vouched for, and
only accept a new key that was signed with the previous one. Since the server is yours, it is still
trusted to keep and order the data; a server that withholds or drops records is not detected.

## What is stored where

| Where | What |
|---|---|
| `~/.marcode/config.json` | `sync.server`, `sync.deviceName` |
| `~/.marcode/sync/credentials.json` (0600) | device id, token, device key pair, every encryption key epoch |
| the server's `--data` directory | device names, token hashes, public keys, sealed keys, encrypted records |
