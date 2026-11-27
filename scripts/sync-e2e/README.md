# Device sync in Docker

Two "devices" and a sync server in containers, each device a real host (`createHost`, the fake provider) with its own
disk, its own `~/.marcode` and its own git checkout, on a private 10.77.0.0/24 network.

```
yarn run compile                      # builds dist/sync-server.js for the server image
node scripts/sync-e2e/run.mjs         # builds the driver, starts the containers, runs every scenario, tears down
node scripts/sync-e2e/run.mjs --keep  # leaves the containers up afterwards (desk :17001, laptop :17002, server :18787)
```

Scenarios: pairing with a bootstrap and a pairing code; another device's session listed read-only and followed live;
memory recall across devices; a move; a take over after the owner died with unsent work, and the owner's fork of that
work when it comes back; a delete reaching the other device. About 75 s, most of it the 1-minute take-over threshold.

Not covered: Windows paths, a native agent thread (the fake provider has none, so a move always restarts from the
transcript), and the clients themselves (VS Code, the TUI, the daemon socket).
