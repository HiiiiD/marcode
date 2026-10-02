# TUI memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The terminal client gets the same memory as the VS Code panel (recall, priming, digests) over the shared `memory.sqlite`, by running `FtsMemoryStore` on `bun:sqlite` under Bun.

**Architecture:** A narrow `SqlDb` driver seam (`src/memory/sqlite-driver.ts`) picks `bun:sqlite` or `node:sqlite` at open time and normalizes their differences. `FtsMemoryStore` opens through it; schema and queries are unchanged, so both hosts read and write one WAL file. The TUI stops forcing memory off; `createHost` already wires the store, `DigestService`, the `digest` lock and the recall tools.

**Tech Stack:** TypeScript, `node:sqlite` (Node 22 host), `bun:sqlite` (TUI, Bun 1.3.5), mocha (unit), `bun test` (TUI).

**Spec:** `docs/superpowers/specs/2026-10-02-tui-memory-design.md`

## Global Constraints

- Extension host target: VS Code `^1.125.0`, Node 22; the extension bundle must still build with `yarn run compile`.
- `src/providers/`, `src/protocol/`, `src/memory/` import no `vscode`; nothing under `src/tui/` imports `vscode`.
- Never hand a renderer or renderable to an assertion (`scripts/check-tui-asserts.mjs`).
- Comments minimal: only non-obvious "why".
- `yarn lint`, `yarn check-types`, `yarn check-types:tui` and `yarn run compile` must pass before the final commit.
- Conventional-commit prefixes; no Claude/Anthropic trailer on commits.
- Tests run through the guarded scripts: `yarn test:unit`, `yarn test:tui`. `yarn test:unit` can fail intermittently with `listen EACCES` or `ENOTEMPTY`; re-run before treating as real.
- Pin every command with its own `cd /e/Efebia/hiiiid-code` and assert the branch with `git branch --show-current`; shell cwd reverts mid-session.
- Write files containing backslashes with the Write or Edit tools, not shell heredocs.

## Review Focus

- A query with no row returns `undefined` from `get()` under both drivers (`bun:sqlite` returns `null`), so `getDigest` of an unknown session is `undefined`, not a crash. (Task 1, Task 2)
- Punctuation-only or empty recall queries return `[]` under Bun, not an FTS5 syntax error. (Task 2)
- Two processes on one file, one Node and one Bun, both index and each finds the other's session. (Task 2)
- A database written by Node with a stale `user_version` is dropped and rebuilt when Bun opens it. (Task 2)
- `memory.sqlite` that cannot be opened (a directory, corrupt) leaves the host running and says why through `notify`, not only `console.warn`. (Task 4)
- A SQLite build without FTS5 fails at open with a clear message instead of at the first query. (Task 1)

---

Run the whole plan on a branch off master: `cd /e/Efebia/hiiiid-code && git checkout -b feat/tui-memory`. The spec and this plan are already on master.

### Task 1: Driver seam and store

**Files:**
- Create: `src/memory/sqlite-driver.ts`
- Modify: `src/memory/fts-memory-store.ts:1,45,52`
- Modify: `esbuild.js:81`
- Test: `src/test/unit/sqlite-driver.test.ts`

**Interfaces:**
- Produces:
  - `interface SqlStatement { get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[]; run(...params: unknown[]): void }`
  - `interface SqlDb { exec(sql: string): void; prepare(sql: string): SqlStatement; close(): void }`
  - `interface RawDatabase` (the structural shape of `DatabaseSync` / `Database`)
  - `wrapDatabase(raw: RawDatabase): SqlDb`: `get()` returns `undefined` for no row
  - `assertFts5(db: SqlDb): void`: throws `Error('SQLite FTS5 is unavailable: …')`
  - `openDatabase(dbPath: string): SqlDb`: opens on the current runtime, runs `assertFts5`, closes and rethrows on failure
- `FtsMemoryStore`'s constructor signature `(dbPath, transcripts, schemaVersion?)` is unchanged.

- [ ] **Step 1: Write the failing test**

Create `src/test/unit/sqlite-driver.test.ts`:

```ts
import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { suite, test } from 'mocha';
import { assertFts5, openDatabase, wrapDatabase, type RawDatabase } from '../../memory/sqlite-driver';

function fakeRaw(over: Partial<RawDatabase> = {}): RawDatabase {
  return {
    exec: () => undefined,
    prepare: () => ({ get: () => null, all: () => [], run: () => undefined }),
    close: () => undefined,
    ...over,
  };
}

suite('sqlite-driver', () => {
  test('wrapDatabase turns a null row into undefined', () => {
    const db = wrapDatabase(fakeRaw());
    assert.strictEqual(db.prepare('SELECT 1').get(), undefined);
  });

  test('wrapDatabase passes a found row through untouched', () => {
    const row = { json: '{}' };
    const db = wrapDatabase(fakeRaw({ prepare: () => ({ get: () => row, all: () => [row], run: () => undefined }) }));
    assert.strictEqual(db.prepare('SELECT 1').get(), row);
    assert.deepStrictEqual(db.prepare('SELECT 1').all(), [row]);
  });

  test('assertFts5 explains a build without FTS5', () => {
    const db = wrapDatabase(fakeRaw({ exec: () => { throw new Error('no such module: fts5'); } }));
    assert.throws(() => assertFts5(db), /FTS5 is unavailable: no such module: fts5/);
  });

  test('openDatabase round-trips on this runtime and reports no row as undefined', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'marcode-driver-'));
    const db = openDatabase(path.join(dir, 'x.sqlite'));
    db.exec('CREATE TABLE t (a TEXT PRIMARY KEY, n INTEGER)');
    db.prepare('INSERT INTO t (a, n) VALUES (?, ?)').run('k', 7);
    assert.deepStrictEqual({ ...(db.prepare('SELECT n FROM t WHERE a = ?').get('k') as object) }, { n: 7 });
    assert.strictEqual(db.prepare('SELECT n FROM t WHERE a = ?').get('missing'), undefined);
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /e/Efebia/hiiiid-code && npx mocha --ui tdd --require tsx/cjs src/test/unit/sqlite-driver.test.ts`
Expected: FAIL, cannot find module `../../memory/sqlite-driver`.

- [ ] **Step 3: Write the driver**

Create `src/memory/sqlite-driver.ts`:

```ts
export interface SqlStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): void;
}

export interface SqlDb {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
}

export interface RawDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
  };
  close(): void;
}

export function wrapDatabase(raw: RawDatabase): SqlDb {
  return {
    exec: (sql) => { raw.exec(sql); },
    prepare: (sql) => {
      const statement = raw.prepare(sql);
      return {
        // bun:sqlite reports no row as null, node:sqlite as undefined
        get: (...params) => statement.get(...params) ?? undefined,
        all: (...params) => statement.all(...params),
        run: (...params) => { statement.run(...params); },
      };
    },
    close: () => raw.close(),
  };
}

// A build without FTS5 (the macOS system SQLite is the known risk) must fail here, not on the first query.
export function assertFts5(db: SqlDb): void {
  try {
    db.exec('CREATE VIRTUAL TABLE temp.fts5_probe USING fts5(x); DROP TABLE temp.fts5_probe;');
  } catch (err) {
    throw new Error(`SQLite FTS5 is unavailable: ${(err as Error).message}`);
  }
}

// require, not a top-level import: the module that does not exist on this runtime must only fail when opened.
function openRaw(dbPath: string): RawDatabase {
  if (process.versions.bun) {
    const { Database } = require('bun:sqlite') as { Database: new (file: string) => RawDatabase };
    return new Database(dbPath);
  }
  const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (file: string) => RawDatabase };
  return new DatabaseSync(dbPath);
}

export function openDatabase(dbPath: string): SqlDb {
  const db = wrapDatabase(openRaw(dbPath));
  try {
    assertFts5(db);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}
```

- [ ] **Step 4: Point the store at it**

In `src/memory/fts-memory-store.ts` replace line 1 `import { DatabaseSync } from 'node:sqlite';` with:

```ts
import { openDatabase, type SqlDb } from './sqlite-driver';
```

Change `private readonly db: DatabaseSync;` to `private readonly db: SqlDb;` and `this.db = new DatabaseSync(dbPath);` to `this.db = openDatabase(dbPath);`.

- [ ] **Step 5: Keep esbuild from resolving `bun:sqlite`**

In `esbuild.js` line 81 change the extension bundle's external list to:

```js
external: ['vscode', '@anthropic-ai/claude-agent-sdk', 'bun:sqlite'],
```

- [ ] **Step 6: Run tests, types, lint, compile**

Run: `cd /e/Efebia/hiiiid-code && npx mocha --ui tdd --require tsx/cjs src/test/unit/sqlite-driver.test.ts src/test/unit/fts-memory-store.test.ts && yarn check-types && yarn lint && yarn run compile`
Expected: all PASS; compile succeeds with no "Could not resolve bun:sqlite".

- [ ] **Step 7: Commit**

```bash
cd /e/Efebia/hiiiid-code && git add src/memory/sqlite-driver.ts src/memory/fts-memory-store.ts esbuild.js src/test/unit/sqlite-driver.test.ts && git commit -m "feat: sqlite driver seam for the memory store"
```

---

### Task 2: Store and cross-driver tests under Bun

**Files:**
- Create: `src/test/tui/node-memory-cli.ts`
- Create: `src/test/tui/memory-store-bun.test.ts`

**Interfaces:**
- Consumes: `FtsMemoryStore(dbPath, reader, schemaVersion?)`, `openDatabase` from Task 1.
- Produces: `node-memory-cli.ts` run as `node --require tsx/cjs src/test/tui/node-memory-cli.ts <write|search> <dbFile> [query]`. `write` indexes session `from-node` (text `zebra migration plan`); `search` prints a JSON array of session ids.

- [ ] **Step 1: Write the Node helper**

Create `src/test/tui/node-memory-cli.ts`:

```ts
import { FtsMemoryStore } from '../../memory/fts-memory-store';

const [command, file, query] = process.argv.slice(2);

async function main(): Promise<void> {
  const store = new FtsMemoryStore(file, { tail: async () => ({ items: [], hasMore: false }) });
  if (command === 'write') {
    await store.index({
      sessionId: 'from-node', providerId: 'claude', cwd: '/repo', closedAt: 1,
      items: [{ id: 'n1', ts: 0, role: 'user', text: 'zebra migration plan' }],
    });
  } else if (command === 'search') {
    console.log(JSON.stringify((await store.search(query ?? '')).map((hit) => hit.sessionId)));
  }
  store.close();
}

void main();
```

- [ ] **Step 2: Write the failing Bun suite**

Create `src/test/tui/memory-store-bun.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { FtsMemoryStore } from '../../memory/fts-memory-store';
import type { TranscriptItem } from '../../protocol/messages';

const reader = { tail: async () => ({ items: [] as TranscriptItem[], hasMore: false }) };
const item = (id: string, text: string): TranscriptItem => ({ id, ts: 0, role: 'user', text });

async function dbPath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'marcode-bun-memory-'));
  return path.join(dir, 'memory.sqlite');
}

function runNode(...args: string[]): string {
  const res = spawnSync('node', ['--require', 'tsx/cjs', 'src/test/tui/node-memory-cli.ts', ...args], {
    encoding: 'utf8', cwd: process.cwd(),
  });
  if (res.status !== 0) { throw new Error(`node helper failed: ${res.stderr}`); }
  return res.stdout.trim().split('\n').pop() ?? '';
}

test('this suite runs under Bun', () => {
  expect(Boolean(process.versions.bun)).toBe(true);
});

test('index then search by keyword, and an unknown session has no digest', async () => {
  const store = new FtsMemoryStore(await dbPath(), reader);
  await store.index({ sessionId: 's1', providerId: 'claude', cwd: '/repo', closedAt: 1, items: [item('u1', 'Investigate the flaky login test')] });
  const hits = await store.search('flaky login');
  expect(hits.map((h) => h.sessionId)).toEqual(['s1']);
  expect(hits[0].itemId).toBe('u1');
  expect(await store.getDigest('nope')).toBeUndefined();
  expect((await store.getDigest('s1'))?.title === undefined).toBe(false);
  store.close();
});

test('search keeps only sessions inside the folder', async () => {
  const store = new FtsMemoryStore(await dbPath(), reader);
  await store.index({ sessionId: 'in', providerId: 'claude', cwd: path.join(os.tmpdir(), 'ws', 'a'), closedAt: 1, items: [item('u1', 'giraffe rollout')] });
  await store.index({ sessionId: 'out', providerId: 'claude', cwd: path.join(os.tmpdir(), 'elsewhere'), closedAt: 2, items: [item('u2', 'giraffe rollout')] });
  const hits = await store.search('giraffe', { cwdWithin: path.join(os.tmpdir(), 'ws') });
  expect(hits.map((h) => h.sessionId)).toEqual(['in']);
  store.close();
});

test('punctuation-only and empty queries return no hits instead of an FTS5 error', async () => {
  const store = new FtsMemoryStore(await dbPath(), reader);
  await store.index({ sessionId: 's1', providerId: 'claude', cwd: '/repo', closedAt: 1, items: [item('u1', 'anything')] });
  expect(await store.search('?? : /')).toEqual([]);
  expect(await store.search('')).toEqual([]);
  store.close();
});

test('forget removes the row and the digest', async () => {
  const store = new FtsMemoryStore(await dbPath(), reader);
  await store.index({ sessionId: 's1', providerId: 'claude', cwd: '/repo', closedAt: 1, items: [item('u1', 'giraffe')] });
  await store.forget('s1');
  expect(await store.search('giraffe')).toEqual([]);
  expect(await store.getDigest('s1')).toBeUndefined();
  store.close();
});

test('a database with a stale schema version is rebuilt, not failed', async () => {
  const file = await dbPath();
  const old = new FtsMemoryStore(file, reader, 1);
  await old.index({ sessionId: 's1', providerId: 'claude', cwd: '/repo', closedAt: 1, items: [item('u1', 'giraffe')] });
  old.close();
  const fresh = new FtsMemoryStore(file, reader);
  expect(await fresh.search('giraffe')).toEqual([]);
  await fresh.index({ sessionId: 's2', providerId: 'claude', cwd: '/repo', closedAt: 2, items: [item('u2', 'giraffe')] });
  expect((await fresh.search('giraffe')).map((h) => h.sessionId)).toEqual(['s2']);
  fresh.close();
});

test('a Node process and a Bun process on one file each find the other\'s session', async () => {
  const file = await dbPath();
  const store = new FtsMemoryStore(file, reader);
  runNode('write', file);
  expect((await store.search('zebra')).map((h) => h.sessionId)).toEqual(['from-node']);
  await store.index({ sessionId: 'from-bun', providerId: 'claude', cwd: '/repo', closedAt: 2, items: [item('b1', 'giraffe rollout notes')] });
  store.close();
  expect(JSON.parse(runNode('search', file, 'giraffe'))).toEqual(['from-bun']);
});
```

- [ ] **Step 3: Run the suite**

Run: `cd /e/Efebia/hiiiid-code && bun test src/test/tui/memory-store-bun.test.ts`
Expected: PASS (Task 1 already made the store Bun-capable). If a test fails, the driver wrapper in Task 1 is wrong for Bun; fix it there, not in the test. In particular, if `bun:sqlite`'s `exec` rejects a multi-statement string, split the statements inside `wrapDatabase.exec` on `;`.

- [ ] **Step 4: Run the guarded TUI gate and types**

Run: `cd /e/Efebia/hiiiid-code && yarn check-types:tui && yarn test:tui`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /e/Efebia/hiiiid-code && git add src/test/tui/node-memory-cli.ts src/test/tui/memory-store-bun.test.ts && git commit -m "test: memory store under bun:sqlite and across drivers"
```

---

### Task 3: Stop forcing memory off in the TUI

**Files:**
- Modify: `src/tui/boot.ts:30-33,44`
- Modify: `src/test/unit/tui-boot.test.ts:5,77-84`
- Modify: `src/test/tui/boot-bun.test.ts:15-24`
- Modify: `scripts/build-tui.mjs:18-19`

**Interfaces:**
- Consumes: `bootHost(opts)`, unchanged signature. `memoryForRuntime` is removed.

- [ ] **Step 1: Rewrite the Bun boot test (failing first)**

Replace the test in `src/test/tui/boot-bun.test.ts` (lines 15-24) with:

```ts
test('under Bun memory follows config: the store opens and nothing warns at launch', async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mar-bunboot-')));
  const notified: string[] = [];
  const home = path.join(tmp, 'home');
  booted = await bootHost({
    cwd: tmp, home, notify: (m) => { notified.push(m); },
    config: { enabledProviders: ['fake'], memory: { enabled: true, summarizer: undefined } },
  });
  const files = await fs.readdir(home, { recursive: true });
  expect(files.some((f) => String(f).endsWith('memory.sqlite'))).toBe(true);
  expect(booted.warnings).toEqual([]);
  expect(notified).toEqual([]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /e/Efebia/hiiiid-code && bun test src/test/tui/boot-bun.test.ts`
Expected: FAIL, no `memory.sqlite` (memory is still forced off).

- [ ] **Step 3: Remove the force-off**

In `src/tui/boot.ts` delete lines 30-33 (the comment and `memoryForRuntime`) and the line `config.memory = memoryForRuntime(config.memory, Boolean(process.versions.bun));`. `HostConfig` is still imported and used.

In `src/test/unit/tui-boot.test.ts` change the import on line 5 to `import { bootHost, type Booted } from '../../tui/boot';` and delete the two `memoryForRuntime` tests (lines 77-84).

In `scripts/build-tui.mjs` replace the comment on lines 18-19 with:

```js
// Bun hoists the lazy require of the sqlite driver into a top-level `import 'node:sqlite'`, which
// Bun's runtime cannot satisfy. The driver opens bun:sqlite under Bun and never constructs this stand-in.
```

- [ ] **Step 4: Run the tests**

Run: `cd /e/Efebia/hiiiid-code && bun test src/test/tui/boot-bun.test.ts && npx mocha --ui tdd --require tsx/cjs src/test/unit/tui-boot.test.ts && yarn check-types && yarn check-types:tui && yarn lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /e/Efebia/hiiiid-code && git add src/tui/boot.ts src/test/unit/tui-boot.test.ts src/test/tui/boot-bun.test.ts scripts/build-tui.mjs && git commit -m "feat: TUI uses memory under Bun"
```

---

### Task 4: Say why memory is off

**Files:**
- Modify: `src/host/create-host.ts:71-73`
- Test: `src/test/unit/create-host.test.ts`

- [ ] **Step 1: Write the failing test**

Add inside the `createHost` suite in `src/test/unit/create-host.test.ts`, after the digest-lock test:

```ts
  test('a memory store that cannot open leaves the host running and says why', async () => {
    await fs.mkdir(path.join(dir, 'memory.sqlite'));
    const warnings: string[] = [];
    const h = await build({ memory: { enabled: true, summarizer: undefined } }, warnings);
    await h.init();
    assert.strictEqual(warnings.some((m) => m.includes('memory is unavailable')), true);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /e/Efebia/hiiiid-code && npx mocha --ui tdd --require tsx/cjs src/test/unit/create-host.test.ts`
Expected: FAIL on the new test (no warning reaches `notify`).

- [ ] **Step 3: Warn through `notify`**

In `src/host/create-host.ts` replace the catch body (the `console.warn` line) with:

```ts
      console.warn('[mar-code] memory store unavailable; recall tools will be disabled', err);
      notify.warn(`Marcode memory is unavailable (${(err as Error).message}); recall and session digests are off in this window.`);
```

- [ ] **Step 4: Run tests**

Run: `cd /e/Efebia/hiiiid-code && npx mocha --ui tdd --require tsx/cjs src/test/unit/create-host.test.ts && yarn check-types && yarn lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /e/Efebia/hiiiid-code && git add src/host/create-host.ts src/test/unit/create-host.test.ts && git commit -m "fix: surface an unavailable memory store through notify"
```

---

### Task 5: Docs and the compiled binary

**Files:**
- Modify: `docs/tui.md:102-103`
- Modify: `docs/superpowers/roadmap-tui.md` (Done and Next sections)
- Modify: `AGENTS.md` (architecture table)

- [ ] **Step 1: Update docs**

In `docs/tui.md` replace the "Memory and recall are off in the TUI" bullet with:

```
- Memory and recall run in the TUI on `bun:sqlite` through `src/memory/sqlite-driver.ts`, over the same
  `memory.sqlite` as the VS Code host. Not verified: macOS, where `bun:sqlite` uses the system SQLite and
  may lack FTS5 (the store then stays off and a warning says so).
```

In `docs/superpowers/roadmap-tui.md` add under Done:

```
- **F1. Memory** (`feat/tui-memory`): `bun:sqlite` behind `src/memory/sqlite-driver.ts`; recall, priming and digests in the TUI over the shared `memory.sqlite`. Spec `2026-10-02-tui-memory-design.md`, plan `2026-10-02-tui-memory.md`.
```

and in "Next" change item 2 to `2. **F2. Platform.** In-TUI login by suspending the renderer.`

In the `AGENTS.md` table add, next to the `src/host/transcript-store.ts` row:

```
| `src/memory/sqlite-driver.ts` | `openDatabase`: `bun:sqlite` under Bun, `node:sqlite` otherwise, behind the narrow `SqlDb` the FTS store uses; probes FTS5 at open |
```

- [ ] **Step 2: Full gate**

Run: `cd /e/Efebia/hiiiid-code && git branch --show-current && yarn lint && yarn check-types && yarn check-types:tui && yarn run compile && yarn test:unit && yarn test:tui`
Expected: all PASS (re-run `test:unit` once if only a loopback `EACCES` or `ENOTEMPTY` fails).

- [ ] **Step 3: Build and smoke the compiled binary**

Run: `cd /e/Efebia/hiiiid-code && yarn build:tui:bin`
Expected: prints `bin/marcode.exe`, exit 0.

Then check by hand in a real terminal: run `bin/marcode.exe` in a git repo, create two sessions, hide one (close its pane), and from the other ask it to call `marcode__recall` for a word from the hidden one. Confirm a hit comes back. Then open the same workspace in VS Code and confirm the hidden session's digest appears in the history tab and is recallable. Record the outcome in the PR description.

- [ ] **Step 4: Commit**

```bash
cd /e/Efebia/hiiiid-code && git add docs/tui.md docs/superpowers/roadmap-tui.md AGENTS.md && git commit -m "docs: TUI memory"
```
