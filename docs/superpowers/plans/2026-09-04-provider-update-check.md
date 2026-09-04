# Provider Update Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tell the user, via a one-time VS Code notification per stale provider, when their
Claude/Codex/opencode binary is behind the latest published version.

**Architecture:** A new optional `AgentProvider.checkForUpdate()` method (same shape as
`fetchUsage`/`fetchModels`: no session, fire-and-forget from the caller). Each provider
composes it from a shared, injectable helper module (`src/providers/update-check.ts`) that
does the actual `--version` spawn, remote-version fetch, and semver compare.
`SessionManager.checkForUpdates()` fans the call out to every provider that implements it.
`MessageRouter` calls it from the same `case 'ready'` branch that already kicks off
`refreshModels`/`refreshUsage`, and hands stale results to an injected `UpdateNotifyHost` —
kept out of `message-router.ts` itself because that file may not import `vscode`.
`extension.ts` supplies the real host, wrapping `vscode.window.showInformationMessage`.

**Tech Stack:** TypeScript, Node 22 (`node:child_process`, global `fetch`), mocha
(`suite`/`test`, run via `yarn test:unit`).

**Spec:** [docs/superpowers/specs/2026-09-04-provider-update-check-design.md](../specs/2026-09-04-provider-update-check-design.md)

## Global Constraints

- No auto-update, no manual re-check command, no badge/chip UI, no wire message, no
  persisted "last notified version" — every `ready` re-checks and re-notifies if still
  stale.
- `checkForUpdate` (and everything it calls) must never reject and never throw
  synchronously — `undefined` on any failure, logged via `console.warn`, never surfaced as
  a user-facing error.
- Version sources, exact:
  - Claude: local `claude --version`; remote `https://registry.npmjs.org/@anthropic-ai/claude-code/latest`, field `version`.
  - Codex: local `codex --version`; remote `https://api.github.com/repos/openai/codex/releases/latest`, field `tag_name`, strip prefix `rust-v`.
  - opencode: local `opencode --version`; remote `https://api.github.com/repos/anomalyco/opencode/releases/latest`, field `tag_name`, strip prefix `v`.
- `src/providers/` and `src/host/message-router.ts` must not import `vscode`.
- Filenames kebab-case.
- `yarn lint`, `yarn check-types`, `yarn run compile` must all pass before a commit.

---

## Task 1: Shared update-check helper module

**Files:**
- Create: `src/providers/update-check.ts`
- Test: `src/test/unit/update-check.test.ts`
- Modify: `src/providers/types.ts` (add `UpdateInfo`, `checkForUpdate?` on `AgentProvider`)

**Interfaces:**
- Produces (consumed by Tasks 2-4):
  - `interface UpdateInfo { current: string; latest: string; }`
  - `type ExecVersionFn = (bin: string, args: string[]) => Promise<{ stdout: string }>;`
  - `type FetchFn = typeof fetch;`
  - `extractVersion(text: string): string | undefined`
  - `isNewer(latest: string, current: string): boolean`
  - `localVersion(bin: string, args?: string[], execVersionFn?: ExecVersionFn): Promise<string | undefined>`
  - `npmLatestVersion(pkg: string, fetchFn?: FetchFn): Promise<string | undefined>`
  - `githubLatestVersion(repo: string, tagPrefix: string, fetchFn?: FetchFn): Promise<string | undefined>`
  - `AgentProvider.checkForUpdate?(): Promise<UpdateInfo | undefined>` (Task 5 reads this)

- [ ] **Step 1: Write the failing tests for `extractVersion` and `isNewer`**

```ts
// src/test/unit/update-check.test.ts
import * as assert from 'assert';
import {
  extractVersion, isNewer, localVersion, npmLatestVersion, githubLatestVersion,
} from '../../providers/update-check';

suite('update-check', () => {
  suite('extractVersion', () => {
    test('pulls a bare x.y.z', () => {
      assert.strictEqual(extractVersion('2.1.260'), '2.1.260');
    });
    test('pulls x.y.z out of a prefixed CLI banner', () => {
      assert.strictEqual(extractVersion('claude-code 2.1.260\n'), '2.1.260');
    });
    test('pulls x.y.z out of a tag with a name prefix', () => {
      assert.strictEqual(extractVersion('rust-v0.153.2'), '0.153.2');
    });
    test('returns undefined when no version-shaped substring exists', () => {
      assert.strictEqual(extractVersion('command not found'), undefined);
    });
  });

  suite('isNewer', () => {
    test('true when latest has a higher patch', () => {
      assert.strictEqual(isNewer('1.2.4', '1.2.3'), true);
    });
    test('true when latest has a higher minor', () => {
      assert.strictEqual(isNewer('1.3.0', '1.2.9'), true);
    });
    test('true when latest has a higher major', () => {
      assert.strictEqual(isNewer('2.0.0', '1.9.9'), true);
    });
    test('false when versions are equal', () => {
      assert.strictEqual(isNewer('1.2.3', '1.2.3'), false);
    });
    test('false when latest is older', () => {
      assert.strictEqual(isNewer('1.2.3', '1.3.0'), false);
    });
    test('false, never throws, when either side is malformed', () => {
      assert.strictEqual(isNewer('not-a-version', '1.2.3'), false);
      assert.strictEqual(isNewer('1.2.3', 'not-a-version'), false);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test:unit --grep update-check`
Expected: FAIL — `Cannot find module '../../providers/update-check'`

- [ ] **Step 3: Implement `extractVersion` and `isNewer`**

```ts
// src/providers/update-check.ts
export interface UpdateInfo { current: string; latest: string; }

/**
 * First `x.y.z` substring found, or undefined. Both a CLI's `--version`
 * banner and a GitHub `tag_name` can carry a leading name/prefix — this
 * strips it implicitly by only ever matching the digits-and-dots run.
 */
export function extractVersion(text: string): string | undefined {
  const match = text.match(/(\d+\.\d+\.\d+)/);
  return match?.[1];
}

function parts(v: string): number[] | undefined {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) { return undefined; }
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Dotted-numeric compare. True only when `latest` is strictly newer than
 * `current`. Malformed input on either side returns false — never a false
 * "update available", per the spec's error-as-state requirement.
 */
export function isNewer(latest: string, current: string): boolean {
  const a = parts(latest);
  const b = parts(current);
  if (!a || !b) { return false; }
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) { return true; }
    if (a[i] < b[i]) { return false; }
  }
  return false;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test:unit --grep update-check`
Expected: PASS (the `extractVersion`/`isNewer` suites; `localVersion`/`npmLatestVersion`/`githubLatestVersion` not yet implemented — next steps)

- [ ] **Step 5: Write the failing tests for `localVersion`, `npmLatestVersion`, `githubLatestVersion`**

```ts
// append to src/test/unit/update-check.test.ts, inside suite('update-check', () => { ... })

  suite('localVersion', () => {
    test('resolves the extracted version on success', async () => {
      const exec = async (bin: string, args: string[]) => {
        assert.strictEqual(bin, 'claude');
        assert.deepStrictEqual(args, ['--version']);
        return { stdout: '2.1.260\n' };
      };
      assert.strictEqual(await localVersion('claude', ['--version'], exec), '2.1.260');
    });
    test('resolves undefined when the spawn rejects', async () => {
      const exec = async () => { throw new Error('ENOENT'); };
      assert.strictEqual(await localVersion('claude', ['--version'], exec), undefined);
    });
    test('resolves undefined when stdout has no version-shaped text', async () => {
      const exec = async () => ({ stdout: 'command not found' });
      assert.strictEqual(await localVersion('claude', ['--version'], exec), undefined);
    });
  });

  suite('npmLatestVersion', () => {
    test('resolves the version field on a 2xx response', async () => {
      const fetchFn = (async () => ({
        ok: true, json: async () => ({ version: '2.1.260' }),
      })) as typeof fetch;
      assert.strictEqual(
        await npmLatestVersion('@anthropic-ai/claude-code', fetchFn), '2.1.260',
      );
    });
    test('resolves undefined on a non-2xx response', async () => {
      const fetchFn = (async () => ({ ok: false, json: async () => ({}) })) as typeof fetch;
      assert.strictEqual(
        await npmLatestVersion('@anthropic-ai/claude-code', fetchFn), undefined,
      );
    });
    test('resolves undefined when fetch rejects', async () => {
      const fetchFn = (async () => { throw new Error('network'); }) as typeof fetch;
      assert.strictEqual(
        await npmLatestVersion('@anthropic-ai/claude-code', fetchFn), undefined,
      );
    });
    test('resolves undefined when the version field is missing', async () => {
      const fetchFn = (async () => ({ ok: true, json: async () => ({}) })) as typeof fetch;
      assert.strictEqual(
        await npmLatestVersion('@anthropic-ai/claude-code', fetchFn), undefined,
      );
    });
  });

  suite('githubLatestVersion', () => {
    test('resolves tag_name with the prefix stripped', async () => {
      const fetchFn = (async () => ({
        ok: true, json: async () => ({ tag_name: 'rust-v0.153.2' }),
      })) as typeof fetch;
      assert.strictEqual(
        await githubLatestVersion('openai/codex', 'rust-v', fetchFn), '0.153.2',
      );
    });
    test('resolves tag_name unchanged when the prefix does not match', async () => {
      const fetchFn = (async () => ({
        ok: true, json: async () => ({ tag_name: '0.153.2' }),
      })) as typeof fetch;
      assert.strictEqual(
        await githubLatestVersion('openai/codex', 'rust-v', fetchFn), '0.153.2',
      );
    });
    test('resolves undefined on a non-2xx response', async () => {
      const fetchFn = (async () => ({ ok: false, json: async () => ({}) })) as typeof fetch;
      assert.strictEqual(await githubLatestVersion('openai/codex', 'rust-v', fetchFn), undefined);
    });
    test('resolves undefined when fetch rejects', async () => {
      const fetchFn = (async () => { throw new Error('network'); }) as typeof fetch;
      assert.strictEqual(await githubLatestVersion('openai/codex', 'rust-v', fetchFn), undefined);
    });
  });
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `yarn test:unit --grep update-check`
Expected: FAIL — `localVersion`/`npmLatestVersion`/`githubLatestVersion` not exported

- [ ] **Step 7: Implement `localVersion`, `npmLatestVersion`, `githubLatestVersion`**

```ts
// append to src/providers/update-check.ts
import { execFile } from 'node:child_process';

export type ExecVersionFn = (bin: string, args: string[]) => Promise<{ stdout: string }>;
export type FetchFn = typeof fetch;

/**
 * Real, child-process-backed default — the production implementation,
 * injected away in every test above. `shell: true` for the same reason
 * `spawnOpenCodeAcp` needs it: on Windows these binaries resolve to `.cmd`
 * shims that a direct (non-shell) spawn refuses to launch.
 */
const realExecVersion: ExecVersionFn = (bin, args) => new Promise((resolve, reject) => {
  execFile(bin, args, { shell: true, windowsHide: true }, (err, stdout) => {
    if (err) { reject(err); return; }
    resolve({ stdout });
  });
});

/**
 * Runs `<bin> <args>` (defaults to `--version`) and extracts a version from
 * its stdout. Resolves undefined on any spawn failure or unparseable
 * output — never rejects, so a caller never needs a try/catch around this.
 */
export async function localVersion(
  bin: string, args: string[] = ['--version'], execVersionFn: ExecVersionFn = realExecVersion,
): Promise<string | undefined> {
  try {
    const { stdout } = await execVersionFn(bin, args);
    return extractVersion(stdout);
  } catch {
    return undefined;
  }
}

/** `GET https://registry.npmjs.org/<pkg>/latest`, reads `.version`. Never rejects. */
export async function npmLatestVersion(
  pkg: string, fetchFn: FetchFn = fetch,
): Promise<string | undefined> {
  try {
    const res = await fetchFn(`https://registry.npmjs.org/${pkg}/latest`);
    if (!res.ok) { return undefined; }
    const json = await res.json() as { version?: string };
    return json.version;
  } catch {
    return undefined;
  }
}

/**
 * `GET https://api.github.com/repos/<repo>/releases/latest`, reads
 * `.tag_name`, strips `tagPrefix` if present. Never rejects.
 */
export async function githubLatestVersion(
  repo: string, tagPrefix: string, fetchFn: FetchFn = fetch,
): Promise<string | undefined> {
  try {
    const res = await fetchFn(`https://api.github.com/repos/${repo}/releases/latest`);
    if (!res.ok) { return undefined; }
    const json = await res.json() as { tag_name?: string };
    if (!json.tag_name) { return undefined; }
    return json.tag_name.startsWith(tagPrefix) ? json.tag_name.slice(tagPrefix.length) : json.tag_name;
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `yarn test:unit --grep update-check`
Expected: PASS, all suites

- [ ] **Step 9: Add `UpdateInfo`/`checkForUpdate` to the `AgentProvider` interface**

In `src/providers/types.ts`, near `fetchUsage`:

```ts
// import at top:
import type { UpdateInfo } from './update-check';
export type { UpdateInfo } from './update-check';

// on AgentProvider, after fetchUsage:
  /**
   * Compares the locally installed binary against its latest published
   * version. Optional: a provider with no standalone binary (`fake`) omits
   * it. `undefined` means "could not determine" — a parse failure or a
   * network miss is not evidence of staleness and must never be reported as
   * one. Rejections propagate; the caller treats a throw the same as
   * `undefined`.
   */
  checkForUpdate?(): Promise<UpdateInfo | undefined>;
```

- [ ] **Step 10: Typecheck**

Run: `yarn check-types`
Expected: PASS

- [ ] **Step 11: Commit**

```bash
git add src/providers/update-check.ts src/test/unit/update-check.test.ts src/providers/types.ts
git commit -m "feat: add shared update-check helper module"
```

---

## Task 2: Wire `ClaudeProvider.checkForUpdate`

**Files:**
- Modify: `src/providers/claude/claude-provider.ts`
- Test: `src/test/unit/claude-provider.test.ts`

**Interfaces:**
- Consumes: `localVersion`, `npmLatestVersion`, `ExecVersionFn`, `FetchFn` from
  `src/providers/update-check.ts` (Task 1).
- Produces: `ClaudeProvider` now implements `checkForUpdate()`; constructor's `instance`
  opts object gains `execVersion?: ExecVersionFn` and `fetchLatest?: FetchFn`.

- [ ] **Step 1: Write the failing tests**

```ts
// append to src/test/unit/claude-provider.test.ts
suite('checkForUpdate', () => {
  test('resolves current/latest on success', async () => {
    const provider = new ClaudeProvider(undefined, undefined, {
      execVersion: async () => ({ stdout: '2.1.259\n' }),
      fetchLatest: (async () => ({
        ok: true, json: async () => ({ version: '2.1.260' }),
      })) as typeof fetch,
    });
    assert.deepStrictEqual(await provider.checkForUpdate(), { current: '2.1.259', latest: '2.1.260' });
  });

  test('resolves undefined when the local version cannot be determined', async () => {
    const provider = new ClaudeProvider(undefined, undefined, {
      execVersion: async () => { throw new Error('ENOENT'); },
      fetchLatest: (async () => ({
        ok: true, json: async () => ({ version: '2.1.260' }),
      })) as typeof fetch,
    });
    assert.strictEqual(await provider.checkForUpdate(), undefined);
  });

  test('resolves undefined when the remote fetch fails', async () => {
    const provider = new ClaudeProvider(undefined, undefined, {
      execVersion: async () => ({ stdout: '2.1.259\n' }),
      fetchLatest: (async () => { throw new Error('network'); }) as typeof fetch,
    });
    assert.strictEqual(await provider.checkForUpdate(), undefined);
  });

  test('runs the configured executable path, not the bare binary name', async () => {
    let seenBin: string | undefined;
    const provider = new ClaudeProvider(undefined, undefined, {
      pathToClaudeCodeExecutable: '/opt/claude/claude',
      execVersion: async (bin) => { seenBin = bin; return { stdout: '2.1.259\n' }; },
      fetchLatest: (async () => ({
        ok: true, json: async () => ({ version: '2.1.260' }),
      })) as typeof fetch,
    });
    await provider.checkForUpdate();
    assert.strictEqual(seenBin, '/opt/claude/claude');
  });
});
```

(Check the top of `claude-provider.test.ts` already imports `assert` and `ClaudeProvider`;
add nothing further if so.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test:unit --grep "ClaudeProvider"`
Expected: FAIL — `provider.checkForUpdate is not a function`

- [ ] **Step 3: Implement**

In `src/providers/claude/claude-provider.ts`:

```ts
// import at top, alongside existing relative imports:
import {
  localVersion, npmLatestVersion, type ExecVersionFn, type FetchFn, type UpdateInfo,
} from '../update-check';

// constructor's `instance` param object gains two fields:
    instance?: {
      id?: string;
      displayName?: string;
      env?: NodeJS.ProcessEnv;
      pathToClaudeCodeExecutable?: string;
      loginKind?: 'oauth' | 'none';
      execVersion?: ExecVersionFn;
      fetchLatest?: FetchFn;
    },

// two new private fields, set in the constructor body next to the existing ones:
  private readonly execVersion?: ExecVersionFn;
  private readonly fetchLatest?: FetchFn;
  // ...
    this.execVersion = instance?.execVersion;
    this.fetchLatest = instance?.fetchLatest;

// new method, near listModels():
  async checkForUpdate(): Promise<UpdateInfo | undefined> {
    const bin = this.pathToClaudeCodeExecutable ?? 'claude';
    const [current, latest] = await Promise.all([
      localVersion(bin, ['--version'], this.execVersion),
      npmLatestVersion('@anthropic-ai/claude-code', this.fetchLatest),
    ]);
    if (!current || !latest) { return undefined; }
    return { current, latest };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test:unit --grep "ClaudeProvider"`
Expected: PASS

- [ ] **Step 5: Typecheck**

Run: `yarn check-types`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/providers/claude/claude-provider.ts src/test/unit/claude-provider.test.ts
git commit -m "feat: wire ClaudeProvider.checkForUpdate"
```

---

## Task 3: Wire `CodexProvider.checkForUpdate`

**Files:**
- Modify: `src/providers/codex/codex-provider.ts`
- Test: `src/test/unit/codex-provider.test.ts`

**Interfaces:**
- Consumes: `localVersion`, `githubLatestVersion`, `ExecVersionFn`, `FetchFn` (Task 1).
- Produces: `CodexProvider.checkForUpdate()`; constructor `opts` gains `execVersion?:
  ExecVersionFn` and `fetchLatest?: FetchFn`.

- [ ] **Step 1: Write the failing tests**

```ts
// append to src/test/unit/codex-provider.test.ts
suite('checkForUpdate', () => {
  test('resolves current/latest, stripping the rust-v tag prefix', async () => {
    const provider = new CodexProvider({
      execVersion: async () => ({ stdout: 'codex-cli 0.153.1\n' }),
      fetchLatest: (async () => ({
        ok: true, json: async () => ({ tag_name: 'rust-v0.153.2' }),
      })) as typeof fetch,
    });
    assert.deepStrictEqual(await provider.checkForUpdate(), { current: '0.153.1', latest: '0.153.2' });
  });

  test('resolves undefined when the local version cannot be determined', async () => {
    const provider = new CodexProvider({
      execVersion: async () => { throw new Error('ENOENT'); },
      fetchLatest: (async () => ({
        ok: true, json: async () => ({ tag_name: 'rust-v0.153.2' }),
      })) as typeof fetch,
    });
    assert.strictEqual(await provider.checkForUpdate(), undefined);
  });

  test('resolves undefined when the remote fetch fails', async () => {
    const provider = new CodexProvider({
      execVersion: async () => ({ stdout: 'codex-cli 0.153.1\n' }),
      fetchLatest: (async () => ({ ok: false, json: async () => ({}) })) as typeof fetch,
    });
    assert.strictEqual(await provider.checkForUpdate(), undefined);
  });

  test('runs the configured binPath, not the bare binary name', async () => {
    let seenBin: string | undefined;
    const provider = new CodexProvider({
      binPath: '/opt/codex/codex',
      execVersion: async (bin) => { seenBin = bin; return { stdout: '0.153.1\n' }; },
      fetchLatest: (async () => ({
        ok: true, json: async () => ({ tag_name: 'rust-v0.153.2' }),
      })) as typeof fetch,
    });
    await provider.checkForUpdate();
    assert.strictEqual(seenBin, '/opt/codex/codex');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test:unit --grep "CodexProvider"`
Expected: FAIL — `provider.checkForUpdate is not a function`

- [ ] **Step 3: Implement**

In `src/providers/codex/codex-provider.ts`:

```ts
// import at top:
import {
  localVersion, githubLatestVersion, type ExecVersionFn, type FetchFn, type UpdateInfo,
} from '../update-check';

// constructor's opts object gains two fields:
  constructor(private readonly opts: {
    id?: string;
    displayName?: string;
    binPath?: string;
    spawn?: (bin: string, env?: NodeJS.ProcessEnv) => Duplex;
    teardownGraceMs?: number;
    selfControlMcp?: SelfControlMcpConfig;
    env?: NodeJS.ProcessEnv;
    loginKind?: 'oauth' | 'none';
    execVersion?: ExecVersionFn;
    fetchLatest?: FetchFn;
  } = {}) {
    // ...existing assignments unchanged; this.opts already retains execVersion/fetchLatest

// new method, near listModels():
  async checkForUpdate(): Promise<UpdateInfo | undefined> {
    const bin = this.binPath ?? 'codex';
    const [current, latest] = await Promise.all([
      localVersion(bin, ['--version'], this.opts.execVersion),
      githubLatestVersion('openai/codex', 'rust-v', this.opts.fetchLatest),
    ]);
    if (!current || !latest) { return undefined; }
    return { current, latest };
  }
```

(`this.opts` is already stored as a constructor-parameter property — `private readonly
opts` — so no new field is needed for `execVersion`/`fetchLatest`; they are read straight
off it, same as `teardownGraceMs` reads `opts.teardownGraceMs` today.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test:unit --grep "CodexProvider"`
Expected: PASS

- [ ] **Step 5: Typecheck**

Run: `yarn check-types`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/providers/codex/codex-provider.ts src/test/unit/codex-provider.test.ts
git commit -m "feat: wire CodexProvider.checkForUpdate"
```

---

## Task 4: Wire `OpenCodeProvider.checkForUpdate`

**Files:**
- Modify: `src/providers/opencode/opencode-provider.ts`
- Test: `src/test/unit/opencode-provider.test.ts`

**Interfaces:**
- Consumes: `localVersion`, `githubLatestVersion`, `ExecVersionFn`, `FetchFn` (Task 1).
- Produces: `OpenCodeProvider.checkForUpdate()`; constructor `opts` gains `execVersion?:
  ExecVersionFn` and `fetchLatest?: FetchFn`.

- [ ] **Step 1: Write the failing tests**

```ts
// append to src/test/unit/opencode-provider.test.ts
suite('checkForUpdate', () => {
  test('resolves current/latest, stripping the v tag prefix', async () => {
    const provider = new OpenCodeProvider({
      execVersion: async () => ({ stdout: '1.18.26\n' }),
      fetchLatest: (async () => ({
        ok: true, json: async () => ({ tag_name: 'v1.18.27' }),
      })) as typeof fetch,
    });
    assert.deepStrictEqual(await provider.checkForUpdate(), { current: '1.18.26', latest: '1.18.27' });
  });

  test('resolves undefined when the local version cannot be determined', async () => {
    const provider = new OpenCodeProvider({
      execVersion: async () => { throw new Error('ENOENT'); },
      fetchLatest: (async () => ({
        ok: true, json: async () => ({ tag_name: 'v1.18.27' }),
      })) as typeof fetch,
    });
    assert.strictEqual(await provider.checkForUpdate(), undefined);
  });

  test('runs the configured binPath, not the bare binary name', async () => {
    let seenBin: string | undefined;
    const provider = new OpenCodeProvider({
      binPath: '/opt/opencode/opencode',
      execVersion: async (bin) => { seenBin = bin; return { stdout: '1.18.26\n' }; },
      fetchLatest: (async () => ({
        ok: true, json: async () => ({ tag_name: 'v1.18.27' }),
      })) as typeof fetch,
    });
    await provider.checkForUpdate();
    assert.strictEqual(seenBin, '/opt/opencode/opencode');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test:unit --grep "OpenCodeProvider"`
Expected: FAIL — `provider.checkForUpdate is not a function`

- [ ] **Step 3: Implement**

In `src/providers/opencode/opencode-provider.ts`:

```ts
// import at top:
import {
  localVersion, githubLatestVersion, type ExecVersionFn, type FetchFn, type UpdateInfo,
} from '../update-check';

// constructor opts object gains two fields:
  constructor(opts: {
    id?: string;
    displayName?: string;
    binPath?: string;
    spawn?: (bin: string, env?: NodeJS.ProcessEnv) => AcpChild;
    selfControlMcp?: SelfControlMcpConfig;
    env?: NodeJS.ProcessEnv;
    loginKind?: 'oauth' | 'none';
    execVersion?: ExecVersionFn;
    fetchLatest?: FetchFn;
  } = {}) {
    // ...existing assignments, plus:
    this.execVersion = opts.execVersion;
    this.fetchLatest = opts.fetchLatest;
  }

// two new private fields, alongside the existing binPath/spawn/env fields:
  private readonly execVersion?: ExecVersionFn;
  private readonly fetchLatest?: FetchFn;

// new method, near listModels():
  async checkForUpdate(): Promise<UpdateInfo | undefined> {
    const bin = this.binPath ?? 'opencode';
    const [current, latest] = await Promise.all([
      localVersion(bin, ['--version'], this.execVersion),
      githubLatestVersion('anomalyco/opencode', 'v', this.fetchLatest),
    ]);
    if (!current || !latest) { return undefined; }
    return { current, latest };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test:unit --grep "OpenCodeProvider"`
Expected: PASS

- [ ] **Step 5: Typecheck**

Run: `yarn check-types`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/providers/opencode/opencode-provider.ts src/test/unit/opencode-provider.test.ts
git commit -m "feat: wire OpenCodeProvider.checkForUpdate"
```

---

## Task 5: `SessionManager.checkForUpdates()`

**Files:**
- Modify: `src/host/session-manager.ts`
- Test: `src/test/unit/session-manager.test.ts`

**Interfaces:**
- Consumes: `AgentProvider.checkForUpdate?` (Task 1), `UpdateInfo` type.
- Produces: `SessionManager.checkForUpdates(): Promise<{ id: string; displayName: string; info: UpdateInfo }[]>`
  — consumed by Task 6.

- [ ] **Step 1: Write the failing tests**

```ts
// append to src/test/unit/session-manager.test.ts
suite('checkForUpdates', () => {
  test('returns only providers whose checkForUpdate resolved a result', async () => {
    const stale: AgentProvider = {
      id: 'stale', displayName: 'Stale', threadScope: 'cwd',
      listModels: () => [], listPermissionModes: () => [{ id: 'default' }],
      start: () => { throw new Error('not used'); },
      checkForUpdate: async () => ({ current: '1.0.0', latest: '1.1.0' }),
    };
    const upToDate: AgentProvider = {
      id: 'current', displayName: 'Current', threadScope: 'cwd',
      listModels: () => [], listPermissionModes: () => [{ id: 'default' }],
      start: () => { throw new Error('not used'); },
      checkForUpdate: async () => undefined,
    };
    const noCheck: AgentProvider = {
      id: 'fake', displayName: 'Fake', threadScope: 'cwd',
      listModels: () => [], listPermissionModes: () => [{ id: 'default' }],
      start: () => { throw new Error('not used'); },
    };
    const providers = new Map<string, AgentProvider>([
      ['stale', stale], ['current', upToDate], ['fake', noCheck],
    ]);
    const m = new SessionManager(new TranscriptStore(dir), providers, () => {});
    await m.init();
    const result = await m.checkForUpdates();
    assert.deepStrictEqual(result, [
      { id: 'stale', displayName: 'Stale', info: { current: '1.0.0', latest: '1.1.0' } },
    ]);
    await m.dispose();
  });

  test('a rejecting provider does not stop the others', async () => {
    const failing: AgentProvider = {
      id: 'failing', displayName: 'Failing', threadScope: 'cwd',
      listModels: () => [], listPermissionModes: () => [{ id: 'default' }],
      start: () => { throw new Error('not used'); },
      checkForUpdate: async () => { throw new Error('boom'); },
    };
    const stale: AgentProvider = {
      id: 'stale', displayName: 'Stale', threadScope: 'cwd',
      listModels: () => [], listPermissionModes: () => [{ id: 'default' }],
      start: () => { throw new Error('not used'); },
      checkForUpdate: async () => ({ current: '1.0.0', latest: '1.1.0' }),
    };
    const providers = new Map<string, AgentProvider>([['failing', failing], ['stale', stale]]);
    const m = new SessionManager(new TranscriptStore(dir), providers, () => {});
    await m.init();
    const result = await m.checkForUpdates();
    assert.deepStrictEqual(result, [
      { id: 'stale', displayName: 'Stale', info: { current: '1.0.0', latest: '1.1.0' } },
    ]);
    await m.dispose();
  });

  test('resolves an empty array when no provider implements checkForUpdate', async () => {
    const providers = new Map<string, AgentProvider>([['fake', provider]]);
    const m = new SessionManager(new TranscriptStore(dir), providers, () => {});
    await m.init();
    assert.deepStrictEqual(await m.checkForUpdates(), []);
    await m.dispose();
  });
});
```

Check the existing `session-manager.test.ts` setup block for a `dir`/`provider` fixture
already in scope for the `suite`; reuse it rather than redeclaring, matching the file's
existing pattern for other `suite(...)` blocks. Import `AgentProvider` and
`TranscriptStore` if not already imported at the top of the file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test:unit --grep "checkForUpdates"`
Expected: FAIL — `m.checkForUpdates is not a function`

- [ ] **Step 3: Implement**

In `src/host/session-manager.ts`, near `refreshUsage`:

```ts
/**
 * Asks every provider that can answer for a stale-binary check, with no
 * session required. Fire-and-forget by design at the call site (this method
 * itself is awaited by its one caller, `MessageRouter`'s `ready` handling,
 * but nothing upstream of that waits on it) — same reasoning as
 * `refreshModels`/`refreshUsage`: a CLI `--version` spawn and a network
 * fetch must never hold up panel startup.
 *
 * Returns only the providers that came back stale — an up-to-date provider
 * and a provider with no answer are indistinguishable to the caller, and
 * both are "nothing to tell the user."
 */
async checkForUpdates(): Promise<{ id: string; displayName: string; info: UpdateInfo }[]> {
  const results = await Promise.all([...this.providers.values()]
    .filter((p) => p.checkForUpdate)
    // Wrapped in Promise.resolve().then(...) for the same reason
    // refreshModels wraps its own probe call: the interface only promises a
    // Promise return, not an async function, so a provider that throws
    // synchronously (legal against the type) must not throw out of
    // checkForUpdates' own body.
    .map((p) => Promise.resolve().then(() => p.checkForUpdate!()).then(
      (info) => (info ? { id: p.id, displayName: p.displayName, info } : undefined),
      (err: unknown) => {
        console.warn('[mar-code] session-manager: update check failed for', p.id, err);
        return undefined;
      },
    )));
  return results.filter(
    (r): r is { id: string; displayName: string; info: UpdateInfo } => r !== undefined,
  );
}
```

Add `UpdateInfo` to the existing `import type { ... } from '../providers/types'` line at
the top of the file.

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test:unit --grep "checkForUpdates"`
Expected: PASS

- [ ] **Step 5: Typecheck**

Run: `yarn check-types`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/host/session-manager.ts src/test/unit/session-manager.test.ts
git commit -m "feat: add SessionManager.checkForUpdates"
```

---

## Task 6: `MessageRouter` wiring — `UpdateNotifyHost` and the `ready` call

**Files:**
- Modify: `src/host/message-router.ts`
- Test: `src/test/unit/message-router.test.ts`

**Interfaces:**
- Consumes: `SessionManager.checkForUpdates()` (Task 5), `isNewer` (Task 1).
- Produces: `export interface UpdateNotifyHost { notify(displayName: string, current: string, latest: string): void; }`
  and `export const NO_UPDATE_NOTIFY: UpdateNotifyHost` — consumed by Task 7.

- [ ] **Step 1: Write the failing test**

```ts
// append to src/test/unit/message-router.test.ts
test('ready notifies about a stale provider through the update-notify host', async () => {
  const staleProvider = new FakeProvider(() => []) as unknown as AgentProvider & {
    checkForUpdate(): Promise<{ current: string; latest: string } | undefined>;
  };
  (staleProvider as { id: string }).id = 'fake';
  (staleProvider as { displayName: string }).displayName = 'Fake';
  staleProvider.checkForUpdate = async () => ({ current: '1.0.0', latest: '1.1.0' });

  const providers = new Map<string, AgentProvider>([['fake', staleProvider]]);
  const m = new SessionManager(new TranscriptStore(dir), providers, (msg) => sent.push(msg));
  await m.init();

  const notified: { displayName: string; current: string; latest: string }[] = [];
  const r = new MessageRouter(
    m, (msg) => sent.push(msg), '/tmp', undefined, attachments, undefined, 750, undefined, [],
    undefined, { notify: (displayName, current, latest) => notified.push({ displayName, current, latest }) },
  );

  await r.handle({ t: 'ready' });
  await settle();

  assert.deepStrictEqual(notified, [{ displayName: 'Fake', current: '1.0.0', latest: '1.1.0' }]);
  await m.dispose();
});

test('ready does not notify when checkForUpdate reports no newer version', async () => {
  const currentProvider = new FakeProvider(() => []) as unknown as AgentProvider & {
    checkForUpdate(): Promise<{ current: string; latest: string } | undefined>;
  };
  (currentProvider as { id: string }).id = 'fake';
  (currentProvider as { displayName: string }).displayName = 'Fake';
  currentProvider.checkForUpdate = async () => ({ current: '1.1.0', latest: '1.1.0' });

  const providers = new Map<string, AgentProvider>([['fake', currentProvider]]);
  const m = new SessionManager(new TranscriptStore(dir), providers, (msg) => sent.push(msg));
  await m.init();

  const notified: unknown[] = [];
  const r = new MessageRouter(
    m, (msg) => sent.push(msg), '/tmp', undefined, attachments, undefined, 750, undefined, [],
    undefined, { notify: (...args) => notified.push(args) },
  );

  await r.handle({ t: 'ready' });
  await settle();

  assert.deepStrictEqual(notified, []);
  await m.dispose();
});
```

This exercises the real `MessageRouter` constructor's positional-arg tail, matching the
file's existing test style (see `'set-favorite-models persists...'` above it for the same
positional-args-with-`undefined`-gaps pattern). Confirm the exact index `updateNotify` lands
at once Step 3 below fixes the constructor's parameter list, and adjust the `undefined,`
count in these two tests to match if it differs from what is drafted here.

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test:unit --grep "ready notifies"`
Expected: FAIL — too many/too few constructor arguments, or `notify` never called

- [ ] **Step 3: Implement**

In `src/host/message-router.ts`:

```ts
// alongside the existing EditorContextHost/ConfigHost interfaces and their NO_* defaults:
export interface UpdateNotifyHost {
  notify(displayName: string, current: string, latest: string): void;
}
export const NO_UPDATE_NOTIFY: UpdateNotifyHost = { notify: () => {} };

// import isNewer alongside other relative imports:
import { isNewer } from '../providers/update-check';

// constructor gains one more trailing param:
  constructor(
    private readonly manager: SessionManager,
    private readonly emit: (msg: HostToWebview) => void,
    private readonly defaultCwd: string,
    private readonly editor: EditorContextHost = NO_EDITOR,
    private readonly attachments?: AttachmentStore,
    private readonly picker: AttachmentHost = NO_PICKER,
    private readonly reviewPollIntervalMs: number = 750,
    private readonly fileSearch?: FileSearch,
    private favoriteModels: string[] = [],
    private readonly configHost: ConfigHost = NO_CONFIG,
    private readonly updateNotify: UpdateNotifyHost = NO_UPDATE_NOTIFY,
  ) {}

// inside case 'ready', immediately after the existing two refresh calls:
        void this.manager.refreshModels(this.defaultCwd);
        void this.manager.refreshUsage(this.defaultCwd);
        void this.manager.checkForUpdates().then((stale) => {
          for (const { displayName, info } of stale) {
            if (isNewer(info.latest, info.current)) {
              this.updateNotify.notify(displayName, info.current, info.latest);
            }
          }
        });
        return;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test:unit --grep "ready notifies\|ready does not notify"`
Expected: PASS

- [ ] **Step 5: Run the full message-router suite to confirm no positional-arg regressions**

Run: `yarn test:unit --grep "MessageRouter"`
Expected: PASS — every existing test still constructs `MessageRouter` correctly since
`updateNotify` is a new trailing optional param, appended after `configHost`

- [ ] **Step 6: Typecheck**

Run: `yarn check-types`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/host/message-router.ts src/test/unit/message-router.test.ts
git commit -m "feat: notify on stale provider binaries from MessageRouter's ready handling"
```

---

## Task 7: `extension.ts` wiring — the real `UpdateNotifyHost`

**Files:**
- Modify: `src/extension.ts`

**Interfaces:**
- Consumes: `UpdateNotifyHost` (Task 6), the existing `new MessageRouter(...)` call site.

No new automated test — `extension.ts`'s `activate()` is exercised only by the
`@vscode/test-cli` integration suite (`yarn test`), and this change is a one-line object
literal plus threading it into an existing constructor call, the same shape as every other
host adapter already wired there without its own unit test (`EditorContextHost`,
`ConfigHost`).

- [ ] **Step 1: Find the `new MessageRouter(...)` construction site**

Run: `grep -n "new MessageRouter(" src/extension.ts`

- [ ] **Step 2: Add the real `UpdateNotifyHost` and pass it in**

Near the `new MessageRouter(...)` call, add:

```ts
const updateNotify: UpdateNotifyHost = {
  notify: (displayName, current, latest) => {
    void vscode.window.showInformationMessage(`${displayName} ${current} → ${latest} available.`);
  },
};
```

Import `UpdateNotifyHost` at the top of the file:

```ts
import { MessageRouter, type UpdateNotifyHost } from './host/message-router';
```

(Adjust if `MessageRouter` is already imported without `type` grouping — merge into the
existing import statement rather than adding a second one.)

Then pass `updateNotify` as the trailing argument to the existing `new MessageRouter(...)`
call, matching whatever positional arguments that call already supplies (fill any gap
before it with the same default the constructor already uses, e.g. `undefined` for
`fileSearch` if the call site doesn't pass one — read the current call site's argument list
before editing so the count lines up with Task 6's constructor).

- [ ] **Step 3: Compile**

Run: `yarn run compile`
Expected: PASS

- [ ] **Step 4: Manual smoke check**

Launch the extension host (F5 in VS Code, or `yarn run compile` + Extension Development
Host), open the Marcode panel, confirm no notification appears when all configured binaries
are current, and confirm the panel still loads normally (no thrown error from the new
`checkForUpdates` fire-and-forget chain breaking `ready` handling).

- [ ] **Step 5: Commit**

```bash
git add src/extension.ts
git commit -m "feat: surface stale provider binaries as a VS Code notification"
```

---

## Task 8: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full unit suite**

Run: `yarn test:unit`
Expected: PASS, no regressions

- [ ] **Step 2: Run lint**

Run: `yarn lint`
Expected: PASS

- [ ] **Step 3: Run typecheck**

Run: `yarn check-types`
Expected: PASS

- [ ] **Step 4: Run compile**

Run: `yarn run compile`
Expected: PASS

- [ ] **Step 5: Confirm no leftover TODOs or debug logging**

Run: `git diff master --stat` (or the equivalent against the branch's base) and read
through the diff once for stray `console.log`, commented-out code, or placeholder text.

No commit — this task is a gate, not a change.
