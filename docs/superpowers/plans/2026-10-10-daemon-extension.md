# Daemon: the extension attaches — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The VS Code extension attaches to the per-workspace daemon, so a window reload no longer stops a running turn and the extension and TUI share live sessions; with in-process fallback.

**Architecture:** Panels stop owning a `SessionManager`/`MessageRouter` and hold a `SurfaceLink` (a `ClientTransport` + status + dispose). `host-connection.ts` hands out links: in daemon mode each is a `DaemonClient` from `connectOrSpawn`; in fallback mode each is a loopback onto a local router and `PostBus`, exactly what the panels do today. Direct manager calls the panels make become router cases. Daemon-side toasts reach the sidebar as two new `act` ops.

**Tech Stack:** TypeScript, VS Code API, Node `net` (existing daemon), esbuild, mocha (`suite`/`test`, `tsx/cjs`), React 19 + shadcn (banner only).

**Spec:** `docs/superpowers/specs/2026-10-10-daemon-extension-design.md` (builds on `2026-10-09-marcode-daemon-design.md`)

## Global Constraints

- `src/protocol/messages.ts` and `src/protocol/daemon-wire.ts` are types-only: no runtime code, no `vscode` import.
- Nothing under `src/daemon/`, `src/daemon-client/`, `src/client-core/`, `src/providers/`, `src/protocol/` imports `vscode`; neither does `src/host/message-router.ts`.
- Every protocol message addressed to a session carries an explicit `SessionId`.
- Errors are state, never exceptions: no handler may leave an unhandled rejection.
- Filenames are kebab-case. Comments minimal: only non-obvious "why". Files over ~300 lines get split.
- Webview UI uses shadcn components (`@/components/ui/*`), classNames composed with `cn` from `@/lib/utils`; no raw `<button>`/`<input>`.
- Every change under `src/webview/components/` is checked with `node <impeccable-skill-dir>/scripts/detect.mjs --json <changed files>`; exit 0 required.
- DOM tests drive components through the real `StoreProvider` with `sendFromHost`; never mock `useStore`; never hand a DOM node to `assert`.
- Conventional-commit prefixes. No `Co-Authored-By` or any Claude/Anthropic trailer on commits.
- `yarn lint`, `yarn check-types` and `yarn run compile` must pass before each commit that touches `src/`. Use guarded `yarn test:unit` / `yarn test:dom` (never the `:raw` variants). A single unit file: `npx mocha --ui tdd --require tsx/cjs <file>`.
- Defaults unchanged: `daemon.enabled = true`, `daemon.idleMinutes = 10`, `PROTOCOL_VERSION` unchanged by this plan.
- Windows: write files containing backslashes with the Write/Edit tools, not heredocs. Pin every command with its own `cd /e/Efebia/hiiiid-code &&` — the shell cwd can revert.
- Work on a branch `feat/daemon-extension` off master (spec and plan are already committed on master).

## Review Focus

1. Two windows (or a window and the TUI) on one workspace: each surface's `set-visible` must not hide the other's panes (union, existing) and a reload must not drop the sidebar's panes (Task 10 replays; Task 12 integration).
2. Review/fleet/history tab opened or restored while the daemon is dead or mid-respawn: the tab must show something sane, not throw (Task 9 test: `connect` after daemon loss returns a link whose status goes `lost`, or falls back — never rejects).
3. Reload while a turn is running: deactivate must close sockets and **not** dispose the host in daemon mode (Task 9, Task 11).
4. Daemon warnings emitted before any client attaches must not crash or queue unbounded (Task 4 test).
5. Same-protocol daemon from the previous release: idle → replaced, busy → attached with a notice, dev version → left alone (Task 5).

---

## File structure

| File | Responsibility |
|---|---|
| `src/host/message-router.ts` (modify) | `open-file` validated + revealed; `focus-session` placement; `request-memory-status` |
| `src/host/focus-session.ts` (rewrite, no `vscode`) | `focusSession(manager, id)`: placement only |
| `src/protocol/messages.ts`, `src/protocol/daemon-wire.ts` (modify) | `request-memory-status`, `host-link`; `notify`, `shellNoise` acts |
| `src/daemon/connection.ts`, `daemon-server.ts`, `remote-hooks.ts`, `run-daemon.ts` (modify) | Act broadcast to sidebar connections; `updateNotify` proxy |
| `src/daemon-client/version-policy.ts`, `connect-or-spawn.ts` (modify) | App-version replacement rule |
| `src/daemon-client/spawn-daemon.ts` (modify) | Extension spawn recipe |
| `esbuild.js`, `package.json`, `.vscodeignore` (modify) | `dist/daemon.js` |
| `src/host/surface-link.ts` (new) | `SurfaceLink`, `HostConnection` types |
| `src/host/host-connection.ts` (new) | `openHostConnection`: daemon-or-in-process, link factory |
| `src/host/in-process-link.ts` (new) | Router + bus loopback link (today's panel wiring) |
| `src/host/vscode-hooks.ts` (new) | `VscodeHooks` + act/ask adapters |
| `src/host/editor-actions.ts` (new) | `revealFile`, `openFileDiff`, `openLoginTerminal`, `openExternal`, `exportCsv`, `exportImage` moved out of `extension.ts` |
| `src/host/commands.ts` (new) | Command registration (pane, memory, login, config, wizard, surfaces) |
| `src/host/panel-view-provider.ts`, `review-panel.ts`, `fleet-panel.ts`, `history-panel.ts` (modify) | Take a `SurfaceLink` source |
| `src/webview/components/host-link-banner.tsx` (new), `src/client-core/reducer.ts`, `src/webview/app.tsx` (modify) | Reconnect banner |
| `src/extension.ts` (shrink) | `activate`/`deactivate` wiring |

---

### Task 1: Router validates and reveals `open-file`

**Files:**
- Modify: `src/host/message-router.ts:611-613`
- Test: `src/test/unit/message-router.test.ts`

**Interfaces:**
- Produces: router `open-file {id, path}` → if `manager.canOpenFile(id, path)` then `editor.reveal(path)`; else logged and dropped.

- [ ] **Step 1: Write the failing test** (append inside the `suite('MessageRouter'` block; reuse its `setup`)

```ts
  test('open-file reveals a path the session reported and refuses any other', async () => {
    const revealed: string[] = [];
    const r = new MessageRouter(manager, (m) => sent.push(m), '/tmp', {
      ...NO_EDITOR_FOR_TEST, reveal: (p: string) => { revealed.push(p); },
    }, attachments);
    const id = (await manager.create({ providerId: 'fake', cwd: '/tmp' } as never)).id;
    (manager as unknown as { canOpenFile: (i: string, p: string) => boolean }).canOpenFile =
      (i, p) => i === id && p === '/mem/a.md';
    await r.handle({ t: 'open-file', id, path: '/mem/a.md' });
    await r.handle({ t: 'open-file', id, path: '/etc/passwd' });
    assert.deepStrictEqual(revealed, ['/mem/a.md']);
  });
```

Add near the top of the file: `const NO_EDITOR_FOR_TEST = { current: () => null, reveal: () => {}, openDiff: () => {}, openSettings: () => {}, openExternal: () => {}, exportCsv: () => {}, exportImage: () => {}, login: () => {} };`. If `manager.create`'s signature differs, copy the call used by the nearest existing test that creates a session.

- [ ] **Step 2: Run** `cd /e/Efebia/hiiiid-code && npx mocha --ui tdd --require tsx/cjs src/test/unit/message-router.test.ts -g "open-file"` — Expected: FAIL (`revealed` is `[]`).

- [ ] **Step 3: Implement.** Replace the `open-file` case and its comment block in `route()`:

```ts
      case 'open-file':
        if (!this.manager.canOpenFile(msg.id, msg.path)) {
          console.error('[mar-code] refusing to open a path this session never reported', msg.path);
          return;
        }
        this.editor.reveal(msg.path);
        return;
```

- [ ] **Step 4: Run** the same command. Expected: PASS. Run the whole file: `npx mocha --ui tdd --require tsx/cjs src/test/unit/message-router.test.ts` — all PASS.

- [ ] **Step 5: Commit** `git add src/host/message-router.ts src/test/unit/message-router.test.ts && git commit -m "feat: router validates and reveals open-file"`

(The panel interception of `open-file` is removed in Task 10; until then the panel still short-circuits, so nothing double-opens.)

---

### Task 2: Router implements `focus-session` placement

**Files:**
- Rewrite: `src/host/focus-session.ts` (drop `vscode`)
- Modify: `src/host/message-router.ts` (`focus-session` case)
- Test: `src/test/unit/message-router.test.ts`, existing `src/test/unit/history-router.test.ts` stays green

**Interfaces:**
- Produces: `focusSession(manager: SessionManager, id: SessionId): Promise<void>` — adds `id` to the visible set and layout if absent; no VS Code calls. Router `focus-session {id}` calls it. The client (Task 10) then reveals the sidebar.

- [ ] **Step 1: Write the failing test**

```ts
  test('focus-session adds a hidden session to the split', async () => {
    const a = (await manager.create({ providerId: 'fake', cwd: '/tmp' } as never)).id;
    await manager.setVisible([]);
    await router.handle({ t: 'focus-session', id: a });
    assert.strictEqual(leafSessionIds(manager.layout().root).includes(a), true);
    assert.strictEqual(manager.visibleIds().includes(a), true);
  });
```

- [ ] **Step 2: Run** with `-g "focus-session"`. Expected: FAIL.

- [ ] **Step 3: Implement.** `src/host/focus-session.ts`:

```ts
import type { SessionManager } from './session-manager';
import type { SessionId } from '../protocol/messages';
import { leafSessionIds, placeSession, rootOrientation } from '../webview/components/layout-tree';

/** Adds a session to the split if absent. Revealing the sidebar is the client's job. */
export async function focusSession(manager: SessionManager, id: SessionId): Promise<void> {
  const ids = leafSessionIds(manager.layout().root);
  if (ids.includes(id)) { return; }
  await manager.setVisible([...ids, id]);
  const { root, focusedSessionId } = manager.layout();
  manager.setLayout({ ...manager.layout(), root: placeSession(root, id, focusedSessionId, rootOrientation(root)) });
}
```

In `message-router.ts` import it (`import { focusSession } from './focus-session';`) and replace the `focus-session` case (and its comment) with:

```ts
      case 'focus-session':
        await focusSession(this.manager, msg.id);
        return;
```

`FleetPanel`/`HistoryPanel` still import `focusSession` and `vscode.commands`; fix their callers in Task 10 — for now keep them compiling by changing their call to `await focusSession(this.manager, raw.id); await vscode.commands.executeCommand('workbench.view.extension.mar-code');` (add the `vscode` import there).

- [ ] **Step 4: Run** the message-router, history-router and fleet-diff-router unit files. Expected: PASS. `yarn check-types` passes.

- [ ] **Step 5: Commit** `git commit -am "feat: router owns focus-session placement"`

---

### Task 3: `request-memory-status`

**Files:**
- Modify: `src/protocol/messages.ts` (add to `WebviewToHost`, near `memory-estimate` ~line 508), `src/host/message-router.ts` (case + `KNOWN_MESSAGE_TAGS` at ~770)
- Test: `src/test/unit/message-router.test.ts`

**Interfaces:**
- Produces: `{ t: 'request-memory-status' }` (WebviewToHost) answered with the existing `{ t: 'memory-status'; enabled; llm }`.

- [ ] **Step 1: Write the failing test**

```ts
  test('request-memory-status answers memory-status', async () => {
    await router.handle({ t: 'request-memory-status' });
    const s = sent.find((m) => m.t === 'memory-status') as Extract<HostToWebview, { t: 'memory-status' }>;
    assert.strictEqual(typeof s.enabled, 'boolean');
  });
```

- [ ] **Step 2: Run** `-g "request-memory-status"`. Expected: FAIL (type error / malformed drop).

- [ ] **Step 3: Implement.** Add `| { t: 'request-memory-status' }` to `WebviewToHost`; add `'request-memory-status'` to `KNOWN_MESSAGE_TAGS`; add the case:

```ts
      case 'request-memory-status':
        this.emit({ t: 'memory-status', ...this.manager.memoryStatus() });
        return;
```

- [ ] **Step 4: Run** the file. PASS. `yarn check-types` passes (TUI exhaustive switches, if any, may need a no-op arm — add it).

- [ ] **Step 5: Commit** `git commit -am "feat: request-memory-status message"`

---

### Task 4: `notify` / `shellNoise` acts, sidebar-only broadcast, `updateNotify` proxy

**Files:**
- Modify: `src/protocol/daemon-wire.ts` (`ActOp`), `src/daemon/connection.ts`, `src/daemon/daemon-server.ts`, `src/daemon/remote-hooks.ts`, `src/daemon/run-daemon.ts`, `src/host/create-host.ts` (nothing if `onShellNoise` already optional — it is)
- Test: `src/test/unit/daemon-remote-hooks.test.ts`, `src/test/unit/daemon-server.test.ts`, `src/test/unit/daemon-run.test.ts`

**Interfaces:**
- Produces:
  - `ActOp` gains `'notify'` (args `[level: 'info' | 'warn', text: string]`) and `'shellNoise'` (args `[profile: string]`).
  - `DaemonConnection.act(op: ActOp, args: unknown[]): void` (no-op when closed or not yet hello'd).
  - `DaemonServer.broadcastAct(kind: ClientKind, op: ActOp, args: unknown[]): void` — to every attached connection of that kind; nothing attached is not an error.
  - `createRemoteHooks(io)` returns `updateNotify: UpdateNotifyHost` (`notify` → `io.act('notify', ['info', `${displayName} ${current} → ${latest} available.`])`).
  - `runDaemon`: router gets `updateNotify` only when `hello.clientKind === 'sidebar'`; `notify.warn` logs and `broadcastAct('sidebar','notify',['warn',m])`; `onShellNoise` → `broadcastAct('sidebar','shellNoise',[profile])`.

- [ ] **Step 1: Write the failing tests**

`daemon-remote-hooks.test.ts`:

```ts
  test('updateNotify becomes a notify act', () => {
    const acts: [string, unknown[]][] = [];
    const h = createRemoteHooks({ act: (op, args) => { acts.push([op, args]); }, ask: async () => undefined });
    h.updateNotify.notify('Claude', '1.0', '1.1');
    assert.deepStrictEqual(acts, [['notify', ['info', 'Claude 1.0 → 1.1 available.']]]);
  });
```

`daemon-server.test.ts` (uses the file's `client`/`HELLO`/`until` helpers):

```ts
  test('broadcastAct reaches only attached clients of that kind, and is a no-op with none', async () => {
    server.broadcastAct('sidebar', 'notify', ['warn', 'early']);
    const sidebar = await client(endpoint);
    const review = await client(endpoint);
    sidebar.send(HELLO('sidebar', ['/a']));
    review.send(HELLO('review', ['/a']));
    await until(() => sidebar.frames.length > 0 && review.frames.length > 0);
    server.broadcastAct('sidebar', 'notify', ['warn', 'hi']);
    await until(() => sidebar.frames.some((f) => f.f === 'act'));
    assert.deepStrictEqual(sidebar.frames.filter((f) => f.f === 'act').map((f) => [f.op, f.args]), [['notify', ['warn', 'hi']]]);
    assert.strictEqual(review.frames.some((f) => f.f === 'act'), false);
    sidebar.sock.destroy(); review.sock.destroy();
  });
```

`daemon-run.test.ts`: add a test that attaches a client with `clientKind: 'sidebar'` (copy the existing `hello(info)` helper and override `clientKind`), then calls the `host` captured via `onHost` ... the `notify.warn` path is only reachable through `createHost`; assert instead through the exported option: add `onNotifier?: (n: { warn(m: string): void; shellNoise(p: string): void }) => void` to `RunDaemonOptions` as a test seam, invoke `warn('boom')` and expect a `notify` act frame with `['warn','boom']` on the sidebar client, and invoke `warn` before any client attaches and expect no throw.

- [ ] **Step 2: Run** the three files. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - `daemon-wire.ts`: extend `ActOp` with `| 'notify' | 'shellNoise'`.
  - `connection.ts`: `act(op: ActOp, args: unknown[]): void { if (this.hello) { this.send({ f: 'act', op, args }); } }` and a public `get kindOrUndefined` is not needed — `kind` getter exists.
  - `daemon-server.ts`:

```ts
  broadcastAct(kind: ClientKind, op: ActOp, args: unknown[]): void {
    for (const conn of this.connections) {
      if (conn.attached && conn.kind === kind) { conn.act(op, args); }
    }
  }
```
  (import `ClientKind`, `ActOp` from `../protocol/daemon-wire`).
  - `remote-hooks.ts`: add

```ts
  const updateNotify: UpdateNotifyHost = {
    notify: (name, current, latest) => io.act('notify', ['info', `${name} ${current} → ${latest} available.`]),
  };
```
  import `UpdateNotifyHost`, return it.
  - `run-daemon.ts`: `server` is assigned after `createHost`, so use `server?.broadcastAct(...)` inside closures:

```ts
  const toSidebar = (op: ActOp, args: unknown[]) => server?.broadcastAct('sidebar', op, args);
  const notifier = {
    warn: (m: string) => { log(m); toSidebar('notify', ['warn', m]); },
    shellNoise: (p: string) => toSidebar('shellNoise', [p]),
  };
  opts.onNotifier?.(notifier);
```
  pass `notify: notifier, onShellNoise: notifier.shellNoise` to `createHost`; in `makeRouter`, append to the `MessageRouter` args after the config host: `hello.clientKind === 'sidebar' ? hooks.updateNotify : undefined, false`. (The router's param order after `configHost` is `updateNotify`, `showCacheTimer`; the `undefined` default applies when omitted.)

- [ ] **Step 4: Run** the three files plus `daemon-connection.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit** `git commit -am "feat: daemon acts for notices, sidebar-only"`

---

### Task 5: Replace an idle daemon built from an older app version

**Files:**
- Modify: `src/daemon-client/version-policy.ts`, `src/daemon-client/connect-or-spawn.ts`, `src/tui/boot.ts`
- Test: `src/test/unit/daemon-client-policy.test.ts`, `src/test/unit/daemon-client-config.test.ts` (copy its harness for the connect-level test)

**Interfaces:**
- Produces: `isOlderBuild(daemon: string, mine: string): boolean` — true only when both parse as plain `x.y.z` (optional `-prerelease` makes it unparsable → false) and `daemon < mine`. `ConnectOptions.replaceOlderBuild?: boolean` (default false). First attach only (cleared on reconnect, like `configSignature`). Busy → attach, warning `STALE_BUILD_WARNING`.

- [ ] **Step 1: Write the failing tests** in `daemon-client-policy.test.ts`:

```ts
import { decideAttach, isOlderBuild } from '../../daemon-client/version-policy';

  test('isOlderBuild compares plain semver and ignores anything else', () => {
    assert.strictEqual(isOlderBuild('0.0.56', '0.0.57'), true);
    assert.strictEqual(isOlderBuild('0.0.57', '0.0.57'), false);
    assert.strictEqual(isOlderBuild('0.1.0', '0.0.57'), false);
    assert.strictEqual(isOlderBuild('0.0.0-dev', '0.0.57'), false);
    assert.strictEqual(isOlderBuild('0.0.56', 'dev'), false);
    assert.strictEqual(isOlderBuild('0.0.9', '0.0.10'), true);
  });
```

In `daemon-client-config.test.ts`, add two tests mirroring its existing "config differs: idle daemon replaced / busy daemon attached with a warning" cases but varying `appVersion` in the stored `daemon.json` and passing `identity.appVersion` newer with `replaceOlderBuild: true`; expect respectively a respawn (spawn called once) and an attach with `STALE_BUILD_WARNING` in `warnings`. Copy the arrange code from the config tests verbatim and swap the differing field.

- [ ] **Step 2: Run** both files. Expected: FAIL (missing exports).

- [ ] **Step 3: Implement.** `version-policy.ts`:

```ts
const PLAIN = /^(\d+)\.(\d+)\.(\d+)$/;

export function isOlderBuild(daemon: string, mine: string): boolean {
  const a = PLAIN.exec(daemon);
  const b = PLAIN.exec(mine);
  if (!a || !b) { return false; }
  for (let i = 1; i <= 3; i++) {
    const d = Number(a[i]) - Number(b[i]);
    if (d !== 0) { return d < 0; }
  }
  return false;
}
```

`connect-or-spawn.ts`: export `STALE_BUILD_WARNING = 'The background host is an older build and sessions are running in it; reload or restart once they finish'`; add `replaceOlderBuild?: boolean` to `ConnectOptions`; in `establish`, compute

```ts
        const oldBuild = decision === 'attach' && opts.replaceOlderBuild === true
          && isOlderBuild(info.appVersion, identity.appVersion) && !keepConfig.has(info.token);
```
and widen the replace branch: `if (decision === 'replace' || oldConfig || oldBuild)`; in the `busy` handling use `(oldConfig || oldBuild)`: `keepConfig.add(...)`, push `oldBuild && !oldConfig ? STALE_BUILD_WARNING : STALE_CONFIG_WARNING`. In `reopen`, pass `replaceOlderBuild: false` alongside `configSignature: undefined`. In `tui/boot.ts` pass `replaceOlderBuild: true` to `connectOrSpawn`.

- [ ] **Step 4: Run** the two files and `daemon-client.test.ts`. PASS.

- [ ] **Step 5: Commit** `git commit -am "feat: replace an idle daemon from an older build"`

---

### Task 6: Spawn recipe for the extension and the `dist/daemon.js` bundle

**Files:**
- Modify: `src/daemon-client/spawn-daemon.ts`, `esbuild.js`, `package.json` (scripts only if `compile` needs it), `.vscodeignore` (confirm `dist/daemon.js` is not excluded)
- Test: `src/test/unit/daemon-command.test.ts` (it covers `daemonSpawnCommand`; add cases there)

**Interfaces:**
- Produces: `daemonSpawnCommand(workspaceDir, roots, runtime?)` accepts an optional 4th arg `{ script: string; electronAsNode: true }`; `spawnDetached(workspaceDir, roots, extension?: { script: string })`. With `extension`: command `process.execPath`, args `[script, 'daemon', '--serve', '--workspace-dir', dir, ...--root r]`, env `ELECTRON_RUN_AS_NODE=1`.

- [ ] **Step 1: Write the failing test**

```ts
  test('extension recipe runs the bundled script as node and sets ELECTRON_RUN_AS_NODE', () => {
    const r = daemonSpawnCommand('/w', ['/r'], { execPath: '/code', argv1: undefined }, { script: '/x/dist/daemon.js' });
    assert.deepStrictEqual(r.args, ['/x/dist/daemon.js', 'daemon', '--serve', '--workspace-dir', '/w', '--root', '/r']);
    assert.strictEqual(r.command, '/code');
    assert.strictEqual(r.env?.ELECTRON_RUN_AS_NODE, '1');
  });
```

- [ ] **Step 2: Run** it. FAIL.

- [ ] **Step 3: Implement.** Extend the return type with `env?: Record<string, string>`:

```ts
export function daemonSpawnCommand(
  workspaceDir: string, roots: string[], runtime: Runtime = current(), extension?: { script: string },
): { command: string; args: string[]; env?: Record<string, string> } {
  const tail = ['daemon', '--serve', '--workspace-dir', workspaceDir, ...roots.flatMap((r) => ['--root', r])];
  if (extension) {
    return { command: runtime.execPath, args: [extension.script, ...tail], env: { ELECTRON_RUN_AS_NODE: '1' } };
  }
  return isBun(runtime.execPath) && runtime.argv1
    ? { command: runtime.execPath, args: [runtime.argv1, ...tail] }
    : { command: runtime.execPath, args: tail };
}
```

`spawnDetached(workspaceDir, roots, extension?)` passes `extension` through and merges `env`: `spawn(command, args, { ...daemonSpawnOptions(workspaceDir, log), ...(env ? { env: { ...process.env, ...env } } : {}) })`.

`esbuild.js`: add after `hostCtx`, reusing `common` and sharing its `external`:

```js
	const daemonCtx = await esbuild.context({
		...common,
		entryPoints: ['src/daemon/daemon-main.ts'],
		format: 'cjs',
		platform: 'node',
		outfile: 'dist/daemon.js',
		external: ['@anthropic-ai/claude-agent-sdk', 'bun:sqlite'],
		alias: { '@': require('path').resolve(__dirname, 'src/webview') },
	});
```
and include `daemonCtx` wherever the other contexts are built/watched/disposed (follow how `hostCtx` appears below in the file).

- [ ] **Step 4: Run** `npx mocha --ui tdd --require tsx/cjs src/test/unit/daemon-command.test.ts` — PASS. Run `cd /e/Efebia/hiiiid-code && node esbuild.js` — `dist/daemon.js` exists.

- [ ] **Step 5: Smoke the bundle under Electron-as-Node.** Run: `cd /e/Efebia/hiiiid-code && node -e "const d=require('os').tmpdir()+'/mar-smoke';require('fs').mkdirSync(d,{recursive:true});const {spawnSync}=require('child_process');const r=spawnSync(process.execPath,['dist/daemon.js','daemon','--status'],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},cwd:d,encoding:'utf8'});console.log(r.status,r.stdout,r.stderr)"` — Expected `1 not running` (proves the bundle loads). Then run the same with `process.execPath` replaced by VS Code's `Code.exe` path (`& "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe"`) to confirm Electron-as-Node; also start a real daemon with `--serve --workspace-dir <tmp>` for a few seconds, read `daemon.log`, and note whether the memory store logged "unavailable". Record the result in `docs/daemon.md` (Task 12). If the bundle fails to load, stop and report.

- [ ] **Step 6: Commit** `git commit -am "feat: bundle the daemon and add the extension spawn recipe"`

---

### Task 7: Host-link banner in the sidebar

**Files:**
- Modify: `src/protocol/messages.ts` (`HostToWebview`), `src/client-core/reducer.ts`, `src/client-core/state.ts` (wherever `ClientState` lives — find with `grep -n "agentsMdNudgeHits" src/client-core/*.ts`), `src/webview/app.tsx`
- Create: `src/webview/components/host-link-banner.tsx`
- Test: `src/test/dom/host-link-banner.test.tsx`

**Interfaces:**
- Produces: `HostToWebview` gains `{ t: 'host-link'; status: 'connected' | 'reconnecting' | 'lost' }`. `ClientState.hostLink` (`'connected' | 'reconnecting' | 'lost'`, default `'connected'`). `<HostLinkBanner/>` renders nothing when connected.

- [ ] **Step 1: Write the failing DOM test.** Mirror `src/test/dom/agents-md-nudge-card.test.tsx`'s mount helper (`harness.tsx`), then:

```tsx
test('shows the reconnecting banner and clears it on connected', async () => {
  const { sendFromHost, screen } = mountApp();   // use the helper agents-md-nudge-card.test.tsx uses
  sendFromHost({ t: 'host-link', status: 'reconnecting' });
  await screen.findByText(/Reconnecting to the background host/);
  sendFromHost({ t: 'host-link', status: 'lost' });
  await screen.findByText(/Lost the background host/);
  sendFromHost({ t: 'host-link', status: 'connected' });
  assert.strictEqual(screen.queryByText(/background host/) === null, true);
});
```
Replace `mountApp`/`screen` with the exact helpers that file imports.

- [ ] **Step 2: Run** `cd /e/Efebia/hiiiid-code && yarn test:dom` filtered if the runner supports it; else run the guarded suite. Expected: FAIL.

- [ ] **Step 3: Implement.** Reducer case:

```ts
    case 'host-link':
      return { ...state, hostLink: msg.status };
```
Add `hostLink: 'connected'` to the initial state. Component:

```tsx
import { useStore } from '../store';

const COPY = {
  reconnecting: 'Reconnecting to the background host…',
  lost: 'Lost the background host; reload the window',
} as const;

export function HostLinkBanner() {
  const { state } = useStore();
  if (state.hostLink === 'connected') { return null; }
  return (
    <div role="status" className="mx-2 mt-2 rounded border-2 border-border bg-muted/40 p-2 text-xs">
      {COPY[state.hostLink]}
    </div>
  );
}
```
Render `<HostLinkBanner />` next to `<AgentsMdNudgeCard />` in `app.tsx`. Review/fleet/history reducers: add a no-op arm only if their exhaustive checks fail typecheck.

- [ ] **Step 4: Run** `yarn test:dom` — PASS; `yarn check-types`. Run the impeccable detector on the two changed component files: exit 0.

- [ ] **Step 5: Commit** `git commit -am "feat: host-link banner"`

---

### Task 8: `VscodeHooks` and `editor-actions`

**Files:**
- Create: `src/host/editor-actions.ts`, `src/host/vscode-hooks.ts`, `src/host/act-adapter.ts` (pure, no `vscode`)
- Modify: `src/extension.ts` (remove the moved functions; import them)
- Test: `src/test/unit/act-adapter.test.ts`

**Interfaces:**
- Consumes: `EditorContextHost`, `AttachmentHost`, `FileSearch`, `ConfigHost`, `UpdateNotifyHost` from `message-router.ts`; `ActOp`/`AskOp` from `daemon-wire`.
- Produces:
  - `editor-actions.ts`: `revealFile(target, startLine?)`, `openFileDiff(root, target, base)`, `openLoginTerminal(name, command, env?)`, `openExternal(url)`, `exportCsv(csv)`, `exportImage(dataUri)` — bodies moved verbatim from `extension.ts` (lines 408–568 there), exported.
  - `act-adapter.ts`: `hooksToClient(set: HookSet, notice: Notices): Pick<ClientHooks,'act'|'ask'>` where `HookSet = { editor: EditorContextHost; picker: AttachmentHost; fileSearch: FileSearch; configHost: ConfigHost }`. `act('notify',[level,text])` → `notice.info|warn`; `act('shellNoise',[p])` → `notice.shellNoise`; other ops dispatch to `editor`/`configHost` exactly like `tui/boot.ts daemonHooks`. `ask('pick')` → `picker.pick()`, `ask('search',[q])` → `fileSearch.search(String(q ?? ''))`.
  - `vscode-hooks.ts`: `createVscodeHooks(deps: { configFile: string; loginRecipes: () => Map<…>; fileIndex: FileSearch; favorites: { set(ids: string[]): Promise<void> }; tracker: { readonly current: EditorContext | null } }): HookSet & { updateNotify: UpdateNotifyHost }` — `editor` is today's `editorHost` object, `picker` today's `picker`, `configHost` today's `configHost`, `updateNotify` today's deduping `updateNotify` (with its `notifiedProviders` set).

- [ ] **Step 1: Write the failing test** `act-adapter.test.ts`:

```ts
import * as assert from 'node:assert';
import { hooksToClient } from '../../host/act-adapter';

suite('act adapter', () => {
  const calls: string[] = [];
  const noop = () => {};
  const set = {
    editor: { current: () => null, reveal: (p: string, l?: number) => { calls.push(`reveal:${p}:${l}`); }, openDiff: noop, openSettings: noop, openExternal: noop, exportCsv: noop, exportImage: noop, login: noop },
    picker: { pick: async () => ['/p'] },
    fileSearch: { search: async (q: string) => [{ path: q }] as never },
    configHost: { setFavoriteModels: (ids: string[]) => { calls.push(`fav:${ids.join(',')}`); } },
  };
  const notice = { info: (t: string) => calls.push(`i:${t}`), warn: (t: string) => calls.push(`w:${t}`), shellNoise: (p: string) => calls.push(`s:${p}`) };
  const c = hooksToClient(set, notice);

  test('routes acts to the matching host call', () => {
    c.act!('reveal', ['/a.ts', 3]);
    c.act!('setFavoriteModels', [['m']]);
    c.act!('notify', ['warn', 'boom']);
    c.act!('notify', ['info', 'fyi']);
    c.act!('shellNoise', ['P']);
    assert.deepStrictEqual(calls, ['reveal:/a.ts:3', 'fav:m', 'w:boom', 'i:fyi', 's:P']);
  });

  test('ask answers pick and search', async () => {
    assert.deepStrictEqual(await c.ask!('pick', []), ['/p']);
    assert.deepStrictEqual(await c.ask!('search', ['q']), [{ path: 'q' }]);
  });
});
```

- [ ] **Step 2: Run** `npx mocha --ui tdd --require tsx/cjs src/test/unit/act-adapter.test.ts`. FAIL.

- [ ] **Step 3: Implement** `act-adapter.ts`:

```ts
import type { ClientHooks } from '../daemon-client/daemon-client';
import type { AttachmentHost, ConfigHost, EditorContextHost, FileSearch } from './message-router';

export interface HookSet { editor: EditorContextHost; picker: AttachmentHost; fileSearch: FileSearch; configHost: ConfigHost }
export interface Notices { info(text: string): void; warn(text: string): void; shellNoise(profile: string): void }

export function hooksToClient(set: HookSet, notice: Notices): Pick<ClientHooks, 'act' | 'ask'> {
  return {
    act: (op, args) => {
      if (op === 'setFavoriteModels') { set.configHost.setFavoriteModels(args[0] as string[]); return; }
      if (op === 'notify') { (args[0] === 'warn' ? notice.warn : notice.info)(String(args[1])); return; }
      if (op === 'shellNoise') { notice.shellNoise(String(args[0])); return; }
      (set.editor[op] as (...a: unknown[]) => void)(...args);
    },
    ask: async (op, args) => (op === 'pick' ? set.picker.pick() : set.fileSearch.search(String(args[0] ?? ''))),
  };
}
```
(`login` is `editor.login(providerId)`, which `createVscodeHooks` resolves against the recipes.) Move the functions into `editor-actions.ts` unchanged except `export`; `vscode-hooks.ts` assembles the objects from `extension.ts` lines 172–239 using the deps above, and `extension.ts` imports from both. `login` in `editor` is `(id) => { const r = deps.loginRecipes().get(id); if (r) { openLoginTerminal(r.terminalName, r.command, r.env); } }`.

- [ ] **Step 4: Run** the test (PASS), then `yarn check-types && yarn lint`.

- [ ] **Step 5: Commit** `git add -A src && git commit -m "refactor: move editor actions and hooks out of extension.ts"`

---

### Task 9: `host-connection` — links in both modes

**Files:**
- Create: `src/host/surface-link.ts`, `src/host/in-process-link.ts`, `src/host/host-connection.ts`
- Test: `src/test/unit/host-connection.test.ts`

**Interfaces:**
- Consumes: `connectOrSpawn` (+ `ConnectOptions`), `createHost`/`HostHandle`/`LoginRecipe`, `MessageRouter`, `PostBus`, `wantsFor`, `createLoopback`, `HookSet`/`hooksToClient`.
- Produces:

```ts
// surface-link.ts
import type { ClientKind } from '../protocol/daemon-wire';
import type { ClientTransport } from '../client-core/transport';
import type { ClientStatus } from '../daemon-client/daemon-client';

export interface SurfaceLink {
  readonly transport: ClientTransport;
  onStatus(cb: (s: ClientStatus) => void): () => void;
  /** Daemon links only; the sidebar pushes editor context through it. */
  pushContext(ctx: unknown): void;
  dispose(): void;
}
export interface HostConnection {
  readonly mode: 'daemon' | 'in-process';
  /** First line for the user when the daemon was wanted but not used; undefined when attached or disabled. */
  readonly fallbackNotice: string | undefined;
  /** Warnings about the attached daemon (stale config/build). */
  readonly warnings: string[];
  readonly loginRecipes: Map<string, LoginRecipe>;
  connect(kind: ClientKind): Promise<SurfaceLink>;
  dispose(): Promise<void>;
}
```

```ts
// host-connection.ts
export interface HostConnectionDeps {
  workspaceDir: string; config: HostConfig; roots: () => string[]; defaultCwd: string;
  configSignature: string; hooks: HookSet & { updateNotify: UpdateNotifyHost };
  notices: Notices; showCacheTimer: boolean; favoriteModels: () => string[];
  context: () => unknown;                         // editor context for the sidebar
  spawn(workspaceDir: string, roots: string[]): Promise<void>;
  connectOrSpawn?: typeof connectOrSpawn;         // test seam
  createHost?: typeof createHost;                 // test seam
  loginRecipesOf: (wire: DaemonClient['loginRecipes']) => Map<string, LoginRecipe>;
}
export async function openHostConnection(deps: HostConnectionDeps): Promise<HostConnection>;
```

Behavior: if `deps.config.daemon.enabled`, the **first** `connect('sidebar')`-equivalent happens inside `openHostConnection` (so mode is decided once): call `connectOrSpawn({ clientKind: 'sidebar', hooks: { ...hooksToClient(...), context: deps.context }, replaceOlderBuild: true, configSignature, identity: { protocolVersion: PROTOCOL_VERSION, appVersion: APP_VERSION }, roots: deps.roots(), defaultCwd, spawn })`. On `attached`, keep that client as the sidebar link and return a `HostConnection` with `mode: 'daemon'`; `connect(kind)` for `sidebar` returns the held link once (then opens a fresh one), for other kinds calls `connectOrSpawn` with `replaceOlderBuild: false`, no `configSignature`, hooks `{ ...hooksToClient(...), context: () => null }`; a fallback result there returns a link that immediately reports `lost` (never rejects). On fallback or disabled, call `createHost({ hostKind: 'vscode', emit: (m) => bus.post(m), notify: { warn: notices.warn }, onShellNoise: notices.shellNoise, workspaceRoots: deps.roots, ... })`, `await host.init()`, and return `mode: 'in-process'` whose `connect(kind)` is `createInProcessLink(...)`. `dispose()`: daemon → dispose every link opened (tracked in a `Set`), never touch a host; in-process → `host.dispose()`.

`in-process-link.ts`: `createInProcessLink({ host, bus, kind, defaultCwd, hooks, config, favoriteModels, showCacheTimer }): SurfaceLink` — builds `createLoopback(msg => router.handle(msg))`, `new MessageRouter(host.manager, (m) => loopback.deliver(m), defaultCwd, hooks.editor, host.attachments, hooks.picker, config.review.pollIntervalMs, hooks.fileSearch, favoriteModels(), hooks.configHost, kind === 'sidebar' ? hooks.updateNotify : undefined, showCacheTimer)`, registers `bus.add({ post: loopback.deliver, wants: wantsFor(kind) })`, `dispose` unregisters. `pushContext` is a no-op (the router asks `hooks.editor.current()`); `onStatus` never fires.

- [ ] **Step 1: Write the failing tests** in `host-connection.test.ts` with stubbed `connectOrSpawn` and `createHost`:
  1. attached → `mode === 'daemon'`, `fallbackNotice === undefined`, `connect('review')` calls the stub a second time with `clientKind: 'review'` and no `configSignature`.
  2. stub returns `{ kind: 'fallback', reason: 'newer-daemon', message: 'x' }` → `mode === 'in-process'`, `fallbackNotice === 'Running without the background host: x'`, and the fake host's `init` was called once.
  3. `daemon.enabled = false` → in-process, `fallbackNotice === undefined`, stub never called.
  4. daemon `dispose()` calls `close()` on every link and never calls the fake host's `dispose`; in-process `dispose()` calls it exactly once.
  5. `connect('fleet')` when the stub returns fallback on the second call → resolves a link whose `onStatus` callback receives `'lost'` (assert the status string).
  6. in-process `connect('review')` link: a `sessions-changed` posted on the bus reaches its transport listener, a `session-patch` does not.
  Write the stubs as plain objects implementing only the methods used; use `FakeProvider`-backed `createHost` for test 6 if the stub is too thin (`createHost({ ..., config: { ...defaultHostConfig(), enabledProviders: ['fake'], memory: { enabled: false, summarizer: undefined } } })` like `daemon-run.test.ts`).

- [ ] **Step 2: Run** `npx mocha --ui tdd --require tsx/cjs src/test/unit/host-connection.test.ts`. FAIL.

- [ ] **Step 3: Implement** the three files per the interfaces above. Mark disposed links so a second `dispose()` is a no-op; wrap listener loops in try/catch as `SocketDaemonClient` does.

- [ ] **Step 4: Run** the new test file and `yarn check-types`. PASS.

- [ ] **Step 5: Commit** `git add -A src && git commit -m "feat: host connection with daemon and in-process links"`

---

### Task 10: Panels hold a `SurfaceLink`

**Files:**
- Modify: `src/host/panel-view-provider.ts`, `src/host/review-panel.ts`, `src/host/fleet-panel.ts`, `src/host/history-panel.ts`
- Test: type-check + `src/test/unit/pane-commands.test.ts` additions + manual (these files import `vscode`, no unit harness exists)

**Interfaces:**
- Consumes: `HostConnection.connect(kind)` (Task 9).
- Produces:
  - Each panel constructor takes `private readonly connect: (kind: ClientKind) => Promise<SurfaceLink>` in place of `manager`, `bus`, `defaultCwd`, `editor`, `attachments`/`picker`/`fileSearch`/`configHost`/`updateNotify`/`favoriteModels`/`showCacheTimer`/`reviewPollIntervalMs` (those now live in the link's router/hooks). `PanelViewProvider` still needs `attachmentsBaseDir: string | undefined` (for `localResourceRoots` and `attachmentBase`; read from `host.attachments?.baseDir` in daemon mode via `join(workspaceDir, …)` — use whatever path `AttachmentStore(baseDir)` is given in `create-host.ts`, export a helper `attachmentsDir(workspaceDir)` from there if none exists).
  - `PanelViewProvider.layout(): PaneLayout | undefined` — last layout seen on the sidebar link (`hydrate` and `layout-changed`).
  - A panel's open flow: `const link = await this.connect(kind); panel.webview.onDidReceiveMessage((raw) => link.transport.post(raw)); link.transport.onMessage((m) => panel.webview.postMessage(m)); link.onStatus(...)`.

- [ ] **Step 1: Add the layout-cache test** to `src/test/unit/pane-commands.test.ts` only for `paneCommandMessage` (existing behavior) — no change needed; instead put the cache in a pure helper to test: create `src/host/layout-cache.ts` exporting

```ts
export function trackLayout(onMessage: (l: (m: HostToWebview) => void) => () => void): { current(): PaneLayout | undefined; dispose(): void }
```
and test it in `src/test/unit/layout-cache.test.ts`: a listener fed `{t:'hydrate', layout: L1}` then `{t:'layout-changed', layout: L2}` yields `current() === L2` (compare by deep equality); unrelated messages leave it unchanged; `dispose` stops tracking.

- [ ] **Step 2: Run** it. FAIL. Implement `layout-cache.ts`; PASS.

- [ ] **Step 3: Refactor the panels.**
  - `PanelViewProvider.resolveWebviewView`: replace the `MessageRouter` with `void this.attach(view)`; `attach` awaits `this.connect('sidebar')`, forwards `view.webview.onDidReceiveMessage` through an intercept function (below) to `link.transport.post`, forwards `link.transport.onMessage` to `view.webview.postMessage`, subscribes `link.onStatus` → `this.post({ t: 'host-link', status })`, tracks layout with `trackLayout`, and disposes the link and subscriptions in `view.onDidDispose`. Each resolve opens a fresh link (the view is rebuilt on every reveal; the previous link is disposed in `onDidDispose`). Pending messages before `connect` resolves are buffered (`const queue: WebviewToHost[] = []`) and flushed after.
  - Intercepts that stay in the panel: `open-attachment` (use `requestAttachmentPath(link.transport as DaemonClient-compatible, …)` — `requestAttachmentPath` takes a `ClientTransport`; reuse `src/tui/attachment-request.ts` by moving it to `src/client-core/attachment-request.ts` and updating the TUI import), then `vscode.commands.executeCommand('vscode.open', Uri.file(path))`; `open-review`, `open-history`, `open-fleet`, `open-fleet-subagent`, `agents-md-nudge-action` (+ `resend()` after `ready`). **Removed:** the `open-file` interception (Task 1 handles it), and the `openFile` and `openAttachment` manager calls.
  - `ReviewPanel`: `adopt` does `const link = await this.connect('review')`, no `bus.add`, no router; keeps the `review-visibility` posting on `ready` and on view-state change. Dispose the link with the panel. Constructor loses `manager`, `bus`, `defaultCwd`, `editor`, `reviewPollIntervalMs`.
  - `FleetPanel` / `HistoryPanel`: same with `'fleet'` / `'history'`; their `focus-session` interception becomes: `link.transport.post(raw); await vscode.commands.executeCommand('workbench.view.extension.mar-code');` (the router from Task 2 does the placement; the ordering is safe because the reveal only needs the container, the layout arrives over the sidebar's own link).
  - A failed `connect` (it never rejects, but guard anyway) logs and leaves the tab empty.

- [ ] **Step 4: Run** `yarn check-types`, `yarn lint`, `yarn test:unit`, `yarn test:dom`. All pass.

- [ ] **Step 5: Commit** `git add -A src && git commit -m "refactor: panels talk to a surface link"`

---

### Task 11: `activate()` wiring, commands, memory and pane commands, deactivate

**Files:**
- Create: `src/host/commands.ts`, `src/host/activate.ts`
- Modify: `src/extension.ts` (becomes the thin entry), `src/host/focus-session.ts` untouched
- Test: `src/test/unit/memory-reindex-flow.test.ts` (pure part), existing `src/test/suite`/`extension.test.ts` integration if it activates the extension

**Interfaces:**
- Produces:
  - `commands.ts`: `registerCommands(deps): vscode.Disposable[]` with `{ context, configFile, provider: PanelViewProvider, review, fleet, history, connection: HostConnection }`. Commands: pane commands via `paneCommandMessage(command, provider.layout())` posted with `provider.post`; `marcode.review.open`/`fleet.open`/`history.open`; `marcode.config.open`; `marcode.login` (recipes from `connection.loginRecipes`); `marcode.accountSetup.wizard`; `marcode.memory.reindex`.
  - `memory-reindex-flow.ts` (pure): `runMemoryReindex(io: { status(): Promise<{enabled:boolean;llm:boolean}>; estimate(): Promise<{sessions:number;approxInputTokens:number}|undefined>; confirm(detail:string): Promise<boolean>; reindex(): Promise<void>; info(msg:string): void }): Promise<void>` containing today's text logic (copy the three `detail` branches verbatim from `extension.ts` lines 331–351). `commands.ts` supplies `io` from a short-lived `'history'`-kind link: `status` posts `request-memory-status` and resolves on the next `memory-status`; `estimate` posts `{t:'memory-estimate', scope:'missing-llm'}` and resolves on `memory-estimate`, or `undefined` after 3 s of silence (the router reindexes immediately when nothing needs a model, then no estimate comes); `reindex` posts `memory-reindex` and resolves on `memory-progress` with `phase:'done'`. The link is disposed afterwards.
  - `activate.ts`: `activateExtension(context)` containing the remaining body of today's `activate()` minus what moved: seed/load config, resolve and import workspace dir, build hooks (`createVscodeHooks`), `openHostConnection`, then provider/panels with `connection.connect`, the `Notices` implementation (`info`→`showInformationMessage`, `warn`→`showWarningMessage`, `shellNoise`→`warnAboutProfile`), the fallback notice and `connection.warnings` surfaced as one warning each, tracker → `link.pushContext` is wired by passing `context: () => tracker.current` and calling `provider.pushContext(ctx)` on tracker change (`PanelViewProvider.pushContext` forwards to its current link in daemon mode and `post({t:'editor-context', ctx})` in both modes). `deactivate` awaits `connection.dispose()`.

- [ ] **Step 1: Write the failing test** `memory-reindex-flow.test.ts` covering: disabled → `info('Marcode memory is off (marcode.memory.enabled).')` and no `reindex`; llm with `sessions: 3, approxInputTokens: 12000` → `confirm` receives a detail containing `3 hidden sessions` and `about 12k input tokens`; confirm false → no `reindex`; no llm → detail contains `No summarizer is configured`; `estimate` returns `undefined` with llm on → the "already has a current model summary" branch is **not** used (that branch is only for `sessions === 0`; `undefined` means the router already reindexed, so the flow ends with the finished toast and no confirm).

- [ ] **Step 2: Run** it. FAIL. Implement `memory-reindex-flow.ts`; PASS.

- [ ] **Step 3: Write `commands.ts`, `activate.ts`, shrink `extension.ts`** to:

```ts
import * as vscode from 'vscode';
import { activateExtension, deactivateExtension } from './host/activate';

export const activate = (context: vscode.ExtensionContext) => activateExtension(context);
export const deactivate = () => deactivateExtension();
```
Keep `host.init()` error handling equivalent: `openHostConnection` already inits the in-process host; wrap the whole in the same try/catch that logs and leaves an empty roster.

- [ ] **Step 4: Run** `yarn lint && yarn check-types && yarn run compile && yarn test:unit && yarn test:dom`. All pass. If `yarn test` (integration) is runnable locally, run it.

- [ ] **Step 5: Commit** `git add -A src && git commit -m "feat: extension attaches to the daemon with in-process fallback"`

---

### Task 12: Integration test, docs, manual verification

**Files:**
- Create: `src/test/unit/daemon-extension-flow.test.ts`
- Modify: `docs/daemon.md`, `AGENTS.md` (architecture + table + invariants), `docs/config.md` only if `daemon.*` text mentions the TUI as the only client

- [ ] **Step 1: Write the integration test.** In-process `runDaemon` (fake provider, as `daemon-run.test.ts`), then `openHostConnection` with the real `connectOrSpawn`, `spawn` stubbed to throw (daemon already running), a stub `HookSet`, two surfaces:
  - `connect('sidebar')` link + `connect('review')` link both hydrate (`post({t:'ready'})`, assert a `hydrate` arrives on each).
  - Create a session through the sidebar link with a fake script that never finishes (`create-session` + `send`); dispose the sidebar link; open a new `openHostConnection`; `ready`; assert the hydrated session summary status is `running`.
  - Disposing the daemon-mode `HostConnection` does not stop the daemon (`server` still accepts: `readDaemonInfo(dir)` still returns the pid).
  - A review link never receives a `session-patch` while the sidebar does.
  Assert booleans/strings/counts only.

- [ ] **Step 2: Run** it; fix any wiring found. PASS.

- [ ] **Step 3: Docs.** `docs/daemon.md`: replace "Today only the TUI attaches…" with the extension attaching, add an "Extension" section (spawn via bundled `dist/daemon.js`, one connection per surface, fallback notice text, `daemon.enabled=false`, reload keeps agents running, the app-version replacement rule, banner copy) and the Task 6 Electron/memory finding. `AGENTS.md`: update the daemon paragraph ("Only the TUI attaches today; the extension is the next plan" → attached), add rows for `host-connection.ts`, `surface-link.ts`, `in-process-link.ts`, `vscode-hooks.ts`, `act-adapter.ts`, `editor-actions.ts`, `commands.ts`, `activate.ts`, `layout-cache.ts`, `dist/daemon.js` in the build line (six bundles), and the invariants from the spec.

- [ ] **Step 4: Full gate.** `cd /e/Efebia/hiiiid-code && yarn lint && yarn check-types && yarn run compile && yarn test:unit && yarn test:dom && yarn test:tui`. All green.

- [ ] **Step 5: Manual F5 checklist** (report each result): (a) open a workspace, start a long turn, Developer: Reload Window — the turn is still `running` and streaming after reload; (b) run `marcode` TUI in the same repo — same sessions, live; (c) kill the daemon pid — sidebar shows "Reconnecting…", then recovers with a respawned daemon and the same panes; (d) set `daemon.enabled: false` in `~/.marcode/config.json`, reload — works in-process, no notice; (e) open Changes, Fleet and History tabs, reload with them open — each restores and fills; (f) run `Marcode: Reindex memory` with and without a summarizer; (g) trigger a stale-provider update toast and confirm one toast per window; (h) run the impeccable detector once more over `src/webview/components/host-link-banner.tsx`.

- [ ] **Step 6: Commit** `git add -A && git commit -m "docs: the extension attaches to the daemon"`

---

## Self-review notes

- **Spec coverage:** fallback kept (Task 9); lease modules untouched (no task touches them); one connection per surface (9, 10); open-file/open-attachment/focus-session/pane commands/memory command (1, 2, 3, 10, 11); notify/shellNoise acts, sidebar only, pre-attach warnings (4); spawn + bundle (6); version rule (5); status banner (7); `extension.ts` split (8, 11); tests and manual (12); Electron-as-Node/`node:sqlite` check (6 step 5).
- **Type consistency:** `SurfaceLink`, `HostConnection`, `HookSet`, `Notices`, `hooksToClient(set, notice)` (two parameters, as redefined in Task 8), `connect(kind)` are used with the same names in Tasks 9–11. `ClientStatus` is the existing `'connected' | 'reconnecting' | 'lost'`, and `host-link.status` carries the same union.
- **Known judgement calls for the executor:** exact `manager.create(...)` arguments in router tests (copy from neighbors); the `ClientState` file path in Task 7; the attachments directory helper in Task 10 — each names how to find it.
