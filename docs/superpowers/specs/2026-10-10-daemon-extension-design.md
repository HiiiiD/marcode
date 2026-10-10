# Daemon: the VS Code extension attaches

Phase 3 of `2026-10-09-marcode-daemon-design.md`. The core, wire protocol, `daemon-client` and the TUI
shipped; this spec covers only what the extension needs on top. Anything not mentioned here is as in
that spec.

## Goal

A window reload or close no longer stops a running turn, and the extension and the TUI share live
sessions in a workspace. If the daemon cannot be used, the extension runs today's in-process host.

## Decisions

| Question | Decision |
|---|---|
| Fallback | In-process host kept, as is `daemon.enabled = false` |
| Lease / dormant / foreign-tail / roster-sync | Untouched; removal is a separate follow-up after a soak |
| Connections | One per surface: sidebar at `activate()`; review, fleet, history when the tab opens or is restored |
| Webview contracts | Unchanged. DOM suites pass without edits |
| Stale daemon after an extension update | See [Version](#version) |

## Shape

Panels stop taking `SessionManager`, `PostBus` and a `MessageRouter`. They take a `SurfaceLink`:

```
interface SurfaceLink { transport: ClientTransport; onStatus(cb): () => void; dispose(): void }
host-connection.ts:  connect(kind: ClientKind): SurfaceLink
```

- **Daemon mode:** `connect(kind)` is `connectOrSpawn` (first call spawns, later ones attach) and wraps the
  resulting `DaemonClient`. `dispose` closes that socket only.
- **In-process mode:** `connect(kind)` builds a `MessageRouter` on the local manager, registers on the local
  `PostBus` with `wantsFor(kind)`, and returns a loopback. This is exactly what `ReviewPanel` and friends do
  today, moved behind the seam, so both modes drive the panels identically.
- `activate()` calls `connect('sidebar')` once. Its outcome decides the mode for the window; later
  `connect` calls never re-decide. A fallback shows one notice, `Running without the background host: <reason>`,
  matching the TUI.
- `deactivate()`: daemon mode closes every link; in-process mode disposes the host as today.

## Client hooks

One `VscodeHooks` object implements `EditorContextHost`, `AttachmentHost`, `FileSearch`, `ConfigHost` and
`UpdateNotifyHost` from the helpers `extension.ts` already has (`revealFile`, `openFileDiff`, `exportCsv`,
`exportImage`, `openExternal`, `openLoginTerminal`, favorites, `showOpenDialog`, the workspace file index).
In-process mode passes it to the router; daemon mode adapts it to `ClientHooks.act` / `ask`, the way `bootHost`
adapts the terminal hooks. The sidebar pushes `ctx` frames from `EditorContextTracker`; the other surfaces send
`context: () => null`.

## Gaps closed

Calls the panels make straight on the manager today, and where each goes:

| Today | Becomes |
|---|---|
| `open-file` (`canOpenFile`, then open) | The router validates with `canOpenFile` and calls `editor.reveal(path)`; the panel interception is dropped, so the check runs daemon-side in both modes |
| `open-attachment` (`attachmentPath`) | Client intercepts and uses the existing `request-attachment-path` pair, as the TUI does |
| `focus-session` (fleet and history tabs; `setVisible`, `layout`, `setLayout`) | The router implements it (`setVisible` + `placeSession` + `setLayout`); the tab then reveals the sidebar view. `focus-session.ts` moves from `host/` logic into the router |
| Pane commands (`manager.layout()`) | The sidebar link caches the last `PaneLayout` from `hydrate` and `layout-changed`; `paneCommandMessage` reads that cache |
| `marcode.memory.reindex` (`memoryStatus`, `memoryEstimate`, `memoryReindex`) | New `request-memory-status` replies with the existing `memory-status`. The command then posts `memory-estimate`, awaits the `memory-estimate` reply (absent when nothing needs a model call, in which case the router already reindexed), confirms, posts `memory-reindex`, and toasts on `memory-progress` `done` |
| `agents-md-nudge-action`, `open-review`, `open-fleet`, `open-history` | Stay client-side, intercepted before the link |

`notify.warn`, `onShellNoise` and update-available run daemon-side. Two new `ActOp`s carry them to the client:
`notify {level, text}` and `shellNoise {profile}`. The daemon sends them to sidebar connections only, so a toast
appears once per window. Warnings raised before any client is attached are written to `daemon.log` and not queued.
`updateNotify` becomes an `act notify` from the daemon-side hooks proxy. The existing per-window dedup stays in the
client.

## Spawn and bundle

- New esbuild bundle `dist/daemon.js` (node/CJS, `src/daemon/daemon-main.ts`; same externals as the host bundle).
- `spawnDetached` gains a recipe for the extension: `process.execPath` with `ELECTRON_RUN_AS_NODE=1`, args
  `[dist/daemon.js, daemon, --serve, --workspace-dir, <dir>, --root <folder>…]`, detached, log to `daemon.log`.
- The extension's `hello` carries `roots` = workspace folders and `defaultCwd` from `defaultCwdOf`. A folder change
  that does not reload the host is not tracked in this plan.
- `extension.ts` is split: `activate.ts` (wiring), `vscode-hooks.ts` (hooks above), `editor-actions.ts` (reveal, diff,
  export, open external, login terminal), `commands.ts` (command registration). `extension.ts` keeps `activate` and
  `deactivate` as thin re-exports.

## Version

`PROTOCOL_VERSION` rarely moves, but every extension release changes daemon code, so a daemon from the previous
release would keep running old code for up to `daemon.idleMinutes`, or indefinitely while a client is attached.
Add one rule to `version-policy`: with an equal protocol, a daemon whose `appVersion` is **older** (semver) than the
client's and is idle is replaced like an older-protocol one; a busy one is attached with a notice; a newer or equal
one is attached. A client never replaces a newer daemon, so a TUI and an extension on different releases settle on
the newer. Dev builds (`0.0.0-dev` or an unparsable version) never trigger replacement.

## Status in the UI

The sidebar link's `onStatus` drives a banner: `reconnecting` shows "Reconnecting to the background host…", `lost`
shows "Lost the background host; reload the window". Other surfaces show nothing of their own; their link's loss
surfaces through the sidebar's. A reconnect re-runs `hydrate`, and `DaemonClient` replays `set-visible`.

## Testing

- **Unit (mocha):** `connect()` in both modes via a fake spawn; the `open-file`, `focus-session` and
  `request-memory-status` router cases; the `notify` / `shellNoise` acts through `remote-hooks`; the app-version
  replacement rule; the spawn recipe; layout cache.
- **Integration:** in-process daemon on a real pipe with a sidebar and a review client; reload simulated by closing the
  sidebar link while a fake turn runs and checking the next link sees `running`.
- **DOM / TUI suites:** pass unchanged.
- **Manual (F5):** reload with a live turn; TUI and extension on one workspace; kill the daemon; `daemon.enabled=false`.
- **Check once, early:** the bundled daemon starts under VS Code's Electron-as-Node, including the memory store
  (`node:sqlite` with FTS5). If memory is unavailable there, the existing "memory is unavailable" notice applies and the
  plan records it.

## Invariants this adds

- Panels import neither `SessionManager` nor `MessageRouter`; they hold a `SurfaceLink`.
- `src/host/` panel files keep the `vscode` import; the router, daemon and `daemon-client` still do not.
- A window's mode is decided once, by the sidebar connect.
