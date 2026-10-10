# Marcode daemon (core + TUI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A detached per-workspace daemon that owns the host, so the TUI (and later the extension) share live sessions and agents survive a client exiting.

**Architecture:** `createHost` (new `hostKind: 'daemon'`) plus a `net` listener on a named pipe / unix socket carrying NDJSON frames. Each connection gets its own `MessageRouter` and a `PostBus` registration gated by `clientKind`. A `daemon-client` module owns discovery, spawn lock, version policy and reconnect, and exposes a `ClientTransport`. The TUI uses it and falls back to the in-process host.

**Tech Stack:** TypeScript, Node `net`, mocha (`suite`/`test`, `tsx/cjs`), `bun test` for TUI tests. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-09-marcode-daemon-design.md`

**Scope of this plan:** spec rollout phases 1 and 2 (core, then TUI). The extension (phase 3) is a separate plan written after the TUI has had real use. Refinements to the spec made here, written back to it in Task 14:
- `EditorContextHost.current()` is synchronous, so the client pushes `ctx` frames and the daemon proxy serves the cache.
- Fire-and-forget host calls (`reveal`, `openDiff`, `openSettings`, `openExternal`, `exportCsv`, `exportImage`, `login`, `setFavoriteModels`) are one-way `act` frames; only `pick` and `search` use `req`/`res`.
- `shutdown` carries the token and is accepted before `hello`, because a client of an incompatible version is rejected at `hello` and still has to be able to replace an idle daemon.
- A client never replaces a daemon whose `protocolVersion` is newer than its own; it falls back and tells the user to update.
- `welcome` carries `loginRecipes`, since the TUI's `login` hint needs them and they derive from daemon-side config.

## Global Constraints

- `src/protocol/messages.ts` and `src/protocol/daemon-wire.ts` are types-only: no runtime code, no `vscode` import.
- Nothing under `src/daemon/`, `src/daemon-client/`, `src/tui/`, `src/client-core/` imports `vscode`. `src/client-core/` has no React or DOM.
- Every protocol message addressed to a session carries an explicit `SessionId`.
- Errors are state, never exceptions: no handler may leave an unhandled rejection; nothing rejects across the socket.
- Filenames are kebab-case.
- Comments are minimal: only non-obvious "why".
- Files over ~300 lines get split.
- Conventional-commit prefixes. No `Co-Authored-By` or any Claude/Anthropic trailer on commits.
- `yarn lint`, `yarn check-types` and `yarn run compile` must pass before each commit that touches `src/`.
- Tests: new pure-node unit tests may be run singly with `npx mocha --ui tdd --require tsx/cjs <file>`. The guarded `yarn test:unit` runs at the end of Tasks 5, 9, 12 and 14 and must stay green. TUI tests run with `yarn test:tui`. Never pass a DOM node or a socket to `assert`.
- Defaults: `daemon.enabled = true`, `daemon.idleMinutes = 10`. Protocol constant `PROTOCOL_VERSION = 1`.
- Pipe path on Windows: `\\.\pipe\marcode-<12 hex of sha256(workspaceDir)>`. Unix: `<os.tmpdir()>/marcode-<uid>/<12 hex>.sock`, dir mode 0700, socket mode 0600. Shell quoting eats backslashes in heredocs: write these files with the Write/Edit tools, never `cat <<EOF`.

## Review Focus

Failure modes the spec implies that no single task's happy path covers. Each has a test in the task named.

1. Two clients start at the same instant: exactly one daemon must result (Task 11 spawn lock; Task 12 race test).
2. `daemon.json` left behind by a dead process: the next client recovers and spawns, rather than failing on "connection refused" forever (Task 11, Task 12).
3. A client sends garbage, half a line, or disconnects mid-frame: the daemon survives and other clients are unaffected (Task 8, Task 9).
4. The TUI quits while a turn is running: the daemon keeps running, nothing interrupts the turn, and the next TUI sees the session still `running` (Task 13).
5. A newer-protocol daemon meets an older client: the daemon is not killed; the client falls back in-process with a notice (Task 11, Task 12).

---

## File structure

| File | Responsibility |
|---|---|
| `src/protocol/daemon-wire.ts` (new) | Frame types only |
| `src/daemon/protocol.ts` (new) | `PROTOCOL_VERSION`, `encodeFrame`, `LineDecoder` |
| `src/daemon/endpoint.ts` (new) | Pipe/socket path from a workspace dir |
| `src/daemon/daemon-info.ts` (new) | `daemon.json` read/write/remove, token |
| `src/daemon/idle-monitor.ts` (new) | Idle-exit timer + `isBusy` predicate |
| `src/daemon/client-wants.ts` (new) | `wantsFor(clientKind)` |
| `src/daemon/remote-hooks.ts` (new) | Proxies for `EditorContextHost`, `AttachmentHost`, `FileSearch`, `ConfigHost` |
| `src/daemon/connection.ts` (new) | One connection's state machine over a `FrameSocket` |
| `src/daemon/daemon-server.ts` (new) | `net.Server`, connection set, bus, client count |
| `src/daemon/run-daemon.ts` (new) | `createHost` + server + idle exit + `daemon.json` lifecycle |
| `src/daemon-client/discover.ts` (new) | Find an attachable daemon |
| `src/daemon-client/spawn-lock.ts` (new) | `daemon.lock` via `createExclusive` |
| `src/daemon-client/version-policy.ts` (new) | Pure attach/replace/refuse decision |
| `src/daemon-client/daemon-client.ts` (new) | `ClientTransport` over a socket, reconnect |
| `src/daemon-client/connect-or-spawn.ts` (new) | Orchestration |
| `src/daemon-client/spawn-daemon.ts` (new) | Detached spawn recipe |
| `src/host/lease.ts`, `src/host/create-host.ts`, `src/protocol/messages.ts`, `src/host/host-config.ts`, `src/host/message-router.ts`, `src/tui/boot.ts`, `src/tui/cli.ts`, `src/tui/subcommands.ts`, `src/tui/ui/main.tsx` (modify) | See tasks |

---

### Task 1: Widen the host kind to include `daemon`

**Files:**
- Modify: `src/host/lease.ts:8` and `:40`
- Modify: `src/host/create-host.ts:32`
- Modify: `src/protocol/messages.ts:193`
- Test: `src/test/unit/lease.test.ts`

**Interfaces:**
- Produces: `LeaseHost = 'vscode' | 'tui' | 'daemon'`; `CreateHostOptions.hostKind` and `SessionState.owner.host` accept `'daemon'`.

- [ ] **Step 1: Write the failing test.** Open `src/test/unit/lease.test.ts`, find how it writes and reads a lease (it uses `readLease`), and add:

```ts
test('a daemon lease round-trips through readLease', async () => {
  const file = path.join(tmp, 'daemon-lease.lock');
  await fs.writeFile(file, JSON.stringify({
    pid: 1, host: 'daemon', instance: 'i', machine: 'm', heartbeat: 1,
  }));
  const info = await readLease(file);
  assert.strictEqual(info?.host, 'daemon');
});
```

Use whatever `tmp` / imports the file already has; add `readLease` to its import from `../../host/lease` if absent.

- [ ] **Step 2: Run, expect FAIL** (`info` is `undefined`, the guard rejects `'daemon'`).

Run: `npx mocha --ui tdd --require tsx/cjs src/test/unit/lease.test.ts`

- [ ] **Step 3: Implement.**
  - `lease.ts:8` → `export type LeaseHost = 'vscode' | 'tui' | 'daemon';`
  - `lease.ts` in `isLeaseInfo`, replace `(v.host === 'vscode' || v.host === 'tui')` with `(v.host === 'vscode' || v.host === 'tui' || v.host === 'daemon')`.
  - `create-host.ts:32` → `hostKind: 'vscode' | 'tui' | 'daemon';`
  - `messages.ts:193` → `owner?: { host: 'vscode' | 'tui' | 'daemon'; pid: number };`

- [ ] **Step 4: Run lease test, then `yarn check-types`.** Expected: PASS, no type errors. Fix any exhaustive-switch fallout the compiler reports (search `'tui'` under `src/` for UI strings that label an owner).

- [ ] **Step 5: Commit.** `git commit -am "feat: allow a daemon host kind"`

---

### Task 2: Wire types and the frame codec

**Files:**
- Create: `src/protocol/daemon-wire.ts`, `src/daemon/protocol.ts`
- Test: `src/test/unit/daemon-protocol.test.ts`

**Interfaces:**
- Produces: `ClientKind`, `ClientFrame`, `ServerFrame`, `LoginRecipeWire`, `RejectReason`, `ActOp`, `AskOp`; `PROTOCOL_VERSION`; `encodeFrame(frame): string`; `class LineDecoder { push(chunk: string): string[] }`; `parseFrame(line): unknown | undefined`; `MAX_LINE_BYTES`.

- [ ] **Step 1: Write the failing test** `src/test/unit/daemon-protocol.test.ts`:

```ts
import * as assert from 'node:assert';
import { encodeFrame, LineDecoder, MAX_LINE_BYTES, parseFrame } from '../../daemon/protocol';

suite('daemon protocol', () => {
  test('encodeFrame is one JSON line ending in a newline', () => {
    const line = encodeFrame({ f: 'bye' });
    assert.strictEqual(line, '{"f":"bye"}\n');
  });

  test('LineDecoder joins a frame split across chunks', () => {
    const d = new LineDecoder();
    assert.deepStrictEqual(d.push('{"f":"b'), []);
    assert.deepStrictEqual(d.push('ye"}\n{"f":"x"}'), ['{"f":"bye"}']);
    assert.deepStrictEqual(d.push('\n'), ['{"f":"x"}']);
  });

  test('LineDecoder skips empty lines', () => {
    assert.deepStrictEqual(new LineDecoder().push('\n\n{"a":1}\n'), ['{"a":1}']);
  });

  test('LineDecoder throws once a single line exceeds the cap', () => {
    const d = new LineDecoder();
    assert.throws(() => d.push('x'.repeat(MAX_LINE_BYTES + 1)), /too long/);
  });

  test('parseFrame returns undefined for garbage and for a frame with no f', () => {
    assert.strictEqual(parseFrame('not json'), undefined);
    assert.strictEqual(parseFrame('{"x":1}'), undefined);
    assert.deepStrictEqual(parseFrame('{"f":"bye"}'), { f: 'bye' });
  });
});
```

- [ ] **Step 2: Run, expect FAIL** (module not found).

- [ ] **Step 3: Implement.** `src/protocol/daemon-wire.ts`:

```ts
import type { HostToWebview, WebviewToHost } from './messages';

export type ClientKind = 'sidebar' | 'review' | 'fleet' | 'history' | 'tui';

export interface LoginRecipeWire {
  id: string;
  terminalName: string;
  command: string;
  /** Only the keys that differ from the daemon's own process.env. */
  env: Record<string, string>;
}

export type RejectReason = 'protocol-mismatch' | 'bad-token' | 'upgrade-busy' | 'bad-hello';

export type ActOp =
  | 'reveal' | 'openDiff' | 'openSettings' | 'openExternal'
  | 'exportCsv' | 'exportImage' | 'login' | 'setFavoriteModels';
export type AskOp = 'pick' | 'search';

export interface DaemonIdentity { protocolVersion: number; appVersion: string }

export type ClientFrame =
  | ({ f: 'hello'; clientKind: ClientKind; token: string; roots: string[]; defaultCwd: string } & DaemonIdentity)
  | { f: 'msg'; m: WebviewToHost }
  | { f: 'ctx'; ctx: unknown }
  | { f: 'res'; id: number; ok: true; result: unknown }
  | { f: 'res'; id: number; ok: false; error: string }
  | { f: 'shutdown'; token: string };

export type ServerFrame =
  | ({ f: 'welcome'; clientId: string; loginRecipes: LoginRecipeWire[] } & DaemonIdentity)
  | { f: 'reject'; reason: RejectReason; daemon: DaemonIdentity }
  | { f: 'msg'; m: HostToWebview }
  | { f: 'act'; op: ActOp; args: unknown[] }
  | { f: 'req'; id: number; op: AskOp; args: unknown[] }
  | { f: 'bye' }
  | { f: 'refuse'; reason: 'busy' | 'bad-token' };
```

`src/daemon/protocol.ts`:

```ts
import type { ClientFrame, ServerFrame } from '../protocol/daemon-wire';

export const PROTOCOL_VERSION = 1;
export const MAX_LINE_BYTES = 64 * 1024 * 1024;

export function encodeFrame(frame: ClientFrame | ServerFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

export class LineDecoder {
  private tail = '';

  push(chunk: string): string[] {
    this.tail += chunk;
    const parts = this.tail.split('\n');
    this.tail = parts.pop() ?? '';
    if (this.tail.length > MAX_LINE_BYTES) { throw new Error('line too long'); }
    return parts.filter((l) => l !== '');
  }
}

export function parseFrame(line: string): { f: string } | undefined {
  try {
    const v: unknown = JSON.parse(line);
    if (typeof v === 'object' && v !== null && typeof (v as { f?: unknown }).f === 'string') {
      return v as { f: string };
    }
  } catch { /* garbage is a closed connection, decided by the caller */ }
  return undefined;
}
```

- [ ] **Step 4: Run test, expect PASS.**
- [ ] **Step 5: Commit.** `git add src/protocol/daemon-wire.ts src/daemon/protocol.ts src/test/unit/daemon-protocol.test.ts && git commit -m "feat: daemon wire types and NDJSON codec"`

---

### Task 3: Endpoint path and `daemon.json`

**Files:**
- Create: `src/daemon/endpoint.ts`, `src/daemon/daemon-info.ts`
- Test: `src/test/unit/daemon-info.test.ts`

**Interfaces:**
- Consumes: `writeFileAtomic` from `../host/atomic-file`.
- Produces: `endpointFor(workspaceDir: string, platform?: NodeJS.Platform): string`; `interface DaemonInfo { pid: number; endpoint: string; token: string; protocolVersion: number; appVersion: string; startedAt: number }`; `daemonInfoPath(dir)`, `newToken()`, `readDaemonInfo(dir)`, `writeDaemonInfo(dir, info)`, `removeDaemonInfo(dir, pid)`.

- [ ] **Step 1: Failing test** `src/test/unit/daemon-info.test.ts`:

```ts
import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { endpointFor } from '../../daemon/endpoint';
import { newToken, readDaemonInfo, removeDaemonInfo, writeDaemonInfo, type DaemonInfo } from '../../daemon/daemon-info';

suite('daemon info', () => {
  let dir: string;
  setup(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-dinfo-')); });
  teardown(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  const info = (pid = 42): DaemonInfo => ({
    pid, endpoint: 'e', token: 't', protocolVersion: 1, appVersion: '1.0.0', startedAt: 1,
  });

  test('windows endpoint is a pipe name derived from the dir', () => {
    const a = endpointFor('C:\\a', 'win32');
    assert.strictEqual(a.startsWith('\\\\.\\pipe\\marcode-'), true);
    assert.notStrictEqual(a, endpointFor('C:\\b', 'win32'));
    assert.strictEqual(a, endpointFor('C:\\a', 'win32'));
  });

  test('posix endpoint is a short socket path', () => {
    const p = endpointFor('/home/x/.marcode/workspaces/a-very-long-slug-name', 'linux');
    assert.strictEqual(p.endsWith('.sock'), true);
    assert.strictEqual(p.length < 100, true);
  });

  test('write then read round-trips; remove only removes our own pid', async () => {
    await writeDaemonInfo(dir, info(42));
    assert.deepStrictEqual(await readDaemonInfo(dir), info(42));
    await removeDaemonInfo(dir, 7);
    assert.strictEqual((await readDaemonInfo(dir))?.pid, 42);
    await removeDaemonInfo(dir, 42);
    assert.strictEqual(await readDaemonInfo(dir), undefined);
  });

  test('a corrupt or partial daemon.json reads as absent', async () => {
    await fs.writeFile(path.join(dir, 'daemon.json'), '{"pid":');
    assert.strictEqual(await readDaemonInfo(dir), undefined);
    await fs.writeFile(path.join(dir, 'daemon.json'), '{"pid":1}');
    assert.strictEqual(await readDaemonInfo(dir), undefined);
  });

  test('tokens are long and distinct', () => {
    assert.strictEqual(newToken().length >= 32, true);
    assert.notStrictEqual(newToken(), newToken());
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** `src/daemon/endpoint.ts`:

```ts
import { createHash } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';

export function endpointFor(workspaceDir: string, platform: NodeJS.Platform = process.platform): string {
  const id = createHash('sha256').update(workspaceDir).digest('hex').slice(0, 12);
  if (platform === 'win32') { return `\\\\.\\pipe\\marcode-${id}`; }
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return path.join(os.tmpdir(), `marcode-${uid}`, `${id}.sock`);
}
```

`src/daemon/daemon-info.ts`:

```ts
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { writeFileAtomic } from '../host/atomic-file';

export interface DaemonInfo {
  pid: number;
  endpoint: string;
  token: string;
  protocolVersion: number;
  appVersion: string;
  startedAt: number;
}

export const daemonInfoPath = (dir: string): string => path.join(dir, 'daemon.json');
export const newToken = (): string => randomBytes(24).toString('hex');

function isInfo(v: unknown): v is DaemonInfo {
  if (typeof v !== 'object' || v === null) { return false; }
  const o = v as Record<string, unknown>;
  return typeof o.pid === 'number' && typeof o.endpoint === 'string' && typeof o.token === 'string'
    && typeof o.protocolVersion === 'number' && typeof o.appVersion === 'string' && typeof o.startedAt === 'number';
}

export async function readDaemonInfo(dir: string): Promise<DaemonInfo | undefined> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(daemonInfoPath(dir), 'utf8'));
    return isInfo(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function writeDaemonInfo(dir: string, info: DaemonInfo): Promise<void> {
  await writeFileAtomic(daemonInfoPath(dir), JSON.stringify(info));
  await fs.chmod(daemonInfoPath(dir), 0o600).catch(() => { /* no POSIX modes on some Windows filesystems */ });
}

export async function removeDaemonInfo(dir: string, pid: number): Promise<void> {
  if ((await readDaemonInfo(dir))?.pid !== pid) { return; }
  await fs.rm(daemonInfoPath(dir), { force: true });
}
```

- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit.** `git commit -am "feat: daemon endpoint path and daemon.json"` (after `git add` of the new files).

---

### Task 4: `daemon.*` config keys

**Files:**
- Modify: `src/host/host-config.ts`, `docs/config.md`
- Test: `src/test/unit/host-config.test.ts` (find the existing file with `grep -l parseHostConfig src/test/unit`)

**Interfaces:**
- Produces: `HostConfig.daemon: { enabled: boolean; idleMinutes: number }`.

- [ ] **Step 1: Failing tests** appended to the existing `parseHostConfig` suite:

```ts
test('daemon defaults to enabled with a 10 minute idle timeout', () => {
  assert.deepStrictEqual(parseHostConfig(undefined).config.daemon, { enabled: true, idleMinutes: 10 });
});

test('daemon.enabled false and a numeric idleMinutes are honoured', () => {
  const { config } = parseHostConfig({ daemon: { enabled: false, idleMinutes: 3 } });
  assert.deepStrictEqual(config.daemon, { enabled: false, idleMinutes: 3 });
});

test('a bad daemon block warns and keeps the defaults', () => {
  const a = parseHostConfig({ daemon: 5 });
  assert.strictEqual(a.warnings.length, 1);
  const b = parseHostConfig({ daemon: { enabled: 'yes', idleMinutes: -1 } });
  assert.deepStrictEqual(b.config.daemon, { enabled: true, idleMinutes: 10 });
  assert.strictEqual(b.warnings.length, 2);
});
```

- [ ] **Step 2: Run, expect FAIL** (`config.daemon` undefined).
- [ ] **Step 3: Implement.** Add `daemon: { enabled: boolean; idleMinutes: number };` to `HostConfig`; `daemon: { enabled: true, idleMinutes: 10 }` to `defaultHostConfig()`; and in `parseHostConfig`, before the final `return`:

```ts
  if (raw.daemon !== undefined) {
    if (!isObject(raw.daemon)) {
      warnings.push('config.json: daemon is not an object; using the default.');
    } else {
      if (raw.daemon.enabled !== undefined) {
        if (typeof raw.daemon.enabled === 'boolean') { config.daemon.enabled = raw.daemon.enabled; }
        else { warnings.push('config.json: daemon.enabled is not a boolean; using the default.'); }
      }
      if (raw.daemon.idleMinutes !== undefined) {
        const m = raw.daemon.idleMinutes;
        if (typeof m === 'number' && Number.isFinite(m) && m >= 1) { config.daemon.idleMinutes = Math.floor(m); }
        else { warnings.push('config.json: daemon.idleMinutes must be a number of at least 1; using the default.'); }
      }
    }
  }
```

Add `daemon` to the settings list in the `docs/config.md` section that documents `memory.*` / `review.*`, with both keys, defaults and "a change takes a window reload / restart of the TUI; an already-running daemon keeps its idle value until it exits".

- [ ] **Step 4: Run, expect PASS; `yarn check-types`** (other code constructing a `HostConfig` literal must now include `daemon`; fix with `defaultHostConfig()` spreads).
- [ ] **Step 5: Commit.** `git commit -am "feat: daemon config keys"`

---

### Task 5: Idle monitor and the busy predicate

**Files:**
- Create: `src/daemon/idle-monitor.ts`
- Test: `src/test/unit/daemon-idle-monitor.test.ts`

**Interfaces:**
- Consumes: `SessionSummary` (`status: SessionStatus`) from `../protocol/messages`.
- Produces: `isBusy(summaries: readonly { status: string }[]): boolean`; `class IdleMonitor` with `constructor(deps)`, `check(): void`, `dispose(): void`; `IdleMonitorDeps { busy(): boolean; clients(): number; idleMs: number; onIdle(): void; setTimer?(fn: () => void, ms: number): unknown; clearTimer?(h: unknown): void }`.

- [ ] **Step 1: Failing test:**

```ts
import * as assert from 'node:assert';
import { IdleMonitor, isBusy } from '../../daemon/idle-monitor';

suite('daemon idle monitor', () => {
  const harness = () => {
    const timers: { fn: () => void; ms: number; live: boolean }[] = [];
    const state = { busy: false, clients: 0, idled: 0 };
    const mon = new IdleMonitor({
      busy: () => state.busy, clients: () => state.clients, idleMs: 600_000, onIdle: () => { state.idled++; },
      setTimer: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
      clearTimer: (h) => { (h as { live: boolean }).live = false; },
    });
    const fire = () => { for (const t of timers) { if (t.live) { t.live = false; t.fn(); } } };
    return { mon, state, timers, fire };
  };

  test('idle with no clients fires onIdle after the timeout', () => {
    const h = harness();
    h.mon.check();
    assert.strictEqual(h.timers[0].ms, 600_000);
    h.fire();
    assert.strictEqual(h.state.idled, 1);
  });

  test('a client attaching cancels the pending exit', () => {
    const h = harness();
    h.mon.check();
    h.state.clients = 1;
    h.mon.check();
    h.fire();
    assert.strictEqual(h.state.idled, 0);
  });

  test('a busy session cancels it, and going idle again restarts it', () => {
    const h = harness();
    h.state.busy = true;
    h.mon.check();
    assert.strictEqual(h.timers.length, 0);
    h.state.busy = false;
    h.mon.check();
    h.fire();
    assert.strictEqual(h.state.idled, 1);
  });

  test('state that turned busy between schedule and fire is re-checked', () => {
    const h = harness();
    h.mon.check();
    h.state.busy = true;
    h.fire();
    assert.strictEqual(h.state.idled, 0);
  });

  test('check() twice does not stack timers', () => {
    const h = harness();
    h.mon.check();
    h.mon.check();
    assert.strictEqual(h.timers.length, 1);
  });

  test('isBusy: running, awaiting-approval count; idle and error do not', () => {
    assert.strictEqual(isBusy([{ status: 'idle' }, { status: 'error' }]), false);
    assert.strictEqual(isBusy([{ status: 'idle' }, { status: 'running' }]), true);
    assert.strictEqual(isBusy([{ status: 'awaiting-approval' }]), true);
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** `src/daemon/idle-monitor.ts`:

```ts
export function isBusy(summaries: readonly { status: string }[]): boolean {
  return summaries.some((s) => s.status !== 'idle' && s.status !== 'error');
}

export interface IdleMonitorDeps {
  busy(): boolean;
  clients(): number;
  idleMs: number;
  onIdle(): void;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

export class IdleMonitor {
  private handle: unknown;
  private armed = false;
  private readonly setTimer: NonNullable<IdleMonitorDeps['setTimer']>;
  private readonly clearTimer: NonNullable<IdleMonitorDeps['clearTimer']>;

  constructor(private readonly deps: IdleMonitorDeps) {
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  private quiet(): boolean { return this.deps.clients() === 0 && !this.deps.busy(); }

  check(): void {
    if (!this.quiet()) { this.disarm(); return; }
    if (this.armed) { return; }
    this.armed = true;
    this.handle = this.setTimer(() => {
      this.armed = false;
      if (this.quiet()) { this.deps.onIdle(); }
    }, this.deps.idleMs);
  }

  dispose(): void { this.disarm(); }

  private disarm(): void {
    if (!this.armed) { return; }
    this.clearTimer(this.handle);
    this.armed = false;
  }
}
```

- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit, then run the guarded suite** (`yarn test:unit`), expecting the full existing count plus the new tests green.

---

### Task 6: Attachment path as a message pair

The TUI's `open-attachment` currently calls `manager.attachmentPath` directly (`src/tui/boot.ts:48-53`), which a remote client cannot do.

**Files:**
- Modify: `src/protocol/messages.ts` (`WebviewToHost` near line 565, `HostToWebview` union), `src/host/message-router.ts` (`KNOWN_MESSAGE_TAGS` at 764, a new `case` in `route`)
- Test: `src/test/unit/message-router.test.ts` (find via `grep -l "new MessageRouter" src/test/unit`; follow how it builds a router and captures `emit`)

**Interfaces:**
- Produces: `WebviewToHost` member `{ t: 'request-attachment-path'; id: SessionId; attachmentId: string; itemId?: string; reqId: number }`; `HostToWebview` member `{ t: 'attachment-path'; reqId: number; path: string | null }`.

- [ ] **Step 1: Failing test** in the router test file, modelled on its existing cases:

```ts
test('request-attachment-path answers with the path or null, echoing reqId', async () => {
  const { router, emitted, manager } = makeRouter();
  (manager as { attachmentPath: unknown }).attachmentPath = async () => '/tmp/a.png';
  await router.handle({ t: 'request-attachment-path', id: 's1' as SessionId, attachmentId: 'a1', reqId: 7 });
  assert.deepStrictEqual(emitted.at(-1), { t: 'attachment-path', reqId: 7, path: '/tmp/a.png' });
  (manager as { attachmentPath: unknown }).attachmentPath = async () => undefined;
  await router.handle({ t: 'request-attachment-path', id: 's1' as SessionId, attachmentId: 'zz', reqId: 8 });
  assert.deepStrictEqual(emitted.at(-1), { t: 'attachment-path', reqId: 8, path: null });
});
```

If the file's helper builds routers differently, follow its pattern (the point is: stub `attachmentPath`, assert the emitted message).

- [ ] **Step 2: Run, expect FAIL** (message dropped as malformed).
- [ ] **Step 3: Implement.** Add both union members in `messages.ts`. In `message-router.ts` add `'request-attachment-path'` to `KNOWN_MESSAGE_TAGS` and, next to `case 'open-attachment':`:

```ts
      case 'request-attachment-path': {
        const found = await this.manager.attachmentPath(msg.id, msg.attachmentId, msg.itemId);
        this.emit({ t: 'attachment-path', reqId: msg.reqId, path: found ?? null });
        return;
      }
```

- [ ] **Step 4: Run, expect PASS; `yarn check-types`.** The client-core reducer's exhaustive switch over `HostToWebview` (if any) needs a no-op arm for `attachment-path`; add it where the compiler asks.
- [ ] **Step 5: Commit.** `git commit -am "feat: attachment path request/reply message"`

---

### Task 7: Remote hooks and per-client gating

**Files:**
- Create: `src/daemon/client-wants.ts`, `src/daemon/remote-hooks.ts`
- Test: `src/test/unit/daemon-remote-hooks.test.ts`

**Interfaces:**
- Consumes: `REVIEW_WANTS`, `FLEET_WANTS`, `HISTORY_WANTS` from `../host/post-bus`; `EditorContextHost`, `AttachmentHost`, `FileSearch`, `ConfigHost` from `../host/message-router`; `EditorContext` from wherever `message-router.ts` imports it.
- Produces: `wantsFor(kind: ClientKind): (m: HostToWebview) => boolean`; `createRemoteHooks(io: { act(op: ActOp, args: unknown[]): void; ask(op: AskOp, args: unknown[]): Promise<unknown> }): { editor: EditorContextHost; picker: AttachmentHost; fileSearch: FileSearch; configHost: ConfigHost; setContext(ctx: EditorContext | null): void }`.

- [ ] **Step 1: Failing test:**

```ts
import * as assert from 'node:assert';
import { wantsFor } from '../../daemon/client-wants';
import { createRemoteHooks } from '../../daemon/remote-hooks';

suite('daemon remote hooks', () => {
  test('tui and sidebar want everything; review does not want session-patch', () => {
    const patch = { t: 'session-patch' } as never;
    assert.strictEqual(wantsFor('tui')(patch), true);
    assert.strictEqual(wantsFor('sidebar')(patch), true);
    assert.strictEqual(wantsFor('review')(patch), false);
    assert.strictEqual(wantsFor('history')({ t: 'sessions-changed' } as never), true);
  });

  test('current() serves the pushed context; fire-and-forget calls become act frames', () => {
    const acts: [string, unknown[]][] = [];
    const h = createRemoteHooks({ act: (op, args) => { acts.push([op, args]); }, ask: async () => undefined });
    assert.strictEqual(h.editor.current(), null);
    const ctx = { path: '/a.ts' } as never;
    h.setContext(ctx);
    assert.strictEqual(h.editor.current() === ctx, true);
    h.editor.reveal('/a.ts', 3);
    h.configHost.setFavoriteModels(['m']);
    assert.deepStrictEqual(acts, [['reveal', ['/a.ts', 3]], ['setFavoriteModels', [['m']]]]);
  });

  test('pick and search ask the client and tolerate a failed answer', async () => {
    const h = createRemoteHooks({
      act: () => {},
      ask: async (op) => { if (op === 'pick') { return ['/x']; } throw new Error('gone'); },
    });
    assert.deepStrictEqual(await h.picker.pick(), ['/x']);
    assert.deepStrictEqual(await h.fileSearch.search('q'), []);
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** `client-wants.ts`:

```ts
import type { ClientKind } from '../protocol/daemon-wire';
import type { HostToWebview } from '../protocol/messages';
import { FLEET_WANTS, HISTORY_WANTS, REVIEW_WANTS } from '../host/post-bus';

const ALL = (): boolean => true;

export function wantsFor(kind: ClientKind): (m: HostToWebview) => boolean {
  switch (kind) {
    case 'review': return REVIEW_WANTS;
    case 'fleet': return FLEET_WANTS;
    case 'history': return HISTORY_WANTS;
    default: return ALL;
  }
}
```

`remote-hooks.ts`:

```ts
import type { ActOp, AskOp } from '../protocol/daemon-wire';
import type { AttachmentHost, ConfigHost, EditorContextHost, FileSearch } from '../host/message-router';

type EditorContext = ReturnType<EditorContextHost['current']>;

export interface HookIo {
  act(op: ActOp, args: unknown[]): void;
  ask(op: AskOp, args: unknown[]): Promise<unknown>;
}

export function createRemoteHooks(io: HookIo) {
  let ctx: EditorContext = null;
  const editor: EditorContextHost = {
    current: () => ctx,
    reveal: (path, line) => io.act('reveal', [path, line]),
    openDiff: (root, path, base) => io.act('openDiff', [root, path, base]),
    openSettings: (section) => io.act('openSettings', [section]),
    openExternal: (url) => io.act('openExternal', [url]),
    exportCsv: (csv) => io.act('exportCsv', [csv]),
    exportImage: (uri) => io.act('exportImage', [uri]),
    login: (providerId) => io.act('login', [providerId]),
  };
  const picker: AttachmentHost = {
    pick: async () => {
      try { const r = await io.ask('pick', []); return Array.isArray(r) ? (r as string[]) : []; } catch { return []; }
    },
  };
  const fileSearch: FileSearch = {
    search: async (query) => {
      try { const r = await io.ask('search', [query]); return Array.isArray(r) ? (r as Awaited<ReturnType<FileSearch['search']>>) : []; } catch { return []; }
    },
  };
  const configHost: ConfigHost = { setFavoriteModels: (ids) => io.act('setFavoriteModels', [ids]) };
  return { editor, picker, fileSearch, configHost, setContext: (c: EditorContext) => { ctx = c; } };
}
```

- [ ] **Step 4: Run, expect PASS; `yarn check-types`.**
- [ ] **Step 5: Commit.** `git commit -m "feat: daemon remote hooks and client gating"` (add new files first).

---

### Task 8: The connection state machine

**Files:**
- Create: `src/daemon/connection.ts`
- Test: `src/test/unit/daemon-connection.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 3, 7. `MessageRouter` constructor from `../host/message-router`.
- Produces:

```ts
export interface FrameSocket {
  write(data: string): boolean;
  end(): void;
  buffered(): number;
  onData(cb: (chunk: string) => void): void;
  onClose(cb: () => void): void;
}
export interface ConnectionDeps {
  token: string;
  identity: DaemonIdentity;
  loginRecipes: LoginRecipeWire[];
  isBusy(): boolean;
  makeRouter(emit: (m: HostToWebview) => void, hooks: ReturnType<typeof createRemoteHooks>, hello: HelloFrame): { handle(m: WebviewToHost): Promise<void> };
  addToBus(client: PostClient): () => void;
  onRoots(roots: string[]): () => void;
  onShutdown(): void;
  onChange(): void;
  maxBuffered?: number;
}
export class DaemonConnection { constructor(socket: FrameSocket, deps: ConnectionDeps); get kind(): ClientKind | undefined; get attached(): boolean; close(): void }
```

Behavior (each is a test below): `hello` first, else `reject bad-hello` and close; wrong token → `reject bad-token`; wrong `protocolVersion` → `reject protocol-mismatch` carrying `daemon`; valid → registers roots, adds to bus with `wantsFor(kind)`, sends `welcome`; `msg` frames go to `router.handle`; `ctx` updates the proxy; `res` resolves a pending `req`; `shutdown{token}` accepted pre-hello: busy → `refuse busy`, bad token → `refuse bad-token`, else `bye` then `deps.onShutdown()`; malformed line or oversized line closes this connection only; close removes bus registration and roots and rejects pending asks; a socket whose `buffered()` exceeds `maxBuffered` (default 32MB) when the bus posts is closed.

- [ ] **Step 1: Failing tests** `src/test/unit/daemon-connection.test.ts`. Write a `FakeSocket` (arrays for writes, stored callbacks, settable `buffered`) and a `deps()` factory that records calls; then these cases:

```ts
import * as assert from 'node:assert';
import { DaemonConnection, type ConnectionDeps, type FrameSocket } from '../../daemon/connection';
import { encodeFrame } from '../../daemon/protocol';
import type { ServerFrame } from '../../protocol/daemon-wire';
import type { PostClient } from '../../host/post-bus';

class FakeSocket implements FrameSocket {
  out: ServerFrame[] = [];
  ended = false;
  bytes = 0;
  private data: (c: string) => void = () => {};
  private close: () => void = () => {};
  write(d: string) { this.out.push(JSON.parse(d) as ServerFrame); return true; }
  end() { this.ended = true; this.close(); }
  buffered() { return this.bytes; }
  onData(cb: (c: string) => void) { this.data = cb; }
  onClose(cb: () => void) { this.close = cb; }
  feed(f: object | string) { this.data(typeof f === 'string' ? f : encodeFrame(f as never)); }
}

const HELLO = { f: 'hello', protocolVersion: 1, appVersion: '1', clientKind: 'tui', token: 'tok', roots: ['/r'], defaultCwd: '/r' };

function setup(over: Partial<ConnectionDeps> = {}) {
  const sock = new FakeSocket();
  const handled: unknown[] = [];
  const bus: PostClient[] = [];
  const state = { shutdown: 0, roots: [] as string[][], rootsDropped: 0, changes: 0 };
  const deps: ConnectionDeps = {
    token: 'tok', identity: { protocolVersion: 1, appVersion: '1' }, loginRecipes: [],
    isBusy: () => false,
    makeRouter: () => ({ handle: async (m) => { handled.push(m); } }),
    addToBus: (c) => { bus.push(c); return () => { bus.splice(bus.indexOf(c), 1); }; },
    onRoots: (r) => { state.roots.push(r); return () => { state.rootsDropped++; }; },
    onShutdown: () => { state.shutdown++; },
    onChange: () => { state.changes++; },
    ...over,
  };
  const conn = new DaemonConnection(sock, deps);
  return { sock, conn, handled, bus, state };
}

suite('daemon connection', () => {
  test('a valid hello is welcomed and registered on the bus', () => {
    const t = setup();
    t.sock.feed(HELLO);
    assert.strictEqual(t.sock.out[0].f, 'welcome');
    assert.strictEqual(t.bus.length, 1);
    assert.deepStrictEqual(t.state.roots, [['/r']]);
  });

  test('anything before hello is rejected and closed', () => {
    const t = setup();
    t.sock.feed({ f: 'msg', m: { t: 'ready' } });
    assert.deepStrictEqual(t.sock.out[0], { f: 'reject', reason: 'bad-hello', daemon: { protocolVersion: 1, appVersion: '1' } });
    assert.strictEqual(t.sock.ended, true);
  });

  test('a wrong token and a wrong protocol version are rejected distinctly', () => {
    const a = setup(); a.sock.feed({ ...HELLO, token: 'nope' });
    assert.strictEqual((a.sock.out[0] as { reason: string }).reason, 'bad-token');
    const b = setup(); b.sock.feed({ ...HELLO, protocolVersion: 9 });
    assert.strictEqual((b.sock.out[0] as { reason: string }).reason, 'protocol-mismatch');
    assert.strictEqual(b.bus.length, 0);
  });

  test('msg frames reach the router after hello', async () => {
    const t = setup();
    t.sock.feed(HELLO);
    t.sock.feed({ f: 'msg', m: { t: 'ready' } });
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(t.handled, [{ t: 'ready' }]);
  });

  test('garbage closes this connection and nothing else', () => {
    const t = setup();
    t.sock.feed(HELLO);
    t.sock.feed('this is not json\n');
    assert.strictEqual(t.sock.ended, true);
    assert.strictEqual(t.bus.length, 0);
    assert.strictEqual(t.state.rootsDropped, 1);
  });

  test('a frame split across two chunks is reassembled', () => {
    const t = setup();
    const line = encodeFrame(HELLO as never);
    t.sock.feed(line.slice(0, 10));
    t.sock.feed(line.slice(10));
    assert.strictEqual(t.sock.out[0].f, 'welcome');
  });

  test('shutdown with the token is refused while busy and honoured while idle', () => {
    const busy = setup({ isBusy: () => true });
    busy.sock.feed({ f: 'shutdown', token: 'tok' });
    assert.deepStrictEqual(busy.sock.out[0], { f: 'refuse', reason: 'busy' });
    assert.strictEqual(busy.state.shutdown, 0);
    const idle = setup();
    idle.sock.feed({ f: 'shutdown', token: 'tok' });
    assert.strictEqual(idle.sock.out[0].f, 'bye');
    assert.strictEqual(idle.state.shutdown, 1);
    const bad = setup();
    bad.sock.feed({ f: 'shutdown', token: 'x' });
    assert.deepStrictEqual(bad.sock.out[0], { f: 'refuse', reason: 'bad-token' });
  });

  test('a bus post to a client more than the cap behind drops it', () => {
    const t = setup({ maxBuffered: 100 });
    t.sock.feed(HELLO);
    t.sock.bytes = 101;
    t.bus[0].post({ t: 'sessions-changed', sessions: [] } as never);
    assert.strictEqual(t.sock.ended, true);
  });

  test('closing removes the bus registration and the roots', () => {
    const t = setup();
    t.sock.feed(HELLO);
    t.sock.end();
    assert.strictEqual(t.bus.length, 0);
    assert.strictEqual(t.state.rootsDropped, 1);
    assert.strictEqual(t.conn.attached, false);
  });
});
```

Add one more case for `ctx` + `res`: feed `{ f: 'ctx', ctx: {...} }` and assert `makeRouter`'s received `hooks.editor.current()` returns it; then capture a `req` via `hooks.picker.pick()` (write appears in `sock.out` with `f: 'req'`), feed the matching `res`, and assert the promise resolves; and a close with a pending `pick()` resolves `[]` (does not hang).

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** `src/daemon/connection.ts`. Key structure:

```ts
import type { ClientFrame, ClientKind, DaemonIdentity, LoginRecipeWire, ServerFrame } from '../protocol/daemon-wire';
import type { HostToWebview, WebviewToHost } from '../protocol/messages';
import type { PostClient } from '../host/post-bus';
import { wantsFor } from './client-wants';
import { createRemoteHooks } from './remote-hooks';
import { encodeFrame, LineDecoder, parseFrame } from './protocol';

export type HelloFrame = Extract<ClientFrame, { f: 'hello' }>;
// FrameSocket, ConnectionDeps as specified above.

export class DaemonConnection {
  private readonly decoder = new LineDecoder();
  private hello: HelloFrame | undefined;
  private router: { handle(m: WebviewToHost): Promise<void> } | undefined;
  private hooks: ReturnType<typeof createRemoteHooks> | undefined;
  private unbus: (() => void) | undefined;
  private unroots: (() => void) | undefined;
  private closed = false;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();

  constructor(private readonly socket: FrameSocket, private readonly deps: ConnectionDeps) {
    socket.onData((chunk) => this.onChunk(chunk));
    socket.onClose(() => this.teardown());
  }

  get kind(): ClientKind | undefined { return this.hello?.clientKind; }
  get attached(): boolean { return this.unbus !== undefined && !this.closed; }
  close(): void { this.socket.end(); this.teardown(); }

  private send(frame: ServerFrame): void { if (!this.closed) { this.socket.write(encodeFrame(frame)); } }

  private onChunk(chunk: string): void {
    let lines: string[];
    try { lines = this.decoder.push(chunk); } catch { this.close(); return; }
    for (const line of lines) {
      const frame = parseFrame(line);
      if (!frame) { this.close(); return; }
      this.onFrame(frame as ClientFrame);
      if (this.closed) { return; }
    }
  }

  private onFrame(frame: ClientFrame): void {
    if (frame.f === 'shutdown') { this.onShutdownFrame(frame.token); return; }
    if (!this.hello) {
      if (frame.f !== 'hello') { this.reject('bad-hello'); return; }
      this.onHello(frame);
      return;
    }
    switch (frame.f) {
      case 'msg': void this.router?.handle(frame.m).catch((err) => console.error('[marcode] daemon: handler failed', err)); return;
      case 'ctx': this.hooks?.setContext(frame.ctx as never); return;
      case 'res': this.settle(frame); return;
      default: return;
    }
  }
  // onHello: check token, then protocolVersion; set this.hello; roots; hooks via createRemoteHooks({
  //   act: (op, args) => this.send({ f: 'act', op, args }),
  //   ask: (op, args) => new Promise((resolve, reject) => { const id = this.nextId++; this.pending.set(id, { resolve, reject }); this.send({ f: 'req', id, op, args }); }) });
  // router = deps.makeRouter((m) => this.send({ f: 'msg', m }), hooks, hello);
  // unbus = deps.addToBus({ wants: wantsFor(kind), post: (m) => this.post(m) });
  // send welcome; deps.onChange().
  // post(m): if (socket.buffered() > (deps.maxBuffered ?? 32 * 1024 * 1024)) { this.close(); return; } this.send({ f: 'msg', m }).
  // reject(reason): send reject with deps.identity, then close().
  // onShutdownFrame(token): token !== deps.token -> refuse bad-token; deps.isBusy() -> refuse busy; else send bye, deps.onShutdown().
  // settle(res): resolve or reject the pending entry and delete it.
  // teardown(): idempotent; closed = true; unbus?.(); unroots?.(); reject every pending ask with new Error('closed'); deps.onChange().
}
```

Fill in the commented methods in full (no stubs), keeping the file under 150 lines. `pick`/`search` already tolerate a rejected ask (Task 7), which is what makes a close with a pending ask resolve `[]`.

- [ ] **Step 4: Run, expect PASS; `yarn check-types && yarn lint`.**
- [ ] **Step 5: Commit.** `git commit -m "feat: daemon connection state machine"`

---

### Task 9: The server on a real pipe

**Files:**
- Create: `src/daemon/daemon-server.ts`
- Test: `src/test/unit/daemon-server.test.ts`

**Interfaces:**
- Consumes: `DaemonConnection`, `FrameSocket`, `PostBus`.
- Produces: `class DaemonServer { constructor(opts: { endpoint: string; connectionDeps: Omit<ConnectionDeps, 'addToBus' | 'onChange' | 'onRoots'> & { onChange(): void }; bus: PostBus }); listen(): Promise<void>; close(): Promise<void>; clientCount(): number; roots(): string[]; onRootsChanged(cb): void }`. `roots()` is the de-duplicated union over attached connections, plus any roots passed at startup.

- [ ] **Step 1: Failing test** over a real pipe/socket, no host involved (fake `makeRouter`):

```ts
import * as assert from 'node:assert';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { DaemonServer } from '../../daemon/daemon-server';
import { endpointFor } from '../../daemon/endpoint';
import { encodeFrame, LineDecoder } from '../../daemon/protocol';
import { PostBus } from '../../host/post-bus';

const HELLO = (kind: string, roots: string[]) => ({
  f: 'hello', protocolVersion: 1, appVersion: '1', clientKind: kind, token: 'tok', roots, defaultCwd: roots[0] ?? '/',
});

function client(endpoint: string): Promise<{ sock: net.Socket; frames: any[]; send(f: object): void }> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(endpoint);
    const dec = new LineDecoder();
    const frames: any[] = [];
    sock.setEncoding('utf8');
    sock.on('data', (c: string) => { for (const l of dec.push(c)) { frames.push(JSON.parse(l)); } });
    sock.once('connect', () => resolve({ sock, frames, send: (f) => { sock.write(encodeFrame(f as never)); } }));
    sock.once('error', reject);
  });
}
const until = async (cond: () => boolean) => { for (let i = 0; i < 100 && !cond(); i++) { await new Promise((r) => setTimeout(r, 10)); } };

suite('daemon server', () => {
  let server: DaemonServer;
  let bus: PostBus;
  let endpoint: string;
  setup(async () => {
    bus = new PostBus();
    endpoint = endpointFor(path.join(os.tmpdir(), `mar-srv-${process.pid}-${Date.now()}`));
    server = new DaemonServer({
      endpoint, bus,
      connectionDeps: {
        token: 'tok', identity: { protocolVersion: 1, appVersion: '1' }, loginRecipes: [],
        isBusy: () => false, makeRouter: () => ({ handle: async () => {} }),
        onShutdown: () => {}, onChange: () => {},
      },
    });
    await server.listen();
  });
  teardown(async () => { await server.close(); });

  test('two clients attach; a bus post reaches only the one whose kind wants it', async () => {
    const tui = await client(endpoint);
    const review = await client(endpoint);
    tui.send(HELLO('tui', ['/a']));
    review.send(HELLO('review', ['/b']));
    await until(() => tui.frames.length > 0 && review.frames.length > 0);
    assert.strictEqual(server.clientCount(), 2);
    assert.deepStrictEqual(server.roots().sort(), ['/a', '/b']);
    bus.post({ t: 'session-patch' } as never);
    await until(() => tui.frames.length > 1);
    assert.strictEqual(tui.frames.some((f) => f.f === 'msg'), true);
    assert.strictEqual(review.frames.some((f) => f.f === 'msg'), false);
    tui.sock.destroy(); review.sock.destroy();
  });

  test('a client sending garbage does not disturb another', async () => {
    const good = await client(endpoint);
    const bad = await client(endpoint);
    good.send(HELLO('tui', ['/a']));
    bad.sock.write('{{{{ not json\n');
    await until(() => good.frames.length > 0);
    await until(() => server.clientCount() === 1);
    assert.strictEqual(server.clientCount(), 1);
    bus.post({ t: 'session-patch' } as never);
    await until(() => good.frames.length > 1);
    assert.strictEqual(good.frames.length > 1, true);
    good.sock.destroy();
  });

  test('closing a client drops its roots and count', async () => {
    const c = await client(endpoint);
    c.send(HELLO('tui', ['/a']));
    await until(() => server.clientCount() === 1);
    c.sock.destroy();
    await until(() => server.clientCount() === 0);
    assert.deepStrictEqual(server.roots(), []);
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** `src/daemon/daemon-server.ts`: `net.createServer`, `setEncoding('utf8')` per socket, wrap each socket as a `FrameSocket` (`write: s.write(d)`, `buffered: () => s.writableLength`, `onData: s.on('data')`, `onClose: s.on('close')`, `end: s.end()`), swallow `socket.on('error')` (the `close` event follows), keep a `Set<DaemonConnection>`. A per-connection roots map backs `onRoots(roots)` returning an unsubscriber that deletes the entry and notifies `onRootsChanged`. On POSIX, `mkdir` the socket's parent with mode `0o700`, remove a stale socket file before `listen`, and `chmod 0o600` after. `close()` ends every connection and resolves when the server closes. `connectionDeps.onChange` is called through to the caller on every attach/detach so the idle monitor re-checks.

- [ ] **Step 4: Run, expect PASS. Run the guarded `yarn test:unit`.**
- [ ] **Step 5: Commit.** `git commit -m "feat: daemon server over a named pipe"`

---

### Task 10: `runDaemon` and the `marcode daemon` command

**Files:**
- Create: `src/daemon/run-daemon.ts`
- Modify: `src/tui/cli.ts`, `src/tui/subcommands.ts`, `src/tui/ui/main.tsx` (dispatch)
- Test: `src/test/unit/daemon-run.test.ts`, `src/test/unit/tui-cli.test.ts` (existing; add cases)

**Interfaces:**
- Consumes: Tasks 1-9, `createHost`, `MessageRouter`, `terminalFileIndex` (`src/host/terminal-file-index.ts`).
- Produces:

```ts
export interface RunDaemonOptions {
  workspaceDir: string;
  config: HostConfig;
  appVersion: string;
  initialRoots: string[];
  idleMsOverride?: number;
  log?: (line: string) => void;
}
export interface RunningDaemon { info: DaemonInfo; done: Promise<void>; stop(): Promise<void> }
export function runDaemon(opts: RunDaemonOptions): Promise<RunningDaemon>;
```

and `CliCommand` gains `{ kind: 'daemon'; action: 'serve' | 'status' | 'stop'; workspaceDir?: string; roots: string[] }`.

Behavior: `runDaemon` builds a `PostBus`; calls `createHost({ workspaceDir, config, hostKind: 'daemon', workspaceRoots: () => server.roots().length ? server.roots() : initialRoots, emit: bus.post, notify: { warn: log } })`; `host.init()`; builds `loginRecipes` (`LoginRecipeWire[]`, env = keys of `recipe.env` whose value differs from `process.env`); starts `DaemonServer` with `makeRouter` creating `new MessageRouter(host.manager, emit, hello.defaultCwd, hooks.editor, host.attachments, hooks.picker, config.review.pollIntervalMs, hooks.fileSearch, config.favoriteModels, hooks.configHost)`; writes `daemon.json` only after `listen()` resolves; `IdleMonitor` with `busy: () => isBusy(host.manager.summaries())`, rechecked on every `onChange` and on every `bus.post` of a `session-status` message (wrap the bus: `emit: (m) => { bus.post(m); if (m.t === 'session-status') monitor.check(); }`); `onIdle` and `onShutdown` both call `stop()`, which is idempotent: dispose monitor, close server, `host.dispose()`, `removeDaemonInfo(dir, process.pid)`, resolve `done`. `SIGTERM`/`SIGINT` call `stop()` when run from the CLI.

`marcode daemon --serve --workspace-dir <d> [--root <r>]...` runs `runDaemon` and awaits `done`, appending log lines to `<workspaceDir>/daemon.log`. `--status` reads `daemon.json` for the workspace derived from `cwd` (same derivation as `bootHost`) and prints `running pid=… protocol=… started=…` or `not running`. `--stop` sends a token'd `shutdown` and prints the daemon's `bye`/`refuse`.

- [ ] **Step 1: Failing tests.**
  - `tui-cli.test.ts`: `parseArgs(['daemon','--serve','--workspace-dir','/w','--root','/r'])` equals `{ kind: 'daemon', action: 'serve', workspaceDir: '/w', roots: ['/r'] }`; `['daemon','--status']` and `['daemon','--stop']` map to their actions; `['daemon']` alone is `{ kind: 'error', … }` mentioning the three flags; `['daemon','--serve']` without `--workspace-dir` is an error.
  - `daemon-run.test.ts` (uses `enabledProviders: ['fake']`, `memory.enabled: false`, a temp dir, a client helper like Task 9's): starts `runDaemon`, asserts `daemon.json` exists and its `endpoint` accepts a `hello` + `msg {t:'ready'}` and answers a `hydrate` whose `catalog` contains `fake`; asserts `stop()` removes `daemon.json` and closes the socket; asserts an `idleMsOverride: 50` daemon with no clients exits on its own (`await done`); asserts an attached client keeps it alive past the idle time; asserts a `shutdown{token}` while a fake session is `running` is refused (create a session via `{t:'create-session',…}` and `send` using the fake provider's `permission fixture` prompt so it parks in `awaiting-approval`, which is non-idle).

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** as specified above. Add the `daemon` branch to `parseArgs` before the prompt-word loop; add to `USAGE`: `marcode daemon --status|--stop   show or stop this workspace's background host`. In `main.tsx`'s `run()` switch add `case 'daemon': return runDaemonCommand(cmd);` implemented in `subcommands.ts`.
- [ ] **Step 4: Run, expect PASS; `yarn check-types && yarn lint`.**
- [ ] **Step 5: Commit.** `git commit -m "feat: marcode daemon command and runDaemon"`

---

### Task 11: Discovery, spawn lock and version policy

**Files:**
- Create: `src/daemon-client/discover.ts`, `src/daemon-client/spawn-lock.ts`, `src/daemon-client/version-policy.ts`
- Test: `src/test/unit/daemon-client-policy.test.ts`

**Interfaces:**
- Produces:

```ts
// discover.ts
export function discover(dir: string, pidAlive?: (pid: number) => boolean): Promise<DaemonInfo | undefined>;
// spawn-lock.ts
export function acquireSpawnLock(dir: string, opts?: { staleMs?: number; pidAlive?: (pid: number) => boolean; now?: () => number }): Promise<(() => Promise<void>) | undefined>;
// version-policy.ts
export type AttachDecision = 'attach' | 'replace' | 'refuse-newer';
export function decideAttach(daemonProtocol: number, myProtocol: number): AttachDecision;
```

- [ ] **Step 1: Failing tests:**

```ts
import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { discover } from '../../daemon-client/discover';
import { acquireSpawnLock } from '../../daemon-client/spawn-lock';
import { decideAttach } from '../../daemon-client/version-policy';
import { writeDaemonInfo } from '../../daemon/daemon-info';

suite('daemon client policy', () => {
  let dir: string;
  setup(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-dcp-')); });
  teardown(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  const info = (pid: number) => ({ pid, endpoint: 'e', token: 't', protocolVersion: 1, appVersion: '1', startedAt: 1 });

  test('discover returns a live daemon and ignores a dead pid', async () => {
    await writeDaemonInfo(dir, info(111));
    assert.strictEqual((await discover(dir, () => true))?.pid, 111);
    assert.strictEqual(await discover(dir, () => false), undefined);
  });

  test('discover is undefined when there is no daemon.json', async () => {
    assert.strictEqual(await discover(dir), undefined);
  });

  test('only one of two concurrent callers gets the spawn lock', async () => {
    const [a, b] = await Promise.all([acquireSpawnLock(dir), acquireSpawnLock(dir)]);
    assert.strictEqual([a, b].filter(Boolean).length, 1);
    await (a ?? b)?.();
    assert.strictEqual(typeof (await acquireSpawnLock(dir)), 'function');
  });

  test('a lock held by a dead pid, or older than staleMs, is taken over', async () => {
    await fs.writeFile(path.join(dir, 'daemon.lock'), JSON.stringify({ pid: 999, at: Date.now() }));
    assert.strictEqual(typeof (await acquireSpawnLock(dir, { pidAlive: () => false })), 'function');
    await fs.writeFile(path.join(dir, 'daemon.lock'), JSON.stringify({ pid: process.pid, at: Date.now() - 60_000 }));
    assert.strictEqual(typeof (await acquireSpawnLock(dir, { staleMs: 30_000, pidAlive: () => true })), 'function');
  });

  test('version policy: equal attaches, older daemon is replaced, newer is never killed', () => {
    assert.strictEqual(decideAttach(1, 1), 'attach');
    assert.strictEqual(decideAttach(1, 2), 'replace');
    assert.strictEqual(decideAttach(3, 2), 'refuse-newer');
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**

`discover.ts`: `readDaemonInfo(dir)`; if undefined return undefined; if `!pidAlive(info.pid)` return undefined; else info. Default `pidAlive`: `process.kill(pid, 0)` with `EPERM` treated as alive (copy the helper from `lease.ts:defaultLeaseDeps`).

`spawn-lock.ts`: body `JSON.stringify({ pid: process.pid, at: now() })`; `createExclusive(path.join(dir,'daemon.lock'), body)`; on false, read it: if parse fails, or `!pidAlive(pid)`, or `now() - at > staleMs` (default 30_000), `fs.rm` it and retry `createExclusive` once; return a release that removes the lock only if it still holds our pid; return `undefined` when another live holder has it.

`version-policy.ts`: `daemon === mine ? 'attach' : daemon < mine ? 'replace' : 'refuse-newer'`.

- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit.** `git commit -m "feat: daemon discovery, spawn lock, version policy"`

---

### Task 12: The client transport and `connectOrSpawn`

**Files:**
- Create: `src/daemon-client/daemon-client.ts`, `src/daemon-client/connect-or-spawn.ts`, `src/daemon-client/spawn-daemon.ts`
- Test: `src/test/unit/daemon-client.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 3, 10 (`runDaemon`), 11.
- Produces:

```ts
// daemon-client.ts
export type ClientStatus = 'connected' | 'reconnecting' | 'lost';
export interface ClientHooks {
  context?: () => unknown;
  act?(op: ActOp, args: unknown[]): void;
  ask?(op: AskOp, args: unknown[]): Promise<unknown>;
}
export interface DaemonClient extends ClientTransport {
  readonly loginRecipes: LoginRecipeWire[];
  onStatus(cb: (s: ClientStatus) => void): () => void;
  pushContext(ctx: unknown): void;
  close(): void;
}
export function attach(info: DaemonInfo, hello: Omit<Extract<ClientFrame, {f:'hello'}>, 'f' | 'token' | 'protocolVersion' | 'appVersion'>, hooks: ClientHooks, identity: DaemonIdentity): Promise<{ client: DaemonClient } | { rejected: Extract<ServerFrame, {f:'reject'}> }>;

// connect-or-spawn.ts
export type ConnectResult =
  | { kind: 'attached'; client: DaemonClient }
  | { kind: 'fallback'; reason: 'disabled' | 'newer-daemon' | 'busy-daemon' | 'spawn-failed' | 'rejected'; message: string };
export interface ConnectOptions {
  workspaceDir: string;
  clientKind: ClientKind;
  roots: string[];
  defaultCwd: string;
  identity: DaemonIdentity;
  hooks: ClientHooks;
  spawn(): Promise<void>;
  timeoutMs?: number;
}
export function connectOrSpawn(opts: ConnectOptions): Promise<ConnectResult>;

// spawn-daemon.ts
export function daemonSpawnCommand(workspaceDir: string, roots: string[]): { command: string; args: string[] };
export function spawnDetached(workspaceDir: string, roots: string[]): Promise<void>;
```

Behavior of `connectOrSpawn`: (1) `discover`; if found, `decideAttach(info.protocolVersion, identity.protocolVersion)`: `attach` → `attach()`; `replace` → connect, send `{f:'shutdown', token}`, on `bye` poll `discover` until it is `undefined` (≤5 s) then continue to spawn; on `refuse` → `fallback busy-daemon` with message "A newer Marcode build is needed but sessions are running; close them or restart"; `refuse-newer` → `fallback newer-daemon` with message "The background host is a newer Marcode version; update this client". (2) Nothing attachable: `acquireSpawnLock`; if obtained, re-`discover` (another client may have just finished), else `spawn()`, release the lock; if the lock is held by another, skip spawning. (3) Poll `discover` + `attach` every 100 ms up to `timeoutMs` (default 10_000); on timeout `fallback spawn-failed`. A `reject` of `bad-token`/`protocol-mismatch` from `attach` re-runs discovery once (the daemon may have been replaced between read and connect) before `fallback rejected`.

`DaemonClient` reconnect: on socket `close` not initiated by `close()`, emit `onStatus('reconnecting')`, retry `connectOrSpawn`-style attach up to 5 times with 200 ms · 2ⁿ backoff (spawning if no daemon), then re-send `{t:'ready'}` through its own listeners' transport so the reducer re-hydrates, and emit `connected`; after the retries emit `lost`.

- [ ] **Step 1: Failing tests** `src/test/unit/daemon-client.test.ts`. Each starts a real in-process `runDaemon` (`enabledProviders: ['fake']`, `memory.enabled: false`, temp `workspaceDir`) and passes `spawn: () => startInProcess()` as the spawn recipe:
  - attaches to a running daemon and `post({t:'ready'})` yields a `hydrate` via `onMessage`.
  - no daemon: `connectOrSpawn` calls `spawn` exactly once and attaches, and the Review Focus race holds: two simultaneous `connectOrSpawn` calls with the same `spawn` counter produce one spawn and both `attached`.
  - a `daemon.json` pointing at a dead pid (write one with `pid: 2_000_000_000`) is recovered: result is `attached`, spawn called once.
  - the daemon's `protocolVersion` lower than the client's and idle: the client replaces it; `spawn` called once; result `attached`; the old daemon's `done` resolved.
  - the daemon's `protocolVersion` higher than the client's: result `fallback newer-daemon`, and the daemon still answers a fresh `hello` afterwards (it was not killed).
  - an older-protocol daemon that is busy (a fake session parked in `awaiting-approval`): result `fallback busy-daemon`, daemon alive.
  - kill the daemon (`stop()`), then `post` from an attached client: status goes `reconnecting` then `connected` (spawn recipe restarts it), and a `hydrate` arrives after.
  - `pushContext(ctx)` sends a `ctx` frame (observe with a router stub or by reading `editor-context` in a subsequent `ready` hydrate).

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** the three files per the interfaces. `spawn-daemon.ts`:

```ts
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const isBunRuntime = (): boolean => /^bun(\.exe)?$/i.test(path.basename(process.execPath));

export function daemonSpawnCommand(workspaceDir: string, roots: string[]): { command: string; args: string[] } {
  const tail = ['daemon', '--serve', '--workspace-dir', workspaceDir, ...roots.flatMap((r) => ['--root', r])];
  return isBunRuntime()
    ? { command: process.execPath, args: [process.argv[1], ...tail] }
    : { command: process.execPath, args: tail };
}

export async function spawnDetached(workspaceDir: string, roots: string[]): Promise<void> {
  const { command, args } = daemonSpawnCommand(workspaceDir, roots);
  const log = fs.openSync(path.join(workspaceDir, 'daemon.log'), 'a');
  const child = spawn(command, args, { detached: true, stdio: ['ignore', log, log], windowsHide: true });
  child.unref();
  fs.closeSync(log);
}
```

(`workspaceDir` already exists by the time a client calls this; `connectOrSpawn` ensures it with `fs.mkdir(recursive)` first.)

- [ ] **Step 4: Run, expect PASS; `yarn check-types && yarn lint`; guarded `yarn test:unit`.**
- [ ] **Step 5: Commit.** `git commit -m "feat: daemon client, connectOrSpawn and spawn recipe"`

---

### Task 13: TUI uses the daemon

**Files:**
- Modify: `src/tui/boot.ts`, `src/tui/subcommands.ts`, `src/tui/ui/main.tsx`; read `src/tui/shutdown.ts` first
- Test: `src/test/unit/tui-boot.test.ts` (existing), `src/test/tui/boot-bun.test.ts` (existing, extend)

**Interfaces:**
- Consumes: Task 12.
- Produces: `BootOptions.inProcess?: boolean`; `Booted.loginRecipes: Map<string, LoginRecipe>` (replaces `host` for callers; keep `host?: HostHandle` set only in-process); `Booted.loopback: { transport: ClientTransport }`; `Booted.router?: MessageRouter` (in-process only); `Booted.mode: 'daemon' | 'in-process'`; `Booted.onStatus(cb)`; `Booted.fallbackReason?: string`.

Behavior: `bootHost` loads config as today. If `!opts.inProcess && config.daemon.enabled`, it calls `connectOrSpawn` with `clientKind: 'tui'`, `roots: [workspaceRoot]`, `defaultCwd: opts.cwd`, `hooks` from `terminalEditorHost`/file picker/`createTerminalFileIndex(workspaceRoot).search`, and `spawn: () => spawnDetached(workspaceDir, [workspaceRoot])`. On `attached`: return a `Booted` whose `loopback.transport` is the `DaemonClient`, whose `shutdown()` only calls `client.close()` (the daemon keeps running; do not interrupt sessions), and whose `loginRecipes` map is built from `client.loginRecipes` (`env: { ...process.env, ...r.env }`). The `open-attachment` interception becomes: post `request-attachment-path` through the transport, await the matching `attachment-path` message by `reqId`, then `openPath`. On `fallback`: log the reason once as a warning in `warnings` (it reaches the notice line) and continue with the existing in-process path unchanged. `runLogin` and `runMigrate` pass `inProcess: true`. In `main.tsx`, `booted.host.loginRecipes` becomes `booted.loginRecipes`; subscribe `booted.onStatus` to the notices (`reconnecting` → "Reconnecting to the background host…", `lost` → "Lost the background host; restart marcode").

- [ ] **Step 1: Failing tests.**
  - `tui-boot.test.ts`: existing tests call `bootHost` with `config` overrides; make them pass `inProcess: true` (they test the in-process path) and add: with `daemon.enabled: true` and a spawn recipe injected through a new `BootOptions.spawnDaemon` (test seam, default `spawnDetached`) that starts `runDaemon` in-process, `bootHost` returns `mode: 'daemon'`, `ready` yields a hydrate with `fake`, and `shutdown()` leaves the daemon running (its `daemon.json` still present and `discover` still finds it).
  - Review Focus 4: boot, create a fake session and send the `permission fixture` prompt (parks in `awaiting-approval`), `shutdown()` the booted client, boot a second `bootHost`, `ready`, and assert the hydrate's `sessions` shows that session still `awaiting-approval`.
  - `daemon.enabled: false` boots in-process with no `daemon.json` written.
  - Daemon unavailable (spawn recipe that throws): boots in-process, `mode: 'in-process'`, `warnings` has one entry mentioning the background host.

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** as specified. `grep -rn "booted.host\|\.loopback\.\|\.router" src/tui src/test` and update each use; the compiler lists the rest. Check `src/tui/shutdown.ts` and keep any "interrupt running sessions on exit" behavior in-process only: in daemon mode quitting must not interrupt.
- [ ] **Step 4: Run `yarn test:unit`, `yarn test:tui`, `yarn check-types`, `yarn lint`, `yarn run compile`.** Expected: all green.
- [ ] **Step 5: Commit.** `git commit -m "feat: TUI attaches to the daemon with in-process fallback"`

---

### Task 14: Cross-runtime, compiled binary, provider busy checks, docs

**Files:**
- Create: `src/test/tui/daemon-bun.test.ts`, `src/test/unit/daemon-provider-busy.test.ts`, `docs/daemon.md`
- Modify: `AGENTS.md`, `docs/tui.md`, `docs/superpowers/specs/2026-10-09-marcode-daemon-design.md`

- [ ] **Step 1: Cross-runtime test** (`bun test`, in `src/test/tui/daemon-bun.test.ts`): spawn a Node daemon child (`node --import tsx -e` is not available; use the built daemon instead: run `yarn build:tui` is a Bun build, so launch the daemon as a Bun child with `bun src/tui/ui/main.tsx daemon --serve --workspace-dir <tmp> --root <tmp>`), then `connectOrSpawn` from the test process (Bun) and assert `hydrate`. Then repeat with the daemon started by Node via the `tsx` loader (`node --import tsx src/tui/ui/main.tsx` fails on JSX; instead add a minimal `scripts/daemon-entry.ts` that calls `runDaemon` for tests and the extension build later, and use `npx tsx scripts/daemon-entry.ts …` for the Node side). Both directions must assert the same `hydrate`. Tests never hand a renderer to an assertion.
- [ ] **Step 2: Compiled binary smoke.** Run `yarn build:tui:bin`, then by hand:

```
bin/marcode daemon --status          # expect: not running
bin/marcode                          # opens the TUI; this spawns the daemon
bin/marcode daemon --status          # expect: running pid=… protocol=1
bin/marcode daemon --stop
```

Record the result in the PR description. If the compiled binary's `process.argv[1]` is not the entry and `daemonSpawnCommand` misbuilds the command, fix `isBunRuntime`/`daemonSpawnCommand` and add a unit case for the compiled shape to `daemon-client.test.ts`.
- [ ] **Step 3: Provider busy checks** `src/test/unit/daemon-provider-busy.test.ts`: for each of Claude, Codex, OpenCode, drive the provider's existing fake/stub run (reuse the harnesses in `claude-run`, `codex-run` and `opencode` tests) so that a background task or subagent is outstanding after `turn-end`, and assert the owning `AgentSession` reports `status !== 'idle'`. Where a provider cannot be driven without a CLI, assert the event mapping emits `background-tasks-changed` for its subagent/background tool call. A provider that fails is a bug to file and fix, not to special-case in the daemon.
- [ ] **Step 4: Docs.** `docs/daemon.md`: lifecycle, files (`daemon.json`, `daemon.lock`, `daemon.log`), `marcode daemon --status|--stop`, config keys, how to tell if you are on a daemon or in-process. `AGENTS.md`: add the `src/daemon/`, `src/daemon-client/` rows to the path table, the daemon to the architecture diagram, and the invariant "a client never touches a session's JSONL or the manager directly when a daemon is attached; the daemon never imports `vscode`". `docs/tui.md`: quitting the TUI no longer stops running agents. Update the spec with the five refinements listed at the top of this plan.
- [ ] **Step 5: Full gate.** `yarn lint && yarn check-types && yarn run compile && yarn test:unit && yarn test:dom && yarn test:tui`. All green, then commit: `git commit -m "docs: daemon docs; test: cross-runtime and provider busy checks"`.

---

## Self-review notes

- **Spec coverage:** host kind (T1), wire + codec (T2), endpoint/`daemon.json`/token (T3), config (T4), busy + idle exit (T5), direct-call replacement for the TUI's one call (T6), proxies + gating (T7), handshake, rejects, shutdown, slow client, garbage (T8), real pipe, fan-out (T9), lifecycle + CLI (T10), discovery/lock/version (T11), client, reconnect, race, stale file (T12), TUI + fallback + survive-quit (T13), cross-runtime, compiled binary, per-provider busy, docs (T14). The extension, and the remaining direct manager calls it needs (`canOpenFile`, `layout`/`setLayout`, memory APIs), are deliberately the next plan.
- **Names used across tasks are consistent:** `DaemonInfo`, `ClientKind`, `FrameSocket`, `ConnectionDeps`, `DaemonConnection`, `DaemonServer`, `DaemonClient`, `ConnectResult`, `decideAttach`, `runDaemon`.
- **Known soft spots to verify early, not assume:** `SessionSummary.status` exists and a session restored from disk never keeps a stale non-idle status (if it does, `isBusy` must use live `AgentSession` state, and Task 5 gains a test for it); `EditorContext`/`FileRef`/`DiffBase` import paths in `message-router.ts`; whether the compiled binary's `process.argv` matches `daemonSpawnCommand` (Task 14 step 2).
