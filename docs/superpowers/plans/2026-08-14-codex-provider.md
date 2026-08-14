# Codex Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Codex as a second real `AgentProvider`, backed by the Codex CLI's `app-server` JSON-RPC service, with interactive tool approvals answered from the panel.

**Architecture:** One lazily-spawned `codex app-server` child process for the whole extension, multiplexing threads by `threadId`. A new adapter under `src/providers/codex/` implements `AgentProvider` / `AgentRun`. The only host-side change is that `PermissionMode` — still a closed union — becomes a per-provider *declared subset*, mirroring how per-model effort levels already work.

**Tech Stack:** TypeScript, Node 22, `child_process` + line-framed JSON-RPC over stdio (no new npm dependencies), mocha for unit tests, mocha + jsdom for DOM tests.

**Spec:** [docs/superpowers/specs/2026-08-14-codex-provider-design.md](../specs/2026-08-14-codex-provider-design.md)

## Global Constraints

- **Nothing under `src/providers/` or `src/protocol/` imports `vscode`.** Same for `src/host/message-router.ts`.
- **`src/protocol/messages.ts` is types-only.** No runtime code.
- **Errors are state, never exceptions.** A failing provider puts a session into `error` with a transcript item. Nothing rejects across `postMessage`.
- **Filenames are kebab-case**, including React components. Component *identifiers* stay PascalCase.
- **Never pass a DOM node to an assertion.** Compare a boolean, a string, or a count. A node-valued `assert` allocated 3.5GB in 4 seconds on 2026-08-14.
- **DOM tests drive components through the real `StoreProvider`** via `sendFromHost`; never mock `useStore` or hand-build a `ClientState`.
- **Usage and context surfaces show percentages, never token counts.**
- **UI:** shadcn components only, no raw HTML controls. Compose classNames with `cn` from `@/lib/utils`, never template literals.
- **No new npm dependencies.** The adapter spawns the CLI and speaks JSON-RPC itself.
- **Verified against `codex-cli 0.147.0`.** Regenerate bindings with `codex app-server generate-ts --out <dir>` to re-check any protocol claim.
- `yarn lint`, `yarn check-types` and `yarn run compile` must all pass before a commit.
- Conventional-commit prefixes: `feat:`, `fix:`, `test:`, `chore:`, `docs:`. Commit after every task.
- **Any task touching `src/webview/components/` must finish with** `node <impeccable-skill-dir>/scripts/detect.mjs --json <changed files>`. Exit 0 is clean; exit 2 is a failing check, not a suggestion.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `src/shared/permission-catalog.ts` | `resolvePermissionMode` — the effort-resolution counterpart for modes |
| `src/providers/codex/wire.ts` | Hand-written types for the ~25 protocol members we consume |
| `src/providers/codex/map-settings.ts` | `PermissionMode` → Codex's three axes; effort mapping; `CODEX_MODES` |
| `src/providers/codex/app-server.ts` | Child process, line-framed JSON-RPC, correlation, dispatch by `threadId` |
| `src/providers/codex/map-events.ts` | `ServerNotification` / `ServerRequest` → `AgentEvent` |
| `src/providers/codex/map-usage.ts` | `RateLimitSnapshot` → `UsageWindow[]`; `ThreadTokenUsage` → `ContextBreakdown` |
| `src/providers/codex/codex-run.ts` | `AgentRun` over one thread |
| `src/providers/codex/codex-provider.ts` | `AgentProvider`; owns the shared connection |
| `src/test/unit/permission-catalog.test.ts` | Mode resolution |
| `src/test/unit/codex-map-settings.test.ts` | The five-mode table, effort mapping |
| `src/test/unit/codex-app-server.test.ts` | Framing, correlation, crash |
| `src/test/unit/codex-map-events.test.ts` | Notification → event |
| `src/test/unit/codex-map-usage.test.ts` | Windows and context |
| `src/test/unit/codex-provider.test.ts` | Availability, models, run wiring |
| `src/test/unit/codex-smoke.test.ts` | Opt-in real-binary smoke + skew check |
| `src/test/dom/mode-menu-declared.test.tsx` | Declared-subset rendering |

**Modified:**

| File | Change |
|---|---|
| `src/providers/types.ts` | `PermissionModeInfo`, `AgentProvider.listPermissionModes()`, `EffortLevel` gains `'ultra'` |
| `src/protocol/messages.ts` | Re-export `PermissionModeInfo`; `ProviderInfo.permissionModes` |
| `src/host/session-manager.ts` | Carry `permissionModes` into `catalog()` |
| `src/providers/claude/claude-provider.ts` | Declare all six modes |
| `src/providers/fake/fake-provider.ts` | Declare all six modes |
| `src/webview/components/permission-modes.ts` | `modesFor(provider)` filter + description override |
| `src/webview/components/mode-menu.tsx` | Iterate declared modes |
| `src/webview/components/session-create-dialog.tsx` | Iterate declared modes |
| `src/webview/components/tool-render.ts` | Codex tool arm |
| `src/extension.ts` | Register `CodexProvider` |
| `package.json` | `hiiiidCode.codex.path` setting, `hiiiidCode.codex.login` command, `codex:bindings` script |

**Availability needs no new mechanism** — `refreshModels` already doubles as the probe, `UnavailableProvider` already rides the wire, and `ModeMenu` already takes a `disabled` prop for it. Task 8 only has to reject `fetchModels` with a good message.

---

### Task 1: Declared permission modes — the host seam

**Files:**
- Modify: `src/providers/types.ts`
- Modify: `src/protocol/messages.ts`
- Modify: `src/host/session-manager.ts:113-118` (`catalog()`)
- Modify: `src/providers/fake/fake-provider.ts`
- Modify: `src/providers/claude/claude-provider.ts`
- Create: `src/shared/permission-catalog.ts`
- Test: `src/test/unit/permission-catalog.test.ts`

**Interfaces:**
- Produces: `PermissionModeInfo { id: PermissionMode; description?: string }`; `AgentProvider.listPermissionModes(): PermissionModeInfo[]`; `ProviderInfo.permissionModes: PermissionModeInfo[]`; `resolvePermissionMode(modes: PermissionModeInfo[], requested: PermissionMode | undefined): PermissionMode`

- [ ] **Step 1: Write the failing test**

Create `src/test/unit/permission-catalog.test.ts`:

```ts
import * as assert from 'assert';
import type { PermissionModeInfo } from '../../providers/types';
import { resolvePermissionMode } from '../../shared/permission-catalog';

const CODEX: PermissionModeInfo[] = [
  { id: 'default' }, { id: 'auto' }, { id: 'plan' }, { id: 'dontAsk' }, { id: 'bypass' },
];

suite('resolvePermissionMode', () => {
  test('keeps a mode the provider offers', () => {
    assert.strictEqual(resolvePermissionMode(CODEX, 'plan'), 'plan');
  });

  test('falls back to default for a mode the provider does not offer', () => {
    // Codex omits acceptEdits: under workspace-write it would be a second
    // name for 'default'.
    assert.strictEqual(resolvePermissionMode(CODEX, 'acceptEdits'), 'default');
  });

  test('never resolves upward into bypass', () => {
    // bypass is settable only at creation. A persisted session whose mode
    // vanished must not be silently promoted into the one mode that runs
    // anything without asking.
    const noDefault: PermissionModeInfo[] = [{ id: 'bypass' }];
    assert.strictEqual(resolvePermissionMode(noDefault, 'acceptEdits'), 'default');
  });

  test('an empty list is no opinion, not a veto', () => {
    // The catalog has not loaded yet; wiping a real choice would be worse
    // than honoring one we cannot yet verify.
    assert.strictEqual(resolvePermissionMode([], 'plan'), 'plan');
  });

  test('an absent request resolves to default', () => {
    assert.strictEqual(resolvePermissionMode(CODEX, undefined), 'default');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:unit --grep "resolvePermissionMode"`
Expected: FAIL — cannot find module `../../shared/permission-catalog`

- [ ] **Step 3: Add the type and the provider method**

In `src/providers/types.ts`, after the `PermissionMode` union:

```ts
/**
 * One permission mode a provider actually offers.
 *
 * `PermissionMode` stays a closed union — this is the `EffortLevel`
 * precedent, where the union is fixed and each model publishes the subset it
 * takes. A provider that cannot honor a mode must not offer it: Codex under
 * `workspace-write` never raises an approval for an in-workspace edit, so a
 * Codex `acceptEdits` would be a second name for `default`.
 */
export interface PermissionModeInfo {
  id: PermissionMode;
  /**
   * Provider-specific one-liner, overriding the shared description in the
   * picker. The same id enforces differently per provider, so the id alone is
   * not always enough for the user to choose safely.
   */
  description?: string;
}
```

In the `AgentProvider` interface:

```ts
  /**
   * The modes this provider can actually honor.
   *
   * Sync, like `listModels`: session creation and the roster read it inline.
   * MUST include 'default' — creation falls back to it in message-router,
   * and `resolvePermissionMode` resolves to it.
   */
  listPermissionModes(): PermissionModeInfo[];
```

- [ ] **Step 4: Write the resolver**

Create `src/shared/permission-catalog.ts`:

```ts
import type { PermissionMode, PermissionModeInfo } from '../providers/types';

/**
 * The permission mode a session should actually run in, given what it was
 * asking for.
 *
 * The counterpart to `resolveEffort`, and it shares that function's two
 * rules. A mode is a property of the provider, not of the session: a session
 * persisted under one provider's mode set — or under an older build that
 * offered more — must not keep asking for something the backend cannot do.
 * And an absent list is no opinion rather than a veto: the catalog may not
 * have loaded, and wiping a real choice is worse than honoring one we cannot
 * yet verify.
 *
 * The fallback is always 'default', never the requested-but-unavailable mode
 * and never 'bypass'. Bypass is settable only before a session's first
 * message; resolving *into* it would hand a session the one mode that runs
 * anything without asking, through a code path the user never touched.
 */
export function resolvePermissionMode(
  modes: PermissionModeInfo[], requested: PermissionMode | undefined,
): PermissionMode {
  if (modes.length === 0) { return requested ?? 'default'; }
  return requested && modes.some((m) => m.id === requested) ? requested : 'default';
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `yarn test:unit --grep "resolvePermissionMode"`
Expected: PASS (5 passing)

- [ ] **Step 6: Implement the method on both existing providers**

In `src/providers/fake/fake-provider.ts`, next to `listModels()`:

```ts
  /** Every mode, so existing tests keep exercising the full picker. */
  listPermissionModes(): PermissionModeInfo[] {
    return [
      { id: 'default' }, { id: 'acceptEdits' }, { id: 'auto' },
      { id: 'plan' }, { id: 'dontAsk' }, { id: 'bypass' },
    ];
  }
```

Add `PermissionModeInfo` to the type import at the top of that file.

In `src/providers/claude/claude-provider.ts`, next to `listModels()`, add the identical method with this comment:

```ts
  /**
   * All six. The union was drawn from Claude's own mode set, so this provider
   * is the one case where declaring a subset would be declaring nothing.
   */
  listPermissionModes(): PermissionModeInfo[] {
    return [
      { id: 'default' }, { id: 'acceptEdits' }, { id: 'auto' },
      { id: 'plan' }, { id: 'dontAsk' }, { id: 'bypass' },
    ];
  }
```

- [ ] **Step 7: Put it on the wire**

In `src/protocol/messages.ts`, add `PermissionModeInfo` to both the import and the re-export lists at the top, then extend `ProviderInfo`:

```ts
export interface ProviderInfo {
  id: string;
  displayName: string;
  models: ModelInfo[];
  /**
   * The modes this provider offers. Rides the existing `hydrate` and
   * `catalog` messages because it lives on `ProviderInfo` — a mode set that
   * arrived out of step with the catalog it belongs to would let the picker
   * offer one provider's modes for another's session.
   */
  permissionModes: PermissionModeInfo[];
}
```

In `src/host/session-manager.ts`, `catalog()`:

```ts
  catalog(): ProviderInfo[] {
    return [...this.providers.values()]
      .map((p) => ({
        id: p.id,
        displayName: p.displayName,
        models: this.modelsFor(p),
        permissionModes: p.listPermissionModes(),
      }))
      .filter((p) => p.models.length > 0);
  }
```

- [ ] **Step 8: Verify the whole suite still passes**

Run: `yarn check-types && yarn test:unit`
Expected: PASS. Any test constructing a `ProviderInfo` literal now needs `permissionModes: []` — fix those inline; an empty list is the "no opinion" case the resolver already handles.

- [ ] **Step 9: Commit**

```bash
git add src/providers/types.ts src/protocol/messages.ts src/host/session-manager.ts \
        src/providers/fake/fake-provider.ts src/providers/claude/claude-provider.ts \
        src/shared/permission-catalog.ts src/test/unit/permission-catalog.test.ts
git commit -m "feat: let a provider declare the permission modes it offers"
```

---

### Task 2: The picker renders the declared subset

**Files:**
- Modify: `src/webview/components/permission-modes.ts`
- Modify: `src/webview/components/mode-menu.tsx:104` (the `MODES.map`)
- Modify: `src/webview/components/session-create-dialog.tsx:150`
- Test: `src/test/dom/mode-menu-declared.test.tsx`

**Interfaces:**
- Consumes: `ProviderInfo.permissionModes` (Task 1)
- Produces: `modesFor(declared: PermissionModeInfo[] | undefined): ModeRow[]` from `permission-modes.ts`, where `ModeRow` is the existing row shape (`{ value, label, description, icon }`)

- [ ] **Step 1: Write the failing test**

Create `src/test/dom/mode-menu-declared.test.tsx`. Follow the existing pattern in `src/test/dom/session-picker.test.tsx` for boot and `sendFromHost`; the assertions that matter:

```tsx
test('a provider that omits acceptEdits does not offer it', async () => {
  await bootWithProvider({
    id: 'codex', displayName: 'Codex',
    models: [{ id: 'gpt-5-codex', displayName: 'GPT-5 Codex' }],
    permissionModes: [
      { id: 'default' }, { id: 'auto' }, { id: 'plan' },
      { id: 'dontAsk' }, { id: 'bypass' },
    ],
  });
  await openModeMenu();
  // Booleans and strings only — never hand a node to assert.
  assert.strictEqual(screen.queryByRole('menuitemradio', { name: /Auto-edit/ }) === null, true);
  assert.strictEqual(screen.queryByRole('menuitemradio', { name: /Plan/ }) === null, false);
});

test('a provider description overrides the shared one', async () => {
  await bootWithProvider({
    id: 'codex', displayName: 'Codex',
    models: [{ id: 'gpt-5-codex', displayName: 'GPT-5 Codex' }],
    permissionModes: [
      { id: 'default', description: 'Codex asks before it leaves the workspace.' },
    ],
  });
  await openModeMenu();
  assert.strictEqual(
    screen.getByText('Codex asks before it leaves the workspace.').textContent,
    'Codex asks before it leaves the workspace.',
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:dom --grep "declared"`
Expected: FAIL — `Auto-edit` is still rendered, because `MODES.map` ignores the provider.

- [ ] **Step 3: Add the filter**

In `src/webview/components/permission-modes.ts`, below `MODE_OF`:

```ts
export type ModeRow = (typeof MODES)[number];

/**
 * The rows to offer for one provider, in the shared order.
 *
 * Order comes from `MODES`, not from the provider: the list reads as a
 * severity ramp from "ask about everything" to "ask about nothing", and a
 * provider returning its modes in some other order would scramble that for
 * its sessions only.
 *
 * An undefined or empty list means the catalog has not loaded yet — the same
 * "no opinion" case `resolvePermissionMode` handles — so every row is shown
 * rather than none. A picker that renders empty while a probe is in flight
 * looks broken in exactly the moment the user is trying to start work.
 */
export function modesFor(declared: PermissionModeInfo[] | undefined): ModeRow[] {
  if (!declared || declared.length === 0) { return MODES; }
  const byId = new Map(declared.map((d) => [d.id, d]));
  return MODES
    .filter((m) => byId.has(m.value))
    .map((m) => {
      const description = byId.get(m.value)?.description;
      return description ? { ...m, description } : m;
    });
}
```

Add `import type { PermissionMode, PermissionModeInfo } from "../../protocol/messages";` at the top.

- [ ] **Step 4: Consume it in both pickers**

In `src/webview/components/mode-menu.tsx`, replace `MODES.map((m) => {` with a `rows` computed from the session's provider. The provider row comes from the store's catalog:

```tsx
  const { post, state } = useStore();
  const provider = state.catalog.find((p) => p.id === pane.summary.providerId);
  const rows = modesFor(provider?.permissionModes);
```

then `rows.map((m) => {`. Update the import to `import { MODE_OF, modesFor } from "./permission-modes";`.

Apply the same substitution in `src/webview/components/session-create-dialog.tsx`, where the provider is the one selected in the dialog rather than the pane's.

- [ ] **Step 5: Run tests to verify they pass**

Run: `yarn test:dom`
Expected: PASS, including the pre-existing mode-menu and create-dialog specs.

- [ ] **Step 6: Run the UI detector**

Run: `node <impeccable-skill-dir>/scripts/detect.mjs --json src/webview/components/mode-menu.tsx src/webview/components/session-create-dialog.tsx src/webview/components/permission-modes.ts`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/webview/components/permission-modes.ts src/webview/components/mode-menu.tsx \
        src/webview/components/session-create-dialog.tsx src/test/dom/mode-menu-declared.test.tsx
git commit -m "feat: offer only the permission modes a session's provider declares"
```

---

### Task 3: Wire types and settings mapping

**Files:**
- Create: `src/providers/codex/wire.ts`
- Create: `src/providers/codex/map-settings.ts`
- Modify: `src/providers/types.ts` (`EffortLevel` gains `'ultra'`)
- Test: `src/test/unit/codex-map-settings.test.ts`

**Interfaces:**
- Produces: `CodexThreadSettings { approvalPolicy: AskForApproval; sandbox: SandboxMode; approvalsReviewer: ApprovalsReviewer }`; `codexSettings(mode: PermissionMode): CodexThreadSettings`; `sandboxPolicyOf(mode: PermissionMode): SandboxPolicy`; `CODEX_MODES: PermissionModeInfo[]`; `effortLevelsOf(model: CodexModel): ModelInfo['effort']`; `EffortLevel` widened by one member

- [ ] **Step 1: Write the failing test**

Create `src/test/unit/codex-map-settings.test.ts`:

```ts
import * as assert from 'assert';
import { CODEX_MODES, codexSettings, effortLevelsOf, sandboxPolicyOf } from '../../providers/codex/map-settings';

suite('codexSettings', () => {
  test('default asks the user, sandboxed to the workspace', () => {
    assert.deepStrictEqual(codexSettings('default'), {
      approvalPolicy: 'on-request', sandbox: 'workspace-write', approvalsReviewer: 'user',
    });
  });

  test('auto differs from default only in who answers', () => {
    // "Approve for me": approvalPolicy decides whether an approval is raised,
    // approvalsReviewer decides who answers it. This is the whole feature.
    assert.deepStrictEqual(codexSettings('auto'), {
      approvalPolicy: 'on-request', sandbox: 'workspace-write', approvalsReviewer: 'auto_review',
    });
  });

  test('plan cannot write and never prompts', () => {
    assert.deepStrictEqual(codexSettings('plan'), {
      approvalPolicy: 'never', sandbox: 'read-only', approvalsReviewer: 'user',
    });
  });

  test('dontAsk refuses without prompting', () => {
    assert.deepStrictEqual(codexSettings('dontAsk'), {
      approvalPolicy: 'never', sandbox: 'workspace-write', approvalsReviewer: 'user',
    });
  });

  test('bypass is the only mode that leaves the sandbox', () => {
    assert.deepStrictEqual(codexSettings('bypass'), {
      approvalPolicy: 'never', sandbox: 'danger-full-access', approvalsReviewer: 'user',
    });
  });

  test('acceptEdits falls back rather than aliasing default', () => {
    // Not offered, so it should never be asked for; if it is, landing on
    // default is the honest answer.
    assert.strictEqual(codexSettings('acceptEdits').sandbox, 'workspace-write');
  });
});

suite('CODEX_MODES', () => {
  test('offers five modes and omits acceptEdits', () => {
    assert.deepStrictEqual(CODEX_MODES.map((m) => m.id),
      ['default', 'auto', 'plan', 'dontAsk', 'bypass']);
  });

  test('includes default, which resolution depends on', () => {
    assert.strictEqual(CODEX_MODES.some((m) => m.id === 'default'), true);
  });
});

suite('sandboxPolicyOf', () => {
  test('builds the struct form a turn override needs', () => {
    // thread/start takes the bare SandboxMode enum; turn/start takes the
    // SandboxPolicy struct. Same mode, two spellings.
    assert.deepStrictEqual(sandboxPolicyOf('plan'), { type: 'readOnly', networkAccess: false });
    assert.deepStrictEqual(sandboxPolicyOf('bypass'), { type: 'dangerFullAccess' });
    assert.deepStrictEqual(sandboxPolicyOf('default'), {
      type: 'workspaceWrite', writableRoots: [], networkAccess: false,
      excludeTmpdirEnvVar: false, excludeSlashTmp: false,
    });
  });
});

suite('effortLevelsOf', () => {
  test('carries the newest models\' full scale, ultra included', () => {
    // Measured against codex-cli 0.147.0 on 2026-08-14: gpt-5.6-sol reports
    // exactly these six. 'ultra' is the only value that was outside
    // EffortLevel, which is why the union gained it rather than this function
    // gaining a filter — dropping it would silently remove the top level of
    // the newest model.
    const effort = effortLevelsOf({
      id: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', hidden: false,
      supportedReasoningEfforts: [
        { reasoningEffort: 'low', description: '' },
        { reasoningEffort: 'medium', description: '' },
        { reasoningEffort: 'high', description: '' },
        { reasoningEffort: 'xhigh', description: '' },
        { reasoningEffort: 'max', description: '' },
        { reasoningEffort: 'ultra', description: '' },
      ],
      defaultReasoningEffort: 'low',
    });
    assert.deepStrictEqual(effort, {
      levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], default: 'low',
    });
  });

  test('an older model\'s shorter scale is carried as-is', () => {
    // gpt-5.5 and gpt-5.4 stop at xhigh. The scale is per model, so nothing
    // pads it out to match its newer siblings.
    const effort = effortLevelsOf({
      id: 'gpt-5.5', displayName: 'GPT-5.5', hidden: false,
      supportedReasoningEfforts: [
        { reasoningEffort: 'low', description: '' },
        { reasoningEffort: 'medium', description: '' },
        { reasoningEffort: 'high', description: '' },
        { reasoningEffort: 'xhigh', description: '' },
      ],
      defaultReasoningEffort: 'medium',
    });
    assert.deepStrictEqual(effort, {
      levels: ['low', 'medium', 'high', 'xhigh'], default: 'medium',
    });
  });

  test('a level we cannot express is dropped rather than invented', () => {
    // ReasoningEffort is an open string: Codex can add a level between
    // releases. Not observed in 0.147.0, but the union is closed and shared
    // with every other provider, so an unknown value is skipped instead of
    // widening the slider for everyone.
    const effort = effortLevelsOf({
      id: 'future', displayName: 'Future', hidden: false,
      supportedReasoningEfforts: [
        { reasoningEffort: 'low', description: '' },
        { reasoningEffort: 'hyper', description: '' },
      ],
      defaultReasoningEffort: 'low',
    });
    assert.deepStrictEqual(effort, { levels: ['low'], default: 'low' });
  });

  test('a model with no expressible level gets no effort control', () => {
    const effort = effortLevelsOf({
      id: 'x', displayName: 'X', hidden: false,
      supportedReasoningEfforts: [{ reasoningEffort: 'hyper', description: '' }],
      defaultReasoningEffort: 'hyper',
    });
    assert.strictEqual(effort, undefined);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:unit --grep "codexSettings"`
Expected: FAIL — cannot find module `../../providers/codex/map-settings`

- [ ] **Step 3: Write the wire types**

Create `src/providers/codex/wire.ts`. Only the members we consume — `codex app-server generate-ts` emits 300+ files, and vendoring all of them makes every Codex upgrade a thousand-line diff:

```ts
/**
 * Hand-written subset of the Codex app-server protocol.
 *
 * Regenerate the full set with `yarn codex:bindings` and diff against it when
 * bumping the pinned CLI version — `InitializeResponse` carries no protocol
 * version, so a shape change is otherwise invisible until it fails at
 * runtime. `src/test/unit/codex-smoke.test.ts` automates the method-name half
 * of that check.
 *
 * Verified against codex-cli 0.147.0.
 */

export type AskForApproval = 'untrusted' | 'on-request' | 'never';
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type ApprovalsReviewer = 'user' | 'auto_review' | 'guardian_subagent';

export type SandboxPolicy =
  | { type: 'dangerFullAccess' }
  | { type: 'readOnly'; networkAccess: boolean }
  | {
      type: 'workspaceWrite'; writableRoots: string[]; networkAccess: boolean;
      excludeTmpdirEnvVar: boolean; excludeSlashTmp: boolean;
    };

/** Open string in the protocol; we narrow it at the boundary. */
export type ReasoningEffort = string;

export interface CodexModel {
  id: string;
  displayName: string;
  hidden: boolean;
  supportedReasoningEfforts: { reasoningEffort: ReasoningEffort; description: string }[];
  defaultReasoningEffort: ReasoningEffort;
}

export interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  /** UNIT IS NOT DOCUMENTED — measured in map-usage, never assumed. */
  resetsAt: number | null;
}

export interface RateLimitSnapshot {
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
}

export interface TokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface ThreadTokenUsage {
  total: TokenUsageBreakdown;
  last: TokenUsageBreakdown;
  modelContextWindow: number | null;
}

export type ThreadItem =
  | { type: 'agentMessage'; id: string; text: string }
  | { type: 'reasoning'; id: string; summary: string[]; content: string[] }
  | { type: 'commandExecution'; id: string; command: string; cwd: string;
      status?: string; aggregatedOutput?: string; exitCode?: number | null }
  | { type: 'fileChange'; id: string; status?: string; changes?: unknown }
  | { type: 'mcpToolCall'; id: string; server: string; toolName: string;
      status?: string; result?: unknown }
  | { type: 'webSearch'; id: string; query?: string }
  | { type: 'dynamicToolCall'; id: string; toolName?: string; status?: string }
  | { type: 'plan'; id: string; text: string }
  // Every other kind is deliberately unmodelled: parsing is tolerant, and an
  // unknown item is ignored rather than thrown.
  | { type: string; id: string };

export type ReviewDecision =
  | 'approved'
  | 'approved_for_session'
  | 'abort'
  | { denied: { rejection: string } };
```

- [ ] **Step 4: Write the mapping**

Create `src/providers/codex/map-settings.ts`:

```ts
import type { EffortLevel, ModelInfo, PermissionMode, PermissionModeInfo } from '../types';
import type {
  ApprovalsReviewer, AskForApproval, CodexModel, SandboxMode, SandboxPolicy,
} from './wire';

export interface CodexThreadSettings {
  approvalPolicy: AskForApproval;
  sandbox: SandboxMode;
  approvalsReviewer: ApprovalsReviewer;
}

/**
 * Codex has three independent axes where the panel has one.
 *
 * `approvalPolicy` decides *whether* an approval is raised. `sandbox` decides
 * what can be touched without one. `approvalsReviewer` decides *who answers*
 * — this is the knob Codex's own UI labels "Approve for me", and it is the
 * only difference between 'default' and 'auto'.
 */
const SETTINGS: Record<PermissionMode, CodexThreadSettings> = {
  default:     { approvalPolicy: 'on-request', sandbox: 'workspace-write',     approvalsReviewer: 'user' },
  auto:        { approvalPolicy: 'on-request', sandbox: 'workspace-write',     approvalsReviewer: 'auto_review' },
  plan:        { approvalPolicy: 'never',      sandbox: 'read-only',           approvalsReviewer: 'user' },
  dontAsk:     { approvalPolicy: 'never',      sandbox: 'workspace-write',     approvalsReviewer: 'user' },
  bypass:      { approvalPolicy: 'never',      sandbox: 'danger-full-access',  approvalsReviewer: 'user' },
  // Not offered — see CODEX_MODES. Mapped anyway so the function is total:
  // an unoffered mode arriving here is a bug elsewhere, and landing on
  // default's settings is the safe reading of it.
  acceptEdits: { approvalPolicy: 'on-request', sandbox: 'workspace-write',     approvalsReviewer: 'user' },
};

export function codexSettings(mode: PermissionMode): CodexThreadSettings {
  return SETTINGS[mode];
}

/**
 * The five modes Codex can honor.
 *
 * `acceptEdits` is absent on purpose. Under `workspace-write` an in-workspace
 * edit raises no approval at all, so a Codex `acceptEdits` would be a second
 * name for `default`. An honest five beats six with one that quietly does
 * nothing.
 */
export const CODEX_MODES: PermissionModeInfo[] = [
  { id: 'default', description: 'Codex asks before anything leaves the workspace.' },
  { id: 'auto', description: 'Codex reviews each request itself and only asks about risky ones.' },
  { id: 'plan', description: 'Read and propose. Nothing on disk is changed.' },
  { id: 'dontAsk', description: 'Refuse anything not already allowed, without prompting.' },
  { id: 'bypass', description: 'No sandbox and no prompts. Chosen before the first message.' },
];

/**
 * The struct spelling of the same sandbox choice.
 *
 * `thread/start` takes the bare `SandboxMode` enum; `turn/start` — which is
 * how a mid-session mode change is applied — takes the `SandboxPolicy`
 * struct. Same decision, two shapes, so both live here rather than being
 * open-coded at each call site.
 */
export function sandboxPolicyOf(mode: PermissionMode): SandboxPolicy {
  switch (codexSettings(mode).sandbox) {
    case 'danger-full-access': return { type: 'dangerFullAccess' };
    case 'read-only': return { type: 'readOnly', networkAccess: false };
    default: return {
      type: 'workspaceWrite', writableRoots: [], networkAccess: false,
      excludeTmpdirEnvVar: false, excludeSlashTmp: false,
    };
  }
}

const LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const isLevel = (e: string): e is EffortLevel => (LEVELS as string[]).includes(e);

/**
 * The effort scale for one Codex model, in the order the model reports it.
 *
 * Measured against codex-cli 0.147.0: gpt-5.6-sol and -terra offer
 * low|medium|high|xhigh|max|ultra, -luna stops at max, and gpt-5.5 / 5.4 stop
 * at xhigh. Only 'ultra' fell outside `EffortLevel`, so the union gained it
 * rather than this function gaining a filter — silently dropping the top
 * level of the newest model is a worse outcome than one more union member
 * that other providers simply never declare.
 *
 * `ReasoningEffort` is nonetheless an open string, so an unrecognized level
 * is still skipped: the union is shared with every provider and the slider
 * renders from it. A model whose whole set is inexpressible gets no effort
 * control, which is what `ModelInfo.effort` being optional is for.
 */
export function effortLevelsOf(model: CodexModel): ModelInfo['effort'] {
  const levels = model.supportedReasoningEfforts
    .map((o) => o.reasoningEffort)
    .filter(isLevel);
  if (levels.length === 0) { return undefined; }
  const preferred = model.defaultReasoningEffort;
  return {
    levels,
    default: isLevel(preferred) && levels.includes(preferred) ? preferred : levels[0],
  };
}
```

- [ ] **Step 5: Widen `EffortLevel` by one member**

In `src/providers/types.ts`:

```ts
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
```

Measured, not assumed: `model/list` on codex-cli 0.147.0 reports
`low|medium|high|xhigh|max|ultra` for gpt-5.6-sol and -terra. `ultra` is the
only level Codex offers that the union did not already have, and its
description is "Maximum reasoning with automatic task delegation" — a real
setting, not an alias for `max`.

Widening the shared union is correct rather than filtering it away: levels are
already declared per model, so Claude's models simply never list `ultra` and
nothing about their sliders changes. Filtering would have silently removed the
top level of Codex's newest models.

- [ ] **Step 6: Run tests to verify they pass**

Run: `yarn test:unit --grep "codexSettings|CODEX_MODES|sandboxPolicyOf|effortLevelsOf"`
Expected: PASS (13 passing)

Then the full suite, since the union widened:

Run: `yarn check-types && yarn test:unit`
Expected: PASS. A `switch` over `EffortLevel` with no default would now be
non-exhaustive — fix any that `check-types` flags.

- [ ] **Step 7: Commit**

```bash
git add src/providers/types.ts src/providers/codex/wire.ts src/providers/codex/map-settings.ts \
        src/test/unit/codex-map-settings.test.ts
git commit -m "feat: map permission modes onto Codex's three approval axes"
```

---

### Task 4: The app-server connection

**Files:**
- Create: `src/providers/codex/app-server.ts`
- Test: `src/test/unit/codex-app-server.test.ts`

**Interfaces:**
- Produces: `AppServer` class with `request<T>(method: string, params: unknown): Promise<T>`, `respond(id: RequestId, result: unknown): void`, `onNotification(cb: (method: string, params: unknown) => void): void`, `onServerRequest(cb: (method: string, id: RequestId, params: unknown) => void): void`, `onClose(cb: (reason: string) => void): void`, `dispose(): void`; `type RequestId = number | string`; `interface Duplex { stdin: NodeJS.WritableStream; stdout: NodeJS.ReadableStream; kill(): void }`

- [ ] **Step 1: Write the failing test**

Create `src/test/unit/codex-app-server.test.ts`:

```ts
import * as assert from 'assert';
import { PassThrough } from 'node:stream';
import { AppServer } from '../../providers/codex/app-server';

/** A stub child: no binary, no auth, no network. */
function stub() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const written: string[] = [];
  stdin.on('data', (chunk: Buffer) => { written.push(chunk.toString()); });
  let killed = false;
  const server = new AppServer({ stdin, stdout, kill: () => { killed = true; } });
  const send = (msg: unknown) => { stdout.write(`${JSON.stringify(msg)}\n`); };
  const sent = () => written.join('').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { server, send, sent, killed: () => killed };
}

suite('AppServer', () => {
  test('correlates a response to its request', async () => {
    const { server, send, sent } = stub();
    const pending = server.request<{ ok: boolean }>('initialize', { a: 1 });
    const [frame] = sent();
    assert.strictEqual(frame.method, 'initialize');
    send({ id: frame.id, result: { ok: true } });
    assert.deepStrictEqual(await pending, { ok: true });
  });

  test('two in-flight requests resolve independently and out of order', async () => {
    const { server, send, sent } = stub();
    const first = server.request<string>('model/list', {});
    const second = server.request<string>('account/read', {});
    const [a, b] = sent();
    send({ id: b.id, result: 'second' });
    send({ id: a.id, result: 'first' });
    assert.deepStrictEqual(await Promise.all([first, second]), ['first', 'second']);
  });

  test('an error response rejects with the server message', async () => {
    const { server, send, sent } = stub();
    const pending = server.request('thread/start', {});
    send({ id: sent()[0].id, error: { code: -32000, message: 'not signed in' } });
    await assert.rejects(pending, /not signed in/);
  });

  test('a notification reaches the notification sink', () => {
    const { server, send } = stub();
    const seen: string[] = [];
    server.onNotification((method) => { seen.push(method); });
    send({ method: 'turn/started', params: { threadId: 't1' } });
    assert.deepStrictEqual(seen, ['turn/started']);
  });

  test('a server request reaches the request sink and can be answered', () => {
    const { server, send, sent } = stub();
    server.onServerRequest((method, id) => {
      if (method === 'item/commandExecution/requestApproval') { server.respond(id, { decision: 'approved' }); }
    });
    send({ id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: 't1' } });
    const reply = sent().at(-1);
    assert.strictEqual(reply.id, 7);
    assert.deepStrictEqual(reply.result, { decision: 'approved' });
  });

  test('a frame split across chunks is still parsed', () => {
    const { server, send: _send } = stub();
    // Not send(): this deliberately writes a partial line first.
    const seen: string[] = [];
    server.onNotification((method) => { seen.push(method); });
    server.ingest('{"method":"turn/star');
    server.ingest('ted","params":{}}\n');
    assert.deepStrictEqual(seen, ['turn/started']);
  });

  test('a malformed line is skipped, not fatal', () => {
    const { server, send } = stub();
    const seen: string[] = [];
    server.onNotification((method) => { seen.push(method); });
    server.ingest('not json\n');
    send({ method: 'turn/completed', params: {} });
    assert.deepStrictEqual(seen, ['turn/completed']);
  });

  test('closing rejects every in-flight request', async () => {
    const { server } = stub();
    const pending = server.request('model/list', {});
    server.close('app-server exited');
    // Errors are state: the caller turns this into a session error item
    // rather than an unhandled rejection.
    await assert.rejects(pending, /app-server exited/);
  });

  test('close notifies once even if called twice', () => {
    const { server } = stub();
    let closes = 0;
    server.onClose(() => { closes += 1; });
    server.close('first');
    server.close('second');
    assert.strictEqual(closes, 1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:unit --grep "AppServer"`
Expected: FAIL — cannot find module `../../providers/codex/app-server`

- [ ] **Step 3: Write the connection**

Create `src/providers/codex/app-server.ts`:

```ts
export type RequestId = number | string;

/** The child process, narrowed to what this module uses, so tests can stub it. */
export interface Duplex {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  kill(): void;
}

/**
 * A line-framed JSON-RPC connection to `codex app-server`.
 *
 * One connection serves every Codex session: the protocol multiplexes
 * conversations by `threadId`, and a process per session would multiply a
 * large Rust binary by the roster size — which is the cost the panel exists
 * to avoid. Dispatch by thread is the caller's job; this class knows only
 * frames.
 *
 * No `vscode` import, and the process is injected rather than spawned here,
 * so the whole thing unit-tests against a pair of PassThrough streams.
 */
export class AppServer {
  private nextId = 1;
  private readonly pending = new Map<RequestId, {
    resolve: (v: never) => void; reject: (e: Error) => void;
  }>();
  private buffer = '';
  private closed = false;
  private notify: (method: string, params: unknown) => void = () => {};
  private serverRequest: (method: string, id: RequestId, params: unknown) => void = () => {};
  private closeCb: (reason: string) => void = () => {};

  constructor(private readonly child: Duplex) {
    child.stdout.on('data', (chunk: Buffer) => { this.ingest(chunk.toString()); });
    child.stdout.on('close', () => { this.close('app-server closed its output'); });
  }

  onNotification(cb: (method: string, params: unknown) => void): void { this.notify = cb; }
  onServerRequest(cb: (method: string, id: RequestId, params: unknown) => void): void {
    this.serverRequest = cb;
  }
  onClose(cb: (reason: string) => void): void { this.closeCb = cb; }

  request<T>(method: string, params: unknown): Promise<T> {
    if (this.closed) { return Promise.reject(new Error('app-server is not running')); }
    const id = this.nextId++;
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: never) => void, reject });
    });
    this.write({ id, method, params });
    return promise;
  }

  /** Answers a server-initiated request. Fire-and-forget by design. */
  respond(id: RequestId, result: unknown): void {
    if (this.closed) { return; }
    this.write({ id, result });
  }

  /**
   * Public for tests, and because stdout arrives in arbitrary chunks: a frame
   * can be split mid-token across two `data` events, so the tail is buffered
   * rather than parsed per chunk.
   */
  ingest(text: string): void {
    this.buffer += text;
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) { this.dispatch(line); }
      newline = this.buffer.indexOf('\n');
    }
  }

  private dispatch(line: string): void {
    let frame: {
      id?: RequestId; method?: string; params?: unknown; result?: unknown;
      error?: { message?: string };
    };
    try {
      frame = JSON.parse(line);
    } catch {
      // Tolerant by policy: a line we cannot parse is a line we ignore. The
      // alternative is one stray write killing every live session.
      console.warn('[hiiiid-code] codex: unparseable frame');
      return;
    }

    if (frame.method !== undefined && frame.id !== undefined) {
      this.serverRequest(frame.method, frame.id, frame.params);
      return;
    }
    if (frame.method !== undefined) {
      this.notify(frame.method, frame.params);
      return;
    }
    if (frame.id === undefined) { return; }

    const waiter = this.pending.get(frame.id);
    if (!waiter) { return; }
    this.pending.delete(frame.id);
    if (frame.error) {
      waiter.reject(new Error(frame.error.message ?? 'app-server error'));
    } else {
      waiter.resolve(frame.result as never);
    }
  }

  private write(frame: unknown): void {
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  /**
   * Every in-flight request rejects with the same reason.
   *
   * A caller awaiting a dead process would otherwise hang forever, and a
   * session stuck in 'running' with no way out is worse than one in 'error'
   * with a message.
   */
  close(reason: string): void {
    if (this.closed) { return; }
    this.closed = true;
    for (const { reject } of this.pending.values()) { reject(new Error(reason)); }
    this.pending.clear();
    this.closeCb(reason);
  }

  dispose(): void {
    this.close('app-server disposed');
    this.child.kill();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test:unit --grep "AppServer"`
Expected: PASS (9 passing)

- [ ] **Step 5: Commit**

```bash
git add src/providers/codex/app-server.ts src/test/unit/codex-app-server.test.ts
git commit -m "feat: add a line-framed JSON-RPC connection to codex app-server"
```

---

### Task 5: Notifications to AgentEvents

**Files:**
- Create: `src/providers/codex/map-events.ts`
- Test: `src/test/unit/codex-map-events.test.ts`

**Interfaces:**
- Consumes: `ThreadItem` (Task 3)
- Produces: `mapNotification(method: string, params: unknown): AgentEvent[]`; `approvalEventOf(method: string, id: RequestId, params: unknown): AgentEvent | undefined`; `DECLINED_INPUT_METHODS: string[]`

- [ ] **Step 1: Write the failing test**

Create `src/test/unit/codex-map-events.test.ts`:

```ts
import * as assert from 'assert';
import { approvalEventOf, mapNotification } from '../../providers/codex/map-events';

suite('mapNotification', () => {
  test('thread/started carries the resume token', () => {
    assert.deepStrictEqual(
      mapNotification('thread/started', { thread: { id: 'th_1' } }),
      [{ kind: 'session', resumeToken: 'th_1' }],
    );
  });

  test('agent message deltas become text', () => {
    assert.deepStrictEqual(
      mapNotification('item/agentMessage/delta', { delta: 'hi' }),
      [{ kind: 'text', delta: 'hi' }],
    );
  });

  test('both reasoning delta shapes become thinking', () => {
    assert.deepStrictEqual(
      mapNotification('item/reasoning/textDelta', { delta: 'a' }),
      [{ kind: 'thinking', delta: 'a' }],
    );
    assert.deepStrictEqual(
      mapNotification('item/reasoning/summaryTextDelta', { delta: 'b' }),
      [{ kind: 'thinking', delta: 'b' }],
    );
  });

  test('a started command execution becomes a tool-start', () => {
    const events = mapNotification('item/started', {
      item: { type: 'commandExecution', id: 'it_1', command: 'ls -la', cwd: '/repo' },
    });
    assert.deepStrictEqual(events, [{
      kind: 'tool-start', id: 'it_1', name: 'commandExecution',
      input: { command: 'ls -la', cwd: '/repo' },
    }]);
  });

  test('a completed command execution reports success from its exit code', () => {
    const [event] = mapNotification('item/completed', {
      item: { type: 'commandExecution', id: 'it_1', command: 'ls', cwd: '/repo',
              exitCode: 0, aggregatedOutput: 'a\nb' },
    });
    assert.strictEqual(event.kind, 'tool-end');
    assert.strictEqual(event.kind === 'tool-end' && event.ok, true);
  });

  test('a nonzero exit code is a failed tool', () => {
    const [event] = mapNotification('item/completed', {
      item: { type: 'commandExecution', id: 'it_1', command: 'false', cwd: '/r', exitCode: 1 },
    });
    assert.strictEqual(event.kind === 'tool-end' && event.ok, false);
  });

  test('an agent message item completing is not a tool', () => {
    // The text already arrived as deltas; emitting a tool row for it would
    // double the assistant's turn in the transcript.
    assert.deepStrictEqual(
      mapNotification('item/completed', { item: { type: 'agentMessage', id: 'it_2', text: 'done' } }),
      [],
    );
  });

  test('turn/completed ends the turn', () => {
    assert.deepStrictEqual(
      mapNotification('turn/completed', { threadId: 't', turn: {} }),
      [{ kind: 'turn-end', reason: 'done' }],
    );
  });

  test('an error notification ends the turn with its message', () => {
    assert.deepStrictEqual(
      mapNotification('error', { error: { message: 'model overloaded' }, willRetry: false }),
      [{ kind: 'turn-end', reason: 'error', error: 'model overloaded' }],
    );
  });

  test('an error that will be retried does not end the turn', () => {
    assert.deepStrictEqual(
      mapNotification('error', { error: { message: 'transient' }, willRetry: true }),
      [],
    );
  });

  test('rate limit updates are a signal to pull, never a payload to read', () => {
    // The notification is documented as a sparse rolling update; numbers come
    // from account/rateLimits/read.
    assert.deepStrictEqual(
      mapNotification('account/rateLimits/updated', { rateLimits: { primary: { usedPercent: 40 } } }),
      [{ kind: 'usage-stale' }],
    );
  });

  test('token usage becomes an input/output usage event', () => {
    assert.deepStrictEqual(
      mapNotification('thread/tokenUsage/updated', {
        tokenUsage: { total: { inputTokens: 100, outputTokens: 20 }, modelContextWindow: 200_000 },
      }),
      [{ kind: 'usage', inputTokens: 100, outputTokens: 20 }],
    );
  });

  test('an unknown method is ignored, not thrown', () => {
    // Tolerant parsing is the mitigation for a protocol with no negotiated
    // version: a method added by a Codex upgrade must be a no-op.
    assert.deepStrictEqual(mapNotification('thread/realtime/sdp', { anything: true }), []);
  });

  test('an unknown item kind is ignored, not thrown', () => {
    assert.deepStrictEqual(
      mapNotification('item/started', { item: { type: 'imageGeneration', id: 'it_9' } }),
      [],
    );
  });
});

suite('approvalEventOf', () => {
  test('a command approval becomes a permission request', () => {
    assert.deepStrictEqual(
      approvalEventOf('item/commandExecution/requestApproval', 11,
        { itemId: 'it_1', command: 'rm -rf build', cwd: '/repo', reason: 'writes outside workspace' }),
      { kind: 'permission', id: '11', name: 'commandExecution',
        input: { command: 'rm -rf build', cwd: '/repo', reason: 'writes outside workspace' } },
    );
  });

  test('a file change approval becomes a permission request', () => {
    assert.deepStrictEqual(
      approvalEventOf('item/fileChange/requestApproval', 12, { itemId: 'it_2', grantRoot: '/repo' }),
      { kind: 'permission', id: '12', name: 'fileChange',
        input: { itemId: 'it_2', grantRoot: '/repo' } },
    );
  });

  test('an unrelated server request produces no permission', () => {
    assert.strictEqual(approvalEventOf('attestation/generate', 13, {}), undefined);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:unit --grep "mapNotification"`
Expected: FAIL — cannot find module `../../providers/codex/map-events`

- [ ] **Step 3: Write the mapping**

Create `src/providers/codex/map-events.ts`:

```ts
import type { AgentEvent } from '../types';
import type { RequestId } from './app-server';
import type { ThreadItem } from './wire';

/** Item kinds that render as a tool row. Everything else is not a tool. */
const TOOL_KINDS = new Set([
  'commandExecution', 'fileChange', 'mcpToolCall', 'webSearch', 'dynamicToolCall', 'plan',
]);

/**
 * Server requests that ask for typed input rather than a yes/no.
 *
 * `ToolDecision` cannot express either one, and a turn that never gets an
 * answer hangs. The run declines them with a transcript note instead — see
 * codex-run.ts. Both are experimental and only fire if a tool or MCP server
 * uses them.
 */
export const DECLINED_INPUT_METHODS = [
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
];

const APPROVAL_METHODS: Record<string, string> = {
  'item/commandExecution/requestApproval': 'commandExecution',
  'item/fileChange/requestApproval': 'fileChange',
  'item/permissions/requestApproval': 'permissions',
};

/**
 * One notification to zero or more `AgentEvent`s.
 *
 * Zero is a normal answer, not a failure: `InitializeResponse` carries no
 * protocol version, so the only defense against a Codex upgrade changing the
 * wire is to ignore what we do not recognize. An unknown method and an
 * unknown item kind are both no-ops.
 */
export function mapNotification(method: string, params: unknown): AgentEvent[] {
  const p = (params ?? {}) as Record<string, never>;

  switch (method) {
    case 'thread/started': {
      const id = (p as { thread?: { id?: string } }).thread?.id;
      return id ? [{ kind: 'session', resumeToken: id }] : [];
    }
    case 'item/agentMessage/delta':
      return [{ kind: 'text', delta: String((p as { delta?: string }).delta ?? '') }];
    case 'item/reasoning/textDelta':
    case 'item/reasoning/summaryTextDelta':
      return [{ kind: 'thinking', delta: String((p as { delta?: string }).delta ?? '') }];
    case 'item/started':
      return startOf((p as { item?: ThreadItem }).item);
    case 'item/completed':
      return endOf((p as { item?: ThreadItem }).item);
    case 'turn/completed':
      return [{ kind: 'turn-end', reason: 'done' }];
    case 'error': {
      const e = p as { error?: { message?: string }; willRetry?: boolean };
      // A retry is not a turn ending. Reporting one would leave the session
      // idle while the provider is still working.
      if (e.willRetry) { return []; }
      return [{ kind: 'turn-end', reason: 'error', error: e.error?.message ?? 'Codex error' }];
    }
    case 'account/rateLimits/updated':
      // Documented as a sparse rolling update: a signal that a pull is due,
      // never the numbers themselves.
      return [{ kind: 'usage-stale' }];
    case 'thread/tokenUsage/updated': {
      const total = (p as { tokenUsage?: { total?: { inputTokens?: number; outputTokens?: number } } })
        .tokenUsage?.total;
      if (!total) { return []; }
      return [{
        kind: 'usage',
        inputTokens: total.inputTokens ?? 0,
        outputTokens: total.outputTokens ?? 0,
      }];
    }
    default:
      return [];
  }
}

function startOf(item: ThreadItem | undefined): AgentEvent[] {
  if (!item || !TOOL_KINDS.has(item.type)) { return []; }
  return [{ kind: 'tool-start', id: item.id, name: item.type, input: inputOf(item) }];
}

function endOf(item: ThreadItem | undefined): AgentEvent[] {
  if (!item || !TOOL_KINDS.has(item.type)) { return []; }
  return [{ kind: 'tool-end', id: item.id, ok: succeeded(item), output: outputOf(item) }];
}

/** The fields worth showing in the tool header, per kind. */
function inputOf(item: ThreadItem): unknown {
  switch (item.type) {
    case 'commandExecution': {
      const c = item as Extract<ThreadItem, { type: 'commandExecution' }>;
      return { command: c.command, cwd: c.cwd };
    }
    case 'mcpToolCall': {
      const m = item as Extract<ThreadItem, { type: 'mcpToolCall' }>;
      return { server: m.server, toolName: m.toolName };
    }
    default:
      return item;
  }
}

function outputOf(item: ThreadItem): unknown {
  if (item.type === 'commandExecution') {
    const c = item as Extract<ThreadItem, { type: 'commandExecution' }>;
    // Buffered, not streamed: `item/commandExecution/outputDelta` exists, but
    // AgentEvent has no tool-output-delta, so this matches Claude's behavior.
    return c.aggregatedOutput ?? '';
  }
  return item;
}

/**
 * Codex reports failure differently per kind: a command has an exit code, and
 * everything else has a status string. Treating a missing signal as success
 * is deliberate — a tool that completed without saying otherwise did.
 */
function succeeded(item: ThreadItem): boolean {
  if (item.type === 'commandExecution') {
    const code = (item as Extract<ThreadItem, { type: 'commandExecution' }>).exitCode;
    return code === undefined || code === null || code === 0;
  }
  const status = (item as { status?: string }).status;
  return status !== 'failed' && status !== 'error';
}

/**
 * A server request to a `permission` event, or undefined if it is not an
 * approval at all.
 *
 * The event id is the JSON-RPC request id as a string: that is the handle
 * `respondToTool` needs to answer the right request, and `AgentEvent.id` is
 * typed as a string.
 */
export function approvalEventOf(
  method: string, id: RequestId, params: unknown,
): AgentEvent | undefined {
  const name = APPROVAL_METHODS[method];
  if (!name) { return undefined; }
  const p = (params ?? {}) as Record<string, unknown>;
  if (name === 'commandExecution') {
    return {
      kind: 'permission', id: String(id), name,
      input: { command: p.command, cwd: p.cwd, reason: p.reason },
    };
  }
  return { kind: 'permission', id: String(id), name, input: p };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test:unit --grep "mapNotification|approvalEventOf"`
Expected: PASS (17 passing)

- [ ] **Step 5: Commit**

```bash
git add src/providers/codex/map-events.ts src/test/unit/codex-map-events.test.ts
git commit -m "feat: map codex notifications and approvals onto AgentEvents"
```

---

### Task 6: Usage and context

**Files:**
- Create: `src/providers/codex/map-usage.ts`
- Test: `src/test/unit/codex-map-usage.test.ts`

**Interfaces:**
- Consumes: `RateLimitSnapshot`, `ThreadTokenUsage` (Task 3)
- Produces: `toUsageWindows(snapshot: RateLimitSnapshot): UsageWindow[]`; `toContextBreakdown(usage: ThreadTokenUsage): ContextBreakdown | undefined`

- [ ] **Step 1: Write the failing test**

Create `src/test/unit/codex-map-usage.test.ts`:

```ts
import * as assert from 'assert';
import { toContextBreakdown, toUsageWindows } from '../../providers/codex/map-usage';

suite('toUsageWindows', () => {
  test('names a window from its duration', () => {
    const windows = toUsageWindows({
      primary: { usedPercent: 62, windowDurationMins: 300, resetsAt: null },
      secondary: { usedPercent: 18, windowDurationMins: 10_080, resetsAt: null },
    });
    assert.deepStrictEqual(windows.map((w) => [w.id, w.label, w.usedPercent]), [
      ['primary', 'Session (5h)', 62],
      ['secondary', 'Week', 18],
    ]);
  });

  test('falls back to a generic label when the duration is unknown', () => {
    const [window] = toUsageWindows({
      primary: { usedPercent: 5, windowDurationMins: null, resetsAt: null },
      secondary: null,
    });
    assert.strictEqual(window.label, 'Plan usage');
  });

  test('an absent window is omitted, not zeroed', () => {
    // A missing window is "not reported", which is different from "0% used".
    assert.deepStrictEqual(toUsageWindows({ primary: null, secondary: null }), []);
  });

  test('resetsAt is converted from epoch seconds to epoch ms', () => {
    // MEASURED, not assumed. account/rateLimits/read on codex-cli 0.147.0
    // returned resetsAt 1787337648 against a wall clock of 1786736436s on
    // 2026-08-14 — 6.96 days out on a 10080-minute window, which is epoch
    // seconds. UsageWindow.resetsAt is epoch ms, hence the conversion.
    // Re-measure if the pinned CLI version moves.
    const [window] = toUsageWindows({
      primary: { usedPercent: 0, windowDurationMins: 10_080, resetsAt: 1_787_337_648 },
      secondary: null,
    });
    assert.strictEqual(window.resetsAt, 1_787_337_648_000);
  });

  test('a plus account reporting only a weekly window yields one row', () => {
    // Observed shape: primary is the weekly window and secondary is null.
    // The strip must render one row, not one row and a blank.
    const windows = toUsageWindows({
      primary: { usedPercent: 0, windowDurationMins: 10_080, resetsAt: 1_787_337_648 },
      secondary: null,
    });
    assert.deepStrictEqual(windows.map((w) => w.label), ['Week']);
  });
});

suite('toContextBreakdown', () => {
  test('reports percentages of the context window, never tokens', () => {
    const breakdown = toContextBreakdown({
      total: { totalTokens: 50_000, inputTokens: 40_000, cachedInputTokens: 0,
               outputTokens: 10_000, reasoningOutputTokens: 0 },
      last: { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0,
              outputTokens: 0, reasoningOutputTokens: 0 },
      modelContextWindow: 200_000,
    });
    assert.deepStrictEqual(breakdown, {
      systemPercent: 0, memoryPercent: 0, conversationPercent: 25, freePercent: 75,
      memoryFiles: [],
    });
  });

  test('the four percentages always sum to 100', () => {
    const breakdown = toContextBreakdown({
      total: { totalTokens: 33_333, inputTokens: 33_333, cachedInputTokens: 0,
               outputTokens: 0, reasoningOutputTokens: 0 },
      last: { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0,
              outputTokens: 0, reasoningOutputTokens: 0 },
      modelContextWindow: 100_000,
    })!;
    const sum = breakdown.systemPercent + breakdown.memoryPercent
      + breakdown.conversationPercent + breakdown.freePercent;
    assert.strictEqual(sum, 100);
  });

  test('no context window means no breakdown at all', () => {
    // A provider that cannot report must omit rather than fabricate.
    assert.strictEqual(toContextBreakdown({
      total: { totalTokens: 1, inputTokens: 1, cachedInputTokens: 0,
               outputTokens: 0, reasoningOutputTokens: 0 },
      last: { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0,
              outputTokens: 0, reasoningOutputTokens: 0 },
      modelContextWindow: null,
    }), undefined);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:unit --grep "toUsageWindows"`
Expected: FAIL — cannot find module `../../providers/codex/map-usage`

- [ ] **Step 3: Write the mapping**

Create `src/providers/codex/map-usage.ts`:

```ts
import type { ContextBreakdown, UsageWindow } from '../types';
import type { RateLimitSnapshot, RateLimitWindow, ThreadTokenUsage } from './wire';

/**
 * Codex names its windows by duration rather than by id, so the label is
 * derived. 300 minutes and 10080 minutes are the two the plans actually use;
 * anything else gets its duration spelled out rather than a wrong guess.
 */
function labelFor(minutes: number | null): string {
  if (minutes === null) { return 'Plan usage'; }
  if (minutes === 300) { return 'Session (5h)'; }
  if (minutes === 10_080) { return 'Week'; }
  if (minutes % 1440 === 0) { return `${minutes / 1440}d`; }
  if (minutes % 60 === 0) { return `${minutes / 60}h`; }
  return `${minutes}m`;
}

/**
 * Codex documents no unit for `resetsAt`; it is epoch **seconds**.
 *
 * Measured against a live account on codex-cli 0.147.0: 1787337648 against a
 * wall clock of 1786736436s, 6.96 days out on a 10080-minute window.
 * `UsageWindow.resetsAt` is epoch milliseconds, so this converts.
 *
 * Do not "simplify" this away. CLAUDE.md records that the sibling Claude
 * provider carries both scales — epoch seconds on the event, ISO strings on
 * the structured response — and mixing them is a live bug class here.
 */
function toMs(resetsAt: number | null): number | undefined {
  return resetsAt === null ? undefined : resetsAt * 1000;
}

function windowOf(id: string, w: RateLimitWindow | null): UsageWindow | undefined {
  if (!w) { return undefined; }
  return {
    id,
    label: labelFor(w.windowDurationMins),
    usedPercent: w.usedPercent,
    resetsAt: toMs(w.resetsAt),
  };
}

/**
 * Plan usage as percentages.
 *
 * `usedPercent` is already a percentage, so nothing here converts a token
 * count — the "usage surfaces show percentages, never token counts"
 * invariant holds without work. An absent window is omitted rather than
 * reported as 0%: "not reported" and "none used" are different facts.
 */
export function toUsageWindows(snapshot: RateLimitSnapshot): UsageWindow[] {
  return [windowOf('primary', snapshot.primary), windowOf('secondary', snapshot.secondary)]
    .filter((w): w is UsageWindow => w !== undefined);
}

/**
 * Context occupancy as percentages of the model's window.
 *
 * Codex reports totals, not the system/memory/conversation split the Claude
 * provider gets, so everything used lands in `conversationPercent` and the
 * other two slices are honestly zero. `memoryFiles` is empty for the same
 * reason: the popover renders what it is given, and inventing rows would be
 * worse than an empty list.
 *
 * `freePercent` is computed as the remainder rather than independently, so
 * the four fields sum to exactly 100 as the interface requires.
 */
export function toContextBreakdown(usage: ThreadTokenUsage): ContextBreakdown | undefined {
  const window = usage.modelContextWindow;
  if (!window || window <= 0) { return undefined; }
  const used = Math.min(100, Math.round((usage.total.totalTokens / window) * 100));
  return {
    systemPercent: 0,
    memoryPercent: 0,
    conversationPercent: used,
    freePercent: 100 - used,
    memoryFiles: [],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test:unit --grep "toUsageWindows|toContextBreakdown"`
Expected: PASS (7 passing)

- [ ] **Step 5: Commit**

```bash
git add src/providers/codex/map-usage.ts src/test/unit/codex-map-usage.test.ts
git commit -m "feat: map codex rate limits and token usage onto percentages"
```

---

### Task 7: The run

**Files:**
- Create: `src/providers/codex/codex-run.ts`
- Test: extend `src/test/unit/codex-app-server.test.ts` with a `CodexRun` suite, or add `src/test/unit/codex-run.test.ts`

**Interfaces:**
- Consumes: `AppServer` (Task 4), `mapNotification` / `approvalEventOf` / `DECLINED_INPUT_METHODS` (Task 5), `codexSettings` / `sandboxPolicyOf` (Task 3), `toContextBreakdown` / `toUsageWindows` (Task 6)
- Produces: `class CodexRun implements AgentRun`, constructed as `new CodexRun(server: AppServer, opts: StartOptions)`; `readonly threadId: string | undefined`

- [ ] **Step 1: Write the failing test**

Create `src/test/unit/codex-run.test.ts`. Reuse the `stub()` helper shape from Task 4 (duplicate it locally — the tasks may be implemented out of order, and a shared fixture across two suites is not worth the coupling):

```ts
suite('CodexRun', () => {
  test('the first send starts a thread with the mode settings', async () => {
    const { server, send, sent } = stub();
    const run = new CodexRun(server, { cwd: '/repo', permissionMode: 'plan', model: 'gpt-5-codex' });
    run.send('hello');
    await tick();
    const start = sent().find((f) => f.method === 'thread/start');
    assert.strictEqual(start.params.approvalPolicy, 'never');
    assert.strictEqual(start.params.sandbox, 'read-only');
    assert.strictEqual(start.params.approvalsReviewer, 'user');
    assert.strictEqual(start.params.cwd, '/repo');
  });

  test('a resume token resumes instead of starting', async () => {
    const { server, sent } = stub();
    const run = new CodexRun(server, {
      cwd: '/repo', permissionMode: 'default', resumeToken: 'th_old',
    });
    run.send('hi');
    await tick();
    assert.strictEqual(sent().some((f) => f.method === 'thread/resume'), true);
    assert.strictEqual(sent().some((f) => f.method === 'thread/start'), false);
  });

  test('auto routes approvals to the guardian', async () => {
    const { server, sent } = stub();
    new CodexRun(server, { cwd: '/repo', permissionMode: 'auto' }).send('hi');
    await tick();
    const start = sent().find((f) => f.method === 'thread/start');
    assert.strictEqual(start.params.approvalsReviewer, 'auto_review');
  });

  test('only this thread\'s notifications reach this run', async () => {
    const { server, send } = stub();
    const run = await started(server, 'th_1');
    const events = collect(run);
    send({ method: 'item/agentMessage/delta', params: { threadId: 'th_other', delta: 'no' } });
    send({ method: 'item/agentMessage/delta', params: { threadId: 'th_1', delta: 'yes' } });
    await tick();
    assert.deepStrictEqual(events().filter((e) => e.kind === 'text').map((e) => e.delta), ['yes']);
  });

  test('an approval decision answers the originating request', async () => {
    const { server, send, sent } = stub();
    const run = await started(server, 'th_1');
    send({ id: 42, method: 'item/commandExecution/requestApproval',
           params: { threadId: 'th_1', command: 'rm -rf x', cwd: '/repo' } });
    await tick();
    run.respondToTool('42', { allow: true });
    assert.deepStrictEqual(sent().at(-1), { id: 42, result: { decision: 'approved' } });
  });

  test('a denial carries the reason as the rejection', async () => {
    const { server, send, sent } = stub();
    const run = await started(server, 'th_1');
    send({ id: 43, method: 'item/fileChange/requestApproval', params: { threadId: 'th_1' } });
    await tick();
    run.respondToTool('43', { allow: false, reason: 'not this file' });
    assert.deepStrictEqual(sent().at(-1),
      { id: 43, result: { decision: { denied: { rejection: 'not this file' } } } });
  });

  test('an input request is declined rather than left hanging', async () => {
    const { server, send, sent } = stub();
    const run = await started(server, 'th_1');
    const events = collect(run);
    send({ id: 44, method: 'item/tool/requestUserInput',
           params: { threadId: 'th_1', questions: [], isBlocking: true } });
    await tick();
    // Answered immediately: an unanswered blocking request hangs the turn.
    assert.strictEqual(sent().at(-1).id, 44);
    // And said so in the transcript, rather than failing silently.
    assert.strictEqual(events().some((e) => e.kind === 'tool-start'), true);
  });

  test('a mode change retargets the live thread', async () => {
    const { server, sent } = stub();
    const run = await started(server, 'th_1');
    run.setPermissionMode('bypass');
    await tick();
    const update = sent().at(-1);
    assert.strictEqual(update.params.approvalPolicy, 'never');
    assert.deepStrictEqual(update.params.sandboxPolicy, { type: 'dangerFullAccess' });
  });

  test('a failing setter does not reject at the caller', async () => {
    const { server } = stub();
    const run = await started(server, 'th_1');
    server.close('gone');
    // Fire-and-forget by design: callers must never see these reject.
    assert.doesNotThrow(() => { run.setPermissionMode('plan'); });
    assert.doesNotThrow(() => { run.setModel('other'); });
    assert.doesNotThrow(() => { run.setEffort('high'); });
  });

  test('the connection closing ends the turn with an error', async () => {
    const { server } = stub();
    const run = await started(server, 'th_1');
    const events = collect(run);
    server.close('app-server exited');
    await tick();
    const last = events().at(-1);
    assert.strictEqual(last.kind, 'turn-end');
    assert.strictEqual(last.kind === 'turn-end' && last.reason, 'error');
  });
});
```

Write the `tick()`, `started()` and `collect()` helpers at the top of the file: `tick` is `() => new Promise((r) => setImmediate(r))`; `started` sends a `thread/start` response plus a `thread/started` notification; `collect` drains `run.events` into an array in the background.

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:unit --grep "CodexRun"`
Expected: FAIL — cannot find module `../../providers/codex/codex-run`

- [ ] **Step 3: Write the run**

Create `src/providers/codex/codex-run.ts` implementing `AgentRun`. Structure, with the reasoning that must survive into the code:

```ts
/**
 * One Codex thread, presented as an `AgentRun`.
 *
 * Thread creation is lazy — deferred to the first `send()` — for the same
 * reason the Claude provider defers query construction: a session restored on
 * a reload should not spawn backend work until the user actually uses it, and
 * the settings a thread starts with can still change before then.
 *
 * The connection is shared with every other Codex session, so this class
 * filters by `threadId` on the way in and tags by it on the way out. A run
 * that has not started yet has no id, and drops everything.
 */
export class CodexRun implements AgentRun {
```

Required behavior, each of which a test above pins:

1. An internal `EventChannel` — same async-iterable pattern as `FakeProvider`'s, which is the house idiom for this.
2. `send(text, context)`: on first call, `thread/start` (or `thread/resume` when `opts.resumeToken` is set) with `codexSettings(mode)`, `cwd`, `model`, and effort; then `turn/start` with `input: [{ type: 'text', text, text_elements: [] }]`. Editor context is appended to the text via the existing `formatEditorContext` helper in `src/providers/format-editor-context.ts`.
3. Notification filter: ignore any notification whose `params.threadId` is set and differs from this run's. `thread/started` is the exception — it is what *establishes* the id.
4. Server requests: `approvalEventOf` → push a `permission` event, and record `id` in a `pendingApprovals` map keyed by the string form. `DECLINED_INPUT_METHODS` → respond immediately with an empty/decline result and push a `tool-start`/`tool-end` pair naming what was declined, so the transcript says so.
5. `respondToTool(id, decision)`: look up the JSON-RPC id, `server.respond(rpcId, { decision })` with `'approved'` or `{ denied: { rejection: reason ?? 'Denied from the panel' } }`. A guardian denial recorded as such instead calls `thread/approveGuardianDeniedAction` with the stored assessment event.
6. `setPermissionMode` / `setModel` / `setEffort`: `void`-returning, each firing a `turn/start`-style override or `thread/metadata/update` as appropriate, and each swallowing rejection via `.catch()` — callers must never see these reject.
7. `interrupt()`: `turn/interrupt`, then push `{ kind: 'turn-end', reason: 'interrupted' }`.
8. `contextBreakdown()` and `usageWindows()`: implemented from the last `thread/tokenUsage/updated` and a live `account/rateLimits/read` respectively.
9. `server.onClose` → push `{ kind: 'turn-end', reason: 'error', error: reason }` and close the channel.
10. `dispose()`: `thread/unsubscribe`, close the channel. Best-effort — the connection may already be gone.

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test:unit --grep "CodexRun"`
Expected: PASS (10 passing)

- [ ] **Step 5: Commit**

```bash
git add src/providers/codex/codex-run.ts src/test/unit/codex-run.test.ts
git commit -m "feat: run one codex thread behind the AgentRun interface"
```

---

### Task 8: The provider

**Files:**
- Create: `src/providers/codex/codex-provider.ts`
- Test: `src/test/unit/codex-provider.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 3-7
- Produces: `class CodexProvider implements AgentProvider`, constructed as `new CodexProvider(opts?: { binPath?: string; spawn?: (bin: string) => Duplex })`

- [ ] **Step 1: Write the failing test**

Create `src/test/unit/codex-provider.test.ts`:

```ts
suite('CodexProvider', () => {
  test('declares five modes and omits acceptEdits', () => {
    const provider = new CodexProvider({ spawn: () => stubChild() });
    assert.deepStrictEqual(provider.listPermissionModes().map((m) => m.id),
      ['default', 'auto', 'plan', 'dontAsk', 'bypass']);
  });

  test('starts with no models until a probe answers', () => {
    // listModels is a cache, not a source of truth. An empty list is what
    // puts the provider in unavailable() rather than in the picker.
    assert.deepStrictEqual(new CodexProvider({ spawn: () => stubChild() }).listModels(), []);
  });

  test('fetchModels maps the catalog and hides hidden rows', async () => {
    const { provider, respondTo } = providerWithStub();
    const probe = provider.fetchModels('/repo');
    await respondTo('model/list', { data: [
      { id: 'gpt-5-codex', displayName: 'GPT-5 Codex', hidden: false,
        supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' },
                                    { reasoningEffort: 'high', description: '' }],
        defaultReasoningEffort: 'high' },
      { id: 'internal', displayName: 'Internal', hidden: true,
        supportedReasoningEfforts: [], defaultReasoningEffort: 'low' },
    ], nextCursor: null });
    const models = await probe;
    assert.deepStrictEqual(models.map((m) => m.id), ['gpt-5-codex']);
    assert.deepStrictEqual(models[0].effort, { levels: ['low', 'high'], default: 'high' });
    // The cache is updated by the probe, so the picker sees it synchronously.
    assert.deepStrictEqual(provider.listModels().map((m) => m.id), ['gpt-5-codex']);
  });

  test('a missing binary rejects fetchModels with an actionable message', async () => {
    const provider = new CodexProvider({
      spawn: () => { throw new Error('ENOENT'); },
    });
    // This rejection IS the availability mechanism: session-manager records
    // the reason and shows the provider as unavailable.
    await assert.rejects(provider.fetchModels('/repo'), /not found/i);
  });

  test('an unauthenticated account rejects with the login instruction', async () => {
    const { provider, respondTo } = providerWithStub();
    const probe = provider.fetchModels('/repo');
    await respondTo('account/read', { requiresOpenaiAuth: true, authMethod: null });
    await assert.rejects(probe, /codex login/);
  });

  test('fetchUsage reads the account snapshot without a thread', async () => {
    const { provider, respondTo } = providerWithStub();
    const probe = provider.fetchUsage('/repo');
    await respondTo('account/rateLimits/read', {
      rateLimits: { primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: null },
                    secondary: null },
    });
    assert.deepStrictEqual((await probe)?.map((w) => w.usedPercent), [40]);
  });

  test('two sessions share one process', () => {
    let spawns = 0;
    const provider = new CodexProvider({ spawn: () => { spawns += 1; return stubChild(); } });
    provider.start({ cwd: '/a', permissionMode: 'default' });
    provider.start({ cwd: '/b', permissionMode: 'plan' });
    assert.strictEqual(spawns, 1);
  });

  test('the process is torn down when the last run is disposed', async () => {
    const { provider, killed } = providerWithStub();
    const first = provider.start({ cwd: '/a', permissionMode: 'default' });
    const second = provider.start({ cwd: '/b', permissionMode: 'default' });
    await first.dispose();
    assert.strictEqual(killed(), false);
    await second.dispose();
    assert.strictEqual(killed(), true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:unit --grep "CodexProvider"`
Expected: FAIL — cannot find module `../../providers/codex/codex-provider`

- [ ] **Step 3: Write the provider**

Create `src/providers/codex/codex-provider.ts`. The load-bearing comments:

```ts
/**
 * Codex, via the CLI's `app-server` JSON-RPC service.
 *
 * `app-server` is the only Codex surface that can raise an approval to the
 * client and wait for an answer — the SDK and `exec --json` both fix the
 * approval policy at start — which is what makes it the transport for a panel
 * whose whole point is answering approvals.
 *
 * One process serves every Codex session, ref-counted by live runs.
 */
export class CodexProvider implements AgentProvider {
  readonly id = 'codex';
  readonly displayName = 'Codex';
```

Required behavior:

1. `listPermissionModes()` returns `CODEX_MODES`.
2. `listModels()` returns the cache, `[]` until a probe answers. **An empty list is the availability signal** — `SessionManager.catalog()` filters on it.
3. `connection()`: spawns once (`codex app-server`, or `binPath`), runs `initialize` with `{ clientInfo: { name: 'hiiiid-code', title: null, version }, capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: OPT_OUT } }`, and caches the promise. `OPT_OUT` lists the notification families we never consume — `thread/realtime/*`, `fs/changed`, `rawResponse/*`, `app/list/updated`.
4. `fetchModels(cwd)`: connect → `account/read` → if `requiresOpenaiAuth` and no `authMethod`, reject with ``Not signed in to Codex. Run `codex login`.`` → `model/list` → filter `hidden`, map through `effortLevelsOf`, cache, return. A spawn failure rejects with `Codex CLI not found. Install it, or set hiiiidCode.codex.path.` **These rejection strings are the entire availability UX** — `session-manager` shows them verbatim.
5. `fetchUsage(cwd)`: connect → `account/rateLimits/read` → `toUsageWindows`.
6. `listInvocables(cwd)`: connect → `skills/list` → map to `Invocable`.
7. `start(opts)`: `new CodexRun(connection, opts)`, ref-count up; the run's `dispose` decrements and tears the process down at zero.

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test:unit --grep "CodexProvider"`
Expected: PASS (8 passing)

- [ ] **Step 5: Commit**

```bash
git add src/providers/codex/codex-provider.ts src/test/unit/codex-provider.test.ts
git commit -m "feat: add the Codex agent provider"
```

---

### Task 9: Render Codex tools

**Files:**
- Modify: `src/webview/components/tool-render.ts`
- Test: extend `src/test/unit/tool-render.test.ts`

**Interfaces:**
- Consumes: tool `name` values emitted by `map-events` (Task 5): `commandExecution`, `fileChange`, `mcpToolCall`, `webSearch`, `dynamicToolCall`, `plan`

- [ ] **Step 1: Write the failing test**

Add to `src/test/unit/tool-render.test.ts`:

```ts
suite('tool-render: codex', () => {
  test('a command execution renders its command, not its JSON', () => {
    const rendered = renderTool('commandExecution', { command: 'yarn test', cwd: '/repo' }, '');
    assert.strictEqual(rendered.header, 'yarn test');
  });

  test('an mcp tool call names the server and the tool', () => {
    const rendered = renderTool('mcpToolCall', { server: 'github', toolName: 'list_prs' }, '');
    assert.strictEqual(rendered.header.includes('github'), true);
    assert.strictEqual(rendered.header.includes('list_prs'), true);
  });

  test('command output renders as an output block', () => {
    const rendered = renderTool('commandExecution', { command: 'ls' }, 'a\nb');
    assert.strictEqual(rendered.blocks.some((b) => b.kind === 'output'), true);
  });
});
```

Match the actual `renderTool` signature and block-kind names already in that file — the names above are placeholders for whatever it really exports.

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:unit --grep "tool-render: codex"`
Expected: FAIL — the header falls through to the generic JSON rendering.

- [ ] **Step 3: Add the Codex arm**

Extend the name switch in `tool-render.ts`. Reuse the existing command, diff, path and output block builders — Codex needs no new block kinds, only new names mapped onto them:

```ts
    case 'commandExecution': return command(input.command, input.cwd);
    case 'fileChange': return diff(input);
    case 'mcpToolCall': return header(`${input.server} · ${input.toolName}`);
    case 'webSearch': return header(input.query ?? 'Web search');
    case 'plan': return header('Plan');
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test:unit --grep "tool-render"`
Expected: PASS, including the pre-existing Claude cases.

- [ ] **Step 5: Run the UI detector**

Run: `node <impeccable-skill-dir>/scripts/detect.mjs --json src/webview/components/tool-render.ts`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/webview/components/tool-render.ts src/test/unit/tool-render.test.ts
git commit -m "feat: render codex tool calls with the existing block types"
```

---

### Task 10: Wire it into the extension

**Files:**
- Modify: `src/extension.ts:18-19`
- Modify: `package.json` (`contributes.configuration`, `contributes.commands`, `scripts`)

- [ ] **Step 1: Register the provider**

In `src/extension.ts`, after the Claude registration:

```ts
  providers.set('claude', new ClaudeProvider());
  providers.set('codex', new CodexProvider({
    binPath: vscode.workspace.getConfiguration('hiiiidCode').get<string>('codex.path'),
  }));
```

Order still matters for the same reason the existing comment gives: `SessionPicker` uses `state.catalog[0]` for the New button, so Claude stays first.

- [ ] **Step 2: Add the setting, the command and the dev script**

In `package.json`, under `contributes`:

```json
"configuration": {
  "title": "HiiiiD Code",
  "properties": {
    "hiiiidCode.codex.path": {
      "type": "string",
      "default": "",
      "description": "Path to the Codex CLI. Leave empty to use `codex` from PATH."
    }
  }
},
"commands": [
  {
    "command": "hiiiidCode.codex.login",
    "title": "HiiiiD Code: Sign in to Codex"
  }
]
```

and under `scripts`:

```json
"codex:bindings": "codex app-server generate-ts --out .codex-bindings"
```

Add `.codex-bindings/` to `.gitignore`.

- [ ] **Step 3: Implement the login command and the re-probe**

In `activate()`:

```ts
  context.subscriptions.push(
    vscode.commands.registerCommand('hiiiidCode.codex.login', () => {
      // `codex login` opens a browser flow and needs a real TTY, so this
      // hands the user a terminal rather than trying to drive it.
      const terminal = vscode.window.createTerminal('Codex login');
      terminal.show();
      terminal.sendText('codex login');
    }),
    // A changed path is a different install: re-probe, which is also how the
    // provider recovers from 'unavailable'. refreshModels already IS the
    // availability probe — see session-manager.
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('hiiiidCode.codex.path')) { void manager.refreshModels(defaultCwd); }
    }),
  );
```

- [ ] **Step 4: Verify the extension compiles and the suite passes**

Run: `yarn run compile && yarn test:unit && yarn test:dom`
Expected: PASS throughout.

- [ ] **Step 5: Manually verify in the dev host**

Press F5. With Codex installed and signed in: create a Codex session, confirm the mode menu shows five modes with no "Auto-edit", send a message, and approve a tool call. With `hiiiidCode.codex.path` set to a bogus value: confirm the provider shows as unavailable with the "not found" reason and that an existing Codex transcript still renders.

- [ ] **Step 6: Commit**

```bash
git add src/extension.ts package.json .gitignore
git commit -m "feat: register the Codex provider in the extension host"
```

---

### Task 11: Smoke and skew checks

**Files:**
- Create: `src/test/unit/codex-smoke.test.ts`

- [ ] **Step 1: Write the gated tests**

These need a real binary and a signed-in account, so they **skip** rather than fail when either is absent — a contributor without Codex must still get a green suite:

```ts
import { execFileSync } from 'node:child_process';

function codexAvailable(): boolean {
  try { execFileSync('codex', ['--version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

suite('codex smoke (opt-in)', function () {
  this.timeout(60_000);
  before(function () { if (!codexAvailable()) { this.skip(); } });

  test('every method name we send still exists in the generated protocol', () => {
    // The closest thing to the version negotiation the handshake does not
    // offer: InitializeResponse carries no protocol version, so a renamed
    // method would otherwise surface as a runtime failure in a user's panel.
    // Regenerate to a temp dir, then assert our constants are still there.
  });

  test('a plan-mode turn produces a session, text and a turn end', async () => {
    // Spawn the real app-server, initialize, thread/start in plan mode
    // (read-only: this test must not be able to write to the repo it runs
    // in), send "say hi", assert the event sequence.
  });

  test('resetsAt is still epoch seconds', async () => {
    // Pins the measurement map-usage depends on, so a CLI upgrade that
    // switched to milliseconds fails here rather than rendering a countdown
    // 50000 years out. Guard, not discovery: the unit was measured on
    // 0.147.0 and is epoch seconds.
    // account/rateLimits/read, then assert the raw value is within a year of
    // Date.now()/1000 rather than of Date.now().
  });
});
```

Fill in each body against the real protocol when implementing; the assertions are ordinary `assert.strictEqual` on event kinds.

- [ ] **Step 2: Run with and without Codex**

Run: `yarn test:unit --grep "codex smoke"`
Expected with Codex installed: PASS. Expected without: pending/skipped, never failed.

- [ ] **Step 3: Commit**

```bash
git add src/test/unit/codex-smoke.test.ts
git commit -m "test: add an opt-in codex smoke and protocol-skew check"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Transport, no new dependencies | 4, 8 |
| Process model, ref-counting, crash → error | 4, 7, 8 |
| Handshake, `experimentalApi`, opt-outs | 8 |
| Module layout | 3-8 |
| Permission modes declared per provider | 1, 2 |
| Codex's five modes, `acceptEdits` omitted | 3 |
| Auto mode via guardian, silent | 3 (settings), 7 (no transcript artifact) |
| Guardian denials → override card | 7 |
| Event mapping, tolerant parsing | 5 |
| Decisions → `ReviewDecision` | 7 |
| Declined input requests | 5, 7 |
| Availability via `fetchModels` rejection | 8, 10 |
| Version skew | 5 (tolerant), 11 (skew test) |
| Testing, `resetsAt` measured not assumed | 6, 11 |
| Host changes summary | 1, 2, 9, 10 |

**Deliberate deviations from the spec**, both recorded above:
- Availability needs no `ProviderInfo.unavailable` field — the existing `refreshModels` probe and `UnavailableProvider` already do it. The spec was corrected before this plan was written.
- `EffortLevel` gains `'ultra'`. The spec did not anticipate that `ReasoningEffort` is an open string; a live `model/list` on 0.147.0 then showed `ultra` is the only value outside the union, so the union widened rather than the adapter filtering.

**Measured during planning, so no task has to discover it:**
- Codex effort scales, live: `low|medium|high|xhigh|max|ultra` (gpt-5.6-sol, -terra), through `max` (-luna), through `xhigh` (gpt-5.5, 5.4, 5.4-mini). No `minimal`.
- `resetsAt` is epoch seconds. `usedPercent` is already a percentage.
- A Plus account reports `primary` only, with `secondary: null`.

**Type consistency:** `PermissionModeInfo` (Task 1) is consumed by name in Tasks 2, 3, 8. `CodexThreadSettings` (3) by 7. `AppServer` / `RequestId` / `Duplex` (4) by 5, 7, 8. `mapNotification` / `approvalEventOf` / `DECLINED_INPUT_METHODS` (5) by 7. `toUsageWindows` / `toContextBreakdown` (6) by 7, 8. `CodexRun` (7) by 8. `CODEX_MODES` / `effortLevelsOf` (3) by 8.

**Known looseness:** Tasks 7, 8 and 9 specify behavior plus the comments that must survive, rather than full bodies — `CodexRun` and `CodexProvider` are 200+ lines each and `tool-render.ts`'s exact block API has to be read at implementation time. Every behavior in those tasks is pinned by a named test above, so the gate is unambiguous even where the body is not transcribed.
