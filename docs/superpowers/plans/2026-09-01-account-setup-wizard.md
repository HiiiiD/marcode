# Account-Setup Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `Marcode: Set up a provider account` command that walks a user through
creating a new `marcode.providerInstances` entry, with an optional step that copies
`skills/` and `plugins/` from the main account's config dir into the new instance's own
(claude and codex only).

**Architecture:** Pure logic (kind→envMap-key tables, source/target dir resolution, id
collision checking) lives in `src/shared/account-setup.ts`, no `vscode` import, unit
tested directly. The filesystem copy is a second small pure-ish module,
`src/host/copy-skills-plugins.ts` (uses `node:fs/promises`, no `vscode`, also unit
tested). The wizard itself, `src/host/account-setup-wizard.ts`, is a thin
`vscode.window.showQuickPick`/`showInputBox` sequence that calls into both and finishes
with a `vscode.workspace.getConfiguration().update(...)` — registered as a command in
`extension.ts` next to the existing `marcode.claude.login`/`marcode.codex.login`
commands. No new webview, no new bundle.

**Tech Stack:** TypeScript, VS Code extension API (`QuickPick`/`InputBox`,
`workspace.getConfiguration`), `node:fs/promises`, mocha (`yarn test:unit`).

**Spec:** [docs/superpowers/specs/2026-09-01-account-setup-wizard-design.md](../specs/2026-09-01-account-setup-wizard-design.md)

## Global Constraints

- Copy step touches only `skills/` and `plugins/` — never `auth.json`/credentials,
  `config.toml`/`settings.json`, `sessions`, or `history`.
- Copy step is offered for `claude` and `codex` kinds only; `opencode` skips it entirely.
- The wizard writes `marcode.providerInstances` at **user** (`Global`) settings scope,
  never workspace.
- The wizard never reads, writes, or displays a secret value — only OS env var *names*.
- No new reload-prompt UI: `extension.ts` already shows "Provider instances changed.
  Reload the window to apply it." on any `PROVIDER_INSTANCES_SETTING` change
  (`src/extension.ts` around its `onDidChangeConfiguration` handler) — the wizard's
  `update()` call triggers that existing listener for free.
- `yarn lint`, `yarn check-types`, and `yarn run compile` must all pass before each
  commit (per `CLAUDE.md`).
- Filenames stay kebab-case.

---

### Task 1: Shared account-setup logic (`src/shared/account-setup.ts`)

**Files:**
- Create: `src/shared/account-setup.ts`
- Create: `src/test/unit/account-setup.test.ts`

**Interfaces:**
- Consumes: `ProviderInstanceConfig`, `ProviderInstanceKind` from
  `src/shared/provider-instances.ts` (already exist — `id`, `kind`, `displayName`,
  `binPath?`, `envMap?` on the config type; kind is `'claude' | 'codex' | 'opencode'`).
- Produces (for Task 3):
  - `CONFIG_DIR_ENV_KEY: Record<'claude' | 'codex', string>` — `{ claude:
    'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' }`.
  - `ENV_MAP_KEYS: Record<ProviderInstanceKind, readonly string[]>`.
  - `supportsSkillsCopy(kind: ProviderInstanceKind): kind is 'claude' | 'codex'`.
  - `defaultConfigDir(kind: 'claude' | 'codex', home: string): string`.
  - `resolveSourceConfigDir(kind: 'claude' | 'codex', osEnv: NodeJS.ProcessEnv, home: string): string`.
  - `isDuplicateInstanceId(id: string, existing: readonly ProviderInstanceConfig[], baseIds: readonly string[]): boolean`.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/test/unit/account-setup.test.ts
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { test, suite } from 'mocha';
import {
  CONFIG_DIR_ENV_KEY, ENV_MAP_KEYS, supportsSkillsCopy, defaultConfigDir,
  resolveSourceConfigDir, isDuplicateInstanceId,
} from '../../shared/account-setup';

suite('shared/account-setup', () => {
  suite('supportsSkillsCopy', () => {
    test('true for claude and codex, false for opencode', () => {
      assert.strictEqual(supportsSkillsCopy('claude'), true);
      assert.strictEqual(supportsSkillsCopy('codex'), true);
      assert.strictEqual(supportsSkillsCopy('opencode'), false);
    });
  });

  suite('defaultConfigDir', () => {
    test('claude defaults to <home>/.claude', () => {
      assert.strictEqual(defaultConfigDir('claude', '/home/marco'), path.join('/home/marco', '.claude'));
    });
    test('codex defaults to <home>/.codex', () => {
      assert.strictEqual(defaultConfigDir('codex', '/home/marco'), path.join('/home/marco', '.codex'));
    });
  });

  suite('resolveSourceConfigDir', () => {
    test('uses the main account\'s own env var when set', () => {
      const dir = resolveSourceConfigDir('claude', { CLAUDE_CONFIG_DIR: '/custom/claude' }, '/home/marco');
      assert.strictEqual(dir, '/custom/claude');
    });
    test('falls back to the platform default when unset', () => {
      const dir = resolveSourceConfigDir('codex', {}, '/home/marco');
      assert.strictEqual(dir, path.join('/home/marco', '.codex'));
    });
    test('falls back when the env var is set but empty', () => {
      const dir = resolveSourceConfigDir('claude', { CLAUDE_CONFIG_DIR: '  ' }, '/home/marco');
      assert.strictEqual(dir, path.join('/home/marco', '.claude'));
    });
  });

  suite('isDuplicateInstanceId', () => {
    test('true when id matches a base kind id', () => {
      assert.strictEqual(isDuplicateInstanceId('claude', [], ['claude', 'codex', 'opencode', 'fake']), true);
    });
    test('true when id matches an existing instance id', () => {
      const existing = [{ id: 'claude-work', kind: 'claude' as const, displayName: 'Work' }];
      assert.strictEqual(isDuplicateInstanceId('claude-work', existing, ['claude']), true);
    });
    test('false for a genuinely new id', () => {
      assert.strictEqual(isDuplicateInstanceId('claude-personal', [], ['claude', 'codex', 'opencode', 'fake']), false);
    });
    test('trims whitespace before comparing', () => {
      assert.strictEqual(isDuplicateInstanceId('  claude  ', [], ['claude']), true);
    });
  });

  suite('ENV_MAP_KEYS / CONFIG_DIR_ENV_KEY', () => {
    test('claude envMap keys match package.json\'s schema list', () => {
      assert.deepStrictEqual(
        ENV_MAP_KEYS.claude,
        ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CONFIG_DIR'],
      );
    });
    test('codex envMap keys match package.json\'s schema list', () => {
      assert.deepStrictEqual(ENV_MAP_KEYS.codex, ['OPENAI_API_KEY', 'CODEX_HOME']);
    });
    test('config-dir env key names', () => {
      assert.deepStrictEqual(CONFIG_DIR_ENV_KEY, { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' });
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test:unit:raw --grep "shared/account-setup"`
Expected: FAIL — `Cannot find module '../../shared/account-setup'`

- [ ] **Step 3: Implement `src/shared/account-setup.ts`**

```typescript
import * as path from 'node:path';

import type { ProviderInstanceConfig, ProviderInstanceKind } from './provider-instances';

/**
 * Only claude and codex have a config-dir `envMap` key whose directory holds
 * a `skills/` and `plugins/` subdirectory in the same shape as one another
 * (verified against both CLIs' own home-dir layouts). Used both to resolve
 * the account-setup wizard's copy-step source/target and to gate that step
 * to these two kinds — opencode's config layout isn't confirmed the same
 * way. See docs/superpowers/specs/2026-09-01-account-setup-wizard-design.md.
 */
export const CONFIG_DIR_ENV_KEY: Record<'claude' | 'codex', string> = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
};

/** The allowed `envMap` subprocess-var keys per kind — mirrors `package.json`'s `marcode.providerInstances` schema. */
export const ENV_MAP_KEYS: Record<ProviderInstanceKind, readonly string[]> = {
  claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CONFIG_DIR'],
  codex: ['OPENAI_API_KEY', 'CODEX_HOME'],
  opencode: ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG_CONTENT'],
};

/** Whether the copy-skills-and-plugins wizard step applies to this kind (see `CONFIG_DIR_ENV_KEY` doc). */
export function supportsSkillsCopy(kind: ProviderInstanceKind): kind is 'claude' | 'codex' {
  return kind === 'claude' || kind === 'codex';
}

/** `<home>/.claude` or `<home>/.codex` — the platform default when the main account never set a config-dir env var. */
export function defaultConfigDir(kind: 'claude' | 'codex', home: string): string {
  return path.join(home, kind === 'claude' ? '.claude' : '.codex');
}

/**
 * Resolves the *source* config dir to copy skills/plugins from: the main
 * account's own config-dir env var if it set one (non-empty), else the
 * platform default. Never the new instance's own env — that is resolved
 * directly from the OS var the wizard is about to write, by the caller.
 */
export function resolveSourceConfigDir(
  kind: 'claude' | 'codex', osEnv: NodeJS.ProcessEnv, home: string,
): string {
  const fromEnv = osEnv[CONFIG_DIR_ENV_KEY[kind]];
  return fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv : defaultConfigDir(kind, home);
}

/** True when `id` (trimmed) would collide with an existing instance id or a base kind id. Mirrors `validateProviderInstances`'s own collision rule. */
export function isDuplicateInstanceId(
  id: string, existing: readonly ProviderInstanceConfig[], baseIds: readonly string[],
): boolean {
  const trimmed = id.trim();
  return baseIds.includes(trimmed) || existing.some((cfg) => cfg.id === trimmed);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test:unit:raw --grep "shared/account-setup"`
Expected: PASS, all assertions green

- [ ] **Step 5: Lint and type-check**

Run: `yarn lint && yarn check-types`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/shared/account-setup.ts src/test/unit/account-setup.test.ts
git commit -m "feat: add shared account-setup logic for provider-instance wizard"
```

---

### Task 2: Skills/plugins copy function (`src/host/copy-skills-plugins.ts`)

**Files:**
- Create: `src/host/copy-skills-plugins.ts`
- Create: `src/test/unit/copy-skills-plugins.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 — this module is self-contained (`node:fs/promises`,
  `node:path` only).
- Produces (for Task 3):
  - `interface CopySkillsAndPluginsResult { copied: string[] }`
  - `copySkillsAndPlugins(sourceDir: string, targetDir: string): Promise<CopySkillsAndPluginsResult>`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/test/unit/copy-skills-plugins.test.ts
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, suite } from 'mocha';
import { copySkillsAndPlugins } from '../../host/copy-skills-plugins';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'marcode-copy-test-'));
}

suite('host/copy-skills-plugins', () => {
  test('copies skills/ and plugins/ into an empty target', async () => {
    const source = await makeTempDir();
    const target = await makeTempDir();
    await fs.mkdir(path.join(source, 'skills', 'my-skill'), { recursive: true });
    await fs.writeFile(path.join(source, 'skills', 'my-skill', 'SKILL.md'), '# hi');
    await fs.mkdir(path.join(source, 'plugins'), { recursive: true });
    await fs.writeFile(path.join(source, 'plugins', 'marketplace.json'), '{}');

    const result = await copySkillsAndPlugins(source, target);

    assert.deepStrictEqual(result.copied.sort(), ['plugins', 'skills']);
    assert.strictEqual(
      await fs.readFile(path.join(target, 'skills', 'my-skill', 'SKILL.md'), 'utf8'),
      '# hi',
    );
    assert.strictEqual(
      await fs.readFile(path.join(target, 'plugins', 'marketplace.json'), 'utf8'),
      '{}',
    );
  });

  test('skips a subdirectory that does not exist at the source', async () => {
    const source = await makeTempDir();
    const target = await makeTempDir();
    await fs.mkdir(path.join(source, 'skills'), { recursive: true });

    const result = await copySkillsAndPlugins(source, target);

    assert.deepStrictEqual(result.copied, ['skills']);
    await assert.rejects(fs.access(path.join(target, 'plugins')));
  });

  test('never touches sibling files outside skills/plugins', async () => {
    const source = await makeTempDir();
    const target = await makeTempDir();
    await fs.mkdir(path.join(source, 'skills'), { recursive: true });
    await fs.writeFile(path.join(source, 'auth.json'), '{"secret":true}');

    await copySkillsAndPlugins(source, target);

    await assert.rejects(fs.access(path.join(target, 'auth.json')));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test:unit:raw --grep "host/copy-skills-plugins"`
Expected: FAIL — `Cannot find module '../../host/copy-skills-plugins'`

- [ ] **Step 3: Implement `src/host/copy-skills-plugins.ts`**

```typescript
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const COPIED_SUBDIRS = ['skills', 'plugins'] as const;

export interface CopySkillsAndPluginsResult {
  copied: string[];
}

/**
 * Copies `skills/` and `plugins/` (only) from `sourceDir` into `targetDir`,
 * recursively, skipping either subdirectory when it doesn't exist at the
 * source. Never touches anything else under either directory — no
 * auth.json/credentials, config.toml/settings.json, sessions, or history.
 * `targetDir` is expected to be a fresh/empty instance config dir, so there
 * is no merge case: whatever lands there is exactly what got copied.
 * See docs/superpowers/specs/2026-09-01-account-setup-wizard-design.md.
 */
export async function copySkillsAndPlugins(
  sourceDir: string, targetDir: string,
): Promise<CopySkillsAndPluginsResult> {
  const copied: string[] = [];
  for (const sub of COPIED_SUBDIRS) {
    const from = path.join(sourceDir, sub);
    let exists = true;
    try {
      await fs.access(from);
    } catch {
      exists = false;
    }
    if (!exists) { continue; }
    await fs.cp(from, path.join(targetDir, sub), { recursive: true });
    copied.push(sub);
  }
  return { copied };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test:unit:raw --grep "host/copy-skills-plugins"`
Expected: PASS, all assertions green

- [ ] **Step 5: Lint and type-check**

Run: `yarn lint && yarn check-types`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/host/copy-skills-plugins.ts src/test/unit/copy-skills-plugins.test.ts
git commit -m "feat: add skills/plugins copy function for account-setup wizard"
```

---

### Task 3: Wizard command (`src/host/account-setup-wizard.ts`) + registration

**Files:**
- Create: `src/host/account-setup-wizard.ts`
- Modify: `src/extension.ts` (add import + `registerCommand('marcode.accountSetup.wizard', ...)` next to the existing `marcode.codex.login`/`marcode.claude.login` registrations, around line 518-524)
- Modify: `package.json` (add a `commands` entry, in the `"commands"` array around line 192-208)

**Interfaces:**
- Consumes:
  - From Task 1: `CONFIG_DIR_ENV_KEY`, `ENV_MAP_KEYS`, `supportsSkillsCopy`,
    `resolveSourceConfigDir`, `isDuplicateInstanceId` (`src/shared/account-setup.ts`).
  - From Task 2: `copySkillsAndPlugins` (`src/host/copy-skills-plugins.ts`).
  - From existing code: `validateProviderInstances` and `ProviderInstanceConfig`,
    `PROVIDER_INSTANCE_KINDS` (`src/shared/provider-instances.ts`);
    `PROVIDER_INSTANCES_SETTING` (`src/shared/settings.ts`); `KNOWN_PROVIDER_IDS`
    (`src/shared/settings.ts`, already imported into `extension.ts`).
- Produces: `runAccountSetupWizard(baseIds: readonly string[]): Promise<void>`, called
  from the new command registration in `extension.ts`.

This task's orchestration code drives real VS Code UI (`QuickPick`/`InputBox`) and is
not unit-testable outside the extension host — no existing sign-in command
(`marcode.claude.login`, `marcode.codex.login`) has a unit or integration test either.
Verification is a manual run through the Extension Development Host (`F5`), listed as
the step's test.

- [ ] **Step 1: Implement `src/host/account-setup-wizard.ts`**

```typescript
import * as os from 'node:os';
import * as vscode from 'vscode';

import {
  CONFIG_DIR_ENV_KEY, ENV_MAP_KEYS, isDuplicateInstanceId, resolveSourceConfigDir,
  supportsSkillsCopy,
} from '../shared/account-setup';
import {
  PROVIDER_INSTANCE_KINDS, validateProviderInstances,
  type ProviderInstanceConfig, type ProviderInstanceKind,
} from '../shared/provider-instances';
import { PROVIDER_INSTANCES_SETTING } from '../shared/settings';
import { copySkillsAndPlugins } from './copy-skills-plugins';

/**
 * `Marcode: Set up a provider account` — a guided QuickPick/InputBox
 * sequence that appends one entry to `marcode.providerInstances` (user
 * settings) and, for claude/codex, offers to copy the main account's
 * skills/plugins into the new instance's own config dir. Any step the user
 * cancels (Esc) aborts the whole wizard with no write. See
 * docs/superpowers/specs/2026-09-01-account-setup-wizard-design.md.
 */
export async function runAccountSetupWizard(baseIds: readonly string[]): Promise<void> {
  const kind = await vscode.window.showQuickPick(
    [...PROVIDER_INSTANCE_KINDS],
    { title: 'Set up a provider account (1/5): kind', placeHolder: 'Which backend is this instance?' },
  ) as ProviderInstanceKind | undefined;
  if (kind === undefined) { return; }

  const config = vscode.workspace.getConfiguration();
  const { valid: existing } = validateProviderInstances(
    config.get<unknown>(PROVIDER_INSTANCES_SETTING), baseIds,
  );

  const id = await vscode.window.showInputBox({
    title: 'Set up a provider account (2/5): id',
    prompt: 'Unique instance id, e.g. claude-personal',
    validateInput: (value) => {
      if (value.trim() === '') { return 'id is required'; }
      if (isDuplicateInstanceId(value, existing, baseIds)) { return `"${value.trim()}" is already in use`; }
      return undefined;
    },
  });
  if (id === undefined) { return; }

  const displayName = await vscode.window.showInputBox({
    title: 'Set up a provider account (3/5): display name',
    prompt: 'Shown in the roster and model picker in place of the base name',
    validateInput: (value) => (value.trim() === '' ? 'displayName is required' : undefined),
  });
  if (displayName === undefined) { return; }

  const selectedKeys = await vscode.window.showQuickPick(
    ENV_MAP_KEYS[kind].map((key) => ({ label: key })),
    {
      title: 'Set up a provider account (4/5): env vars',
      placeHolder: 'Which subprocess env vars does this instance set? (space to select, can be none)',
      canPickMany: true,
    },
  );
  if (selectedKeys === undefined) { return; }

  const envMap: Record<string, string> = {};
  for (const { label: key } of selectedKeys) {
    const osVarName = await vscode.window.showInputBox({
      title: `Set up a provider account (5/5): OS env var for ${key}`,
      prompt: `Name of the OS environment variable that holds ${key}'s value (not the value itself)`,
      validateInput: (value) => (value.trim() === '' ? 'required' : undefined),
    });
    if (osVarName === undefined) { return; }
    envMap[key] = osVarName.trim();
  }

  if (supportsSkillsCopy(kind)) {
    await maybeCopySkillsAndPlugins(kind, envMap);
  }

  const osVarNames = [...new Set(Object.values(envMap))];
  if (osVarNames.length > 0) {
    const loginCmd = kind === 'claude' ? 'claude login' : kind === 'codex' ? 'codex login' : undefined;
    void vscode.window.showInformationMessage(
      `Next: run ${osVarNames.map((v) => `\`setx ${v} "..."\``).join(' and ')} in a shell, restart VS Code`
      + (loginCmd ? `, then sign in once with \`${loginCmd}\` in a shell that has ${osVarNames.join(', ')} set.` : '.'),
    );
  }

  const newEntry: ProviderInstanceConfig = {
    id: id.trim(),
    kind,
    displayName: displayName.trim(),
    ...(Object.keys(envMap).length > 0 ? { envMap } : {}),
  };
  try {
    await config.update(
      PROVIDER_INSTANCES_SETTING, [...existing, newEntry], vscode.ConfigurationTarget.Global,
    );
    // extension.ts's existing onDidChangeConfiguration listener for
    // PROVIDER_INSTANCES_SETTING shows its own "Reload the window to apply
    // it." prompt in response to this update() — no second prompt here.
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Could not save the new provider instance: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Offers and, if accepted, performs the skills/plugins copy. Warns (never
 * throws) on any failure, including the common case where the OS env var
 * for this instance's config dir isn't set in this VS Code process yet —
 * `setx` only takes effect for shells/processes started after it runs, so a
 * brand new instance's config-dir var is normally still unset here.
 */
async function maybeCopySkillsAndPlugins(
  kind: 'claude' | 'codex', envMap: Record<string, string>,
): Promise<void> {
  const configDirOsVar = envMap[CONFIG_DIR_ENV_KEY[kind]];
  if (configDirOsVar === undefined) { return; }

  const choice = await vscode.window.showQuickPick(['Yes', 'No'], {
    title: 'Copy skills/plugins from your main account?',
    placeHolder: `Copies skills/ and plugins/ into this instance's ${CONFIG_DIR_ENV_KEY[kind]}`,
  });
  if (choice !== 'Yes') { return; }

  const targetDir = process.env[configDirOsVar];
  if (targetDir === undefined || targetDir.trim() === '') {
    void vscode.window.showWarningMessage(
      `Skipped copying skills/plugins: ${configDirOsVar} isn't set in this VS Code session yet. `
      + 'Set it, restart VS Code, then re-run this wizard or copy the files manually.',
    );
    return;
  }

  const sourceDir = resolveSourceConfigDir(kind, process.env, os.homedir());
  try {
    const { copied } = await copySkillsAndPlugins(sourceDir, targetDir);
    void vscode.window.showInformationMessage(
      copied.length > 0
        ? `Copied ${copied.join(', ')} from ${sourceDir} to ${targetDir}.`
        : `Nothing to copy: ${sourceDir} has no skills/ or plugins/ directory.`,
    );
  } catch (err) {
    void vscode.window.showWarningMessage(
      `Could not copy skills/plugins from ${sourceDir}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
```

- [ ] **Step 2: Register the command in `extension.ts`**

Add the import near the other `./host/*` imports (alongside `SessionManager`, etc.):

```typescript
import { runAccountSetupWizard } from './host/account-setup-wizard';
```

Add the command registration to the `context.subscriptions.push(...)` call, next to
`marcode.codex.login`/`marcode.claude.login` (around line 518-524 of
`src/extension.ts`):

```typescript
    vscode.commands.registerCommand('marcode.accountSetup.wizard', () => {
      void runAccountSetupWizard(KNOWN_PROVIDER_IDS);
    }),
```

`KNOWN_PROVIDER_IDS` is already imported into `extension.ts` from `./shared/settings`
(used for the existing `validateProviderInstances` call around line 326) — no new
import needed for it.

- [ ] **Step 3: Add the command contribution to `package.json`**

In the `"commands"` array (around line 192-208), add:

```jsonc
      {
        "command": "marcode.accountSetup.wizard",
        "title": "Marcode: Set up a provider account"
      },
```

- [ ] **Step 4: Type-check and lint**

Run: `yarn check-types && yarn lint`
Expected: no errors

- [ ] **Step 5: Manual verification via Extension Development Host**

Run: press `F5` (or `yarn watch` + `F5` if not already running).

In the dev host window:
1. Open Command Palette, run **Marcode: Set up a provider account**.
2. Pick `claude`, enter an id (`claude-test`), a display name (`Claude (test)`), select
   `CLAUDE_CONFIG_DIR` as the only env var, and enter an OS var name
   (`CLAUDE_CONFIG_DIR_TEST`).
3. Confirm **Yes** on the skills/plugins copy prompt.
4. Expected: a warning that `CLAUDE_CONFIG_DIR_TEST` isn't set yet (since it wasn't
   `setx`'d before launching the dev host) — confirms the "not yet set" path from Step 1
   works rather than silently no-oping.
5. Expected: an information message with the `setx`/login instructions.
6. Expected: the existing "Provider instances changed. Reload the window to apply it."
   prompt appears (from the pre-existing `onDidChangeConfiguration` listener).
7. Open the dev host's user `settings.json` and confirm `marcode.providerInstances` now
   contains the `claude-test` entry with the expected shape.
8. Re-run the wizard, enter `claude-test` again as the id: expect the InputBox to reject
   it with "already in use" and not let the step proceed — confirms the collision check
   from Task 1 is wired through.
9. Undo the settings.json change (remove the test entry) before moving on, so the dev
   host's real settings stay clean.

Expected overall: no exceptions in the Debug Console; all of the above observed.

- [ ] **Step 6: Commit**

```bash
git add src/host/account-setup-wizard.ts src/extension.ts package.json
git commit -m "feat: add guided account-setup wizard command"
```

---

## Self-Review Notes

- **Spec coverage:** command steps 1-8 of the spec → Task 3's wizard function 1:1 (kind,
  identity, envMap keys, OS var names, copy step gated to claude/codex, setx/login
  reminder, user-scope write). Reload prompt requirement satisfied by the pre-existing
  listener (verified in exploration, not assumed) rather than new code — matches the
  spec's step 8 intent without duplicating UI. Error handling section → copy-step
  warnings in Task 3 Step 1's `maybeCopySkillsAndPlugins`, settings-write failure left to
  VS Code's own `update()` rejection surfacing as an unhandled rejection is **not**
  covered by wrapping the write in try/catch (now included directly in Task 3 Step 1's
  code, surfacing `showErrorMessage` on failure per the spec's error-handling section).
  Testing section → Tasks 1 and 2 cover the two pure modules; Task 3's manual
  verification covers the orchestration, matching the spec's "matching however the
  existing sign-in commands are (or aren't) covered today."
- **Type consistency:** `ProviderInstanceConfig`/`ProviderInstanceKind` used identically
  across Tasks 1 and 3 (same import path, same field names as the existing
  `src/shared/provider-instances.ts`). `CopySkillsAndPluginsResult`/`copySkillsAndPlugins`
  signature matches between Task 2's definition and Task 3's call site
  (`copySkillsAndPlugins(sourceDir, targetDir): Promise<{ copied: string[] }>`).
- **Placeholder scan:** none found — every step has real code or a concrete manual-test
  script.
