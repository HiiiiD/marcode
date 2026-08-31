# Provider Instances Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user register extra named instances of an existing provider kind (Claude, Codex, OpenCode) via `marcode.providerInstances`, each with its own env-sourced auth/config, so e.g. a personal and a work Claude account — or an OpenCode instance pointed at a different model provider — can run side by side.

**Architecture:** A pure, `vscode`-free validator (`src/shared/provider-instances.ts`) parses the new setting and resolves each instance's `envMap` against `process.env`. `extension.ts` builds one extra `ClaudeProvider`/`CodexProvider`/`OpenCodeProvider` per valid entry — each provider class grows an optional 3rd/extra constructor argument for `id`/`displayName`/env override — and registers it in `SessionManager`'s existing `providers: Map<string, AgentProvider>` (already keyed by an arbitrary string id, no change needed there). Auth-failure UX gets a new `loginKind: 'oauth' | 'none'` field, computed once per instance, threaded through `catalog()`/`unavailable()` to the webview so the Login button only appears where a terminal login flow actually exists.

**Tech Stack:** TypeScript, VS Code extension API, mocha (unit + jsdom DOM tests), existing `AgentProvider`/`ProviderInfo`/`UnavailableProvider` types.

**Spec:** [docs/superpowers/specs/2026-08-31-provider-instances-design.md](../specs/2026-08-31-provider-instances-design.md)

## Global Constraints

- `src/protocol/messages.ts` stays types-only — no runtime code, no `vscode` import.
- Nothing under `src/providers/`, `src/protocol/`, `src/shared/`, or `src/host/message-router.ts` imports `vscode`.
- Every new/changed file follows kebab-case naming.
- Secrets never live in `settings.json` — `envMap` is name→name indirection into `process.env` only (see spec's Data model section).
- `yarn lint`, `yarn check-types`, and `yarn run compile` must all pass before a commit; run `yarn test:unit` (guarded) after each task that adds/changes a unit test, `yarn test:dom` (guarded) after each task that adds/changes a DOM test.
- Conventional-commit prefixes (`feat:`, `test:`, `chore:`, `docs:`); commit after every task.

---

### Task 1: Shared setting id for `marcode.providerInstances`

**Files:**
- Modify: `src/shared/settings.ts`
- Test: `src/test/unit/settings.test.ts` (create if it doesn't exist — check first with Glob)

**Interfaces:**
- Produces: `PROVIDER_INSTANCES_SETTING: string` (the literal `'marcode.providerInstances'`), exported from `src/shared/settings.ts`.

- [ ] **Step 1: Write the failing test**

Check whether `src/test/unit/settings.test.ts` already exists. If not, create it:

```ts
import assert from 'node:assert/strict';
import { test, suite } from 'mocha';
import { PROVIDER_INSTANCES_SETTING } from '../../shared/settings';

suite('shared/settings', () => {
  test('PROVIDER_INSTANCES_SETTING names the providerInstances setting', () => {
    assert.strictEqual(PROVIDER_INSTANCES_SETTING, 'marcode.providerInstances');
  });
});
```

If the file already exists, add this `test()` inside its existing `suite()` instead of creating a new one.

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:unit --grep "PROVIDER_INSTANCES_SETTING"`
Expected: FAIL — `PROVIDER_INSTANCES_SETTING` is not exported.

- [ ] **Step 3: Write minimal implementation**

Modify `src/shared/settings.ts` — add after `ENABLED_PROVIDERS_SETTING`:

```ts
/**
 * Extra named instances of an existing provider kind (claude/codex/opencode),
 * additive to `ENABLED_PROVIDERS_SETTING`. See `provider-instances.ts` for
 * the shape each array entry takes and its validation.
 */
export const PROVIDER_INSTANCES_SETTING = 'marcode.providerInstances';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test:unit --grep "PROVIDER_INSTANCES_SETTING"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/settings.ts src/test/unit/settings.test.ts
git commit -m "feat: add marcode.providerInstances setting id"
```

---

### Task 2: `src/shared/provider-instances.ts` — validation, env resolution, login recipes

**Files:**
- Create: `src/shared/provider-instances.ts`
- Test: `src/test/unit/provider-instances.test.ts`

**Interfaces:**
- Consumes: `PROVIDER_INSTANCES_SETTING` (Task 1, not used inside this file — the setting id is read by `extension.ts`, this file only validates the already-fetched value).
- Produces (all exported from `src/shared/provider-instances.ts`, consumed by Task 11 / `extension.ts` and Tasks 4-6's providers):
  - `type ProviderInstanceKind = 'claude' | 'codex' | 'opencode'`
  - `const PROVIDER_INSTANCE_KINDS: readonly ProviderInstanceKind[]`
  - `interface ProviderInstanceConfig { id: string; kind: ProviderInstanceKind; displayName: string; binPath?: string; envMap?: Record<string, string>; }`
  - `interface ProviderInstanceValidation { valid: ProviderInstanceConfig[]; warnings: string[]; }`
  - `function validateProviderInstances(configured: unknown, baseIds: readonly string[]): ProviderInstanceValidation`
  - `function resolveEnvMap(envMap: Record<string, string> | undefined, osEnv: NodeJS.ProcessEnv): Record<string, string>`
  - `type LoginKind = 'oauth' | 'none'`
  - `function computeLoginKind(kind: ProviderInstanceKind, resolvedEnv: Record<string, string>): LoginKind`
  - `function claudeLoginCommand(binPath: string | undefined): string`
  - `function codexLoginCommand(binPath: string | undefined, resolvedEnv: Record<string, string>): string`

- [ ] **Step 1: Write the failing tests**

Create `src/test/unit/provider-instances.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test, suite } from 'mocha';
import {
  validateProviderInstances, resolveEnvMap, computeLoginKind,
  claudeLoginCommand, codexLoginCommand,
} from '../../shared/provider-instances';

suite('shared/provider-instances', () => {
  suite('validateProviderInstances', () => {
    test('accepts a well-formed entry', () => {
      const result = validateProviderInstances(
        [{ id: 'claude-work', kind: 'claude', displayName: 'Claude (work)' }],
        ['claude', 'codex', 'opencode', 'fake'],
      );
      assert.deepStrictEqual(result.valid, [
        { id: 'claude-work', kind: 'claude', displayName: 'Claude (work)' },
      ]);
      assert.deepStrictEqual(result.warnings, []);
    });

    test('passes through binPath and envMap when present', () => {
      const result = validateProviderInstances(
        [{
          id: 'claude-work', kind: 'claude', displayName: 'Claude (work)',
          binPath: '/usr/local/bin/claude',
          envMap: { ANTHROPIC_API_KEY: 'WORK_KEY' },
        }],
        ['claude'],
      );
      assert.deepStrictEqual(result.valid, [{
        id: 'claude-work', kind: 'claude', displayName: 'Claude (work)',
        binPath: '/usr/local/bin/claude', envMap: { ANTHROPIC_API_KEY: 'WORK_KEY' },
      }]);
    });

    test('ignores a non-array value with a warning', () => {
      const result = validateProviderInstances('not-an-array', ['claude']);
      assert.deepStrictEqual(result.valid, []);
      assert.strictEqual(result.warnings.length, 1);
    });

    test('a missing value produces no warning', () => {
      const result = validateProviderInstances(undefined, ['claude']);
      assert.deepStrictEqual(result.valid, []);
      assert.deepStrictEqual(result.warnings, []);
    });

    test('drops an entry with an unknown kind, with a warning', () => {
      const result = validateProviderInstances(
        [{ id: 'x', kind: 'grok', displayName: 'X' }],
        ['claude'],
      );
      assert.deepStrictEqual(result.valid, []);
      assert.strictEqual(result.warnings.length, 1);
    });

    test('drops an entry whose id collides with a base kind id', () => {
      const result = validateProviderInstances(
        [{ id: 'claude', kind: 'claude', displayName: 'Duplicate' }],
        ['claude', 'codex', 'opencode', 'fake'],
      );
      assert.deepStrictEqual(result.valid, []);
      assert.strictEqual(result.warnings.length, 1);
    });

    test('drops the second of two entries sharing an id', () => {
      const result = validateProviderInstances(
        [
          { id: 'dup', kind: 'claude', displayName: 'First' },
          { id: 'dup', kind: 'codex', displayName: 'Second' },
        ],
        ['claude', 'codex'],
      );
      assert.strictEqual(result.valid.length, 1);
      assert.strictEqual(result.valid[0].displayName, 'First');
      assert.strictEqual(result.warnings.length, 1);
    });

    test('drops an entry with no id or no displayName', () => {
      const result = validateProviderInstances(
        [{ kind: 'claude', displayName: 'No id' }, { id: 'no-name', kind: 'claude' }],
        [],
      );
      assert.deepStrictEqual(result.valid, []);
      assert.strictEqual(result.warnings.length, 2);
    });
  });

  suite('resolveEnvMap', () => {
    test('reads each subprocess var from the named OS var', () => {
      const resolved = resolveEnvMap(
        { ANTHROPIC_API_KEY: 'WORK_KEY', ANTHROPIC_BASE_URL: 'WORK_URL' },
        { WORK_KEY: 'sk-123', WORK_URL: 'https://proxy.example' },
      );
      assert.deepStrictEqual(resolved, {
        ANTHROPIC_API_KEY: 'sk-123', ANTHROPIC_BASE_URL: 'https://proxy.example',
      });
    });

    test('omits a subprocess var whose OS var is unset', () => {
      const resolved = resolveEnvMap({ ANTHROPIC_API_KEY: 'MISSING' }, {});
      assert.deepStrictEqual(resolved, {});
    });

    test('an undefined envMap resolves to an empty object', () => {
      assert.deepStrictEqual(resolveEnvMap(undefined, { X: 'y' }), {});
    });
  });

  suite('computeLoginKind', () => {
    test('opencode never offers a login flow', () => {
      assert.strictEqual(computeLoginKind('opencode', {}), 'none');
    });

    test('claude with no key-shaped env is oauth', () => {
      assert.strictEqual(computeLoginKind('claude', {}), 'oauth');
      assert.strictEqual(computeLoginKind('claude', { CLAUDE_CONFIG_DIR: '/tmp/x' }), 'oauth');
    });

    test('claude with an API key or auth token is none', () => {
      assert.strictEqual(computeLoginKind('claude', { ANTHROPIC_API_KEY: 'sk-1' }), 'none');
      assert.strictEqual(computeLoginKind('claude', { ANTHROPIC_AUTH_TOKEN: 'tok' }), 'none');
    });

    test('codex is always oauth, key or no key', () => {
      assert.strictEqual(computeLoginKind('codex', {}), 'oauth');
      assert.strictEqual(computeLoginKind('codex', { OPENAI_API_KEY: 'sk-1' }), 'oauth');
    });
  });

  suite('claudeLoginCommand', () => {
    test('defaults to claude on PATH', () => {
      assert.strictEqual(claudeLoginCommand(undefined), 'claude auth login');
    });
    test('uses a custom binPath', () => {
      assert.strictEqual(claudeLoginCommand('/opt/claude'), '/opt/claude auth login');
    });
  });

  suite('codexLoginCommand', () => {
    test('plain login with no key', () => {
      assert.strictEqual(codexLoginCommand(undefined, {}), 'codex login');
    });
    test('pipes the key through --with-api-key when one is present', () => {
      assert.strictEqual(
        codexLoginCommand(undefined, { OPENAI_API_KEY: 'sk-1' }),
        'printenv OPENAI_API_KEY | codex login --with-api-key',
      );
    });
    test('uses a custom binPath in both forms', () => {
      assert.strictEqual(codexLoginCommand('/opt/codex', {}), '/opt/codex login');
      assert.strictEqual(
        codexLoginCommand('/opt/codex', { OPENAI_API_KEY: 'sk-1' }),
        'printenv OPENAI_API_KEY | /opt/codex login --with-api-key',
      );
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test:unit --grep "shared/provider-instances"`
Expected: FAIL — `src/shared/provider-instances.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `src/shared/provider-instances.ts`:

```ts
/**
 * Extra named instances of an existing provider kind, configured via
 * `marcode.providerInstances`. Pure — no `vscode` import — so `extension.ts`'s
 * validation, env resolution and login-command choice are unit-testable
 * without a real workspace configuration. See
 * docs/superpowers/specs/2026-08-31-provider-instances-design.md.
 */

export type ProviderInstanceKind = 'claude' | 'codex' | 'opencode';

export const PROVIDER_INSTANCE_KINDS: readonly ProviderInstanceKind[] = ['claude', 'codex', 'opencode'];

/** One entry of the `marcode.providerInstances` setting, once validated. */
export interface ProviderInstanceConfig {
  id: string;
  kind: ProviderInstanceKind;
  displayName: string;
  binPath?: string;
  envMap?: Record<string, string>;
}

export interface ProviderInstanceValidation {
  valid: ProviderInstanceConfig[];
  warnings: string[];
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) { return false; }
  return Object.values(value).every((v) => typeof v === 'string');
}

/**
 * Parses and validates the raw `marcode.providerInstances` setting value.
 *
 * An entry is dropped (and a warning recorded, never thrown) when: it isn't
 * an object, `kind` isn't one of `PROVIDER_INSTANCE_KINDS`, `id` or
 * `displayName` aren't non-empty strings, `id` collides with a base kind id
 * (`baseIds` — the ids already registered from `marcode.enabledProviders`),
 * or `id` repeats an earlier valid entry's id in this same array. Mirrors
 * `enabledProviderIds()`'s existing unknown-id posture in `extension.ts`.
 */
export function validateProviderInstances(
  configured: unknown,
  baseIds: readonly string[],
): ProviderInstanceValidation {
  const valid: ProviderInstanceConfig[] = [];
  const warnings: string[] = [];
  if (!Array.isArray(configured)) {
    if (configured !== undefined) {
      warnings.push('marcode.providerInstances is not an array; ignoring it.');
    }
    return { valid, warnings };
  }
  const seenIds = new Set<string>(baseIds);
  for (const [index, entry] of configured.entries()) {
    if (typeof entry !== 'object' || entry === null) {
      warnings.push(`marcode.providerInstances[${index}] is not an object; skipping it.`);
      continue;
    }
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const kind = record.kind;
    const displayName = typeof record.displayName === 'string' ? record.displayName.trim() : '';
    if (id === '') {
      warnings.push(`marcode.providerInstances[${index}] has no id; skipping it.`);
      continue;
    }
    if (typeof kind !== 'string' || !PROVIDER_INSTANCE_KINDS.includes(kind as ProviderInstanceKind)) {
      warnings.push(
        `marcode.providerInstances[${index}] ("${id}") has an unknown kind ${JSON.stringify(kind)}; skipping it.`,
      );
      continue;
    }
    if (displayName === '') {
      warnings.push(`marcode.providerInstances[${index}] ("${id}") has no displayName; skipping it.`);
      continue;
    }
    if (seenIds.has(id)) {
      warnings.push(
        `marcode.providerInstances[${index}]: id "${id}" collides with an existing provider id; skipping it.`,
      );
      continue;
    }
    const binPath = typeof record.binPath === 'string' && record.binPath.trim() !== ''
      ? record.binPath.trim() : undefined;
    const envMap = isStringRecord(record.envMap) ? record.envMap : undefined;
    seenIds.add(id);
    valid.push({
      id, kind: kind as ProviderInstanceKind, displayName,
      ...(binPath ? { binPath } : {}), ...(envMap ? { envMap } : {}),
    });
  }
  return { valid, warnings };
}

/**
 * Resolves an instance's `envMap` (subprocess var name -> OS var name to
 * read the value from) against the real OS environment into concrete
 * values. A referenced OS variable that is unset is simply omitted — not a
 * config-time error; it surfaces later as a normal auth failure.
 */
export function resolveEnvMap(
  envMap: Record<string, string> | undefined,
  osEnv: NodeJS.ProcessEnv,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [subprocessVar, osVarName] of Object.entries(envMap ?? {})) {
    const value = osEnv[osVarName];
    if (value !== undefined) { resolved[subprocessVar] = value; }
  }
  return resolved;
}

export type LoginKind = 'oauth' | 'none';

/** Env vars whose presence means a claude instance is key/token-authenticated, not OAuth. */
const CLAUDE_KEY_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

/**
 * Whether an instance offers a terminal login flow at all.
 *
 * Claude: an API-key/auth-token instance has no login flow — a terminal
 * running `claude auth login` would write an OAuth session nobody reads and
 * would not fix the actual problem (a bad OS env var). Codex: always offers
 * one — even an `OPENAI_API_KEY` instance still has to persist that key into
 * its `CODEX_HOME/auth.json` via a login command, just a different one (see
 * `codexLoginCommand`). OpenCode: never offers one (matches today — no login
 * command exists for it). See the design doc's "Login and auth-failure UX"
 * section.
 */
export function computeLoginKind(
  kind: ProviderInstanceKind, resolvedEnv: Record<string, string>,
): LoginKind {
  if (kind === 'opencode') { return 'none'; }
  if (kind === 'claude' && CLAUDE_KEY_VARS.some((v) => resolvedEnv[v] !== undefined)) { return 'none'; }
  return 'oauth';
}

/** The terminal command that signs a claude instance in, given its resolved binPath. */
export function claudeLoginCommand(binPath: string | undefined): string {
  return `${binPath ?? 'claude'} auth login`;
}

/**
 * The terminal command that signs a codex instance in. When the instance's
 * resolved env carries `OPENAI_API_KEY`, the key is piped into
 * `codex login --with-api-key` so it lands in this instance's own
 * `CODEX_HOME/auth.json` — plain `codex login` would open a browser OAuth
 * flow instead and ignore the key entirely.
 */
export function codexLoginCommand(binPath: string | undefined, resolvedEnv: Record<string, string>): string {
  const bin = binPath ?? 'codex';
  return resolvedEnv.OPENAI_API_KEY !== undefined
    ? `printenv OPENAI_API_KEY | ${bin} login --with-api-key`
    : `${bin} login`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test:unit --grep "shared/provider-instances"`
Expected: PASS (all `suite`s green)

- [ ] **Step 5: Commit**

```bash
git add src/shared/provider-instances.ts src/test/unit/provider-instances.test.ts
git commit -m "feat: add provider-instances validation and env resolution"
```

---

### Task 3: `AgentProvider.loginKind` field

**Files:**
- Modify: `src/providers/types.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `AgentProvider.loginKind?: 'oauth' | 'none'` — optional field every provider class may set; `undefined` means "let the legacy message-text heuristic decide" (see Task 9).

- [ ] **Step 1: Locate the `AgentProvider` interface**

Open `src/providers/types.ts`, find the `AgentProvider` interface (near the end of the file, alongside `id`, `displayName`, `threadScope`).

- [ ] **Step 2: Add the field**

Add this member to the `AgentProvider` interface, next to `readonly threadScope: ThreadScope;`:

```ts
  /**
   * Whether a terminal login flow exists for this instance, and if so what
   * kind. `undefined` for a provider that predates this field — the webview
   * falls back to its old message-text heuristic in that case (see
   * `shouldOfferLogin` in `webview/lib/provider-login.ts`). Set explicitly by
   * `ClaudeProvider`/`CodexProvider` for a custom instance (see
   * `provider-instances.ts#computeLoginKind`); base instances leave it unset,
   * unchanged from today's behavior.
   */
  readonly loginKind?: 'oauth' | 'none';
```

- [ ] **Step 3: Run type-check**

Run: `yarn check-types`
Expected: PASS (adding an optional interface member is backward-compatible with every existing implementer).

- [ ] **Step 4: Commit**

```bash
git add src/providers/types.ts
git commit -m "feat: add AgentProvider.loginKind"
```

---

### Task 4: `ClaudeProvider` — instance overrides (id, displayName, env, binPath, loginKind)

**Files:**
- Modify: `src/providers/claude/claude-provider.ts:272-290` (class fields + constructor), `:516-543` (`buildOptions`)
- Test: `src/test/unit/claude-provider.test.ts`

**Interfaces:**
- Consumes: `AgentProvider.loginKind` (Task 3).
- Produces: `new ClaudeProvider(loadQueryFn?, selfControlMcp?, instance?: { id?: string; displayName?: string; env?: NodeJS.ProcessEnv; pathToClaudeCodeExecutable?: string; loginKind?: 'oauth' | 'none'; })`. Every field of `instance` is optional and defaults to today's behavior — the existing call site `new ClaudeProvider(undefined, selfControlConfig)` in `extension.ts` needs no change.

- [ ] **Step 1: Write the failing test**

Read `src/test/unit/claude-provider.test.ts`'s existing top-of-file fixture helpers first (`fakeLoadQuery`, `CATALOG`) so the new test reuses them. Add this test inside the existing `suite`:

```ts
test('an instance override sets id, displayName and merges env/pathToClaudeCodeExecutable into Options', async () => {
  let capturedOptions: Record<string, unknown> | undefined;
  const fake = fakeLoadQuery({
    onQuery: (options) => { capturedOptions = options as Record<string, unknown>; },
  });
  const provider = new ClaudeProvider(fake.load, undefined, {
    id: 'claude-work', displayName: 'Claude (work)',
    env: { ANTHROPIC_API_KEY: 'sk-work' } as NodeJS.ProcessEnv,
    pathToClaudeCodeExecutable: '/opt/claude-work/claude',
  });
  assert.strictEqual(provider.id, 'claude-work');
  assert.strictEqual(provider.displayName, 'Claude (work)');
  const run = provider.start({ cwd: '/repo', permissionMode: 'default' });
  run.send('hi');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.strictEqual((capturedOptions?.env as Record<string, string> | undefined)?.ANTHROPIC_API_KEY, 'sk-work');
  assert.strictEqual(capturedOptions?.pathToClaudeCodeExecutable, '/opt/claude-work/claude');
});

test('id/displayName default to claude/Claude when no instance override is given', () => {
  const provider = new ClaudeProvider(fakeLoadQuery().load);
  assert.strictEqual(provider.id, 'claude');
  assert.strictEqual(provider.displayName, 'Claude');
  assert.strictEqual(provider.loginKind, undefined);
});

test('loginKind passes through from the instance override', () => {
  const provider = new ClaudeProvider(fakeLoadQuery().load, undefined, { loginKind: 'none' });
  assert.strictEqual(provider.loginKind, 'none');
});
```

If `fakeLoadQuery` in the existing test file doesn't already support an `onQuery` callback that observes the `options` object passed to the fake `query()` call, add that capability to the fixture helper at the top of the test file — check its current implementation first and extend it minimally (e.g. accept `opts.onQuery?: (options: unknown) => void` and call it inside the fake `QueryFn`).

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:unit --grep "instance override"`
Expected: FAIL — `ClaudeProvider` constructor doesn't accept a 3rd argument, `provider.id` is always `'claude'`.

- [ ] **Step 3: Write minimal implementation**

Modify `src/providers/claude/claude-provider.ts`. Replace the class field declarations and constructor (lines 272-290):

```ts
export class ClaudeProvider implements AgentProvider {
  readonly id: string;
  readonly displayName: string;
  readonly threadScope: ThreadScope = 'cwd';
  readonly loginKind?: 'oauth' | 'none';

  /**
   * The last answer from `fetchModels()`, and the whole of what this provider
   * knows. Empty until a probe succeeds: there is no hardcoded catalog to
   * fall back to, because a list of models is also a claim that this install
   * can run them — and the SDK ships no CLI, so on a machine without Claude
   * Code that claim is false. A provider with no models is not selectable at
   * all; see SessionManager.catalog().
   */
  private models: ModelInfo[] = [];

  constructor(
    private readonly loadQueryFn: () => Promise<QueryFn> = loadQuery,
    private readonly selfControlMcp?: SelfControlMcpConfig,
    instance?: {
      id?: string;
      displayName?: string;
      env?: NodeJS.ProcessEnv;
      pathToClaudeCodeExecutable?: string;
      loginKind?: 'oauth' | 'none';
    },
  ) {
    this.id = instance?.id ?? 'claude';
    this.displayName = instance?.displayName ?? 'Claude';
    this.env = instance?.env;
    this.pathToClaudeCodeExecutable = instance?.pathToClaudeCodeExecutable;
    this.loginKind = instance?.loginKind;
  }

  /** Instance env override, merged into every `Options.env` this provider builds. */
  private readonly env?: NodeJS.ProcessEnv;
  /** Instance binary override — a second Claude Code install, not just a second account. */
  private readonly pathToClaudeCodeExecutable?: string;
```

Then modify `buildOptions()` (around line 516-543) — add `env` and `pathToClaudeCodeExecutable` to the returned object, right after the `thinking` field:

```ts
      return {
        cwd: opts.cwd,
        model: pendingModel,
        resume: opts.resumeToken,
        permissionMode: PERMISSION_MODE[pendingMode],
        canUseTool,
        thinking: { type: 'adaptive', display: 'summarized' },
        ...(this.env ? { env: this.env } : {}),
        ...(this.pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable: this.pathToClaudeCodeExecutable } : {}),
        ...(effort !== undefined ? { effort: effort as SdkEffortLevel } : {}),
        ...(isBypassMode ? { allowDangerouslySkipPermissions: true } : {}),
        ...(this.selfControlMcp ? {
          mcpServers: {
            marcode_self_control: {
              type: 'http' as const,
              url: this.selfControlMcp.url,
              headers: { authorization: `Bearer ${this.selfControlMcp.token}` },
            },
          },
        } : {}),
      };
```

(TypeScript note: class field declarations must all be grouped before the constructor per the project's lint rules — check `yarn lint` output after this step; if it flags field-ordering, move `private readonly env?` and `private readonly pathToClaudeCodeExecutable?` up next to the other field declarations, above the constructor, and drop the assignment lines from inside the constructor body accordingly — TypeScript parameter properties (`private readonly loadQueryFn`) must stay as constructor parameters, but plain fields set from `instance` do not.)

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test:unit --grep "claude-provider"`
Expected: PASS

- [ ] **Step 5: Run lint and type-check**

Run: `yarn lint && yarn check-types`
Expected: PASS — fix any field-ordering issue per the note in Step 3.

- [ ] **Step 6: Commit**

```bash
git add src/providers/claude/claude-provider.ts src/test/unit/claude-provider.test.ts
git commit -m "feat: let ClaudeProvider take an instance override (id, env, binPath)"
```

---

### Task 5: `CodexProvider` — instance overrides (id, displayName, env, loginKind)

**Files:**
- Modify: `src/providers/codex/codex-provider.ts:158-229` (class fields + constructor), `:254-266` (`connect()`)
- Test: `src/test/unit/codex-provider.test.ts`

**Interfaces:**
- Consumes: `AgentProvider.loginKind` (Task 3).
- Produces: `new CodexProvider({ id?, displayName?, binPath?, spawn?, teardownGraceMs?, selfControlMcp?, env?: NodeJS.ProcessEnv, loginKind?: 'oauth' | 'none' })`. All new fields optional; the existing call site `new CodexProvider({ binPath: codexBinPath(), selfControlMcp: selfControlConfig })` needs no change.

- [ ] **Step 1: Write the failing test**

Read the existing `stubChild()`/`providerWithStub()` helpers at the top of `src/test/unit/codex-provider.test.ts` first. Add inside the existing `suite`:

```ts
test('an instance override sets id/displayName and merges env into the spawned process', () => {
  let capturedEnv: NodeJS.ProcessEnv | undefined;
  const child = stubChild();
  const provider = new CodexProvider({
    spawn: (bin, env) => { capturedEnv = env; return child; },
    id: 'codex-work', displayName: 'Codex (work)',
    env: { OPENAI_API_KEY: 'sk-work' } as NodeJS.ProcessEnv,
  });
  assert.strictEqual(provider.id, 'codex-work');
  assert.strictEqual(provider.displayName, 'Codex (work)');
  provider.start({ cwd: '/repo', permissionMode: 'default' });
  assert.strictEqual(capturedEnv?.OPENAI_API_KEY, 'sk-work');
});

test('id/displayName default to codex/Codex when no instance override is given', () => {
  const provider = new CodexProvider({ spawn: () => stubChild() });
  assert.strictEqual(provider.id, 'codex');
  assert.strictEqual(provider.displayName, 'Codex');
  assert.strictEqual(provider.loginKind, undefined);
});

test('instance env and selfControlMcp env both reach the spawned process', () => {
  let capturedEnv: NodeJS.ProcessEnv | undefined;
  const child = stubChild();
  const provider = new CodexProvider({
    spawn: (bin, env) => { capturedEnv = env; return child; },
    env: { OPENAI_API_KEY: 'sk-work' } as NodeJS.ProcessEnv,
    selfControlMcp: { url: 'http://localhost:1', token: 'tok' },
  });
  provider.start({ cwd: '/repo', permissionMode: 'default' });
  assert.strictEqual(capturedEnv?.OPENAI_API_KEY, 'sk-work');
  assert.strictEqual(capturedEnv?.MARCODE_SELF_CONTROL_TOKEN, 'tok');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:unit --grep "instance override"`
Expected: FAIL — `CodexProvider` opts don't accept `id`/`displayName`/`env`, `provider.id` is always `'codex'`.

- [ ] **Step 3: Write minimal implementation**

Modify `src/providers/codex/codex-provider.ts`. Replace the field declarations and constructor (lines 158-229):

```ts
export class CodexProvider implements AgentProvider {
  readonly id: string;
  readonly displayName: string;
  readonly threadScope: ThreadScope = 'global';
  readonly loginKind?: 'oauth' | 'none';

  private models: ModelInfo[] = [];
  private readonly views = new Set<ThreadView>();
  private connectionPromise: Promise<AppServer> | undefined;
  private serverInstance: AppServer | undefined;
  private binPath: string | undefined;
  private teardownTimer: NodeJS.Timeout | undefined;
  private readonly teardownGraceMs: number;
  /** Instance env override, merged into every spawned `app-server` process's env. */
  private readonly env?: NodeJS.ProcessEnv;

  constructor(private readonly opts: {
    id?: string;
    displayName?: string;
    binPath?: string;
    spawn?: (bin: string, env?: NodeJS.ProcessEnv) => Duplex;
    teardownGraceMs?: number;
    /** The loopback MCP server this provider's threads should connect to, if any. */
    selfControlMcp?: SelfControlMcpConfig;
    env?: NodeJS.ProcessEnv;
    loginKind?: 'oauth' | 'none';
  } = {}) {
    this.id = opts.id ?? 'codex';
    this.displayName = opts.displayName ?? 'Codex';
    this.binPath = opts.binPath;
    this.teardownGraceMs = opts.teardownGraceMs ?? 5000;
    this.env = opts.env;
    this.loginKind = opts.loginKind;
  }
```

Then modify `connect()` (around lines 254-266) to merge `this.env` in alongside the self-control token:

```ts
  private async connect(): Promise<AppServer> {
    const bin = this.binPath ?? 'codex';
    const hasOverrides = this.env !== undefined || this.opts.selfControlMcp !== undefined;
    const env = hasOverrides
      ? {
          ...process.env,
          ...(this.env ?? {}),
          ...(this.opts.selfControlMcp ? { MARCODE_SELF_CONTROL_TOKEN: this.opts.selfControlMcp.token } : {}),
        }
      : undefined;
    let child: Duplex;
    try {
      child = (this.opts.spawn ?? spawnAppServer)(bin, env);
    } catch {
      this.connectionPromise = undefined;
      // This message IS the availability UX — see fetchModels()'s header.
      throw new Error('Codex CLI not found. Install it, or set marcode.codex.path.');
    }
```

(The rest of `connect()` is unchanged.)

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test:unit --grep "codex-provider"`
Expected: PASS

- [ ] **Step 5: Run lint and type-check**

Run: `yarn lint && yarn check-types`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/providers/codex/codex-provider.ts src/test/unit/codex-provider.test.ts
git commit -m "feat: let CodexProvider take an instance override (id, env)"
```

---

### Task 6: `OpenCodeProvider` + `spawnOpenCodeAcp` — instance overrides (id, displayName, env)

**Files:**
- Modify: `src/providers/opencode/opencode-provider.ts` (full file — `spawnOpenCodeAcp` signature, class fields/constructor, `fetchModels`, `start`)
- Test: `src/test/unit/opencode-provider.test.ts` (check filename with Glob first — may be `opencode.test.ts`)

**Interfaces:**
- Consumes: `AgentProvider.loginKind` (Task 3) — always left `undefined`/`'none'` for this kind per `computeLoginKind`, since OpenCode never offers a login flow.
- Produces: `spawnOpenCodeAcp(binPath?: string, env?: NodeJS.ProcessEnv): AcpChild`; `new OpenCodeProvider({ id?, displayName?, binPath?, spawn?: (bin: string, env?: NodeJS.ProcessEnv) => AcpChild, selfControlMcp?, env?: NodeJS.ProcessEnv })`. Existing call site `new OpenCodeProvider({ binPath: openCodeBinPath(), selfControlMcp: selfControlConfig })` needs no change.

- [ ] **Step 1: Write the failing test**

Find the existing test file with Glob (`src/test/unit/opencode*.test.ts`) and read its `spawn` stub pattern. Add:

```ts
test('an instance override sets id/displayName and merges env into the spawned process', async () => {
  let capturedEnv: NodeJS.ProcessEnv | undefined;
  const provider = new OpenCodeProvider({
    id: 'opencode-grok', displayName: 'OpenCode (Grok)',
    env: { OPENCODE_CONFIG_DIR: '/home/user/.config/opencode-grok' } as NodeJS.ProcessEnv,
    spawn: (bin, env) => {
      capturedEnv = env;
      // reuse this file's existing scripted AcpChild stub helper here
      return stubAcpChild();
    },
  });
  assert.strictEqual(provider.id, 'opencode-grok');
  assert.strictEqual(provider.displayName, 'OpenCode (Grok)');
  provider.start({ cwd: '/repo', permissionMode: 'default' });
  assert.strictEqual(capturedEnv?.OPENCODE_CONFIG_DIR, '/home/user/.config/opencode-grok');
});

test('id/displayName default to opencode/OpenCode when no instance override is given', () => {
  const provider = new OpenCodeProvider({ spawn: () => stubAcpChild() });
  assert.strictEqual(provider.id, 'opencode');
  assert.strictEqual(provider.displayName, 'OpenCode');
});
```

Use whatever the file's existing scripted `AcpChild` stub helper is actually named (read the file first — do not invent a name that doesn't already exist there).

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:unit --grep "instance override"`
Expected: FAIL — `OpenCodeProvider` opts don't accept `id`/`displayName`/`env`.

- [ ] **Step 3: Write minimal implementation**

Modify `src/providers/opencode/opencode-provider.ts`. Replace `spawnOpenCodeAcp` (lines 32-57):

```ts
export function spawnOpenCodeAcp(binPath?: string, env?: NodeJS.ProcessEnv): AcpChild {
  const bin = binPath ?? 'opencode';
  const child = spawnChildProcess(bin, ['acp'], {
    stdio: ['pipe', 'pipe', 'pipe'], shell: true, windowsHide: true, ...(env ? { env } : {}),
  });
  let tail = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    tail = (tail + chunk.toString()).slice(-STDERR_TAIL_BYTES);
  });
  child.stderr?.on('error', () => {});
  let notify: (reason: string) => void = () => {};
  let failed = false;
  const fail = (reason: string): void => {
    if (failed) { return; }
    failed = true;
    const detail = tail.trim();
    notify(detail ? `${reason}: ${detail}` : reason);
  };
  child.on('error', (err: Error) => { fail(`opencode acp failed to start (${err.message})`); });
  child.on('exit', (code, signal) => { fail(`opencode acp exited (${signal ?? `code ${code}`})`); });
  return {
    stdin: child.stdin!, stdout: child.stdout!,
    kill: () => { child.kill(); },
    onFailure: (cb) => { notify = cb; },
  };
}
```

Replace the class (lines 72-103) — fields and constructor:

```ts
export class OpenCodeProvider implements AgentProvider {
  readonly id: string;
  readonly displayName: string;
  readonly threadScope: ThreadScope = 'cwd';

  private models: ModelInfo[] = [];
  private readonly binPath?: string;
  private readonly spawn: (bin: string, env?: NodeJS.ProcessEnv) => AcpChild;
  private readonly selfControlMcp?: SelfControlMcpConfig;
  /** Instance env override, merged into every spawned `opencode acp` process's env. */
  private readonly env?: NodeJS.ProcessEnv;

  readonly fetchUsage?: AgentProvider['fetchUsage'];

  constructor(opts: {
    id?: string;
    displayName?: string;
    binPath?: string;
    spawn?: (bin: string, env?: NodeJS.ProcessEnv) => AcpChild;
    selfControlMcp?: SelfControlMcpConfig;
    env?: NodeJS.ProcessEnv;
  } = {}) {
    this.id = opts.id ?? 'opencode';
    this.displayName = opts.displayName ?? 'OpenCode';
    this.binPath = opts.binPath;
    this.spawn = opts.spawn ?? ((bin, env) => spawnOpenCodeAcp(bin, env));
    this.selfControlMcp = opts.selfControlMcp;
    this.env = opts.env;
  }

  /** Instance env merged over `process.env`, or `undefined` when there is no override. */
  private mergedEnv(): NodeJS.ProcessEnv | undefined {
    return this.env ? { ...process.env, ...this.env } : undefined;
  }
```

Then update the two call sites that invoke `this.spawn(...)` — in `fetchModels` (around line 125) and `start` (around line 167) — to pass the merged env:

```ts
      child = this.spawn(this.binPath ?? 'opencode', this.mergedEnv());
```

and

```ts
    const child = this.spawn(this.binPath ?? 'opencode', this.mergedEnv());
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test:unit --grep "opencode"`
Expected: PASS

- [ ] **Step 5: Run lint and type-check**

Run: `yarn lint && yarn check-types`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/providers/opencode/opencode-provider.ts src/test/unit/opencode-provider.test.ts
git commit -m "feat: let OpenCodeProvider take an instance override (id, env)"
```

---

### Task 7: `loginKind` on the wire — `ProviderInfo`/`UnavailableProvider`

**Files:**
- Modify: `src/protocol/messages.ts` (the `ProviderInfo` and `UnavailableProvider` interfaces)
- Test: `src/test/unit/protocol.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ProviderInfo.loginKind?: 'oauth' | 'none'`, `UnavailableProvider.loginKind?: 'oauth' | 'none'`.

- [ ] **Step 1: Write the failing test**

Find `src/test/unit/protocol.test.ts`'s existing type-shape assertions (or add a new small one if the file has no precedent for asserting on a single interface's fields — a compile-time-only check is acceptable here since this is a types-only file). Add:

```ts
test('ProviderInfo and UnavailableProvider carry an optional loginKind', () => {
  const info: ProviderInfo = {
    id: 'claude-work', displayName: 'Claude (work)', models: [], permissionModes: [],
    loginKind: 'none',
  };
  const unavailable: UnavailableProvider = {
    id: 'claude-work', displayName: 'Claude (work)', reason: 'x', loginKind: 'oauth',
  };
  assert.strictEqual(info.loginKind, 'none');
  assert.strictEqual(unavailable.loginKind, 'oauth');
});
```

Add the necessary `import type { ProviderInfo, UnavailableProvider } from '../../protocol/messages';` at the top of the test file if not already imported.

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn check-types`
Expected: FAIL — TS2353 (`loginKind` does not exist on type `ProviderInfo`/`UnavailableProvider`).

- [ ] **Step 3: Write minimal implementation**

Modify `src/protocol/messages.ts`:

```ts
export interface ProviderInfo {
  id: string;
  displayName: string;
  models: ModelInfo[];
  permissionModes: PermissionModeInfo[];
  /** See `AgentProvider.loginKind` — passed through verbatim by `SessionManager.catalog()`. */
  loginKind?: 'oauth' | 'none';
}

export interface UnavailableProvider {
  id: string;
  displayName: string;
  reason: string;
  /** See `AgentProvider.loginKind` — passed through verbatim by `SessionManager.unavailable()`. */
  loginKind?: 'oauth' | 'none';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn check-types && yarn test:unit --grep "loginKind"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/protocol/messages.ts src/test/unit/protocol.test.ts
git commit -m "feat: add loginKind to ProviderInfo and UnavailableProvider"
```

---

### Task 8: `SessionManager.catalog()`/`unavailable()` pass through `loginKind`

**Files:**
- Modify: `src/host/session-manager.ts` (`catalog()` and `unavailable()`)
- Test: `src/test/unit/session-manager.test.ts` (find the exact filename with Glob — may be split across multiple `session-manager-*.test.ts` files; add to whichever one already covers `catalog()`/`unavailable()`)

**Interfaces:**
- Consumes: `AgentProvider.loginKind` (Task 3), `ProviderInfo.loginKind`/`UnavailableProvider.loginKind` (Task 7).
- Produces: `SessionManager.catalog()` entries and `SessionManager.unavailable()` entries both carry `loginKind` verbatim from the underlying `AgentProvider`.

- [ ] **Step 1: Write the failing test**

Find the existing test(s) covering `catalog()`/`unavailable()` (search for `.catalog()` and `.unavailable()` calls in `src/test/unit/`) and read one to match its `AgentProvider` stub pattern. Add:

```ts
test('catalog() passes through a provider\'s loginKind', () => {
  const provider = stubProvider({ id: 'claude-work', models: [{ id: 'm', displayName: 'M' }], loginKind: 'none' });
  const manager = new SessionManager(store, new Map([['claude-work', provider]]), () => {});
  const entry = manager.catalog().find((p) => p.id === 'claude-work');
  assert.strictEqual(entry?.loginKind, 'none');
});

test('unavailable() passes through a provider\'s loginKind', async () => {
  const provider = stubProvider({ id: 'claude-work', models: [], loginKind: 'oauth', fetchModelsError: new Error('nope') });
  const manager = new SessionManager(store, new Map([['claude-work', provider]]), () => {});
  await manager.refreshModels('/repo');
  const entry = manager.unavailable().find((p) => p.id === 'claude-work');
  assert.strictEqual(entry?.loginKind, 'oauth');
});
```

Adapt `stubProvider(...)`'s exact shape/name to whatever helper the existing test file already uses to build a fake `AgentProvider` — do not invent a new one if one already exists; extend it to accept `loginKind` and `fetchModelsError` if it doesn't already.

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:unit --grep "loginKind"`
Expected: FAIL — `entry?.loginKind` is `undefined` (not passed through yet).

- [ ] **Step 3: Write minimal implementation**

Modify `src/host/session-manager.ts`. In `catalog()`:

```ts
  catalog(): ProviderInfo[] {
    return [...this.providers.values()]
      .map((p) => ({
        id: p.id,
        displayName: p.displayName,
        models: this.modelsFor(p),
        permissionModes: p.listPermissionModes(),
        ...(p.loginKind ? { loginKind: p.loginKind } : {}),
      }))
      .filter((p) => p.models.length > 0);
  }
```

In `unavailable()`:

```ts
  unavailable(): UnavailableProvider[] {
    return [...this.providers.values()]
      .filter((p) => this.modelsFor(p).length === 0 && this.probeFailures.has(p.id))
      .map((p) => ({
        id: p.id, displayName: p.displayName, reason: this.probeFailures.get(p.id)!,
        ...(p.loginKind ? { loginKind: p.loginKind } : {}),
      }));
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test:unit --grep "loginKind"`
Expected: PASS

- [ ] **Step 5: Run full unit suite**

Run: `yarn test:unit`
Expected: PASS (no regression in existing `catalog()`/`unavailable()` tests — the added field is optional and only present when `p.loginKind` is set).

- [ ] **Step 6: Commit**

```bash
git add src/host/session-manager.ts src/test/unit/session-manager.test.ts
git commit -m "feat: pass provider loginKind through catalog and unavailable"
```

---

### Task 9: `shouldOfferLogin` — the authoritative gate

**Files:**
- Modify: `src/webview/lib/provider-login.ts`
- Test: `src/test/unit/provider-login.test.ts`

**Interfaces:**
- Consumes: nothing new (works alongside the existing `isSignInFailure`).
- Produces: `function shouldOfferLogin(reason: string | undefined, loginKind: 'oauth' | 'none' | undefined): boolean`, exported alongside the existing `isSignInFailure`.

- [ ] **Step 1: Write the failing test**

Modify `src/test/unit/provider-login.test.ts`, add:

```ts
suite('shouldOfferLogin', () => {
  test('loginKind "none" suppresses the button even with sign-in-shaped text', () => {
    assert.strictEqual(
      shouldOfferLogin('Not signed in to Claude. Run `claude auth login`.', 'none'),
      false,
    );
  });

  test('loginKind "oauth" offers the button even with unrelated text', () => {
    assert.strictEqual(shouldOfferLogin('some other failure', 'oauth'), true);
  });

  test('undefined loginKind falls back to the message-text heuristic', () => {
    assert.strictEqual(
      shouldOfferLogin('Not signed in to Codex. Run `codex login`.', undefined),
      true,
    );
    assert.strictEqual(shouldOfferLogin('control request failed', undefined), false);
  });
});
```

Add the import: `import { isSignInFailure, shouldOfferLogin } from '../../webview/lib/provider-login';` (update the existing import line if `isSignInFailure` is already imported alone).

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:unit --grep "shouldOfferLogin"`
Expected: FAIL — `shouldOfferLogin` is not exported.

- [ ] **Step 3: Write minimal implementation**

Modify `src/webview/lib/provider-login.ts`:

```ts
export function isSignInFailure(reason: string | undefined): boolean {
  return reason !== undefined && /Not signed in to \w+\b/i.test(reason);
}

/**
 * Whether the Login action belongs on this failure.
 *
 * `loginKind` is authoritative when a provider set it (custom instances
 * always do — see `AgentProvider.loginKind`): `'none'` suppresses the button
 * regardless of the message text (an API-key claude instance's failure is
 * never fixed by a terminal login), `'oauth'` always offers it (a codex
 * instance's login command varies by whether a key is configured, but a
 * login flow always exists). `undefined` — every base, non-custom provider
 * today — falls back to the old message-text heuristic, unchanged behavior.
 */
export function shouldOfferLogin(reason: string | undefined, loginKind: 'oauth' | 'none' | undefined): boolean {
  if (loginKind === 'none') { return false; }
  if (loginKind === 'oauth') { return true; }
  return isSignInFailure(reason);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test:unit --grep "provider-login"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/webview/lib/provider-login.ts src/test/unit/provider-login.test.ts
git commit -m "feat: add shouldOfferLogin, authoritative on a provider's loginKind"
```

---

### Task 10: Wire `shouldOfferLogin` into `pane-group.tsx` and `transcript-item.tsx`

**Files:**
- Modify: `src/webview/components/pane-group.tsx:154-166` (the empty-state Login button)
- Modify: `src/webview/components/transcript-item.tsx:67-91` (the error-item Login button)
- Test: `src/test/dom/pane-group.test.tsx`, `src/test/dom/transcript-item.test.tsx`

**Interfaces:**
- Consumes: `shouldOfferLogin` (Task 9), `UnavailableProvider.loginKind`/`ProviderInfo.loginKind` (Task 7).
- Produces: no new exports — behavior change only, verified by tests.

- [ ] **Step 1: Write the failing tests**

In `src/test/dom/pane-group.test.tsx`, add next to the existing `'a not-signed-in provider offers a login action...'` test:

```tsx
test('an unavailable provider with loginKind "none" offers no login action even with sign-in text', () => {
  renderApp();
  sendFromHost({
    t: 'hydrate',
    sessions: [], layout: layoutOf(), snapshots: [],
    catalog: [],
    unavailable: [{
      id: 'claude-work', displayName: 'Claude (work)',
      reason: 'Not signed in to Claude. Run `claude auth login`.',
      loginKind: 'none',
    }],
    probing: false,
    usage: {},
  });
  assert.strictEqual(screen.queryByRole('button', { name: /log in/i }) === null, true);
});

test('an unavailable provider with loginKind "oauth" offers a login action even with unrelated reason text', async () => {
  renderApp();
  sendFromHost({
    t: 'hydrate',
    sessions: [], layout: layoutOf(), snapshots: [],
    catalog: [],
    unavailable: [{
      id: 'codex-work', displayName: 'Codex (work)', reason: 'connection refused', loginKind: 'oauth',
    }],
    probing: false,
    usage: {},
  });
  await userEvent.click(screen.getByRole('button', { name: /log in/i }));
  assert.deepStrictEqual(posted().at(-1), { t: 'login-provider', providerId: 'codex-work' });
});
```

In `src/test/dom/transcript-item.test.tsx`, add next to the existing sign-in-error test — first check how `hydrateWithItems`'s second argument threads a session's provider info (it currently only sets `providerId` per the excerpt already read); extend that fixture helper, or the `hydrate` call it wraps, to also let a test supply the session's `catalog`/provider `loginKind` if it doesn't already support that — then add:

```tsx
test('a sign-in error for a loginKind "none" provider offers no login action', () => {
  renderApp();
  hydrateWithItems(
    [{ id: '3', ts: 3, role: 'error', message: 'Not signed in to Claude. Run `claude auth login`.' }],
    { providerId: 'claude-work', catalog: [{ id: 'claude-work', displayName: 'Claude (work)', models: [], permissionModes: [], loginKind: 'none' }] },
  );
  assert.strictEqual(screen.queryByRole('button', { name: /log in/i }) === null, true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test:dom --grep "loginKind"`
Expected: FAIL — the button still renders based on `isSignInFailure` alone.

- [ ] **Step 3: Write minimal implementation**

In `src/webview/components/pane-group.tsx`, change the import and the button's guard condition (around line 154-166):

```tsx
import { shouldOfferLogin } from "../lib/provider-login";
```

(replace the existing `import { isSignInFailure } from "../lib/provider-login";` line)

```tsx
              {shouldOfferLogin(p.reason, p.loginKind) && (
                <Button size="sm" variant="outline" onClick={() => post({ t: "login-provider", providerId: p.id })}>
                  <LogInIcon aria-hidden />
                  Log in
                </Button>
              )}
```

In `src/webview/components/transcript-item.tsx`, change the import and the `'error'` case's guard (around line 67-91):

```tsx
import { shouldOfferLogin } from '../lib/provider-login';
```

```tsx
    case 'error': {
      const providerId = state.byId[sessionId]?.summary.providerId;
      const loginKind = state.catalog.find((p) => p.id === providerId)?.loginKind
        ?? state.unavailable.find((p) => p.id === providerId)?.loginKind;
      return (
        <TranscriptItemShell role="error" label="Error" ts={item.ts}>
          <div className="max-h-48 overflow-auto rounded border border-destructive px-2 py-1 text-xs wrap-break-word whitespace-pre-wrap text-destructive">
            {item.message}
          </div>
          {shouldOfferLogin(item.message, loginKind) && providerId !== undefined && (
            <Button size="sm" variant="outline" className="mt-1.5" onClick={() => post({ t: 'login-provider', providerId })}>
              <LogInIcon aria-hidden />
              Log in
            </Button>
          )}
        </TranscriptItemShell>
      );
    }
```

Before editing, confirm `state.catalog` and `state.unavailable` are both reachable from this component's `useStore()`/props (check how `pane-group.tsx` reaches `state.catalog`/`state.unavailable` and mirror that access pattern here — it may be `useStore()` directly or a prop already threaded through; match whatever the file's existing pattern is, don't introduce a second one).

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test:dom --grep "loginKind"`
Expected: PASS

- [ ] **Step 5: Run full DOM suite**

Run: `yarn test:dom`
Expected: PASS (no regression in the two pre-existing login tests in each file — they don't set `loginKind`, so `shouldOfferLogin` falls back to `isSignInFailure`, same as before).

- [ ] **Step 6: Run the impeccable detector over both changed files**

Run: `node <impeccable-skill-dir>/scripts/detect.mjs --json src/webview/components/pane-group.tsx src/webview/components/transcript-item.tsx`
Expected: exit 0. If it reports findings (exit 2), fix them before committing — this is a required gate per `CLAUDE.md`'s "UI changes go through impeccable" section, even though this task is behavior-only (no new visual markup).

- [ ] **Step 7: Commit**

```bash
git add src/webview/components/pane-group.tsx src/webview/components/transcript-item.tsx src/test/dom/pane-group.test.tsx src/test/dom/transcript-item.test.tsx
git commit -m "feat: gate the Login button on a provider's loginKind"
```

---

### Task 11: `extension.ts` — read `marcode.providerInstances`, construct extra providers, dynamic login dispatch

**Files:**
- Modify: `src/extension.ts` (imports; provider-construction block, lines 264-308; `editorHost.login`, lines 347-355; `LOGIN_COMMANDS`/`openLoginTerminal`, lines 562-578; command registrations, lines 451-456; config-change listener, lines 467-486)
- Test: `src/test/integration/extension.test.ts` if it already exercises provider construction (check with Glob/Grep first) — otherwise this task is verified by the unit tests already written in Tasks 2/4/5/6 plus a manual smoke check (see Step 6), since `extension.ts` itself has no unit-test harness for `activate()` (it's `vscode`-dependent, exercised only by the `@vscode/test-cli` integration suite).

**Interfaces:**
- Consumes: `PROVIDER_INSTANCES_SETTING` (Task 1), `validateProviderInstances`/`resolveEnvMap`/`computeLoginKind`/`claudeLoginCommand`/`codexLoginCommand`/`ProviderInstanceConfig` (Task 2), the extended `ClaudeProvider`/`CodexProvider`/`OpenCodeProvider` constructors (Tasks 4-6).
- Produces: `providers` map gains one entry per valid `marcode.providerInstances` entry; `editorHost.login(providerId)` resolves any registered instance's login recipe, not just the two hardcoded base ones.

- [ ] **Step 1: Add imports**

Modify `src/extension.ts`'s import block — extend the existing:

```ts
import {
  DEFAULT_PROVIDER_IDS, ENABLED_PROVIDERS_SETTING, KNOWN_PROVIDER_IDS,
} from './shared/settings';
```

to:

```ts
import {
  DEFAULT_PROVIDER_IDS, ENABLED_PROVIDERS_SETTING, KNOWN_PROVIDER_IDS, PROVIDER_INSTANCES_SETTING,
} from './shared/settings';
import {
  claudeLoginCommand, codexLoginCommand, computeLoginKind, resolveEnvMap, validateProviderInstances,
} from './shared/provider-instances';
```

- [ ] **Step 2: Build the login-recipe table and construct extra providers**

Modify `src/extension.ts` — right after the existing base-provider construction block ends (after the `if (enabled.has('fake')) { ... }` block, i.e. right after line 308, before the `resolvedCwd` block that currently starts at line 313):

```ts
  /** One instance id -> the terminal command that signs it in, and the env that terminal runs with. */
  type LoginRecipe = { terminalName: string; command: string; env: NodeJS.ProcessEnv };
  const loginRecipes = new Map<string, LoginRecipe>();
  if (enabled.has('claude')) {
    loginRecipes.set('claude', { terminalName: 'Claude login', command: 'claude auth login', env: process.env });
  }
  if (codexProvider) {
    loginRecipes.set('codex', { terminalName: 'Codex login', command: 'codex login', env: process.env });
  }

  // Extra named instances of an existing kind — additive to `enabled` above.
  // See docs/superpowers/specs/2026-08-31-provider-instances-design.md.
  const { valid: instanceConfigs, warnings: instanceWarnings } = validateProviderInstances(
    vscode.workspace.getConfiguration().get<unknown>(PROVIDER_INSTANCES_SETTING),
    [...providers.keys()],
  );
  for (const warning of instanceWarnings) {
    void vscode.window.showWarningMessage(warning);
  }
  for (const cfg of instanceConfigs) {
    const resolvedEnv = resolveEnvMap(cfg.envMap, process.env);
    const mergedEnv = { ...process.env, ...resolvedEnv };
    const loginKind = computeLoginKind(cfg.kind, resolvedEnv);
    if (cfg.kind === 'claude') {
      providers.set(cfg.id, new ClaudeProvider(undefined, selfControlConfig, {
        id: cfg.id, displayName: cfg.displayName, env: mergedEnv,
        pathToClaudeCodeExecutable: cfg.binPath, loginKind,
      }));
      if (loginKind === 'oauth') {
        loginRecipes.set(cfg.id, {
          terminalName: `${cfg.displayName} login`,
          command: claudeLoginCommand(cfg.binPath),
          env: mergedEnv,
        });
      }
    } else if (cfg.kind === 'codex') {
      providers.set(cfg.id, new CodexProvider({
        id: cfg.id, displayName: cfg.displayName, binPath: cfg.binPath,
        env: mergedEnv, selfControlMcp: selfControlConfig, loginKind,
      }));
      loginRecipes.set(cfg.id, {
        terminalName: `${cfg.displayName} login`,
        command: codexLoginCommand(cfg.binPath, resolvedEnv),
        env: mergedEnv,
      });
    } else {
      providers.set(cfg.id, new OpenCodeProvider({
        id: cfg.id, displayName: cfg.displayName, binPath: cfg.binPath,
        env: mergedEnv, selfControlMcp: selfControlConfig,
      }));
    }
  }
```

- [ ] **Step 3: Rewrite `editorHost.login` and `openLoginTerminal`**

Modify `editorHost.login` (lines 347-355):

```ts
    login: (providerId: string) => {
      // `providerId` names a registered instance's login recipe — a provider
      // with none (no login flow, e.g. a key-based instance, or a typo
      // reaching this from a future provider) is a no-op rather than a thrown
      // error, the same tolerance `revealFile` and `openFileDiff` give a dead
      // reference.
      const recipe = loginRecipes.get(providerId);
      if (recipe) { openLoginTerminal(recipe.terminalName, recipe.command, recipe.env); }
    },
```

Modify `openLoginTerminal` (lines 574-578) and remove `LOGIN_COMMANDS` (lines 562-566) entirely:

```ts
/**
 * `claude auth login` / `codex login` (or their instance-scoped variants)
 * each open a browser flow and need a real TTY, so this hands the user a
 * terminal rather than trying to drive it. Re-probing afterward is the
 * existing "Check again" retry — nothing here waits for the terminal to
 * close or the login to succeed. `env`, when given, is what scopes the
 * session to a custom instance's own `CLAUDE_CONFIG_DIR`/`CODEX_HOME` rather
 * than the default one.
 */
function openLoginTerminal(terminalName: string, command: string, env?: NodeJS.ProcessEnv): void {
  const terminal = vscode.window.createTerminal({ name: terminalName, ...(env ? { env } : {}) });
  terminal.show();
  terminal.sendText(command);
}
```

- [ ] **Step 4: Update the two command-palette registrations**

Modify the two `registerCommand` calls (lines 451-456) so they go through the same `loginRecipes` table instead of a hardcoded string, keeping them working for the base instances:

```ts
    vscode.commands.registerCommand('marcode.codex.login', () => {
      const recipe = loginRecipes.get('codex');
      if (recipe) { openLoginTerminal(recipe.terminalName, recipe.command, recipe.env); }
    }),
    vscode.commands.registerCommand('marcode.claude.login', () => {
      const recipe = loginRecipes.get('claude');
      if (recipe) { openLoginTerminal(recipe.terminalName, recipe.command, recipe.env); }
    }),
```

- [ ] **Step 5: Add a config-change listener branch for the new setting**

Modify the `vscode.workspace.onDidChangeConfiguration` handler (around lines 467-486) — add, alongside the existing `ENABLED_PROVIDERS_SETTING` branch:

```ts
      if (e.affectsConfiguration(PROVIDER_INSTANCES_SETTING)) {
        const reload = 'Reload window';
        void vscode.window.showInformationMessage(
          'Provider instances changed. Reload the window to apply it.',
          reload,
        ).then((choice) => {
          if (choice !== reload) { return; }
          void vscode.commands.executeCommand('workbench.action.reloadWindow');
        });
      }
```

- [ ] **Step 6: Run type-check and lint**

Run: `yarn check-types && yarn lint`
Expected: PASS

- [ ] **Step 7: Manual smoke check (no automated integration test for `activate()`'s provider construction — see the task header)**

Run: `yarn run compile`, then launch the extension host (`F5` in VS Code, or whatever this repo's existing manual-run convention is — check `CLAUDE.md`/`package.json` scripts for a `run` skill or `launch.json` entry first). Add a `marcode.providerInstances` entry to your own `settings.json` pointing at a real or dummy claude/codex/opencode kind, reload, and confirm: no crash, the extra instance either appears in the roster (if models probe successfully) or in the empty-state's unavailable list (if not) with a Login button matching its `loginKind`.

- [ ] **Step 8: Commit**

```bash
git add src/extension.ts
git commit -m "feat: construct extra provider instances from marcode.providerInstances"
```

---

### Task 12: `package.json` — `marcode.providerInstances` setting schema

**Files:**
- Modify: `package.json` (`contributes.configuration.properties`)

**Interfaces:**
- Consumes: nothing (declarative only).
- Produces: the `marcode.providerInstances` setting VS Code's Settings UI/JSON editor exposes, matching what `validateProviderInstances` (Task 2) accepts.

- [ ] **Step 1: Add the setting**

Modify `package.json`'s `contributes.configuration.properties`, adding a new entry after `marcode.opencode.path`:

```json
"marcode.providerInstances": {
  "type": "array",
  "items": {
    "type": "object",
    "required": ["id", "kind", "displayName"],
    "properties": {
      "id": {
        "type": "string",
        "description": "Unique instance id, distinct from claude/codex/opencode/fake."
      },
      "kind": {
        "type": "string",
        "enum": ["claude", "codex", "opencode"],
        "description": "Which existing backend this instance wraps."
      },
      "displayName": {
        "type": "string",
        "description": "Shown in the roster and model picker in place of the base name."
      },
      "binPath": {
        "type": "string",
        "description": "Override binary/executable path for this instance."
      },
      "envMap": {
        "type": "object",
        "additionalProperties": { "type": "string" },
        "description": "Subprocess env var name -> OS env var name to source its value from. Secrets stay in OS env vars, never in this file."
      }
    },
    "allOf": [
      {
        "if": { "properties": { "kind": { "const": "claude" } } },
        "then": {
          "properties": {
            "envMap": {
              "properties": {
                "ANTHROPIC_API_KEY": { "type": "string" },
                "ANTHROPIC_BASE_URL": { "type": "string" },
                "ANTHROPIC_AUTH_TOKEN": { "type": "string" },
                "CLAUDE_CONFIG_DIR": { "type": "string" }
              }
            }
          }
        }
      },
      {
        "if": { "properties": { "kind": { "const": "codex" } } },
        "then": {
          "properties": {
            "envMap": {
              "properties": {
                "OPENAI_API_KEY": { "type": "string" },
                "CODEX_HOME": { "type": "string" }
              }
            }
          }
        }
      },
      {
        "if": { "properties": { "kind": { "const": "opencode" } } },
        "then": {
          "properties": {
            "envMap": {
              "properties": {
                "OPENCODE_CONFIG": { "type": "string" },
                "OPENCODE_CONFIG_DIR": { "type": "string" },
                "OPENCODE_CONFIG_CONTENT": { "type": "string" }
              }
            }
          }
        }
      }
    ]
  },
  "default": [],
  "scope": "window",
  "markdownDescription": "Extra named instances of an existing provider kind — e.g. a second Claude account, or an OpenCode instance pointed at a different config/provider. Non-secret only; secrets stay in OS env vars referenced by `envMap`. Takes effect after a window reload."
}
```

- [ ] **Step 2: Validate the JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('package.json', 'utf8')); console.log('valid')"`
Expected: prints `valid` (catches a syntax error before VS Code's own package validation does).

- [ ] **Step 3: Run the full check suite**

Run: `yarn lint && yarn check-types && yarn run compile`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "feat: add marcode.providerInstances setting schema"
```

---

## Self-Review Notes

- **Spec coverage:** Data model (Task 2, 12), envMap resolution (Task 2), Claude no-API-key path (Task 4's `pathToClaudeCodeExecutable`/`env`, Task 2's `computeLoginKind`), provider construction (Task 4-6, 11), login/auth-failure UX including codex's key-vs-oauth command split (Task 2's `codexLoginCommand`, Task 11), `loginKind` wire field (Task 3, 7, 8), webview gating (Task 9-10), settings schema/intellisense (Task 12) — all covered. Testing section's unit/DOM/integration split matches Tasks 2, 4-10's test steps and Task 11's manual-smoke note.
- **No generic-ACP-any-binary code was added** anywhere in this plan, matching the spec's Non-goals.
- **Placeholder scan:** no TBD/TODO; every step has real code or an explicit "read the existing helper and match its pattern" instruction where a file's current exact shape could only be confirmed by opening it during execution (test fixture helper names) — never left as an unstated action.
- **Type consistency:** `ProviderInstanceKind`, `ProviderInstanceConfig`, `LoginKind`/`'oauth' | 'none'`, `loginKind`, `resolveEnvMap`, `computeLoginKind`, `claudeLoginCommand`, `codexLoginCommand` are spelled identically across Tasks 2, 3, 4, 5, 7, 8, 9, 11.
