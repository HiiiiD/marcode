# Shared Storage and a vscode-free Host Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Marcode's host runnable without VS Code, over a `~/.marcode/` store shared with any VS Code window, so a terminal client can attach to the same sessions.

**Architecture:** No daemon. Each client keeps an in-process host; hosts share files under `~/.marcode/workspaces/<slug>/`. One session has one owner, proven by a lease file; a session leased by another live host is opened over a dormant provider with every store write for it disabled, and tailed from disk. `config.json` becomes the single source of truth for every host-consumed setting. The wiring in `activate()` moves into a vscode-free `createHost()`.

**Tech Stack:** TypeScript, Node 22 (`node:fs`, `node:crypto`, `node:sqlite`), mocha TDD-style (`suite`/`test`) via `tsx/cjs`, esbuild, VS Code `^1.125.0`.

**Spec:** [docs/superpowers/specs/2026-09-30-shared-storage-headless-host-design.md](../specs/2026-09-30-shared-storage-headless-host-design.md)

## Global Constraints

- Work on branch `feat/shared-storage-headless-host`. **Every command that depends on the directory or branch pins it:** `cd /e/Efebia/hiiiid-code && git branch --show-current` must print `feat/shared-storage-headless-host` before a commit. Subagents launch outside the worktree and shells revert cwd mid-session, so a gate run without its own `cd` is an unrun gate.
- `yarn lint`, `yarn check-types` and `yarn run compile` must pass before every commit; run tests with the guarded `yarn test:unit` / `yarn test:dom`, never the `:raw` variants.
- Conventional-commit prefixes (`feat:`, `fix:`, `test:`, `chore:`, `docs:`). Commit after every task. **No `Co-Authored-By` or any Claude/Anthropic trailer** on any commit.
- Filenames are kebab-case. Comments only for non-obvious "why"; never more comment than code.
- `src/protocol/messages.ts` stays types-only. Nothing under `src/providers/` or `src/protocol/` imports `vscode`, and **neither do any new module in this plan** (`src/host/atomic-file.ts`, `workspace-dir.ts`, `lease.ts`, `session-ownership.ts`, `dormant-provider.ts`, `foreign-tail.ts`, `roster-sync.ts`, `host-config.ts`, `config-file.ts`, `create-host.ts`, `migrate-storage.ts`, `src/shared/workspace-dir.ts`). Only `extension.ts` and the existing UI shells import `vscode`.
- Errors are state, never exceptions: a failed lease/config/migration step yields a returned reason or a session `error` item, never a rejection across `postMessage`.
- Never hand a DOM node to an assertion (compare booleans/strings/counts). DOM tests drive components through the real `StoreProvider` with `sendFromHost`.
- Every change under `src/webview/components/` is followed by `node <impeccable-skill-dir>/scripts/detect.mjs --json <changed files>` (exit 0 required).
- Storage layout, constants and names are exactly those in the spec: `MARCODE_HOME` overrides `~/.marcode`; heartbeat every 5s; a lease is stale after 20s or when its pid is dead on the same machine; slugs over 80 chars are cut to 64 + `-` + 8 hex of sha1.
- **Deviations from the spec, decided while planning (Task 15 writes them into the spec):** (1) `digest.lock` gates only the LLM summarizer, because extractive digests are idempotent and SQLite WAL plus `busy_timeout` makes two writers safe at the file level; (2) the pane layout is per host (`layout.<host>.json` for non-vscode hosts, the existing `index.json` `layout` field for vscode), since two clients showing different panes cannot share one layout; (3) `host-config.ts` lives in `src/host/`, not `src/shared/`, because it imports `clampCap` from `src/host/fleet-diff.ts`.

## Review Focus

Failure modes the spec implies but no single task's happy path exercises, most likely first. Each has a test in the owning task.

1. **A second host in the same process** (the integration test, and any TUI embedded in a test) has the same pid as the first. A lease that only compares pids would call its own sibling "alive and mine". Leases carry a per-host `instance` id. (Task 3, Task 15)
2. **A foreign session must never write.** `send`, delete, rename or a stray flush against a session owned elsewhere must leave its JSONL byte-identical. (Task 5, Task 8)
3. **Bad `config.json`.** Missing file, empty file, invalid JSON, a wrong-typed key: all give defaults plus a warning string, never a throw and never an empty provider list by accident. (Task 9, Task 10)
4. **Workspace path edge cases.** Drive root (`E:\`), `/`, trailing separators, unicode folder names, a symlinked workspace, the same folder spelled with different case, and two different folders that slug identically. (Task 2)
5. **Migration edge cases.** Destination already holding sessions, a failure halfway through, running it twice, an old `index.json` at a different `TRANSCRIPT_VERSION`, and no old dir at all. (Task 13)

Known limits, accepted and recorded rather than fixed: two hosts persisting `index.json` within the same few milliseconds can lose one update (the next 500 ms persist repairs it); a foreign session tails at the owner's flush cadence, not per token; deleting a foreign session is refused; attachments are not copied by the migration (transcripts keep pointing at the intact old directory); a changed `codexPath` needs a window reload like every other provider setting.

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/host/atomic-file.ts` | create | `writeFileAtomic`, `createExclusive`: the only two write primitives the shared store uses |
| `src/shared/workspace-dir.ts` | create | Pure: `normalizeWorkspacePath`, `slugOf` |
| `src/host/workspace-dir.ts` | create | `marcodeHome`, `resolveWorkspaceDir` (fs, `workspace.json` verification) |
| `src/host/lease.ts` | create | Lease file: claim, heartbeat, release, staleness |
| `src/host/session-ownership.ts` | create | Many leases behind one heartbeat timer; `claim`, `release`, `ownerOf`, `onLost` |
| `src/host/transcript-store.ts` | modify | Atomic index/usage/catalog writes, per-host layout, foreign write guard, `reloadFromDisk` |
| `src/host/dormant-provider.ts` | create | A provider whose `start()` returns an inert run |
| `src/host/roster-sync.ts` | create | Pure merge of the on-disk roster into this host's roster |
| `src/host/foreign-tail.ts` | create | Polls a foreign session's JSONL and emits patches |
| `src/host/session-manager.ts` | modify | `setOwnership`, lease claim/release, foreign open, roster reconcile |
| `src/protocol/messages.ts` | modify | `SessionState.owner?` |
| `src/host/host-config.ts` | create | `HostConfig`, defaults, `parseHostConfig` |
| `src/host/config-file.ts` | create | Load, first-import seed, patch-write, reload-relevance |
| `src/memory/fts-memory-store.ts` | modify | WAL + `busy_timeout` |
| `src/host/create-host.ts` | create | The store/provider/manager wiring extracted from `activate()` |
| `src/extension.ts` | modify | Resolve dir, load config, migrate, `createHost`, panels and commands |
| `package.json` | modify | Drop moved settings, add `marcode.config.open` |
| `src/host/migrate-storage.ts` | create | Copy-only import of the old `storageUri` |
| `src/webview/lib/owner-reason.ts` + `pane-content.tsx` | create/modify | Read-only reason for a foreign session |
| `src/test/unit/*.test.ts`, `src/test/dom/owner-readonly.test.tsx` | create | Tests per task |
| `AGENTS.md`, spec | modify | Architecture table, invariants, deviations |

---

### Task 1: Atomic file primitives

**Files:**
- Create: `src/host/atomic-file.ts`
- Test: `src/test/unit/atomic-file.test.ts`

**Interfaces:**
- Produces: `writeFileAtomic(file: string, body: string): Promise<void>`; `createExclusive(file: string, body: string): Promise<boolean>` (`true` = this call created the file, `false` = it already existed; the file is never observable half-written).

- [ ] **Step 1: Write the failing test**

```ts
import * as assert from 'assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createExclusive, writeFileAtomic } from '../../host/atomic-file';

suite('atomic-file', () => {
  let dir: string;
  setup(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-atomic-')); });
  teardown(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  test('writeFileAtomic replaces the content and leaves no temp file', async () => {
    const file = path.join(dir, 'a.json');
    await writeFileAtomic(file, '1');
    await writeFileAtomic(file, '2');
    assert.strictEqual(await fs.readFile(file, 'utf8'), '2');
    assert.deepStrictEqual((await fs.readdir(dir)).filter((n) => n.endsWith('.tmp')), []);
  });

  test('writeFileAtomic creates missing parent directories', async () => {
    const file = path.join(dir, 'x', 'y', 'a.json');
    await writeFileAtomic(file, 'ok');
    assert.strictEqual(await fs.readFile(file, 'utf8'), 'ok');
  });

  test('createExclusive: the first caller wins and the loser does not overwrite', async () => {
    const file = path.join(dir, 'lock');
    assert.strictEqual(await createExclusive(file, 'first'), true);
    assert.strictEqual(await createExclusive(file, 'second'), false);
    assert.strictEqual(await fs.readFile(file, 'utf8'), 'first');
    assert.deepStrictEqual((await fs.readdir(dir)).filter((n) => n.endsWith('.tmp')), []);
  });

  test('createExclusive: exactly one of many racers wins and the file is whole', async () => {
    const file = path.join(dir, 'race');
    const body = JSON.stringify({ pad: 'x'.repeat(4096) });
    const results = await Promise.all(Array.from({ length: 20 }, () => createExclusive(file, body)));
    assert.strictEqual(results.filter(Boolean).length, 1);
    assert.strictEqual(await fs.readFile(file, 'utf8'), body);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit -g "atomic-file"`
Expected: FAIL, cannot find module `../../host/atomic-file`.

- [ ] **Step 3: Implement**

```ts
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);

function tmpName(file: string): string {
  return `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (attempt >= 4 || !RETRYABLE.has(code)) { throw err; }
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}

export async function writeFileAtomic(file: string, body: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = tmpName(file);
  try {
    await fs.writeFile(tmp, body, 'utf8');
    await renameWithRetry(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => { /* best effort */ });
    throw err;
  }
}

/**
 * `wx` alone is not enough: it creates the file empty before the body lands,
 * so a concurrent reader can see a valid-looking but empty lock. A hard link
 * publishes the finished file in one step. Filesystems without hard links fall
 * back to `wx`.
 */
export async function createExclusive(file: string, body: string): Promise<boolean> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = tmpName(file);
  await fs.writeFile(tmp, body, 'utf8');
  try {
    await fs.link(tmp, file);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') { return false; }
    if (code === 'EPERM' || code === 'ENOSYS' || code === 'ENOTSUP' || code === 'EXDEV') {
      try {
        await fs.writeFile(file, body, { encoding: 'utf8', flag: 'wx' });
        return true;
      } catch (inner) {
        if ((inner as NodeJS.ErrnoException).code === 'EEXIST') { return false; }
        throw inner;
      }
    }
    throw err;
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => { /* best effort */ });
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit -g "atomic-file"`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
cd /e/Efebia/hiiiid-code && git branch --show-current && yarn lint && yarn check-types
git add src/host/atomic-file.ts src/test/unit/atomic-file.test.ts
git commit -m "feat: atomic write and exclusive-create primitives for the shared store"
```

---

### Task 2: Workspace directory resolution

**Files:**
- Create: `src/shared/workspace-dir.ts`, `src/host/workspace-dir.ts`
- Test: `src/test/unit/workspace-dir.test.ts`

**Interfaces:**
- Consumes: `createExclusive` (Task 1).
- Produces:
  - `normalizeWorkspacePath(input: string, platform?: NodeJS.Platform): string`
  - `slugOf(normalized: string): string`
  - `marcodeHome(env?: NodeJS.ProcessEnv): string`
  - `resolveWorkspaceDir(home: string, workspacePath: string | undefined): Promise<string>` returning `<home>/workspaces/<slug>[-N]` (or `_global` for `undefined`), creating it with a `workspace.json` on first use.

- [ ] **Step 1: Write the failing test**

```ts
import * as assert from 'assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { normalizeWorkspacePath, slugOf } from '../../shared/workspace-dir';
import { marcodeHome, resolveWorkspaceDir } from '../../host/workspace-dir';

suite('workspace-dir (pure)', () => {
  test('a windows path is case-folded, forward-slashed and slugged', () => {
    const n = normalizeWorkspacePath('E:\\Efebia\\hiiiid-code\\', 'win32');
    assert.strictEqual(n, 'e:/efebia/hiiiid-code');
    assert.strictEqual(slugOf(n), 'e--efebia-hiiiid-code');
  });

  test('two spellings of one windows folder share a slug', () => {
    assert.strictEqual(
      slugOf(normalizeWorkspacePath('E:/EFEBIA/x/', 'win32')),
      slugOf(normalizeWorkspacePath('e:\\efebia\\x', 'win32')),
    );
  });

  test('posix keeps case, so /Home/A and /home/a stay distinct', () => {
    assert.notStrictEqual(
      normalizeWorkspacePath('/Home/A', 'linux'),
      normalizeWorkspacePath('/home/a', 'linux'),
    );
  });

  test('drive roots and / still produce a non-empty slug', () => {
    assert.strictEqual(slugOf(normalizeWorkspacePath('E:\\', 'win32')), 'e-');
    assert.strictEqual(slugOf(normalizeWorkspacePath('/', 'linux')), '-');
  });

  test('a path over 80 chars is cut and hashed, deterministically', () => {
    const long = `/${'a'.repeat(120)}`;
    const slug = slugOf(long);
    assert.strictEqual(slug.length <= 80, true);
    assert.strictEqual(slug, slugOf(long));
    assert.notStrictEqual(slug, slugOf(`${long}b`));
  });

  test('unicode folder names are slugged to dashes, not dropped', () => {
    assert.strictEqual(slugOf('/home/ünï/proj'), '-home--n--proj');
  });
});

suite('workspace-dir (fs)', () => {
  let home: string;
  setup(async () => { home = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-home-')); });
  teardown(async () => { await fs.rm(home, { recursive: true, force: true }); });

  test('marcodeHome honours MARCODE_HOME', () => {
    assert.strictEqual(marcodeHome({ MARCODE_HOME: '/x/y' }), '/x/y');
    assert.strictEqual(marcodeHome({}).endsWith('.marcode'), true);
  });

  test('resolving twice yields the same directory and a workspace.json', async () => {
    const ws = path.join(home, 'proj');
    await fs.mkdir(ws);
    const a = await resolveWorkspaceDir(home, ws);
    const b = await resolveWorkspaceDir(home, ws);
    assert.strictEqual(a, b);
    const marker = JSON.parse(await fs.readFile(path.join(a, 'workspace.json'), 'utf8')) as { path: string };
    assert.strictEqual(marker.path, normalizeWorkspacePath(await fs.realpath(ws)));
  });

  test('two folders with the same slug get distinct directories', async () => {
    const a = await resolveWorkspaceDir(home, path.join(home, 'a', 'b-c'));
    const b = await resolveWorkspaceDir(home, path.join(home, 'a-b', 'c'));
    assert.notStrictEqual(a, b);
    assert.strictEqual(path.basename(b).endsWith('-2'), true);
  });

  test('no workspace uses _global', async () => {
    const dir = await resolveWorkspaceDir(home, undefined);
    assert.strictEqual(path.basename(dir), '_global');
  });

  test('two racing resolvers of one folder agree', async () => {
    const ws = path.join(home, 'race');
    const [a, b] = await Promise.all([resolveWorkspaceDir(home, ws), resolveWorkspaceDir(home, ws)]);
    assert.strictEqual(a, b);
  });

  test('a symlinked workspace resolves to the same directory as its target', async function () {
    const target = path.join(home, 'real');
    await fs.mkdir(target);
    const link = path.join(home, 'link');
    try { await fs.symlink(target, link, 'junction'); } catch { this.skip(); }
    assert.strictEqual(await resolveWorkspaceDir(home, link), await resolveWorkspaceDir(home, target));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit -g "workspace-dir"`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `src/shared/workspace-dir.ts`**

```ts
import { createHash } from 'node:crypto';
import * as path from 'node:path';

const MAX_SLUG = 80;
const KEPT = 64;

export function normalizeWorkspacePath(input: string, platform: NodeJS.Platform = process.platform): string {
  const win = platform === 'win32';
  let p = (win ? path.win32 : path.posix).resolve(input).replace(/\\/g, '/');
  if (p.length > 1 && p.endsWith('/')) { p = p.slice(0, -1); }
  if (win || platform === 'darwin') { p = p.toLowerCase(); }
  return p;
}

export function slugOf(normalized: string): string {
  const slug = normalized.replace(/[^a-zA-Z0-9]/g, '-');
  if (slug.length <= MAX_SLUG) { return slug; }
  const hash = createHash('sha1').update(normalized).digest('hex').slice(0, 8);
  return `${slug.slice(0, KEPT)}-${hash}`;
}
```

- [ ] **Step 4: Implement `src/host/workspace-dir.ts`**

```ts
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { normalizeWorkspacePath, slugOf } from '../shared/workspace-dir';
import { createExclusive } from './atomic-file';

export function marcodeHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.MARCODE_HOME || path.join(os.homedir(), '.marcode');
}

async function realOrSelf(p: string): Promise<string> {
  try { return await fs.realpath(p); } catch { return p; }
}

async function claimDir(dir: string, key: string): Promise<boolean> {
  const marker = path.join(dir, 'workspace.json');
  if (await createExclusive(marker, JSON.stringify({ path: key }))) { return true; }
  try {
    const parsed = JSON.parse(await fs.readFile(marker, 'utf8')) as { path?: unknown };
    return parsed.path === key;
  } catch {
    return false;
  }
}

export async function resolveWorkspaceDir(home: string, workspacePath: string | undefined): Promise<string> {
  const workspaces = path.join(home, 'workspaces');
  if (workspacePath === undefined) {
    const dir = path.join(workspaces, '_global');
    await claimDir(dir, '_global');
    return dir;
  }
  const key = normalizeWorkspacePath(await realOrSelf(workspacePath));
  const base = slugOf(key);
  for (let n = 1; ; n++) {
    const dir = path.join(workspaces, n === 1 ? base : `${base}-${n}`);
    if (await claimDir(dir, key)) { return dir; }
  }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit -g "workspace-dir"`
Expected: PASS (13 tests; the symlink test may skip on a machine that cannot create junctions).

- [ ] **Step 6: Commit**

```bash
cd /e/Efebia/hiiiid-code && git branch --show-current && yarn lint && yarn check-types
git add src/shared/workspace-dir.ts src/host/workspace-dir.ts src/test/unit/workspace-dir.test.ts
git commit -m "feat: resolve a workspace to its ~/.marcode directory"
```

---

### Task 3: Lease file

**Files:**
- Create: `src/host/lease.ts`
- Test: `src/test/unit/lease.test.ts`

**Interfaces:**
- Consumes: `createExclusive`, `writeFileAtomic` (Task 1).
- Produces:
  - `type LeaseHost = 'vscode' | 'tui'`
  - `interface LeaseInfo { pid: number; host: LeaseHost; instance: string; machine: string; heartbeat: number }`
  - `interface LeaseDeps { now(): number; pidAlive(pid: number): boolean; machine: string }`, `defaultLeaseDeps`
  - `HEARTBEAT_MS = 5000`, `STALE_MS = 20000`
  - `isStale(info, deps): boolean`, `readLease(file): Promise<LeaseInfo | undefined>`
  - `claimLease(file, self: { host: LeaseHost; instance: string }, deps?): Promise<{ ok: true; lease: HeldLease } | { ok: false; owner: LeaseInfo }>`
  - `class HeldLease { readonly info: LeaseInfo; beat(): Promise<boolean>; release(): Promise<void> }` (`beat()` is `false` when the lease was taken from us).

- [ ] **Step 1: Write the failing test**

```ts
import * as assert from 'assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { claimLease, isStale, readLease, STALE_MS, type LeaseDeps } from '../../host/lease';

function deps(over: Partial<LeaseDeps> = {}): LeaseDeps {
  return { now: () => 1_000_000, pidAlive: () => true, machine: 'm1', ...over };
}

suite('lease', () => {
  let dir: string;
  let file: string;
  setup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-lease-'));
    file = path.join(dir, 's1.lock');
  });
  teardown(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  test('the first claim wins and a second host sees who owns it', async () => {
    const a = await claimLease(file, { host: 'vscode', instance: 'A' }, deps());
    assert.strictEqual(a.ok, true);
    const b = await claimLease(file, { host: 'tui', instance: 'B' }, deps());
    assert.strictEqual(b.ok, false);
    if (!b.ok) { assert.strictEqual(b.owner.host, 'vscode'); assert.strictEqual(b.owner.instance, 'A'); }
  });

  test('two hosts in one process are still different owners', async () => {
    await claimLease(file, { host: 'vscode', instance: 'A' }, deps());
    const b = await claimLease(file, { host: 'tui', instance: 'B' }, deps());
    assert.strictEqual(b.ok, false);
  });

  test('re-claiming with the same instance is idempotent', async () => {
    await claimLease(file, { host: 'vscode', instance: 'A' }, deps());
    assert.strictEqual((await claimLease(file, { host: 'vscode', instance: 'A' }, deps())).ok, true);
  });

  test('a lease with an old heartbeat is stale and can be taken over', async () => {
    await claimLease(file, { host: 'vscode', instance: 'A' }, deps({ now: () => 0 }));
    const b = await claimLease(file, { host: 'tui', instance: 'B' }, deps({ now: () => STALE_MS + 1 }));
    assert.strictEqual(b.ok, true);
    assert.strictEqual((await readLease(file))?.instance, 'B');
  });

  test('a dead pid on this machine is stale immediately', async () => {
    await claimLease(file, { host: 'vscode', instance: 'A' }, deps());
    const b = await claimLease(file, { host: 'tui', instance: 'B' }, deps({ pidAlive: () => false }));
    assert.strictEqual(b.ok, true);
  });

  test('a dead-looking pid on another machine is not trusted', async () => {
    await claimLease(file, { host: 'vscode', instance: 'A' }, deps({ machine: 'other' }));
    const b = await claimLease(file, { host: 'tui', instance: 'B' }, deps({ pidAlive: () => false }));
    assert.strictEqual(b.ok, false);
  });

  test('a corrupt lease file is treated as no owner', async () => {
    await fs.writeFile(file, '{not json');
    assert.strictEqual((await claimLease(file, { host: 'tui', instance: 'B' }, deps())).ok, true);
  });

  test('beat refreshes the heartbeat, and reports false once the lease was taken', async () => {
    const a = await claimLease(file, { host: 'vscode', instance: 'A' }, deps({ now: () => 100 }));
    if (!a.ok) { throw new Error('expected a claim'); }
    assert.strictEqual(await a.lease.beat(), true);
    await fs.rm(file);
    await claimLease(file, { host: 'tui', instance: 'B' }, deps());
    assert.strictEqual(await a.lease.beat(), false);
  });

  test('release removes only our own lease', async () => {
    const a = await claimLease(file, { host: 'vscode', instance: 'A' }, deps());
    if (!a.ok) { throw new Error('expected a claim'); }
    await fs.rm(file);
    await claimLease(file, { host: 'tui', instance: 'B' }, deps());
    await a.lease.release();
    assert.strictEqual((await readLease(file))?.instance, 'B');
  });

  test('isStale is a pure function of heartbeat, pid and machine', () => {
    const info = { pid: 1, host: 'tui' as const, instance: 'x', machine: 'm1', heartbeat: 0 };
    assert.strictEqual(isStale(info, deps({ now: () => STALE_MS })), false);
    assert.strictEqual(isStale(info, deps({ now: () => STALE_MS + 1 })), true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit -g "lease"`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { createExclusive, writeFileAtomic } from './atomic-file';

export const HEARTBEAT_MS = 5_000;
export const STALE_MS = 20_000;

export type LeaseHost = 'vscode' | 'tui';

export interface LeaseInfo {
  pid: number;
  host: LeaseHost;
  instance: string;
  machine: string;
  heartbeat: number;
}

export interface LeaseDeps {
  now(): number;
  pidAlive(pid: number): boolean;
  machine: string;
}

export const defaultLeaseDeps: LeaseDeps = {
  now: () => Date.now(),
  pidAlive: (pid) => {
    try { process.kill(pid, 0); return true; } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
  machine: os.hostname(),
};

function isLeaseInfo(value: unknown): value is LeaseInfo {
  if (typeof value !== 'object' || value === null) { return false; }
  const v = value as Record<string, unknown>;
  return typeof v.pid === 'number' && typeof v.instance === 'string' && typeof v.machine === 'string'
    && typeof v.heartbeat === 'number' && (v.host === 'vscode' || v.host === 'tui');
}

export async function readLease(file: string): Promise<LeaseInfo | undefined> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    return isLeaseInfo(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** The pid probe only speaks for this machine: a shared home can be read from several. */
export function isStale(info: LeaseInfo, deps: LeaseDeps): boolean {
  if (deps.now() - info.heartbeat > STALE_MS) { return true; }
  return info.machine === deps.machine && !deps.pidAlive(info.pid);
}

export class HeldLease {
  constructor(
    private readonly file: string,
    readonly info: LeaseInfo,
    private readonly deps: LeaseDeps,
  ) {}

  async beat(): Promise<boolean> {
    const current = await readLease(this.file);
    if (current?.instance !== this.info.instance) { return false; }
    await writeFileAtomic(this.file, JSON.stringify({ ...this.info, heartbeat: this.deps.now() }));
    return true;
  }

  async release(): Promise<void> {
    const current = await readLease(this.file);
    if (current?.instance === this.info.instance) { await fs.rm(this.file, { force: true }); }
  }
}

export type Claim = { ok: true; lease: HeldLease } | { ok: false; owner: LeaseInfo };

export async function claimLease(
  file: string,
  self: { host: LeaseHost; instance: string },
  deps: LeaseDeps = defaultLeaseDeps,
): Promise<Claim> {
  const info: LeaseInfo = {
    pid: process.pid, host: self.host, instance: self.instance, machine: deps.machine, heartbeat: deps.now(),
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await createExclusive(file, JSON.stringify(info))) { return { ok: true, lease: new HeldLease(file, info, deps) }; }
    const current = await readLease(file);
    if (current?.instance === self.instance) { return { ok: true, lease: new HeldLease(file, current, deps) }; }
    if (current && !isStale(current, deps)) { return { ok: false, owner: current }; }
    await fs.rm(file, { force: true });
  }
  const last = await readLease(file);
  if (last) { return { ok: false, owner: last }; }
  throw new Error(`could not claim lease ${file}`);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit -g "lease"`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
cd /e/Efebia/hiiiid-code && git branch --show-current && yarn lint && yarn check-types
git add src/host/lease.ts src/test/unit/lease.test.ts
git commit -m "feat: per-session lease files with heartbeat and stale takeover"
```

---

### Task 4: Session ownership service

**Files:**
- Create: `src/host/session-ownership.ts`
- Test: `src/test/unit/session-ownership.test.ts`

**Interfaces:**
- Consumes: `claimLease`, `readLease`, `isStale`, `HeldLease`, `LeaseDeps`, `LeaseHost`, `defaultLeaseDeps`, `HEARTBEAT_MS` (Task 3).
- Produces:
  - `interface OwnerInfo { host: LeaseHost; pid: number }`
  - `class SessionOwnership { constructor(dir: string, host: LeaseHost, opts?: { deps?: LeaseDeps; instance?: string; heartbeatMs?: number }); claim(id: string): Promise<{ owned: true } | { owned: false; owner: OwnerInfo }>; ownerOf(id: string): Promise<OwnerInfo | undefined>; owns(id: string): boolean; release(id: string): Promise<void>; onLost(cb: (id: string) => void): void; dispose(): Promise<void> }`
  - Lease file for id `x` is `<dir>/x.lock`.

- [ ] **Step 1: Write the failing test**

```ts
import * as assert from 'assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { STALE_MS } from '../../host/lease';
import { SessionOwnership } from '../../host/session-ownership';

suite('SessionOwnership', () => {
  let dir: string;
  const live: SessionOwnership[] = [];
  const make = (host: 'vscode' | 'tui', opts: ConstructorParameters<typeof SessionOwnership>[2] = {}) => {
    const o = new SessionOwnership(dir, host, opts);
    live.push(o);
    return o;
  };
  setup(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-own-')); });
  teardown(async () => {
    await Promise.all(live.splice(0).map((o) => o.dispose()));
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('the second host is told who owns the session', async () => {
    const a = make('vscode');
    const b = make('tui');
    assert.deepStrictEqual(await a.claim('s1'), { owned: true });
    const r = await b.claim('s1');
    assert.strictEqual(r.owned, false);
    if (!r.owned) { assert.deepStrictEqual(r.owner, { host: 'vscode', pid: process.pid }); }
  });

  test('ownerOf reports a live foreign owner and nothing for our own or a free session', async () => {
    const a = make('vscode');
    const b = make('tui');
    await a.claim('s1');
    assert.deepStrictEqual(await b.ownerOf('s1'), { host: 'vscode', pid: process.pid });
    assert.strictEqual(await a.ownerOf('s1'), undefined);
    assert.strictEqual(await b.ownerOf('nobody'), undefined);
  });

  test('release frees the session for the other host', async () => {
    const a = make('vscode');
    const b = make('tui');
    await a.claim('s1');
    await a.release('s1');
    assert.deepStrictEqual(await b.claim('s1'), { owned: true });
  });

  test('a host that stopped beating loses the session to a claimant after the stale window', async () => {
    let now = 0;
    const clock = { now: () => now, pidAlive: () => true, machine: 'm' };
    const a = make('vscode', { deps: clock, heartbeatMs: 1_000_000 });
    const b = make('tui', { deps: clock, heartbeatMs: 1_000_000 });
    await a.claim('s1');
    now = STALE_MS + 1;
    assert.deepStrictEqual(await b.claim('s1'), { owned: true });
  });

  test('a lease taken from us is reported through onLost', async () => {
    const lost: string[] = [];
    const a = make('vscode', { heartbeatMs: 10 });
    a.onLost((id) => lost.push(id));
    await a.claim('s1');
    await fs.rm(path.join(dir, 's1.lock'));
    await make('tui').claim('s1');
    for (let i = 0; i < 40 && lost.length === 0; i++) { await new Promise((r) => setTimeout(r, 10)); }
    assert.deepStrictEqual(lost, ['s1']);
    assert.strictEqual(a.owns('s1'), false);
  });

  test('dispose releases every held lease', async () => {
    const a = make('vscode');
    await a.claim('s1');
    await a.claim('s2');
    await a.dispose();
    assert.deepStrictEqual((await fs.readdir(dir)).filter((n) => n.endsWith('.lock')), []);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit -g "SessionOwnership"`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import {
  claimLease, defaultLeaseDeps, HEARTBEAT_MS, isStale, readLease,
  type HeldLease, type LeaseDeps, type LeaseHost,
} from './lease';

export interface OwnerInfo { host: LeaseHost; pid: number }
export type OwnClaim = { owned: true } | { owned: false; owner: OwnerInfo };

export class SessionOwnership {
  private readonly held = new Map<string, HeldLease>();
  private readonly deps: LeaseDeps;
  private readonly instance: string;
  private readonly heartbeatMs: number;
  private timer?: NodeJS.Timeout;
  private lost: (id: string) => void = () => {};

  constructor(
    private readonly dir: string,
    private readonly host: LeaseHost,
    opts: { deps?: LeaseDeps; instance?: string; heartbeatMs?: number } = {},
  ) {
    this.deps = opts.deps ?? defaultLeaseDeps;
    this.instance = opts.instance ?? randomUUID();
    this.heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  }

  onLost(cb: (id: string) => void): void { this.lost = cb; }

  owns(id: string): boolean { return this.held.has(id); }

  private file(id: string): string { return path.join(this.dir, `${id}.lock`); }

  async claim(id: string): Promise<OwnClaim> {
    if (this.held.has(id)) { return { owned: true }; }
    const result = await claimLease(this.file(id), { host: this.host, instance: this.instance }, this.deps);
    if (!result.ok) { return { owned: false, owner: { host: result.owner.host, pid: result.owner.pid } }; }
    this.held.set(id, result.lease);
    this.startTimer();
    return { owned: true };
  }

  async ownerOf(id: string): Promise<OwnerInfo | undefined> {
    if (this.held.has(id)) { return undefined; }
    const info = await readLease(this.file(id));
    if (!info || isStale(info, this.deps)) { return undefined; }
    return { host: info.host, pid: info.pid };
  }

  async release(id: string): Promise<void> {
    const lease = this.held.get(id);
    if (!lease) { return; }
    this.held.delete(id);
    if (this.held.size === 0) { this.stopTimer(); }
    await lease.release();
  }

  async dispose(): Promise<void> {
    this.stopTimer();
    const leases = [...this.held.values()];
    this.held.clear();
    await Promise.all(leases.map((l) => l.release()));
  }

  private startTimer(): void {
    if (this.timer) { return; }
    this.timer = setInterval(() => { void this.beatAll(); }, this.heartbeatMs);
    this.timer.unref();
  }

  private stopTimer(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }

  private async beatAll(): Promise<void> {
    for (const [id, lease] of [...this.held]) {
      let alive = true;
      try { alive = await lease.beat(); } catch { /* a transient fs error is not a lost lease */ }
      if (!alive) {
        this.held.delete(id);
        this.lost(id);
      }
    }
    if (this.held.size === 0) { this.stopTimer(); }
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit -g "SessionOwnership"`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
cd /e/Efebia/hiiiid-code && git branch --show-current && yarn lint && yarn check-types
git add src/host/session-ownership.ts src/test/unit/session-ownership.test.ts
git commit -m "feat: session ownership service over lease files"
```

---

### Task 5: TranscriptStore for a shared directory

**Files:**
- Modify: `src/host/transcript-store.ts`
- Test: `src/test/unit/transcript-store-shared.test.ts`

**Interfaces:**
- Consumes: `writeFileAtomic` (Task 1).
- Produces on `TranscriptStore`:
  - `constructor(rootDir: string, layoutHost: string = 'vscode')`
  - `writeIndex`/`writeUsage`/`writeCatalog` are atomic with per-writer temp names.
  - Non-`vscode` hosts keep their layout in `layout.<host>.json` and never touch the `layout` field of `index.json`.
  - `markForeign(id)`, `clearForeign(id)`, `isForeign(id): boolean`: while foreign, `append`, `replace`, `flush` and `remove` for that id do nothing.
  - `reloadFromDisk(id): Promise<{ appended: TranscriptItem[]; replaced: TranscriptItem[] }>`: re-reads the JSONL, tolerating one torn trailing line without inventing a "corrupt" item.

- [ ] **Step 1: Write the failing test**

```ts
import * as assert from 'assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SessionState, TranscriptItem } from '../../protocol/messages';
import { TranscriptStore } from '../../host/transcript-store';

const item = (id: string, text: string): TranscriptItem =>
  ({ id, ts: 1, role: 'assistant', text } as TranscriptItem);

function state(id: string): SessionState {
  return {
    id, providerId: 'fake', model: 'm', title: 't', name: id, cwd: '/w', status: 'idle',
    permissionMode: 'default', includeEditorContext: true, resumeTokens: {}, createdAt: 1, updatedAt: 1,
  } as SessionState;
}

suite('TranscriptStore (shared directory)', () => {
  let dir: string;
  setup(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-store-')); });
  teardown(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  const file = (id: string) => path.join(dir, 'sessions', `${id}.jsonl`);

  test('interleaved index writes from two stores leave one whole file and no temp files', async () => {
    const a = new TranscriptStore(dir);
    const b = new TranscriptStore(dir, 'tui');
    for (let i = 0; i < 6; i++) {
      await a.writeIndex({ version: 2, sessions: [state(`a${i}`)], layout: (await a.readIndex()).layout });
      await b.writeIndex({ version: 2, sessions: [state(`b${i}`)], layout: (await b.readIndex()).layout });
    }
    JSON.parse(await fs.readFile(path.join(dir, 'index.json'), 'utf8'));
    assert.deepStrictEqual((await fs.readdir(dir)).filter((n) => n.endsWith('.tmp')), []);
  });

  test('a tui host keeps its layout in its own file and leaves the vscode layout alone', async () => {
    const vs = new TranscriptStore(dir);
    const layout = { root: { kind: 'leaf' as const, sessionId: 'x', size: 100 }, presets: [] };
    await vs.writeIndex({ version: 2, sessions: [], layout });
    const tui = new TranscriptStore(dir, 'tui');
    await tui.writeIndex({ version: 2, sessions: [state('s')], layout: { root: { kind: 'leaf', sessionId: 'y', size: 100 }, presets: [] } });
    assert.strictEqual((await new TranscriptStore(dir).readIndex()).layout.root.kind, 'leaf');
    const vsRoot = (await new TranscriptStore(dir).readIndex()).layout.root;
    assert.strictEqual(vsRoot.kind === 'leaf' && vsRoot.sessionId === 'x', true);
    const tuiRoot = (await new TranscriptStore(dir, 'tui').readIndex()).layout.root;
    assert.strictEqual(tuiRoot.kind === 'leaf' && tuiRoot.sessionId === 'y', true);
  });

  test('a foreign session is never written: append, replace, flush and remove are no-ops', async () => {
    const owner = new TranscriptStore(dir);
    owner.append('s1', item('i1', 'one'));
    await owner.flush('s1');
    const before = await fs.readFile(file('s1'), 'utf8');

    const guest = new TranscriptStore(dir, 'tui');
    guest.markForeign('s1');
    guest.append('s1', item('i2', 'two'));
    guest.replace('s1', item('i1', 'CHANGED'));
    await guest.flush();
    await guest.flush('s1');
    await guest.remove('s1');
    assert.strictEqual(await fs.readFile(file('s1'), 'utf8'), before);
  });

  test('clearForeign makes the store writable again and drops the stale cache', async () => {
    const owner = new TranscriptStore(dir);
    owner.append('s1', item('i1', 'one'));
    await owner.flush('s1');
    const guest = new TranscriptStore(dir, 'tui');
    guest.markForeign('s1');
    await guest.tail('s1');
    owner.append('s1', item('i2', 'two'));
    await owner.flush('s1');
    guest.clearForeign('s1');
    assert.strictEqual((await guest.tail('s1')).items.length, 2);
    guest.append('s1', item('i3', 'three'));
    await guest.flush('s1');
    assert.strictEqual((await fs.readFile(file('s1'), 'utf8')).trim().split('\n').length, 3);
  });

  test('reloadFromDisk reports appended and replaced items', async () => {
    const owner = new TranscriptStore(dir);
    owner.append('s1', item('i1', 'one'));
    await owner.flush('s1');
    const guest = new TranscriptStore(dir, 'tui');
    guest.markForeign('s1');
    await guest.tail('s1');

    owner.append('s1', item('i2', 'two'));
    owner.replace('s1', item('i1', 'ONE'));
    await owner.flush('s1');

    const delta = await guest.reloadFromDisk('s1');
    assert.deepStrictEqual(delta.appended.map((i) => i.id), ['i2']);
    assert.deepStrictEqual(delta.replaced.map((i) => i.id), ['i1']);
    assert.deepStrictEqual(await guest.reloadFromDisk('s1'), { appended: [], replaced: [] });
  });

  test('a torn trailing line while the owner is mid-append is not reported as corruption', async () => {
    const guest = new TranscriptStore(dir, 'tui');
    guest.markForeign('s1');
    await fs.mkdir(path.join(dir, 'sessions'), { recursive: true });
    await fs.writeFile(file('s1'), `${JSON.stringify(item('i1', 'one'))}\n{"id":"i2","ts":1,"ro`);
    const delta = await guest.reloadFromDisk('s1');
    assert.deepStrictEqual(delta.appended.map((i) => i.id), ['i1']);
    await fs.writeFile(file('s1'), `${JSON.stringify(item('i1', 'one'))}\n${JSON.stringify(item('i2', 'two'))}\n`);
    assert.deepStrictEqual((await guest.reloadFromDisk('s1')).appended.map((i) => i.id), ['i2']);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit -g "TranscriptStore \(shared"`
Expected: FAIL (`markForeign is not a function`, 2-arg constructor).

- [ ] **Step 3: Implement in `src/host/transcript-store.ts`**

3a. Imports and constructor. Add `import { writeFileAtomic } from './atomic-file';` and replace the constructor line `constructor(private readonly rootDir: string) {}` with:

```ts
  private foreign = new Set<SessionId>();

  constructor(private readonly rootDir: string, private readonly layoutHost: string = 'vscode') {}

  markForeign(id: SessionId): void {
    this.foreign.add(id);
    this.pending.delete(id);
    this.dirty.delete(id);
    this.replacements.delete(id);
  }

  clearForeign(id: SessionId): void {
    this.foreign.delete(id);
    this.cache.delete(id);
  }

  isForeign(id: SessionId): boolean { return this.foreign.has(id); }
```

3b. Guards. At the top of `append`: `if (this.foreign.has(id)) { return; }`. At the top of `replace`: same. In `flush`, change the `ids` line to
`const ids = (id ? [id] : [...new Set([...this.pending.keys(), ...this.dirty])]).filter((i) => !this.foreign.has(i));`
In `remove`, first line: `if (this.foreign.has(id)) { return; }`.

3c. Torn-tail tolerant load. Change the signature to `private async ensureLoaded(id: SessionId, opts: { dropTornTail?: boolean } = {})`. In the loop, replace the `for (const line of raw.split('\n'))` block with an indexed loop that knows the last non-empty line:

```ts
      const lines = raw.split('\n');
      let last = lines.length - 1;
      while (last >= 0 && lines[last].trim().length === 0) { last--; }
      for (let n = 0; n < lines.length; n++) {
        const line = lines[n];
        if (line.trim().length === 0) { continue; }
        try {
          items.push(JSON.parse(line) as TranscriptItem);
        } catch {
          if (!(opts.dropTornTail && n === last)) { skipped++; }
        }
      }
```
(keep the existing explanatory comment above the `catch`).

3d. `reloadFromDisk`, placed after `find`:

```ts
  async reloadFromDisk(id: SessionId): Promise<{ appended: TranscriptItem[]; replaced: TranscriptItem[] }> {
    const known = new Map((this.cache.get(id) ?? []).map((i) => [i.id, JSON.stringify(i)]));
    this.cache.delete(id);
    const after = await this.ensureLoaded(id, { dropTornTail: true });
    const appended: TranscriptItem[] = [];
    const replaced: TranscriptItem[] = [];
    for (const it of after) {
      const prior = known.get(it.id);
      if (prior === undefined) { appended.push(it); } else if (prior !== JSON.stringify(it)) { replaced.push(it); }
    }
    return { appended, replaced };
  }
```

3e. Atomic, per-host index/usage/catalog. Replace the bodies of `writeIndex`, `writeUsage`, `writeCatalog` with `writeFileAtomic` calls, and give `readIndex`/`writeIndex` the per-host layout:

```ts
  private layoutFile(): string { return path.join(this.rootDir, `layout.${this.layoutHost}.json`); }

  private async readOwnLayout(): Promise<PaneLayout | undefined> {
    try { return migrateLayout(JSON.parse(await fs.readFile(this.layoutFile(), 'utf8'))); } catch { return undefined; }
  }
```
In `readIndex`, after computing the result, for a non-`vscode` host use `(await this.readOwnLayout()) ?? emptyIndex().layout` instead of `migrateLayout(parsed.layout) ?? emptyIndex().layout`. In the `ENOENT`/version-mismatch `emptyIndex()` returns, leave as they are.

```ts
  async writeIndex(index: StoredIndex): Promise<void> {
    let layout = index.layout;
    if (this.layoutHost !== 'vscode') {
      await writeFileAtomic(this.layoutFile(), JSON.stringify(index.layout, null, 2));
      layout = await this.diskLayout();
    }
    await writeFileAtomic(
      path.join(this.rootDir, 'index.json'),
      JSON.stringify({ ...index, layout, version: TRANSCRIPT_VERSION }, null, 2),
    );
  }

  private async diskLayout(): Promise<PaneLayout> {
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(this.rootDir, 'index.json'), 'utf8')) as { layout?: unknown };
      return migrateLayout(parsed.layout) ?? emptyIndex().layout;
    } catch {
      return emptyIndex().layout;
    }
  }
```
`writeUsage` → `await writeFileAtomic(path.join(this.rootDir, 'usage.json'), JSON.stringify(usage, null, 2));` and `writeCatalog` likewise for `catalog.json`. Remove the now-redundant `fs.mkdir` calls in those three (`writeFileAtomic` creates the directory).

- [ ] **Step 4: Run to verify it passes, and that nothing regressed**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit -g "TranscriptStore"`
Expected: PASS for the new suite and the existing `transcript-store.test.ts`.

- [ ] **Step 5: Commit**

```bash
cd /e/Efebia/hiiiid-code && git branch --show-current && yarn lint && yarn check-types
git add src/host/transcript-store.ts src/test/unit/transcript-store-shared.test.ts
git commit -m "feat: make TranscriptStore safe to share between hosts"
```

---

### Task 6: Dormant provider

**Files:**
- Create: `src/host/dormant-provider.ts`
- Test: `src/test/unit/dormant-provider.test.ts`

**Interfaces:**
- Produces: `dormantProvider(provider: AgentProvider): AgentProvider`: same catalog surface, but `start()` returns an inert `AgentRun` (no backend process, no events until disposed).

- [ ] **Step 1: Write the failing test**

```ts
import * as assert from 'assert';
import { dormantProvider } from '../../host/dormant-provider';
import { FakeProvider } from '../../providers/fake/fake-provider';

suite('dormantProvider', () => {
  test('it keeps the wrapped provider\'s identity and catalog', () => {
    const fake = new FakeProvider(() => []);
    const dormant = dormantProvider(fake);
    assert.strictEqual(dormant.id, fake.id);
    assert.deepStrictEqual(dormant.listModels(), fake.listModels());
  });

  test('start() spawns nothing on the wrapped provider', () => {
    const fake = new FakeProvider(() => []);
    dormantProvider(fake).start({ cwd: '/w', model: 'fake-large', permissionMode: 'default', sessionId: 's' });
    assert.strictEqual(fake.lastStart, undefined);
  });

  test('the run ignores sends and its event stream ends only when disposed', async () => {
    const run = dormantProvider(new FakeProvider(() => [])).start({
      cwd: '/w', model: 'fake-large', permissionMode: 'default', sessionId: 's',
    });
    run.send('hello');
    run.respondToTool('t', { behavior: 'deny' } as never);
    let ended = false;
    const drain = (async () => { for await (const _ of run.events) { /* none */ } ended = true; })();
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(ended, false);
    await run.dispose();
    await drain;
    assert.strictEqual(ended, true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit -g "dormantProvider"`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
import type { AgentEvent, AgentProvider, AgentRun } from '../providers/types';

class DormantRun implements AgentRun {
  private release: () => void = () => {};
  private readonly closed = new Promise<void>((resolve) => { this.release = resolve; });
  readonly events: AsyncIterable<AgentEvent> = this.iterate();

  private async *iterate(): AsyncGenerator<AgentEvent> { await this.closed; }

  send(): void {}
  respondToTool(): void {}
  respondToQuestion(): void {}
  setEffort(): void {}
  setModel(): void {}
  setPermissionMode(): void {}
  async interrupt(): Promise<void> { this.release(); }
  async dispose(): Promise<void> { this.release(); }
}

export function dormantProvider(provider: AgentProvider): AgentProvider {
  return Object.create(provider, { start: { value: (): AgentRun => new DormantRun() } }) as AgentProvider;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit -g "dormantProvider"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd /e/Efebia/hiiiid-code && git branch --show-current && yarn lint && yarn check-types
git add src/host/dormant-provider.ts src/test/unit/dormant-provider.test.ts
git commit -m "feat: dormant provider for sessions owned by another host"
```

---

### Task 7: Roster merge (pure)

**Files:**
- Create: `src/host/roster-sync.ts`
- Test: `src/test/unit/roster-sync.test.ts`
- Modify: `src/protocol/messages.ts` (add `owner?` to `SessionState`)

**Interfaces:**
- Produces:
  - `SessionState.owner?: { host: 'vscode' | 'tui'; pid: number }` (in `messages.ts`, type-only).
  - `mergeRoster(input: MergeInput): MergeResult` where
    - `MergeInput { ours: Map<SessionId, SessionState>; disk: SessionState[]; owners: Map<SessionId, { host: 'vscode' | 'tui'; pid: number }>; knownOnDisk: Set<SessionId> }`
    - `MergeResult { sessions: SessionState[]; adopt: SessionState[]; update: SessionState[]; drop: SessionId[]; knownOnDisk: Set<SessionId>; changed: boolean }`

Rules: a disk entry for a session leased by another live host wins (`update`); a session only on disk is `adopt`ed; a session we hold that is on disk but not foreign keeps ours; a session we hold that is not on disk is dropped if we saw it there last time (someone deleted it) and kept if it is a fresh creation; `owner` is set from `owners` and never persisted.

- [ ] **Step 1: Add the protocol field.** In `src/protocol/messages.ts`, inside `SessionState` after `name: string;` add:

```ts
  /**
   * Set only while another live host owns this session: read-only here, and
   * the label says where it is running. Host-derived from the lease files and
   * stripped before the index is written.
   */
  owner?: { host: 'vscode' | 'tui'; pid: number };
```

- [ ] **Step 2: Write the failing test**

```ts
import * as assert from 'assert';
import type { SessionState } from '../../protocol/messages';
import { mergeRoster } from '../../host/roster-sync';

const s = (id: string, over: Partial<SessionState> = {}): SessionState => ({
  id, providerId: 'fake', model: 'm', title: id, name: id, cwd: '/w', status: 'idle',
  permissionMode: 'default', includeEditorContext: true, resumeTokens: {}, createdAt: 1, updatedAt: 1, ...over,
} as SessionState);

const owner = { host: 'vscode' as const, pid: 7 };

suite('mergeRoster', () => {
  test('a session only on disk is adopted', () => {
    const r = mergeRoster({ ours: new Map(), disk: [s('a')], owners: new Map(), knownOnDisk: new Set() });
    assert.deepStrictEqual(r.adopt.map((x) => x.id), ['a']);
    assert.deepStrictEqual(r.sessions.map((x) => x.id), ['a']);
    assert.strictEqual(r.changed, true);
  });

  test('a session owned by another host takes the disk copy and carries the owner', () => {
    const ours = new Map([['a', s('a', { title: 'stale', status: 'idle' })]]);
    const r = mergeRoster({
      ours, disk: [s('a', { title: 'fresh', status: 'running' })], owners: new Map([['a', owner]]), knownOnDisk: new Set(['a']),
    });
    assert.deepStrictEqual(r.update.map((x) => x.title), ['fresh']);
    assert.deepStrictEqual(r.update[0].owner, owner);
  });

  test('a session we hold and nobody else owns keeps our copy', () => {
    const ours = new Map([['a', s('a', { title: 'mine' })]]);
    const r = mergeRoster({ ours, disk: [s('a', { title: 'theirs' })], owners: new Map(), knownOnDisk: new Set(['a']) });
    assert.deepStrictEqual(r.update, []);
    assert.deepStrictEqual(r.sessions.map((x) => x.title), ['mine']);
  });

  test('a session we saw on disk that is now gone was deleted elsewhere', () => {
    const r = mergeRoster({ ours: new Map([['a', s('a')]]), disk: [], owners: new Map(), knownOnDisk: new Set(['a']) });
    assert.deepStrictEqual(r.drop, ['a']);
    assert.deepStrictEqual(r.sessions, []);
  });

  test('a fresh session we created and never wrote is kept', () => {
    const r = mergeRoster({ ours: new Map([['n', s('n')]]), disk: [], owners: new Map(), knownOnDisk: new Set() });
    assert.deepStrictEqual(r.drop, []);
    assert.deepStrictEqual(r.sessions.map((x) => x.id), ['n']);
  });

  test('persisted sessions never carry owner', () => {
    const r = mergeRoster({ ours: new Map(), disk: [s('a')], owners: new Map([['a', owner]]), knownOnDisk: new Set() });
    assert.strictEqual(r.sessions.every((x) => x.owner === undefined), true);
  });

  test('an unchanged roster reports changed: false and does not ping-pong', () => {
    const disk = [s('a')];
    const first = mergeRoster({ ours: new Map(), disk, owners: new Map(), knownOnDisk: new Set() });
    const ours = new Map(first.adopt.map((x) => [x.id, x]));
    const second = mergeRoster({ ours, disk, owners: new Map(), knownOnDisk: first.knownOnDisk });
    assert.strictEqual(second.changed, false);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit -g "mergeRoster"`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement `src/host/roster-sync.ts`**

```ts
import type { SessionId, SessionState } from '../protocol/messages';

type Owner = NonNullable<SessionState['owner']>;

export interface MergeInput {
  ours: Map<SessionId, SessionState>;
  disk: SessionState[];
  owners: Map<SessionId, Owner>;
  knownOnDisk: Set<SessionId>;
}

export interface MergeResult {
  sessions: SessionState[];
  adopt: SessionState[];
  update: SessionState[];
  drop: SessionId[];
  knownOnDisk: Set<SessionId>;
  changed: boolean;
}

function stripOwner(state: SessionState): SessionState {
  const { owner: _owner, ...rest } = state;
  return rest as SessionState;
}

export function mergeRoster(input: MergeInput): MergeResult {
  const { ours, disk, owners, knownOnDisk } = input;
  const onDisk = new Set(disk.map((d) => d.id));
  const sessions: SessionState[] = [];
  const adopt: SessionState[] = [];
  const update: SessionState[] = [];
  const drop: SessionId[] = [];

  for (const d of disk) {
    const owner = owners.get(d.id);
    const mine = ours.get(d.id);
    if (!mine) {
      adopt.push(owner ? { ...d, owner } : d);
      sessions.push(stripOwner(d));
    } else if (owner) {
      const changed = JSON.stringify({ ...d, owner }) !== JSON.stringify(mine);
      if (changed) { update.push({ ...d, owner }); }
      sessions.push(stripOwner(d));
    } else {
      sessions.push(stripOwner(mine));
    }
  }

  for (const [id, mine] of ours) {
    if (onDisk.has(id)) { continue; }
    if (knownOnDisk.has(id)) { drop.push(id); } else { sessions.push(stripOwner(mine)); }
  }

  return {
    sessions, adopt, update, drop,
    knownOnDisk: new Set(sessions.map((x) => x.id)),
    changed: adopt.length > 0 || update.length > 0 || drop.length > 0,
  };
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit -g "mergeRoster" && yarn check-types`
Expected: PASS (7 tests), types clean.

- [ ] **Step 6: Commit**

```bash
cd /e/Efebia/hiiiid-code && git branch --show-current && yarn lint
git add src/host/roster-sync.ts src/protocol/messages.ts src/test/unit/roster-sync.test.ts
git commit -m "feat: pure roster merge and the SessionState owner field"
```

---

### Task 8: SessionManager ownership, foreign sessions and roster sync

**Files:**
- Create: `src/host/foreign-tail.ts`
- Modify: `src/host/session-manager.ts`
- Test: `src/test/unit/foreign-tail.test.ts`, `src/test/unit/session-manager-shared.test.ts`

**Interfaces:**
- Consumes: `SessionOwnership`, `OwnerInfo` (Task 4); `dormantProvider` (Task 6); `TranscriptStore.markForeign/clearForeign/isForeign/reloadFromDisk` (Task 5); `mergeRoster` (Task 7).
- Produces:
  - `class ForeignTail { constructor(opts: { id: SessionId; file: string; store: TranscriptStore; stillForeign: () => Promise<boolean>; onPatch: (p: TranscriptPatch) => void; onFree: () => void; intervalMs?: number }); start(): void; stop(): void }`
  - On `SessionManager`: `setOwnership(o: SessionOwnership): void`, `syncRoster(): Promise<void>`, `startRosterSync(intervalMs?: number): void`. Behavior unchanged when no ownership is set (every existing test keeps passing).

- [ ] **Step 1: Write the failing `ForeignTail` test**

```ts
import * as assert from 'assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TranscriptItem, TranscriptPatch } from '../../protocol/messages';
import { ForeignTail } from '../../host/foreign-tail';
import { TranscriptStore } from '../../host/transcript-store';

const item = (id: string, text: string): TranscriptItem => ({ id, ts: 1, role: 'assistant', text } as TranscriptItem);
const until = async (ok: () => boolean) => { for (let i = 0; i < 100 && !ok(); i++) { await new Promise((r) => setTimeout(r, 10)); } };

suite('ForeignTail', () => {
  let dir: string;
  setup(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-tail-')); });
  teardown(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  test('it turns the owner\'s flushed writes into append and replace patches', async () => {
    const owner = new TranscriptStore(dir);
    owner.append('s1', item('i1', 'one'));
    await owner.flush('s1');
    const guest = new TranscriptStore(dir, 'tui');
    guest.markForeign('s1');
    await guest.tail('s1');
    const patches: TranscriptPatch[] = [];
    const tail = new ForeignTail({
      id: 's1', file: path.join(dir, 'sessions', 's1.jsonl'), store: guest, intervalMs: 10,
      stillForeign: async () => true, onPatch: (p) => patches.push(p), onFree: () => {},
    });
    tail.start();
    owner.append('s1', item('i2', 'two'));
    owner.replace('s1', item('i1', 'ONE'));
    await owner.flush('s1');
    await until(() => patches.length >= 2);
    tail.stop();
    assert.deepStrictEqual(patches.map((p) => p.op).sort(), ['append', 'replace']);
  });

  test('it stops and reports when the owner is gone', async () => {
    let free = 0;
    let foreign = true;
    const tail = new ForeignTail({
      id: 's1', file: path.join(dir, 'x.jsonl'), store: new TranscriptStore(dir, 'tui'), intervalMs: 10,
      stillForeign: async () => foreign, onPatch: () => {}, onFree: () => { free++; },
    });
    tail.start();
    foreign = false;
    await until(() => free > 0);
    await new Promise((r) => setTimeout(r, 40));
    assert.strictEqual(free, 1);
  });
});
```

- [ ] **Step 2: Implement `src/host/foreign-tail.ts`**

```ts
import * as fs from 'node:fs/promises';
import type { SessionId, TranscriptPatch } from '../protocol/messages';
import type { TranscriptStore } from './transcript-store';

interface Options {
  id: SessionId;
  file: string;
  store: TranscriptStore;
  stillForeign: () => Promise<boolean>;
  onPatch: (patch: TranscriptPatch) => void;
  onFree: () => void;
  intervalMs?: number;
}

/**
 * Polls instead of `fs.watch`: watch events are unreliable on network shares
 * and coalesce differently per OS, and the owner only flushes at turn end and
 * every 500 ms anyway. A whole-file reload diffed by item id is used because
 * the owner rewrites the file (atomically) on a `replace`, so an offset read
 * would miss it.
 */
export class ForeignTail {
  private timer?: NodeJS.Timeout;
  private signature = '';
  private busy = false;

  constructor(private readonly o: Options) {}

  start(): void {
    if (this.timer) { return; }
    this.timer = setInterval(() => { void this.tick(); }, this.o.intervalMs ?? 750);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }

  private async tick(): Promise<void> {
    if (this.busy) { return; }
    this.busy = true;
    try {
      if (!(await this.o.stillForeign())) {
        this.stop();
        this.o.onFree();
        return;
      }
      const stat = await fs.stat(this.o.file).catch(() => undefined);
      const signature = stat ? `${stat.size}:${stat.mtimeMs}` : '';
      if (signature === this.signature) { return; }
      this.signature = signature;
      const { appended, replaced } = await this.o.store.reloadFromDisk(this.o.id);
      for (const item of replaced) { this.o.onPatch({ op: 'replace', item }); }
      for (const item of appended) { this.o.onPatch({ op: 'append', item }); }
    } catch {
      // Errors are state: a failed poll is retried on the next tick.
    } finally {
      this.busy = false;
    }
  }
}
```

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit -g "ForeignTail"` → PASS.

- [ ] **Step 3: Write the failing manager test (`session-manager-shared.test.ts`)**

```ts
import * as assert from 'assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionManager } from '../../host/session-manager';
import { SessionOwnership } from '../../host/session-ownership';
import { TranscriptStore } from '../../host/transcript-store';
import type { HostToWebview } from '../../protocol/messages';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { AgentProvider } from '../../providers/types';

interface Host { manager: SessionManager; ownership: SessionOwnership; sent: HostToWebview[]; store: TranscriptStore }

suite('SessionManager (shared directory)', () => {
  let dir: string;
  const hosts: Host[] = [];

  async function host(kind: 'vscode' | 'tui'): Promise<Host> {
    const store = new TranscriptStore(dir, kind);
    const sent: HostToWebview[] = [];
    const providers = new Map<string, AgentProvider>([
      ['fake', new FakeProvider(() => [{ kind: 'text', delta: 'ok' }, { kind: 'turn-end', reason: 'done' }])],
    ]);
    const manager = new SessionManager(store, providers, (m) => sent.push(m));
    const ownership = new SessionOwnership(path.join(dir, 'sessions'), kind, { heartbeatMs: 20 });
    manager.setOwnership(ownership);
    await manager.init();
    const h = { manager, ownership, sent, store };
    hosts.push(h);
    return h;
  }

  setup(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-shared-')); });
  teardown(async () => {
    for (const h of hosts.splice(0)) { await h.manager.dispose(); await h.ownership.dispose(); }
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('a session owned by one host opens read-only on the other and carries the owner', async () => {
    const owner = await host('vscode');
    const session = await owner.manager.create('fake', '/w');
    session.send('hi');
    await new Promise((r) => setTimeout(r, 50));
    await owner.manager.persistNow();
    const guest = await host('tui');
    await guest.manager.syncRoster();
    const opened = await guest.manager.open(session.state.id);
    assert.deepStrictEqual(opened.state.owner, { host: 'vscode', pid: process.pid });
  });

  test('sending to a foreign session changes nothing on disk', async () => {
    const owner = await host('vscode');
    const session = await owner.manager.create('fake', '/w');
    session.send('hi');
    await new Promise((r) => setTimeout(r, 50));
    await owner.store.flush();
    const file = path.join(dir, 'sessions', `${session.state.id}.jsonl`);
    const before = await fs.readFile(file, 'utf8');

    const guest = await host('tui');
    await guest.manager.syncRoster();
    const foreign = await guest.manager.open(session.state.id);
    foreign.send('should not land');
    await new Promise((r) => setTimeout(r, 50));
    await guest.store.flush();
    assert.strictEqual(await fs.readFile(file, 'utf8'), before);
  });

  test('deleting a foreign session is refused and its transcript survives', async () => {
    const owner = await host('vscode');
    const session = await owner.manager.create('fake', '/w');
    session.send('hi');
    await new Promise((r) => setTimeout(r, 50));
    await owner.store.flush();
    const guest = await host('tui');
    await guest.manager.syncRoster();
    await guest.manager.open(session.state.id);
    await guest.manager.remove(session.state.id);
    await fs.access(path.join(dir, 'sessions', `${session.state.id}.jsonl`));
  });

  test('once the owner lets go, the guest can take the session over', async () => {
    const owner = await host('vscode');
    const session = await owner.manager.create('fake', '/w');
    session.send('hi');
    await new Promise((r) => setTimeout(r, 50));
    await owner.store.flush();
    const guest = await host('tui');
    await guest.manager.syncRoster();
    await guest.manager.open(session.state.id);

    await owner.manager.close(session.state.id);
    await guest.manager.setVisible([]);
    const taken = await guest.manager.open(session.state.id);
    assert.strictEqual(taken.state.owner, undefined);
  });

  test('a new session made on one host appears on the other after a sync', async () => {
    const a = await host('vscode');
    const b = await host('tui');
    const made = await a.manager.create('fake', '/w');
    await a.manager.persistNow();
    await b.manager.syncRoster();
    assert.strictEqual(b.manager.summaries().some((x) => x.id === made.state.id), true);
  });
});
```

The owner host stays alive while the guest opens the session, because disposing it would release the lease. `persistNow()` (added in Step 5b) is the public way to force a write; `persist` stays private. In the tests below, replace every `owner.manager['persist' as never]?.()` / `a.manager['persist' as never]?.()` with `persistNow()`.

- [ ] **Step 4: Run to verify it fails**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit -g "SessionManager \(shared"`
Expected: FAIL (`setOwnership is not a function`).

- [ ] **Step 5: Implement in `src/host/session-manager.ts`**

5a. Imports: `import { dormantProvider } from './dormant-provider'; import { ForeignTail } from './foreign-tail'; import { mergeRoster } from './roster-sync'; import type { OwnerInfo, SessionOwnership } from './session-ownership'; import * as path from 'node:path';` (skip any already imported).

5b. Fields and setter (next to `setWorkspaceRoots`):

```ts
  private ownership?: SessionOwnership;
  private readonly foreign = new Map<SessionId, ForeignTail>();
  private knownOnDisk = new Set<SessionId>();
  private rosterTimer?: NodeJS.Timeout;

  setOwnership(ownership: SessionOwnership): void {
    this.ownership = ownership;
    ownership.onLost((id) => { void this.hide(id).catch(() => { /* errors are state */ }); });
  }

  startRosterSync(intervalMs = 2000): void {
    if (this.rosterTimer || !this.ownership) { return; }
    this.rosterTimer = setInterval(() => { void this.syncRoster(); }, intervalMs);
    this.rosterTimer.unref();
  }

  async persistNow(): Promise<void> { await this.persist(); }
```

5c. `init()`: after `this.paneLayout = index.layout;` add `this.knownOnDisk = new Set(index.sessions.map((s) => s.id));`.

5d. Reconcile (private) and `syncRoster` (public):

```ts
  private async reconcile(): Promise<{ sessions: SessionState[]; changed: boolean }> {
    const disk = (await this.store.readIndex()).sessions;
    const owners = new Map<SessionId, OwnerInfo>();
    for (const id of new Set([...disk.map((d) => d.id), ...this.meta.keys()])) {
      const owner = await this.ownership?.ownerOf(id);
      if (owner) { owners.set(id, owner); }
    }
    const merged = mergeRoster({ ours: this.meta, disk, owners, knownOnDisk: this.knownOnDisk });
    for (const d of merged.adopt) { this.meta.set(d.id, { ...d, status: d.status === 'running' ? d.status : 'idle' }); }
    for (const d of merged.update) { Object.assign(this.meta.get(d.id) as SessionState, d); }
    for (const [id, mine] of this.meta) {
      if (!owners.has(id) && mine.owner) { delete mine.owner; merged.changed ||= true; }
    }
    for (const id of merged.drop) { await this.hide(id); this.meta.delete(id); }
    this.knownOnDisk = merged.knownOnDisk;
    return { sessions: merged.sessions, changed: merged.changed };
  }

  async syncRoster(): Promise<void> {
    if (!this.ownership || this.disposed) { return; }
    try {
      const { changed } = await this.reconcile();
      if (changed) { this.emit({ t: 'sessions-changed', sessions: this.summaries() }); }
    } catch (err) {
      console.error('[mar-code] roster sync failed', err);
    }
  }
```
`adopt` entries must have `owner` set for sessions we adopt that are leased elsewhere: `mergeRoster` returns them with `owner`; `this.meta.set(d.id, {...d, ...})` keeps it.

5e. `persist()`: replace the first lines building `index` with:

```ts
    const sessions = this.ownership
      ? (await this.reconcile()).sessions
      : [...this.meta.values()].map(({ owner: _owner, ...rest }) => rest as SessionState);
    const index: StoredIndex = { version: TRANSCRIPT_VERSION, sessions, layout: this.paneLayout };
```

5f. Claim on create/fork/open. In `create()`, immediately before `const session = new AgentSession(state, provider, this.store, this);` add `await this.ownership?.claim(state.id);`. In `fork()`, before its `new AgentSession(forkState, …)` add `await this.ownership?.claim(forkState.id);`. In `open()`, replace from `state.status = 'idle';` with:

```ts
    if (this.ownership) {
      const claim = await this.ownership.claim(id);
      if (!claim.owned) { return this.openForeign(state, provider, claim.owner); }
    }
    state.status = 'idle';
```
(Keep the rest of `open()` unchanged.)

5g. `openForeign`, `releaseForeign`:

```ts
  private openForeign(state: SessionState, provider: AgentProvider, owner: OwnerInfo): AgentSession {
    const id = state.id;
    this.store.markForeign(id);
    state.owner = owner;
    const session = new AgentSession(state, dormantProvider(provider), this.store, this);
    this.live.set(id, session);
    const tail = new ForeignTail({
      id, store: this.store, file: path.join(this.storeRoot(), 'sessions', `${id}.jsonl`),
      stillForeign: async () => (await this.ownership?.ownerOf(id)) !== undefined,
      onPatch: (patch) => { this.patch(id, patch); },
      onFree: () => { void this.releaseForeign(id); },
    });
    this.foreign.set(id, tail);
    tail.start();
    this.changed();
    return session;
  }

  private async releaseForeign(id: SessionId): Promise<void> {
    this.foreign.get(id)?.stop();
    this.foreign.delete(id);
    this.store.clearForeign(id);
    const session = this.live.get(id);
    if (session) { await session.dispose(); this.live.delete(id); }
    const state = this.meta.get(id);
    if (state) { delete state.owner; }
    if (!this.disposed) { this.emit({ t: 'sessions-changed', sessions: this.summaries() }); }
  }
```
`storeRoot()` needs the store's root; add to `TranscriptStore` a public `get root(): string { return this.rootDir; }` and use `this.store.root` in place of `this.storeRoot()`.

5h. `hide()`: at the top add `const wasForeign = this.foreign.has(id); if (wasForeign) { await this.releaseForeign(id); }`. Wrap the mutation and digest so a foreign hide changes nothing of the owner's: change the `if (state) { state.status = 'idle'; state.updatedAt = Date.now(); }` block to `if (state && !wasForeign) {…}` and `if (state) { await this.digestHidden(id); }` to `if (state && !wasForeign) { await this.digestHidden(id); }`. After the `session.dispose()` block add `if (!wasForeign) { await this.ownership?.release(id); }`.

5i. `close()`: change the discard condition to `if (state && !this.foreign.has(id) && await this.isDiscardable(id, state))`. `remove()`: first line `if (this.foreign.has(id)) { return; }`.

5j. `dispose()`: after `this.disposed = true;` add `if (this.rosterTimer) { clearInterval(this.rosterTimer); }`; after the sessions' disposal and before `await this.persist()` add `for (const id of [...this.foreign.keys()]) { this.foreign.get(id)?.stop(); }`; after `await this.persist();` add `await this.ownership?.dispose();`.

- [ ] **Step 6: Run to verify it passes, and nothing regressed**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit`
Expected: PASS for the new suites and every existing `session-manager*.test.ts` (ownership unset there, so the legacy path runs).

- [ ] **Step 7: Commit**

```bash
cd /e/Efebia/hiiiid-code && git branch --show-current && yarn lint && yarn check-types
git add src/host/foreign-tail.ts src/host/session-manager.ts src/host/transcript-store.ts src/test/unit/foreign-tail.test.ts src/test/unit/session-manager-shared.test.ts
git commit -m "feat: SessionManager claims leases, opens foreign sessions read-only and syncs the roster"
```

---

### Task 9: Host config schema

**Files:**
- Create: `src/host/host-config.ts`
- Test: `src/test/unit/host-config.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_PROVIDER_IDS`, `KNOWN_PROVIDER_IDS` (`src/shared/settings.ts`); `clampCap` (`src/host/fleet-diff.ts`); `UsageMirror` (`src/providers/types.ts`).
- Produces:
  - `interface HostConfig { enabledProviders: string[]; providerInstances: unknown; systemPrompts: unknown; codexPath?: string; opencodePath?: string; usageMirrors: UsageMirror[]; memory: { enabled: boolean; summarizer: unknown }; review: { fileCap: number; pollIntervalMs: number; baseRefs: string[] }; favoriteModels: string[] }`
  - `defaultHostConfig(): HostConfig`
  - `parseHostConfig(raw: unknown): { config: HostConfig; warnings: string[] }`
  - `MOVED_SETTING_IDS: readonly string[]` (the `marcode.*` ids that now live in the file, used by the extension's open-settings routing).
  - `reloadSignature(config: HostConfig): string` (everything except `favoriteModels`).

`providerInstances`, `systemPrompts` and `memory.summarizer` stay `unknown` on purpose: their existing validators (`validateProviderInstances`, `validateSystemPrompts`, `validateSummarizer`) need the resolved provider ids and are run by `createHost`, exactly where `activate()` runs them today.

- [ ] **Step 1: Write the failing test**

```ts
import * as assert from 'assert';
import { defaultHostConfig, parseHostConfig, reloadSignature } from '../../host/host-config';

suite('host-config', () => {
  test('an absent file is the defaults with no warnings', () => {
    const { config, warnings } = parseHostConfig(undefined);
    assert.deepStrictEqual(config, defaultHostConfig());
    assert.deepStrictEqual(warnings, []);
  });

  test('the default provider list matches the extension default', () => {
    assert.deepStrictEqual(defaultHostConfig().enabledProviders, ['claude', 'codex', 'opencode']);
  });

  test('a non-object file is the defaults plus one warning', () => {
    const { config, warnings } = parseHostConfig([1, 2]);
    assert.deepStrictEqual(config, defaultHostConfig());
    assert.strictEqual(warnings.length, 1);
  });

  test('a wrong-typed key falls back to its default and names the key', () => {
    const { config, warnings } = parseHostConfig({ enabledProviders: 'claude', memory: { enabled: 'yes' } });
    assert.deepStrictEqual(config.enabledProviders, defaultHostConfig().enabledProviders);
    assert.strictEqual(config.memory.enabled, true);
    assert.strictEqual(warnings.some((w) => w.includes('enabledProviders')), true);
    assert.strictEqual(warnings.some((w) => w.includes('memory.enabled')), true);
  });

  test('an empty provider list is honoured, not replaced by the default', () => {
    assert.deepStrictEqual(parseHostConfig({ enabledProviders: [] }).config.enabledProviders, []);
  });

  test('unknown provider ids are kept out and named', () => {
    const { config, warnings } = parseHostConfig({ enabledProviders: ['claude', 'cluade'] });
    assert.deepStrictEqual(config.enabledProviders, ['claude']);
    assert.strictEqual(warnings.some((w) => w.includes('cluade')), true);
  });

  test('empty binary paths mean "from PATH"', () => {
    const { config } = parseHostConfig({ codexPath: '', opencodePath: '/x/opencode' });
    assert.strictEqual(config.codexPath, undefined);
    assert.strictEqual(config.opencodePath, '/x/opencode');
  });

  test('review settings are clamped through the existing rules', () => {
    const { config } = parseHostConfig({ review: { fileCap: 9_999_999, pollIntervalMs: 1, baseRefs: ['develop', 3, ' '] } });
    assert.strictEqual(config.review.fileCap, 2000);
    assert.strictEqual(config.review.pollIntervalMs, 100);
    assert.deepStrictEqual(config.review.baseRefs, ['develop']);
  });

  test('usage mirrors with a missing field or a broken pattern are dropped', () => {
    const ok = { sourceProviderId: 'a', modelPattern: '^x', targetProviderId: 'b', usageProviderId: 'c', displayName: 'D' };
    const { config } = parseHostConfig({ usageMirrors: [ok, { ...ok, modelPattern: '(' }, { ...ok, displayName: '' }, 5] });
    assert.strictEqual(config.usageMirrors.length, 1);
  });

  test('reloadSignature ignores favoriteModels and nothing else', () => {
    const a = defaultHostConfig();
    const b = { ...a, favoriteModels: ['fake x'] };
    const c = { ...a, enabledProviders: ['claude'] };
    assert.strictEqual(reloadSignature(a), reloadSignature(b));
    assert.notStrictEqual(reloadSignature(a), reloadSignature(c));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit -g "host-config"`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement.** Move the logic of `enabledProviderIds`, `reviewFileCap`, `reviewPollIntervalMs`, `reviewBaseRefs`, `favoriteModels`, `configuredUsageMirrors` and `codexBinPath`/`openCodeBinPath` from `extension.ts` (lines 53-147 and 162-185) into pure functions of the parsed object:

```ts
import { KNOWN_PROVIDER_IDS, DEFAULT_PROVIDER_IDS } from '../shared/settings';
import type { UsageMirror } from '../providers/types';
import { clampCap } from './fleet-diff';

export interface HostConfig {
  enabledProviders: string[];
  providerInstances: unknown;
  systemPrompts: unknown;
  codexPath?: string;
  opencodePath?: string;
  usageMirrors: UsageMirror[];
  memory: { enabled: boolean; summarizer: unknown };
  review: { fileCap: number; pollIntervalMs: number; baseRefs: string[] };
  favoriteModels: string[];
}

export const MOVED_SETTING_IDS: readonly string[] = [
  'marcode.enabledProviders', 'marcode.providerInstances', 'marcode.systemPrompts', 'marcode.codex.path',
  'marcode.opencode.path', 'marcode.usageMirrors', 'marcode.memory.enabled', 'marcode.memory.summarizer',
  'marcode.review.fileCap', 'marcode.review.pollIntervalMs', 'marcode.review.baseRefs', 'marcode.favoriteModels',
];

export function defaultHostConfig(): HostConfig {
  return {
    enabledProviders: [...DEFAULT_PROVIDER_IDS], providerInstances: undefined, systemPrompts: undefined,
    usageMirrors: [], memory: { enabled: true, summarizer: undefined },
    review: { fileCap: clampCap(undefined), pollIntervalMs: 750, baseRefs: [] }, favoriteModels: [],
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const stringList = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;

export function parseHostConfig(raw: unknown): { config: HostConfig; warnings: string[] } {
  const config = defaultHostConfig();
  const warnings: string[] = [];
  if (raw === undefined) { return { config, warnings }; }
  if (!isObject(raw)) { return { config, warnings: ['config.json is not an object; using the defaults.'] }; }

  if (raw.enabledProviders !== undefined) {
    const ids = stringList(raw.enabledProviders);
    if (!ids) {
      warnings.push('config.json: enabledProviders is not a list of strings; using the default.');
    } else {
      const unknown = ids.filter((id) => !KNOWN_PROVIDER_IDS.includes(id as (typeof KNOWN_PROVIDER_IDS)[number]));
      if (unknown.length > 0) {
        warnings.push(`config.json: ignoring unknown provider ${unknown.join(', ')}. Known providers: ${KNOWN_PROVIDER_IDS.join(', ')}.`);
      }
      config.enabledProviders = ids.filter((id) => !unknown.includes(id));
    }
  }
  config.providerInstances = raw.providerInstances;
  config.systemPrompts = raw.systemPrompts;
  if (typeof raw.codexPath === 'string' && raw.codexPath !== '') { config.codexPath = raw.codexPath; }
  if (typeof raw.opencodePath === 'string' && raw.opencodePath !== '') { config.opencodePath = raw.opencodePath; }

  if (Array.isArray(raw.usageMirrors)) {
    const fields = ['sourceProviderId', 'modelPattern', 'targetProviderId', 'usageProviderId', 'displayName'];
    config.usageMirrors = raw.usageMirrors.flatMap((entry): UsageMirror[] => {
      if (!isObject(entry)) { return []; }
      if (!fields.every((f) => typeof entry[f] === 'string' && (entry[f] as string).trim() !== '')) { return []; }
      try { new RegExp(entry.modelPattern as string); } catch { return []; }
      return [entry as unknown as UsageMirror];
    });
  }

  if (raw.memory !== undefined) {
    if (!isObject(raw.memory)) {
      warnings.push('config.json: memory is not an object; using the default.');
    } else {
      if (raw.memory.enabled !== undefined) {
        if (typeof raw.memory.enabled === 'boolean') { config.memory.enabled = raw.memory.enabled; }
        else { warnings.push('config.json: memory.enabled is not a boolean; using the default.'); }
      }
      config.memory.summarizer = raw.memory.summarizer;
    }
  }

  if (isObject(raw.review)) {
    config.review.fileCap = clampCap(raw.review.fileCap as number | undefined);
    const poll = raw.review.pollIntervalMs;
    if (typeof poll === 'number' && !Number.isNaN(poll) && poll >= 1) { config.review.pollIntervalMs = Math.max(100, Math.floor(poll)); }
    if (Array.isArray(raw.review.baseRefs)) {
      config.review.baseRefs = raw.review.baseRefs.filter((r): r is string => typeof r === 'string' && r.trim() !== '');
    }
  }
  config.favoriteModels = (Array.isArray(raw.favoriteModels) ? raw.favoriteModels : [])
    .filter((id): id is string => typeof id === 'string' && id.trim() !== '');

  return { config, warnings };
}

export function reloadSignature(config: HostConfig): string {
  const { favoriteModels: _favorites, ...rest } = config;
  return JSON.stringify(rest);
}
```

The `review.pollIntervalMs` default is `750` (the value `activate()` falls back to today).

- [ ] **Step 4: Run to verify it passes**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit -g "host-config" && yarn check-types`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
cd /e/Efebia/hiiiid-code && git branch --show-current && yarn lint
git add src/host/host-config.ts src/test/unit/host-config.test.ts
git commit -m "feat: host config schema and validation"
```

---

### Task 10: Config file (load, seed, patch, watch)

**Files:**
- Create: `src/host/config-file.ts`
- Test: `src/test/unit/config-file.test.ts`

**Interfaces:**
- Consumes: `parseHostConfig`, `HostConfig`, `reloadSignature` (Task 9); `writeFileAtomic` (Task 1).
- Produces:
  - `configPath(home: string): string` (`<home>/config.json`)
  - `loadConfig(file: string): Promise<{ config: HostConfig; warnings: string[]; raw: Record<string, unknown> }>`: missing/empty file is the defaults with no warning; invalid JSON is the defaults with one warning.
  - `seedConfigFile(file: string, legacy: Record<string, unknown>): Promise<boolean>`: writes the file from explicit legacy VS Code values only if it does not exist (`true` if it wrote).
  - `patchConfig(file: string, patch: Record<string, unknown>): Promise<void>`: read-modify-write, atomic.
  - `watchConfig(file: string, initial: HostConfig, onReloadNeeded: () => void, intervalMs?: number): { dispose(): void }`: polls the file and calls `onReloadNeeded` once when `reloadSignature` differs from `initial`.
- Legacy key map (exactly): `enabledProviders`, `providerInstances`, `systemPrompts`, `codex.path`→`codexPath`, `opencode.path`→`opencodePath`, `usageMirrors`, `memory.enabled`→`memory.enabled`, `memory.summarizer`→`memory.summarizer`, `review.fileCap`/`pollIntervalMs`/`baseRefs`→`review.*`, `favoriteModels`. Empty-string paths are not seeded.

- [ ] **Step 1: Write the failing test**

```ts
import * as assert from 'assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig, patchConfig, seedConfigFile, watchConfig } from '../../host/config-file';

suite('config-file', () => {
  let dir: string;
  let file: string;
  setup(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-cfg-')); file = path.join(dir, 'config.json'); });
  teardown(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  test('a missing file loads as the defaults without a warning', async () => {
    const { config, warnings } = await loadConfig(file);
    assert.deepStrictEqual(config.enabledProviders, ['claude', 'codex', 'opencode']);
    assert.deepStrictEqual(warnings, []);
  });

  test('an empty file is the defaults without a warning', async () => {
    await fs.writeFile(file, '');
    assert.deepStrictEqual((await loadConfig(file)).warnings, []);
  });

  test('invalid JSON is the defaults plus one warning, never a throw', async () => {
    await fs.writeFile(file, '{ "enabledProviders": [');
    const { config, warnings } = await loadConfig(file);
    assert.strictEqual(warnings.length, 1);
    assert.deepStrictEqual(config.enabledProviders, ['claude', 'codex', 'opencode']);
  });

  test('seeding writes only explicit legacy values, and never overwrites', async () => {
    const wrote = await seedConfigFile(file, {
      enabledProviders: ['claude'], 'codex.path': '', 'opencode.path': '/o', 'memory.enabled': false, 'review.fileCap': 700,
    });
    assert.strictEqual(wrote, true);
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
    assert.deepStrictEqual(raw, {
      enabledProviders: ['claude'], opencodePath: '/o', memory: { enabled: false }, review: { fileCap: 700 },
    });
    assert.strictEqual(await seedConfigFile(file, { enabledProviders: ['codex'] }), false);
    assert.deepStrictEqual((await loadConfig(file)).config.enabledProviders, ['claude']);
  });

  test('patchConfig merges into what is there and keeps unrelated keys', async () => {
    await fs.writeFile(file, JSON.stringify({ enabledProviders: ['claude'] }));
    await patchConfig(file, { favoriteModels: ['fake x'] });
    const { config } = await loadConfig(file);
    assert.deepStrictEqual(config.enabledProviders, ['claude']);
    assert.deepStrictEqual(config.favoriteModels, ['fake x']);
  });

  test('the watcher fires for a reload-relevant edit but not for favoriteModels', async () => {
    await fs.writeFile(file, JSON.stringify({ enabledProviders: ['claude'] }));
    const { config } = await loadConfig(file);
    let fired = 0;
    const w = watchConfig(file, config, () => { fired++; }, 10);
    await patchConfig(file, { favoriteModels: ['a'] });
    await new Promise((r) => setTimeout(r, 60));
    assert.strictEqual(fired, 0);
    await patchConfig(file, { enabledProviders: ['codex'] });
    for (let i = 0; i < 50 && fired === 0; i++) { await new Promise((r) => setTimeout(r, 10)); }
    await new Promise((r) => setTimeout(r, 40));
    w.dispose();
    assert.strictEqual(fired, 1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit -g "config-file"`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { writeFileAtomic } from './atomic-file';
import { parseHostConfig, reloadSignature, type HostConfig } from './host-config';

export function configPath(home: string): string { return path.join(home, 'config.json'); }

async function readRaw(file: string): Promise<{ raw: Record<string, unknown> | undefined; warning?: string }> {
  let text: string;
  try { text = await fs.readFile(file, 'utf8'); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') { return { raw: undefined }; }
    return { raw: undefined, warning: `config.json could not be read (${(err as Error).message}); using the defaults.` };
  }
  if (text.trim() === '') { return { raw: undefined }; }
  try {
    const parsed: unknown = JSON.parse(text);
    return { raw: parsed as Record<string, unknown> };
  } catch (err) {
    return { raw: undefined, warning: `config.json is not valid JSON (${(err as Error).message}); using the defaults.` };
  }
}

export async function loadConfig(file: string): Promise<{ config: HostConfig; warnings: string[]; raw: Record<string, unknown> }> {
  const { raw, warning } = await readRaw(file);
  const parsed = parseHostConfig(raw);
  return { config: parsed.config, warnings: warning ? [warning, ...parsed.warnings] : parsed.warnings, raw: raw ?? {} };
}

const LEGACY_TOP: Record<string, string> = {
  enabledProviders: 'enabledProviders', providerInstances: 'providerInstances', systemPrompts: 'systemPrompts',
  usageMirrors: 'usageMirrors', favoriteModels: 'favoriteModels', 'codex.path': 'codexPath', 'opencode.path': 'opencodePath',
};

export async function seedConfigFile(file: string, legacy: Record<string, unknown>): Promise<boolean> {
  try { await fs.access(file); return false; } catch { /* absent: seed it */ }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(legacy)) {
    if (value === undefined || value === '') { continue; }
    const top = LEGACY_TOP[key];
    if (top) { out[top] = value; continue; }
    const [group, leaf] = key.split('.');
    if (group === 'memory' || group === 'review') {
      const bucket = (out[group] ?? {}) as Record<string, unknown>;
      bucket[leaf] = value;
      out[group] = bucket;
    }
  }
  await writeFileAtomic(file, JSON.stringify(out, null, 2));
  return true;
}

export async function patchConfig(file: string, patch: Record<string, unknown>): Promise<void> {
  const { raw } = await readRaw(file);
  await writeFileAtomic(file, JSON.stringify({ ...(raw ?? {}), ...patch }, null, 2));
}

export function watchConfig(
  file: string, initial: HostConfig, onReloadNeeded: () => void, intervalMs = 1500,
): { dispose(): void } {
  const baseline = reloadSignature(initial);
  let fired = false;
  let busy = false;
  const timer = setInterval(() => {
    if (fired || busy) { return; }
    busy = true;
    void loadConfig(file).then(({ config }) => {
      if (reloadSignature(config) !== baseline) { fired = true; onReloadNeeded(); }
    }).catch(() => { /* a failed poll is retried */ }).finally(() => { busy = false; });
  }, intervalMs);
  timer.unref();
  return { dispose: () => { clearInterval(timer); } };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit -g "config-file" && yarn check-types`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
cd /e/Efebia/hiiiid-code && git branch --show-current && yarn lint
git add src/host/config-file.ts src/test/unit/config-file.test.ts
git commit -m "feat: config.json load, first-import seed, patch and watch"
```

---

### Task 11: `createHost`

**Files:**
- Create: `src/host/create-host.ts`
- Modify: `src/memory/fts-memory-store.ts` (WAL + `busy_timeout`)
- Test: `src/test/unit/create-host.test.ts`, extend `src/test/unit/fts-memory-store.test.ts`

**Interfaces:**
- Consumes: `HostConfig` (Task 9); `SessionOwnership` (Task 4); every construction currently inlined in `activate()`.
- Produces:
  ```ts
  export interface LoginRecipe { terminalName: string; command: string; env: NodeJS.ProcessEnv }
  export interface CreateHostOptions {
    workspaceDir: string;
    config: HostConfig;
    hostKind: 'vscode' | 'tui';
    workspaceRoots: () => string[];
    emit: (msg: HostToWebview) => void;
    notify: { warn(message: string): void };
    onShellNoise?: (profile: string) => void;
  }
  export interface HostHandle {
    manager: SessionManager; store: TranscriptStore; attachments: AttachmentStore;
    providers: Map<string, AgentProvider>; enabled: Set<string>;
    loginRecipes: Map<string, LoginRecipe>; selfControlServer: SelfControlMcpServer;
    init(): Promise<void>; dispose(): Promise<void>;
  }
  export function createHost(opts: CreateHostOptions): Promise<HostHandle>
  ```

- [ ] **Step 1: Write the failing tests**

`fts-memory-store.test.ts`: add

```ts
  test('two stores on one file can both index and both see each other\'s rows', async () => {
    // build two FtsMemoryStore instances over the same temp db path with the
    // helper this file already uses to construct one, index a different
    // session through each, then assert each store's search finds both.
  });
```
Write it concretely against the helpers already at the top of `fts-memory-store.test.ts` (open the file, reuse its `record()` builder and temp path pattern); it must fail before the pragma change only if a `SQLITE_BUSY` surfaces, so also add `assert.strictEqual(pragma, 'wal')` by opening a third `DatabaseSync(path)` and reading `PRAGMA journal_mode`.

`create-host.test.ts`:

```ts
import * as assert from 'assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHost } from '../../host/create-host';
import { defaultHostConfig } from '../../host/host-config';
import type { HostToWebview } from '../../protocol/messages';

suite('createHost', () => {
  let dir: string;
  const handles: { dispose(): Promise<void> }[] = [];
  setup(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-host-')); });
  teardown(async () => {
    for (const h of handles.splice(0)) { await h.dispose(); }
    await fs.rm(dir, { recursive: true, force: true });
  });

  const build = async (over: Partial<ReturnType<typeof defaultHostConfig>> = {}, warnings: string[] = []) => {
    const h = await createHost({
      workspaceDir: dir, hostKind: 'tui', workspaceRoots: () => [dir], emit: (_m: HostToWebview) => {},
      notify: { warn: (m) => warnings.push(m) },
      config: { ...defaultHostConfig(), enabledProviders: ['fake'], memory: { enabled: false, summarizer: undefined }, ...over },
    });
    handles.push(h);
    return h;
  };

  test('only the enabled providers are registered', async () => {
    const h = await build();
    assert.deepStrictEqual([...h.providers.keys()], ['fake']);
    assert.deepStrictEqual([...h.enabled], ['fake']);
  });

  test('an empty provider list registers nothing and constructs no backend', async () => {
    assert.strictEqual((await build({ enabledProviders: [] })).providers.size, 0);
  });

  test('a session created through the handle survives a second host reading the same directory', async () => {
    const a = await build();
    await a.init();
    const s = await a.manager.create('fake', dir);
    await a.manager.persistNow();
    const b = await build();
    await b.init();
    assert.strictEqual(b.manager.summaries().some((x) => x.id === s.state.id), true);
  });

  test('a summarizer naming an unknown provider is a warning, not a failed start', async () => {
    const warnings: string[] = [];
    await build({ memory: { enabled: true, summarizer: { mode: 'llm', provider: 'nope', model: 'm' } } }, warnings);
    assert.strictEqual(warnings.some((w) => w.includes('memory.summarizer')), true);
  });

  test('dispose releases the leases it held', async () => {
    const h = await build();
    await h.init();
    await h.manager.create('fake', dir);
    await h.dispose();
    const locks = (await fs.readdir(path.join(dir, 'sessions')).catch(() => [])).filter((n) => n.endsWith('.lock'));
    assert.deepStrictEqual(locks, []);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit -g "createHost|FtsMemoryStore"`
Expected: FAIL.

- [ ] **Step 3: FTS store.** In `src/memory/fts-memory-store.ts`, immediately after `this.db = new DatabaseSync(dbPath);` add `this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');`.

- [ ] **Step 4: Create `src/host/create-host.ts`.** Move, verbatim except for the substitutions listed, these blocks from `src/extension.ts`:
  1. lines 242-262: `rootDir` becomes `opts.workspaceDir`; `memoryEnabled` becomes `opts.config.memory.enabled`.
  2. lines 264-287: `enabled = new Set(opts.config.enabledProviders)`; `usageMirrors = opts.config.usageMirrors`; the `SessionManager` construction takes `opts.emit` instead of `(msg) => bus.post(msg)`, `opts.onShellNoise` instead of `warnAboutProfile`, `opts.config.review.fileCap`, `opts.config.review.baseRefs`. Then add:
     ```ts
     const sessionsDir = path.join(opts.workspaceDir, 'sessions');
     const ownership = new SessionOwnership(sessionsDir, opts.hostKind);
     manager.setOwnership(ownership);
     ```
     and construct the store as `new TranscriptStore(opts.workspaceDir, opts.hostKind)`.
  3. lines 289-325: the self-control server, unchanged; `manager.setWorkspaceRoots(opts.workspaceRoots)`.
  4. lines 327-348: `validateProviderInstances(opts.config.providerInstances, KNOWN_PROVIDER_IDS)` and `validateSystemPrompts(opts.config.systemPrompts, kindOf)`; every `vscode.window.showWarningMessage(w)` becomes `opts.notify.warn(w)`.
  5. lines 350-465: provider construction and `loginRecipes`, with `codexBinPath()` → `opts.config.codexPath` and `openCodeBinPath()` → `opts.config.opencodePath`; the `warn` at the unset-env-var check becomes `opts.notify.warn(...)`.
  6. lines 467-487: the summarizer. Gate it on holding the digest lease:
     ```ts
     const digestLock = new SessionOwnership(opts.workspaceDir, opts.hostKind);
     const holdsDigest = memory ? (await digestLock.claim('digest')).owned : false;
     if (memory && holdsDigest) { /* the existing block, with the setting read from opts.config.memory.summarizer and warnings sent through opts.notify.warn */ }
     ```
  Keep the same explanatory comments the moved blocks already carry; do not add new ones except one line above `holdsDigest`: `// Extractive digests are idempotent so both hosts write them; only the LLM summarizer costs money, so one host runs it.`
  Return:
  ```ts
  manager.startRosterSync();
  return {
    manager, store, attachments, providers, enabled, loginRecipes, selfControlServer,
    init: () => manager.init(),
    dispose: async () => { await manager.dispose(); await selfControlServer.dispose(); await digestLock.dispose(); },
  };
  ```
  (`manager.dispose()` already disposes `ownership`.) `startRosterSync()` is called from `init` instead if the test above shows a poll before `init` misbehaving: put it inside `init: async () => { await manager.init(); manager.startRosterSync(); }`.

- [ ] **Step 5: Run to verify it passes**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit -g "createHost|FtsMemoryStore" && yarn check-types`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /e/Efebia/hiiiid-code && git branch --show-current && yarn lint
git add src/host/create-host.ts src/memory/fts-memory-store.ts src/test/unit/create-host.test.ts src/test/unit/fts-memory-store.test.ts
git commit -m "feat: extract vscode-free createHost"
```

---

### Task 12: Extension uses `createHost` and `config.json`

**Files:**
- Modify: `src/extension.ts`, `package.json`, `src/host/account-setup-wizard.ts`, `src/host/message-router.ts` (only its `ConfigHost` and `EditorHost` wiring, if the calls need new parameters), `src/test/integration/extension.test.ts`
- Test: `src/test/unit/settings.test.ts` (fix the expectations it holds for the moved settings), unit test `src/test/unit/open-settings-routing.test.ts`

**Interfaces:**
- Consumes: `marcodeHome`, `resolveWorkspaceDir` (Task 2); `loadConfig`, `seedConfigFile`, `patchConfig`, `watchConfig`, `configPath` (Task 10); `MOVED_SETTING_IDS` (Task 9); `createHost` (Task 11).
- Produces: `routeOpenSettings(section: string): 'config-file' | 'vscode'` (in `src/host/host-config.ts` or a tiny `src/host/settings-routing.ts`): `'config-file'` when any whitespace-separated id in `section` is in `MOVED_SETTING_IDS`.

- [ ] **Step 1: Write the failing routing test**

```ts
import * as assert from 'assert';
import { routeOpenSettings } from '../../host/settings-routing';

suite('routeOpenSettings', () => {
  test('a moved setting opens the config file', () => {
    assert.strictEqual(routeOpenSettings('marcode.enabledProviders marcode.providerInstances'), 'config-file');
  });
  test('a pure-UI setting stays in VS Code', () => {
    assert.strictEqual(routeOpenSettings('marcode.showCacheTimer'), 'vscode');
    assert.strictEqual(routeOpenSettings('marcode.debug'), 'vscode');
  });
});
```
Create `src/host/settings-routing.ts` exporting `routeOpenSettings` (splits on whitespace, checks `MOVED_SETTING_IDS`). Run `yarn test:unit -g "routeOpenSettings"` → PASS.

- [ ] **Step 2: Rewrite `activate()`.** Replace lines 240-487 of `src/extension.ts` with:

```ts
export async function activate(context: vscode.ExtensionContext) {
  setLifecycleDebug(vscode.workspace.getConfiguration('marcode').get<boolean>('debug', false));
  const home = marcodeHome();
  const configFile = configPath(home);
  await seedConfigFile(configFile, legacySettings());
  const { config, warnings: configWarnings } = await loadConfig(configFile);
  for (const warning of configWarnings) { void vscode.window.showWarningMessage(warning); }

  const workspaceDir = await resolveWorkspaceDir(home, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
  await offerMigration(context, workspaceDir);

  let provider: PanelViewProvider;
  const bus = new PostBus();
  const host = await createHost({
    workspaceDir, config, hostKind: 'vscode',
    workspaceRoots: () => vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [],
    emit: (msg) => bus.post(msg),
    notify: { warn: (m) => { void vscode.window.showWarningMessage(m); } },
    onShellNoise: warnAboutProfile,
  });
  const { manager, attachments, providers, enabled, loginRecipes, selfControlServer } = host;
  const codexProvider = providers.get('codex') as CodexProvider | undefined;
```
`legacySettings()` is a new local function returning `Record<string, unknown>` built from `getConfiguration('marcode').inspect(key)` for each legacy key, taking `globalValue ?? workspaceValue` and skipping `undefined`. `offerMigration` is added in Task 13; for this task define it as `async function offerMigration(): Promise<void> {}` in `extension.ts` so the file compiles, and Task 13 replaces it.

Then keep, unchanged, the code from the current line 489 (`resolvedCwd`) through the end of the `PanelViewProvider`/`bus.add` wiring, with these edits:
  - `reviewPollIntervalMs()` → `config.review.pollIntervalMs`; `favoriteModels` callback → `() => config.favoriteModels`; `showCacheTimer()` stays (a VS Code setting).
  - `configHost.setFavoriteModels` → `void patchConfig(configFile, { favoriteModels: ids });`
  - `editorHost.openSettings` → `(section) => { if (routeOpenSettings(section) === 'config-file') { void vscode.commands.executeCommand('vscode.open', vscode.Uri.file(configFile)); } else { void vscode.commands.executeCommand('workbench.action.openSettings', section); } }`
  - Register `vscode.commands.registerCommand('marcode.config.open', () => vscode.commands.executeCommand('vscode.open', vscode.Uri.file(configFile)))`.
  - Replace the whole `vscode.workspace.onDidChangeConfiguration` subscription's provider/memory/instance branches with one `const watcher = watchConfig(configFile, config, () => { /* the existing "Reload window" prompt, text: 'Marcode settings changed. Reload the window to apply them.' */ });` pushed to `context.subscriptions` as `{ dispose: () => watcher.dispose() }`. Keep only the `marcode.debug` branch in `onDidChangeConfiguration`; **delete** the `codexProvider.setBinPath` branch (a changed path now takes a reload).
  - `pendingDeactivate` awaits `host.dispose()`; `context.subscriptions` uses `{ dispose: () => { void host.dispose(); } }` instead of the separate manager/selfControlServer entries; `manager.init()` at the end becomes `await host.init()` inside the same `try`.
  - Delete the now-unused helper functions (`codexBinPath`, `openCodeBinPath`, `reviewFileCap`, `reviewPollIntervalMs`, `reviewBaseRefs`, `favoriteModels`, `configuredUsageMirrors`, `enabledProviderIds`) and the imports they alone used.

- [ ] **Step 3: Account-setup wizard.** In `src/host/account-setup-wizard.ts`, the read (`config.get(PROVIDER_INSTANCES_SETTING)`, line 34) and the write (lines 114-116) go through `loadConfig(configFile).config.providerInstances` and `patchConfig(configFile, { providerInstances: [...existing, newEntry] })`. Pass `configFile` in as a new parameter of `runAccountSetupWizard(KNOWN_PROVIDER_IDS, configFile)` and update its one call site in `extension.ts`. Replace the "shows its own Reload the window" comment context accordingly: the watcher now raises that prompt.

- [ ] **Step 4: `package.json`.** Delete these entries from `contributes.configuration.properties`: `marcode.memory.enabled`, `marcode.memory.summarizer`, `marcode.enabledProviders`, `marcode.codex.path`, `marcode.opencode.path`, `marcode.usageMirrors`, `marcode.providerInstances`, `marcode.systemPrompts`, `marcode.review.fileCap`, `marcode.review.pollIntervalMs`, `marcode.review.baseRefs`, `marcode.favoriteModels`. Keep `marcode.debug`, `marcode.showCacheTimer`, `marcode.agentsMdNudge.excludePaths`. Add to `contributes.commands`: `{ "command": "marcode.config.open", "title": "Marcode: Open Config File" }`. Move the moved settings' descriptions into a new `docs/config.md` (one heading per key, its old description, its default) so the documentation is not lost.

- [ ] **Step 5: Fix the tests that referenced removed settings.** Run `cd /e/Efebia/hiiiid-code && yarn test:unit` and update `settings.test.ts` (and any test asserting `package.json` contains a moved id) to assert the moved ids are now absent from `contributes.configuration` and present in `MOVED_SETTING_IDS`. In `src/test/integration/extension.test.ts` set `process.env.MARCODE_HOME` to a temp directory in the suite's `setup` so the run never touches the real `~/.marcode`.

- [ ] **Step 6: Verify**

Run: `cd /e/Efebia/hiiiid-code && yarn lint && yarn check-types && yarn run compile && yarn test:unit`
Expected: all green.

- [ ] **Step 7: Manual check.** Launch the extension dev host (F5). Confirm: the panel comes up; `~/.marcode/config.json` exists, seeded from any old VS Code settings; editing `enabledProviders` in it raises the reload prompt within ~2s; "Open settings" on the empty state opens `config.json`.

- [ ] **Step 8: Commit**

```bash
cd /e/Efebia/hiiiid-code && git branch --show-current
git add -A src package.json docs/config.md
git commit -m "feat: run the extension on createHost with config.json as the settings source"
```

---

### Task 13: Migration

**Files:**
- Create: `src/host/migrate-storage.ts`
- Modify: `src/extension.ts` (replace the placeholder `offerMigration`)
- Test: `src/test/unit/migrate-storage.test.ts`

**Interfaces:**
- Consumes: `writeFileAtomic` (Task 1).
- Produces:
  - `countOldSessions(oldDir: string): Promise<number>` (0 when there is no readable `index.json`)
  - `migrateStorage(oldDir: string, newDir: string, now?: () => number): Promise<{ ok: true; sessions: number } | { ok: false; reason: string }>`
  - `readMigrationMarker(newDir: string): Promise<{ from: string; at: number; sessions?: number; declined?: boolean } | undefined>`, `declineMigration(newDir: string, from: string): Promise<void>`

Behavior: copies `index.json` (merging with an existing destination index by session id, destination wins), `catalog.json`, `usage.json`, `memory.sqlite`, and every `sessions/*.jsonl`, never overwriting a destination file that already exists (except the merged `index.json`); the old directory is never modified; on the first error, files this run created are removed, no marker is written, and the reason is returned; on success `migrated.json` records `{ from, at, sessions }`.

- [ ] **Step 1: Write the failing test**

```ts
import * as assert from 'assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { countOldSessions, declineMigration, migrateStorage, readMigrationMarker } from '../../host/migrate-storage';

const idx = (ids: string[], layoutId = 'x') => JSON.stringify({
  version: 2,
  sessions: ids.map((id) => ({ id, title: id, name: id })),
  layout: { root: { kind: 'leaf', sessionId: layoutId, size: 100 }, presets: [] },
});

suite('migrate-storage', () => {
  let oldDir: string;
  let newDir: string;
  setup(async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-mig-'));
    oldDir = path.join(base, 'old');
    newDir = path.join(base, 'new');
    await fs.mkdir(path.join(oldDir, 'sessions'), { recursive: true });
    await fs.mkdir(newDir, { recursive: true });
  });
  teardown(async () => { await fs.rm(path.dirname(oldDir), { recursive: true, force: true }); });

  const seedOld = async () => {
    await fs.writeFile(path.join(oldDir, 'index.json'), idx(['s1', 's2']));
    await fs.writeFile(path.join(oldDir, 'catalog.json'), '{"providers":{}}');
    await fs.writeFile(path.join(oldDir, 'sessions', 's1.jsonl'), 'line1\n');
    await fs.writeFile(path.join(oldDir, 'sessions', 's2.jsonl'), 'line2\n');
  };

  test('countOldSessions reads the roster size, and is 0 with nothing there', async () => {
    assert.strictEqual(await countOldSessions(oldDir), 0);
    await seedOld();
    assert.strictEqual(await countOldSessions(oldDir), 2);
  });

  test('it copies everything, leaves the old directory untouched and writes the marker', async () => {
    await seedOld();
    const before = await fs.readFile(path.join(oldDir, 'index.json'), 'utf8');
    const r = await migrateStorage(oldDir, newDir, () => 42);
    assert.deepStrictEqual(r, { ok: true, sessions: 2 });
    assert.strictEqual(await fs.readFile(path.join(newDir, 'sessions', 's1.jsonl'), 'utf8'), 'line1\n');
    assert.strictEqual(await fs.readFile(path.join(oldDir, 'index.json'), 'utf8'), before);
    assert.deepStrictEqual(await readMigrationMarker(newDir), { from: oldDir, at: 42, sessions: 2 });
  });

  test('a destination that already holds a session keeps it and gains the rest', async () => {
    await seedOld();
    await fs.writeFile(path.join(newDir, 'index.json'), idx(['s2', 's9'], 'kept'));
    await fs.mkdir(path.join(newDir, 'sessions'), { recursive: true });
    await fs.writeFile(path.join(newDir, 'sessions', 's2.jsonl'), 'DEST\n');
    await migrateStorage(oldDir, newDir);
    const merged = JSON.parse(await fs.readFile(path.join(newDir, 'index.json'), 'utf8')) as { sessions: { id: string }[] };
    assert.deepStrictEqual(merged.sessions.map((s) => s.id).sort(), ['s1', 's2', 's9']);
    assert.strictEqual(await fs.readFile(path.join(newDir, 'sessions', 's2.jsonl'), 'utf8'), 'DEST\n');
  });

  test('a failure halfway removes what this run created and writes no marker', async () => {
    await seedOld();
    await fs.mkdir(path.join(oldDir, 'sessions', 's3.jsonl'));
    const r = await migrateStorage(oldDir, newDir);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(await readMigrationMarker(newDir), undefined);
    assert.deepStrictEqual(await fs.readdir(newDir), []);
  });

  test('running it twice is a no-op the second time', async () => {
    await seedOld();
    await migrateStorage(oldDir, newDir);
    const again = await migrateStorage(oldDir, newDir);
    assert.deepStrictEqual(again, { ok: true, sessions: 2 });
  });

  test('no old directory is a clear reason, not a throw', async () => {
    const r = await migrateStorage(path.join(oldDir, 'missing'), newDir);
    assert.strictEqual(r.ok, false);
  });

  test('a declined migration is remembered', async () => {
    await declineMigration(newDir, oldDir);
    assert.strictEqual((await readMigrationMarker(newDir))?.declined, true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit -g "migrate-storage"`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/host/migrate-storage.ts`**

```ts
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { writeFileAtomic } from './atomic-file';

export interface MigrationMarker { from: string; at: number; sessions?: number; declined?: boolean }
type Result = { ok: true; sessions: number } | { ok: false; reason: string };

const markerFile = (dir: string) => path.join(dir, 'migrated.json');
const exists = (p: string) => fs.access(p).then(() => true, () => false);

async function readSessions(dir: string): Promise<{ id: string }[] | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(dir, 'index.json'), 'utf8')) as { sessions?: unknown };
    return Array.isArray(parsed.sessions) ? (parsed.sessions as { id: string }[]) : undefined;
  } catch { return undefined; }
}

export async function countOldSessions(oldDir: string): Promise<number> {
  return (await readSessions(oldDir))?.length ?? 0;
}

export async function readMigrationMarker(newDir: string): Promise<MigrationMarker | undefined> {
  try { return JSON.parse(await fs.readFile(markerFile(newDir), 'utf8')) as MigrationMarker; } catch { return undefined; }
}

export async function declineMigration(newDir: string, from: string): Promise<void> {
  await writeFileAtomic(markerFile(newDir), JSON.stringify({ from, at: Date.now(), declined: true }));
}

export async function migrateStorage(oldDir: string, newDir: string, now: () => number = Date.now): Promise<Result> {
  const oldSessions = await readSessions(oldDir);
  if (!oldSessions) { return { ok: false, reason: `No Marcode sessions were found in ${oldDir}.` }; }
  const existing = await readMigrationMarker(newDir);
  if (existing && !existing.declined) { return { ok: true, sessions: existing.sessions ?? oldSessions.length }; }

  const created: string[] = [];
  const copyNew = async (from: string, to: string): Promise<void> => {
    if (await exists(to)) { return; }
    await fs.mkdir(path.dirname(to), { recursive: true });
    const tmp = `${to}.migrating`;
    await fs.copyFile(from, tmp);
    await fs.rename(tmp, to);
    created.push(to);
  };

  try {
    for (const name of ['catalog.json', 'usage.json', 'memory.sqlite']) {
      if (await exists(path.join(oldDir, name))) { await copyNew(path.join(oldDir, name), path.join(newDir, name)); }
    }
    const sessionsDir = path.join(oldDir, 'sessions');
    for (const name of await fs.readdir(sessionsDir).catch(() => [] as string[])) {
      if (name.endsWith('.jsonl')) { await copyNew(path.join(sessionsDir, name), path.join(newDir, 'sessions', name)); }
    }
    await mergeIndex(oldDir, newDir, created);
    await writeFileAtomic(markerFile(newDir), JSON.stringify({ from: oldDir, at: now(), sessions: oldSessions.length }));
    return { ok: true, sessions: oldSessions.length };
  } catch (err) {
    await Promise.all(created.map((f) => fs.rm(f, { force: true, recursive: true })));
    return { ok: false, reason: `Importing sessions failed: ${(err as Error).message}` };
  }
}

async function mergeIndex(oldDir: string, newDir: string, created: string[]): Promise<void> {
  const target = path.join(newDir, 'index.json');
  const old = JSON.parse(await fs.readFile(path.join(oldDir, 'index.json'), 'utf8')) as { sessions: { id: string }[]; layout?: unknown; version?: number };
  if (!(await exists(target))) {
    await writeFileAtomic(target, JSON.stringify(old, null, 2));
    created.push(target);
    return;
  }
  const current = JSON.parse(await fs.readFile(target, 'utf8')) as { sessions: { id: string }[] };
  const have = new Set(current.sessions.map((s) => s.id));
  const merged = { ...current, sessions: [...current.sessions, ...old.sessions.filter((s) => !have.has(s.id))] };
  await writeFileAtomic(target, JSON.stringify(merged, null, 2));
}
```
If the "failure halfway" test does not fail as written (the unreadable `s3.jsonl` directory makes `copyFile` throw `EISDIR` when `readdir` lists it and `name.endsWith('.jsonl')`), keep the test as the specification and make the implementation satisfy it.

- [ ] **Step 4: Replace the placeholder `offerMigration` in `extension.ts`**

```ts
async function offerMigration(context: vscode.ExtensionContext, workspaceDir: string): Promise<void> {
  const oldDir = (context.storageUri ?? context.globalStorageUri).fsPath;
  if (await readMigrationMarker(workspaceDir)) { return; }
  const count = await countOldSessions(oldDir);
  if (count === 0) { return; }
  const importLabel = 'Import';
  const choice = await vscode.window.showInformationMessage(
    `Import ${count} Marcode session${count === 1 ? '' : 's'} into ~/.marcode? Your existing data is copied, never moved.`,
    importLabel, 'Not now',
  );
  if (choice !== importLabel) { return; }
  const result = await migrateStorage(oldDir, workspaceDir);
  if (!result.ok) { void vscode.window.showWarningMessage(result.reason); }
}
```
"Not now" writes nothing so it asks again next launch; add a `'Never'` button that calls `declineMigration(workspaceDir, oldDir)`. Pass `workspaceDir` and `context` at the call site in `activate()`.

- [ ] **Step 5: Verify**

Run: `cd /e/Efebia/hiiiid-code && yarn lint && yarn check-types && yarn run compile && yarn test:unit -g "migrate-storage"`
Expected: green.

- [ ] **Step 6: Commit**

```bash
cd /e/Efebia/hiiiid-code && git branch --show-current
git add src/host/migrate-storage.ts src/extension.ts src/test/unit/migrate-storage.test.ts
git commit -m "feat: copy-only migration from the old storageUri"
```

---

### Task 14: Read-only state in the webview

**Files:**
- Create: `src/webview/lib/owner-reason.ts`
- Modify: `src/webview/components/pane-content.tsx` (line ~76)
- Test: `src/test/unit/owner-reason.test.ts`, `src/test/dom/owner-readonly.test.tsx`

**Interfaces:**
- Consumes: `SessionState.owner` (Task 7); `unavailabilityFor` (`src/webview/lib/provider-availability.ts`).
- Produces: `ownerReason(summary: { owner?: { host: string; pid: number } }): string | undefined`, `"Running in vscode (pid 1234). Read-only here."`.

- [ ] **Step 1: Invoke the impeccable skill's `shape` route** for this state change (a disabled composer with a reason line inside a 300-500px sidebar during a long agent turn). The reason reuses the existing `blockedReason` line, so no new element is added; the check is that it reads as informational rather than an error.

- [ ] **Step 2: Write the failing unit test**

```ts
import * as assert from 'assert';
import { ownerReason } from '../../webview/lib/owner-reason';

suite('ownerReason', () => {
  test('a foreign owner is named with its host and pid', () => {
    assert.strictEqual(ownerReason({ owner: { host: 'vscode', pid: 1234 } }), 'Running in vscode (pid 1234). Read-only here.');
  });
  test('no owner means no reason', () => {
    assert.strictEqual(ownerReason({}), undefined);
  });
});
```

Run `yarn test:unit -g "ownerReason"` → FAIL.

- [ ] **Step 3: Implement**

```ts
export function ownerReason(summary: { owner?: { host: string; pid: number } }): string | undefined {
  return summary.owner ? `Running in ${summary.owner.host} (pid ${summary.owner.pid}). Read-only here.` : undefined;
}
```

In `pane-content.tsx` change `unavailableReason={unavailabilityFor(state, paneState.summary.providerId)}` to `unavailableReason={ownerReason(paneState.summary) ?? unavailabilityFor(state, paneState.summary.providerId)}` and add the import.

- [ ] **Step 4: Write the DOM test.** Following `src/test/dom/harness.tsx`'s conventions (mount `<App/>` under the real `StoreProvider`, drive with `sendFromHost`, read what the webview posted): send a genuine `hydrate` whose `sessions[0]` and `snapshots[0]` carry `owner: { host: 'vscode', pid: 1234 }`, then assert with `screen.getByText(/Running in vscode \(pid 1234\)/)` (a `getBy` helper, safe) and that the composer's send control is disabled (`(screen.getByRole('button', { name: /send/i }) as HTMLButtonElement).disabled === true`, comparing a boolean). Add the mirror case with no `owner`, asserting the composer is enabled. Never pass a DOM node to `assert`.

- [ ] **Step 5: Run and gate**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit -g "ownerReason" && yarn test:dom -g "owner" && yarn lint && yarn check-types`
Then: `node <impeccable-skill-dir>/scripts/detect.mjs --json src/webview/components/pane-content.tsx src/webview/lib/owner-reason.ts` (exit 0). The controller (not this task's implementer) runs the two-agent critique gate at branch end, per the project's memory note.

- [ ] **Step 6: Commit**

```bash
cd /e/Efebia/hiiiid-code && git branch --show-current
git add src/webview src/test
git commit -m "feat: read-only composer with the owner named for a foreign session"
```

---

### Task 15: Two-host integration test and documentation

**Files:**
- Create: `src/test/unit/two-hosts.test.ts`
- Modify: `AGENTS.md`, `docs/superpowers/specs/2026-09-30-shared-storage-headless-host-design.md`

- [ ] **Step 1: Write the two-host test.** Two `createHost` instances, one process (so identical pids), one temp `workspaceDir`, `FakeProvider` (`enabledProviders: ['fake']`, memory off), host kinds `vscode` and `tui`, `emit` collecting messages:

```ts
import * as assert from 'assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHost, type HostHandle } from '../../host/create-host';
import { defaultHostConfig } from '../../host/host-config';
import type { HostToWebview } from '../../protocol/messages';

suite('two hosts, one directory', () => {
  let dir: string;
  const handles: HostHandle[] = [];
  const sent: Record<string, HostToWebview[]> = { vscode: [], tui: [] };
  setup(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-two-')); sent.vscode = []; sent.tui = []; });
  teardown(async () => { for (const h of handles.splice(0)) { await h.dispose(); } await fs.rm(dir, { recursive: true, force: true }); });

  const make = async (kind: 'vscode' | 'tui') => {
    const h = await createHost({
      workspaceDir: dir, hostKind: kind, workspaceRoots: () => [dir], emit: (m) => sent[kind].push(m),
      notify: { warn: () => {} },
      config: { ...defaultHostConfig(), enabledProviders: ['fake'], memory: { enabled: false, summarizer: undefined } },
    });
    await h.init();
    handles.push(h);
    return h;
  };
  const settle = () => new Promise((r) => setTimeout(r, 80));

  test('the guest sees the owner\'s session as foreign, tails its transcript and cannot write it', async () => {
    const a = await make('vscode');
    const b = await make('tui');
    const s = await a.manager.create('fake', dir);
    s.send('hello');
    await settle();
    await a.manager.persistNow();
    await b.manager.syncRoster();

    const opened = await b.manager.open(s.state.id);
    assert.deepStrictEqual(opened.state.owner, { host: 'vscode', pid: process.pid });
    const file = path.join(dir, 'sessions', `${s.state.id}.jsonl`);
    const before = await fs.readFile(file, 'utf8');
    opened.send('nope');
    await settle();
    await b.store.flush();
    assert.strictEqual(await fs.readFile(file, 'utf8'), before);

    await b.manager.setVisible([s.state.id]);
    s.send('second');
    await settle();
    await a.manager.persistNow();
    await settle();
    const patched = sent.tui.some((m) => m.t === 'session-patch' && m.id === s.state.id);
    assert.strictEqual(patched, true);
  });

  test('after the owner closes the session the guest can run it', async () => {
    const a = await make('vscode');
    const b = await make('tui');
    const s = await a.manager.create('fake', dir);
    await a.manager.persistNow();
    await b.manager.syncRoster();
    await b.manager.open(s.state.id);
    await a.manager.close(s.state.id);
    await settle();
    await settle();
    await b.manager.setVisible([]);
    const taken = await b.manager.open(s.state.id);
    assert.strictEqual(taken.state.owner, undefined);
  });
});
```

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit -g "two hosts"` → PASS. If a step is timing-sensitive, raise `settle` durations rather than adding retries in production code.

- [ ] **Step 2: Full gate**

Run: `cd /e/Efebia/hiiiid-code && git branch --show-current && yarn lint && yarn check-types && yarn run compile && yarn test:unit && yarn test:dom`
Expected: all green. Then run `yarn test` (integration); it must pass with `MARCODE_HOME` pointed at a temp directory (Task 12 Step 5).

- [ ] **Step 3: Update `AGENTS.md`.** Architecture table: add rows for `src/host/create-host.ts`, `session-ownership.ts`, `lease.ts`, `dormant-provider.ts`, `foreign-tail.ts`, `roster-sync.ts`, `workspace-dir.ts` (+ `src/shared/workspace-dir.ts`), `host-config.ts`, `config-file.ts`, `migrate-storage.ts`. Change the `extension.ts` row (it now resolves the directory, loads config, migrates, calls `createHost`, registers panels and commands) and the `src/host/transcript-store.ts` row (`~/.marcode/workspaces/<slug>/`, not `context.storageUri`). Add two invariants: **"A host never writes a session it does not own"** (the lease is the owner; a foreign session is opened over a dormant provider and the store refuses every write for it) and **"`config.json` is the single source of truth for host settings"** (moved setting ids, what stays in VS Code, that a change takes a reload). Update the `enabledProviders` invariant bullet's "a setting" wording to point at `config.json`.

- [ ] **Step 4: Update the spec.** In `## Decisions`/relevant sections add the three deviations listed under Global Constraints (digest lock gates only the LLM summarizer; layout per host; `host-config.ts` in `src/host/`), and in `## Code changes` fix the module list to match the File Structure table above.

- [ ] **Step 5: Commit**

```bash
cd /e/Efebia/hiiiid-code && git branch --show-current
git add src/test/unit/two-hosts.test.ts AGENTS.md docs/superpowers/specs/2026-09-30-shared-storage-headless-host-design.md
git commit -m "docs: record the shared-store invariants and add the two-host test"
```

---

## Self-Review

**Spec coverage.** Storage layout and resolver: Tasks 1-2. Config (all host-consumed settings, watcher, first import, `marcode.config.open`, open-settings routing, wizard, favoriteModels): Tasks 9, 10, 12. Ownership, leases, stale rules, foreign states, `owner` field: Tasks 3, 4, 7, 8, 14. Foreign tail via whole-file diff and store write guard: Tasks 5, 8. Roster atomic writes and merge: Tasks 1, 5, 7, 8. Digest lock and WAL: Task 11 (with the recorded deviation). Migration and prompt: Task 13. `createHost` and the `extension.ts` shrink: Tasks 11, 12. Tests named in the spec (resolver, lease, migration, config, merge, tail, two-host integration): Tasks 2, 3, 13, 9-10, 7, 8, 15. Out-of-scope items (OpenTUI client, forced takeover, daemon, per-workspace config) have no task, as intended.

**Placeholder scan.** Two spots in Task 11 reference existing test helpers ("reuse the helper this file already uses") instead of showing code, because `fts-memory-store.test.ts` was not read; the implementer must open it and write the concrete test there. Task 12 Step 2 moves existing code by line range rather than reprinting ~250 lines; the ranges and every substitution are listed. Task 14's DOM test describes the assertions but not the full file, since `harness.tsx` conventions must be read first. These are the plan's honest gaps.

**Type consistency.** `OwnerInfo` (`{ host; pid }`) matches `SessionState.owner`. `SessionOwnership.claim` returns `{ owned }` and `ownerOf` returns `OwnerInfo | undefined` everywhere they are used (Tasks 8, 11). `TranscriptStore(rootDir, layoutHost)` is constructed with the host kind in `createHost` and in every test. `persistNow()` is public and is what the tests call; `persist()` stays private. `HostConfig` fields used in Task 11 (`memory.summarizer`, `review.*`, `codexPath`, `opencodePath`) match Task 9.

**Review Focus coverage.** (1) same pid: Task 3 test "two hosts in one process", Task 15. (2) foreign never writes: Task 5, Task 8, Task 15. (3) bad config: Task 9, Task 10. (4) path edges: Task 2. (5) migration edges: Task 13.
