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

## Manage devices

```sh
marcode sync devices          # name, id, last seen, which one is this device
marcode sync revoke <id>      # a unique prefix of the id is enough
marcode sync status
marcode sync leave            # remove this device
```

Revoking a device (or leaving) rotates the encryption key: records written afterwards use a key
the removed device never had. What it already downloaded stays with it.

## What is stored where

| Where | What |
|---|---|
| `~/.marcode/config.json` | `sync.server`, `sync.deviceName` |
| `~/.marcode/sync/credentials.json` (0600) | device id, token, device key pair, every encryption key epoch |
| the server's `--data` directory | device names, token hashes, public keys, sealed keys, encrypted records |
