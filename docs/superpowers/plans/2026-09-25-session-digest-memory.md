# Session Digest Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the raw-prompt memory snippet and the separate history summary cache with one structured per-session digest, an optional LLM summarizer, tiered recall, a reindex path, and a `marcode.memory.enabled` switch.

**Architecture:** A `DigestService` is the single writer of a `SessionDigest`, stored in a `digests` table beside the FTS table in `memory.sqlite`. `SessionState.summary` becomes a projection of it. The LLM summarizer is a hidden, tool-less `AgentRun` started with a new `StartOptions.withoutSelfControl` flag. Recall returns one-line pointers, then the digest, then the transcript slice. With `memory.enabled = false` no store, service, recall tool or priming exists and the history tab keeps its legacy extractive summary.

**Tech Stack:** TypeScript, `node:sqlite` (FTS5), mocha (TDD `suite`/`test`), React 19 + shadcn (Base UI) for the history tab.

**Spec:** [docs/superpowers/specs/2026-09-25-session-digest-memory-design.md](../specs/2026-09-25-session-digest-memory-design.md)

**Already on this branch** (`feat/memory-priming`, commit `3310b1e`): first-message priming (`AgentSession.deliver` → `sink.recall`, `SessionManager.recall`, `prime-block.ts`), `match: 'any'` on `MemoryStore.search`.

## Global Constraints

- `src/protocol/messages.ts` is types-only; nothing under `src/providers/` or `src/protocol/` imports `vscode`; neither does `src/host/message-router.ts`.
- Every protocol message addressed to a session carries an explicit `SessionId`.
- Errors are state, never exceptions: a failing summarizer or store never rejects out of `close()`, `send()` or a router handler.
- A digest write never touches `SessionState.updatedAt` (it is the history sort key and the summary cache key).
- Filenames are kebab-case. No bare `<button>`/`<input>`; use `@/components/ui/*`; compose classNames with `cn`.
- DOM tests drive components through the real `StoreProvider` via `sendFromHost`; never pass a DOM node to an assertion (compare booleans, strings, counts).
- Comments only for non-obvious "why". Split any file that passes ~300 lines.
- `marcode.memory.summarizer`: `provider` and `model` are required when `mode` is `llm`; `effort` optional, default `low`; bad config warns once and falls back to `off`. LLM digests only for closed sessions.
- `marcode.memory.enabled` defaults to `true`; a change prompts a window reload.
- Conventional-commit prefixes. No `Co-Authored-By`/Claude/Anthropic trailer on any commit. `yarn lint`, `yarn check-types` and `yarn run compile` must pass before a commit that changes source.
- Tests: `yarn test:unit` / `yarn test:dom` (RAM-guarded). Never the `:raw` variants.

## Review Focus

Failure modes the spec implies that no single task's happy path covers. Each has a test in the task named in brackets.

1. `memory.enabled = false`: the history tab must still show summaries, recall tools must not be listed, no sqlite file opened. [Task 2, Task 9]
2. The model replies with JSON wrapped in prose or a markdown fence, or with garbage: the fence case parses, the garbage case keeps the extractive digest and the session stays findable. [Task 6, Task 8]
3. The configured summarizer provider is not registered (disabled in `enabledProviders`): one warning at activate, extractive digests continue. [Task 13]
4. A long reindex is running when a session closes: the close-time digest is not starved behind hundreds of queued sessions. [Task 8]
5. The window reloads mid-reindex: re-running skips every session whose digest is current, so it resumes rather than restarts. [Task 8]

---

## File Structure

| File | Responsibility |
|---|---|
| `src/shared/memory-settings.ts` (new) | Setting ids, `validateSummarizer` (pure) |
| `src/memory/digest.ts` (new) | `SessionDigest`, `extractiveDigest`, `indexLine`, `digestText`, `SUMMARIZER_VERSION` |
| `src/memory/session-digest.ts` | `digestSession` becomes a thin wrapper over `digest.ts` |
| `src/memory/types.ts` | `MemoryStore` gains `getDigest`, `digestMeta`; `SessionRecord` drops `title`, gains optional `digest`; `Summarizer` removed |
| `src/memory/fts-memory-store.ts` | `digests` table, digest-derived FTS row, schema v2, no summarizer arg |
| `src/memory/extractive-summarizer.ts` | Deleted |
| `src/memory/prime-block.ts` | Block text points at digest fetch |
| `src/host/digest/llm-prompt.ts` (new) | `buildSummaryPrompt`, `parseLlmDigest` (pure) |
| `src/host/digest/llm-summarizer.ts` (new) | `LlmSummarizer`: the hidden run |
| `src/host/digest/digest-service.ts` (new) | Serial queue, `refresh`, `upgrade`, `ensureCurrent`, `reindex`, `estimate`, `cancel` |
| `src/host/session-manager.ts` | Owns the service; archive/dispose/ensureSummaries/memory-* methods |
| `src/host/self-control-mcp-server.ts` | Recall tools only with a store; `recall_fetch` tiers; nudge in `instructions` |
| `src/providers/types.ts` + 3 providers | `StartOptions.withoutSelfControl` |
| `src/protocol/messages.ts`, `src/host/message-router.ts`, `src/host/post-bus.ts` | `memory-*` messages |
| `src/history/*` | Status, estimate, progress, per-row and bulk actions |
| `src/extension.ts`, `package.json` | Settings, gating, summarizer wiring, `marcode.memory.reindex` |

---

### Task 1: Memory settings

**Files:**
- Create: `src/shared/memory-settings.ts`
- Test: `src/test/unit/memory-settings.test.ts`
- Modify: `package.json` (configuration block, after `marcode.debug`)

**Interfaces:**
- Produces:
  - `MEMORY_ENABLED_SETTING = 'marcode.memory.enabled'`, `MEMORY_SUMMARIZER_SETTING = 'marcode.memory.summarizer'`
  - `interface LlmSummarizerConfig { provider: string; model: string; effort: EffortLevel }`
  - `type SummarizerSetting = { mode: 'off' } | ({ mode: 'llm' } & LlmSummarizerConfig)`
  - `validateSummarizer(configured: unknown, providerIds: Iterable<string>): { setting: SummarizerSetting; warnings: string[] }`

- [ ] **Step 1: Write the failing test**

```ts
import * as assert from 'node:assert';
import { suite, test } from 'mocha';
import { validateSummarizer } from '../../shared/memory-settings';

const ids = ['claude', 'codex', 'opencode'];

suite('validateSummarizer', () => {
  test('undefined is off with no warning', () => {
    assert.deepStrictEqual(validateSummarizer(undefined, ids), { setting: { mode: 'off' }, warnings: [] });
  });

  test('llm with provider and model is accepted and effort defaults to low', () => {
    const { setting, warnings } = validateSummarizer(
      { mode: 'llm', provider: 'claude', model: 'claude-haiku-4-5' }, ids,
    );
    assert.deepStrictEqual(setting, { mode: 'llm', provider: 'claude', model: 'claude-haiku-4-5', effort: 'low' });
    assert.deepStrictEqual(warnings, []);
  });

  test('llm without a model warns and falls back to off', () => {
    const { setting, warnings } = validateSummarizer({ mode: 'llm', provider: 'claude' }, ids);
    assert.deepStrictEqual(setting, { mode: 'off' });
    assert.strictEqual(warnings.length, 1);
    assert.strictEqual(warnings[0].includes('model'), true);
  });

  test('llm with an unknown provider warns and falls back to off', () => {
    const { setting, warnings } = validateSummarizer({ mode: 'llm', provider: 'nope', model: 'm' }, ids);
    assert.deepStrictEqual(setting, { mode: 'off' });
    assert.strictEqual(warnings[0].includes('"nope"'), true);
  });

  test('an invalid effort warns and uses low', () => {
    const { setting, warnings } = validateSummarizer(
      { mode: 'llm', provider: 'codex', model: 'm', effort: 'turbo' }, ids,
    );
    assert.deepStrictEqual(setting, { mode: 'llm', provider: 'codex', model: 'm', effort: 'low' });
    assert.strictEqual(warnings.length, 1);
  });

  test('a non-object warns and is off', () => {
    const { setting, warnings } = validateSummarizer('llm', ids);
    assert.deepStrictEqual(setting, { mode: 'off' });
    assert.strictEqual(warnings.length, 1);
  });

  test('an unknown mode warns and is off', () => {
    const { setting, warnings } = validateSummarizer({ mode: 'fast' }, ids);
    assert.deepStrictEqual(setting, { mode: 'off' });
    assert.strictEqual(warnings.length, 1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `yarn test:unit`
Expected: FAIL, "Cannot find module '../../shared/memory-settings'".

- [ ] **Step 3: Implement**

```ts
import type { EffortLevel } from '../providers/types';

export const MEMORY_ENABLED_SETTING = 'marcode.memory.enabled';
export const MEMORY_SUMMARIZER_SETTING = 'marcode.memory.summarizer';

const EFFORTS: readonly EffortLevel[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

export interface LlmSummarizerConfig { provider: string; model: string; effort: EffortLevel }
export type SummarizerSetting = { mode: 'off' } | ({ mode: 'llm' } & LlmSummarizerConfig);
export interface SummarizerValidation { setting: SummarizerSetting; warnings: string[] }

const OFF: SummarizerSetting = { mode: 'off' };

export function validateSummarizer(configured: unknown, providerIds: Iterable<string>): SummarizerValidation {
  if (configured === undefined) { return { setting: OFF, warnings: [] }; }
  if (typeof configured !== 'object' || configured === null || Array.isArray(configured)) {
    return { setting: OFF, warnings: [`${MEMORY_SUMMARIZER_SETTING} is not an object; ignoring it.`] };
  }
  const value = configured as Record<string, unknown>;
  if (value.mode === undefined || value.mode === 'off') { return { setting: OFF, warnings: [] }; }
  if (value.mode !== 'llm') {
    return { setting: OFF, warnings: [`${MEMORY_SUMMARIZER_SETTING}.mode must be "off" or "llm"; using "off".`] };
  }
  const known = new Set(providerIds);
  const warnings: string[] = [];
  if (typeof value.provider !== 'string' || !known.has(value.provider)) {
    warnings.push(`${MEMORY_SUMMARIZER_SETTING}.provider "${String(value.provider)}" is not an enabled provider; using "off".`);
  }
  if (typeof value.model !== 'string' || value.model.trim() === '') {
    warnings.push(`${MEMORY_SUMMARIZER_SETTING}.model is required when mode is "llm"; using "off".`);
  }
  if (warnings.length > 0) { return { setting: OFF, warnings }; }
  let effort: EffortLevel = 'low';
  if (value.effort !== undefined) {
    if (EFFORTS.includes(value.effort as EffortLevel)) {
      effort = value.effort as EffortLevel;
    } else {
      warnings.push(`${MEMORY_SUMMARIZER_SETTING}.effort "${String(value.effort)}" is not a known level; using "low".`);
    }
  }
  return {
    setting: { mode: 'llm', provider: value.provider as string, model: value.model as string, effort },
    warnings,
  };
}
```

- [ ] **Step 4: Add the two settings to `package.json`**

Insert after the `marcode.debug` property inside `contributes.configuration.properties`:

```json
        "marcode.memory.enabled": {
          "type": "boolean",
          "default": true,
          "description": "Index closed sessions and let agents recall them. Turn off if another memory plugin already does this. Requires a window reload."
        },
        "marcode.memory.summarizer": {
          "type": "object",
          "default": { "mode": "off" },
          "description": "How session digests are written. \"off\" builds them from the transcript with no model call. \"llm\" runs a hidden agent on session close using the provider, model and effort below. Requires a window reload.",
          "properties": {
            "mode": { "type": "string", "enum": ["off", "llm"], "default": "off" },
            "provider": { "type": "string", "description": "A provider or instance id, e.g. \"claude\". Required when mode is \"llm\"." },
            "model": { "type": "string", "description": "A model id that provider lists. Required when mode is \"llm\"." },
            "effort": { "type": "string", "enum": ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"], "default": "low" }
          },
          "additionalProperties": false
        },
```

- [ ] **Step 5: Run tests, then commit**

Run: `yarn test:unit` — Expected: PASS.

```bash
git add src/shared/memory-settings.ts src/test/unit/memory-settings.test.ts package.json
git commit -m "feat: add marcode.memory.enabled and marcode.memory.summarizer settings"
```

---

### Task 2: Gate memory on `memory.enabled`; recall tools only with a store

**Files:**
- Modify: `src/extension.ts:248-257` (store creation), `src/extension.ts:653-685` (reload prompt)
- Modify: `src/host/self-control-mcp-server.ts:121-130` (instructions), `:296-341` (tool registration)
- Modify: `src/providers/marcode-context.ts` (remove the recall nudge sentence added in `3310b1e`)
- Test: `src/test/unit/self-control-mcp-server.test.ts`

**Interfaces:**
- Consumes: `MEMORY_ENABLED_SETTING`, `MEMORY_SUMMARIZER_SETTING` (Task 1).
- Produces: with no `MemoryStore`, `tools/list` contains neither recall tool and the MCP `instructions` do not mention `marcode__recall`.

- [ ] **Step 1: Replace the old "errors without a store" test with a failing one**

In `self-control-mcp-server.test.ts`, replace the test `'marcode__recall errors without a MemoryStore configured'` with:

```ts
  test('the recall tools are not listed without a MemoryStore', async () => {
    const server = new SelfControlMcpServer(fakeManager());
    const config = await server.start();
    const res = await fetch(config.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream',
        authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const body = await res.json() as { result: { tools: { name: string }[] } };
    const names = body.result.tools.map((t) => t.name);
    assert.strictEqual(names.includes('marcode__recall'), false);
    assert.strictEqual(names.includes('marcode__recall_fetch'), false);
    assert.strictEqual(names.includes('marcode__list_sessions'), true);
    await server.dispose();
  });

  test('the recall tools are listed with a MemoryStore', async () => {
    const server = new SelfControlMcpServer(fakeManager(), fakeMemory({}));
    const config = await server.start();
    const res = await fetch(config.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream',
        authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const body = await res.json() as { result: { tools: { name: string }[] } };
    assert.strictEqual(body.result.tools.some((t) => t.name === 'marcode__recall'), true);
    await server.dispose();
  });
```

If the file's other tests reach the server at a URL other than `config.url` (for example with `?sid=`), mirror the `callFor` helper near line 438 for the request URL.

- [ ] **Step 2: Run to verify it fails**

Run: `yarn test:unit`
Expected: FAIL, `marcode__recall` is still listed without a store.

- [ ] **Step 3: Gate the tools and the instructions**

In `self-control-mcp-server.ts`, replace the `instructions:` string's recall clause and add a local before the `new McpServer(...)` call:

```ts
    const recallClause = this.memory
      ? ', and marcode__recall/marcode__recall_fetch to search what past sessions already figured out '
        + '(when a task resembles earlier work, search before starting from scratch)'
      : '';
```

and change the instructions to:

```ts
      instructions: 'You are one of several agent sessions running side by side in Marcode, a VS '
        + 'Code panel. Each session is its own pane, possibly a different provider (Claude, Codex, '
        + 'OpenCode) and a different working directory. These marcode__* tools are how you interact '
        + 'with the panel itself, not with files or the user directly: marcode__list_sessions to see '
        + 'who else is running, marcode__send_message to message another session, marcode__spawn_session '
        + 'to start a new one (marcode__list_models finds the provider/model ids it accepts), marcode__close_session to close one (e.g. a worker you spawned once it '
        + `has reported back)${recallClause}. Check marcode__list_sessions whenever coordinating with, or delegating `
        + 'to, another session would help — do not assume you are alone just because nothing mentioned '
        + 'these tools yet.',
```

Wrap both `mcp.registerTool('marcode__recall', ...)` and `mcp.registerTool('marcode__recall_fetch', ...)` in `if (this.memory) { ... }`, and inside the two handlers replace `this.memory` uses with a local `const memory = this.memory;` captured before the `if` so TypeScript narrows it. Delete the now-unreachable `if (!this.memory) { return { isError: true, ... } }` guards.

- [ ] **Step 4: Remove the nudge from the always-on intro**

In `src/providers/marcode-context.ts`, restore the original single sentence (drop the added `Earlier sessions in this workspace may have solved related problems...` lines):

```ts
export const MARCODE_INTRO =
  '<marcode-context>You are running inside Marcode, a VS Code extension that hosts you in '
  + 'a resizable split-pane session alongside other concurrent agent sessions.</marcode-context>';
```

- [ ] **Step 5: Gate store creation and add the reload prompt**

In `extension.ts`, add `import { MEMORY_ENABLED_SETTING, MEMORY_SUMMARIZER_SETTING } from './shared/memory-settings';` and change the store block:

```ts
  const memoryEnabled = vscode.workspace.getConfiguration().get<boolean>(MEMORY_ENABLED_SETTING, true);
  let memory: MemoryStore | undefined;
  if (memoryEnabled) {
    try {
      memory = new FtsMemoryStore(
        path.join(rootDir, 'memory.sqlite'),
        new ExtractiveSummarizer(),
        { tail: (id, limit) => store.tail(id, limit) },
      );
    } catch (err) {
      console.warn('[mar-code] memory store unavailable; recall tools will be disabled', err);
    }
  }
```

Task 4 removes the `ExtractiveSummarizer` argument and its import.

Inside the `onDidChangeConfiguration` handler, after the `PROVIDER_INSTANCES_SETTING` block, add:

```ts
      if (e.affectsConfiguration(MEMORY_ENABLED_SETTING) || e.affectsConfiguration(MEMORY_SUMMARIZER_SETTING)) {
        const reload = 'Reload window';
        void vscode.window.showInformationMessage(
          'Memory settings changed. Reload the window to apply them.',
          reload,
        ).then((choice) => {
          if (choice !== reload) { return; }
          void vscode.commands.executeCommand('workbench.action.reloadWindow');
        });
      }
```

- [ ] **Step 6: Verify and commit**

Run: `yarn check-types && yarn lint && yarn test:unit` — Expected: all pass.

```bash
git add -A src package.json
git commit -m "feat: honor marcode.memory.enabled and list recall tools only with a store"
```

---

### Task 3: The digest model

**Files:**
- Create: `src/memory/digest.ts`
- Modify: `src/memory/session-digest.ts`
- Test: `src/test/unit/digest.test.ts` (existing `session-digest` test must keep passing)

**Interfaces:**
- Produces:
  - `SUMMARIZER_VERSION = 1`
  - `interface SessionDigest { title: string; request: string; outcome: string; filesEdited: string[]; learned?: string; decisions?: string[]; nextSteps?: string[]; source: 'extractive' | 'llm'; summarizerVersion: number; forUpdatedAt: number }`
  - `extractiveDigest(items: TranscriptItem[], forUpdatedAt: number): SessionDigest | undefined` (undefined when there is no user text)
  - `indexLine(d: SessionDigest): string`
  - `digestText(d: SessionDigest): string`

- [ ] **Step 1: Write the failing test**

```ts
import * as assert from 'node:assert';
import { suite, test } from 'mocha';
import { digestText, extractiveDigest, indexLine, SUMMARIZER_VERSION } from '../../memory/digest';
import type { TranscriptItem } from '../../protocol/messages';

const user = (id: string, text: string): TranscriptItem => ({ id, ts: 0, role: 'user', text });
const assistant = (id: string, text: string): TranscriptItem => ({ id, ts: 0, role: 'assistant', text });

suite('extractiveDigest', () => {
  test('takes the first user text as title and request, the last assistant text as outcome', () => {
    const d = extractiveDigest([
      user('u1', 'Fix the flaky login test'), assistant('a1', 'Looking'), assistant('a2', 'Added a retry'),
    ], 42)!;
    assert.strictEqual(d.title, 'Fix the flaky login test');
    assert.strictEqual(d.request, 'Fix the flaky login test');
    assert.strictEqual(d.outcome, 'Added a retry');
    assert.strictEqual(d.source, 'extractive');
    assert.strictEqual(d.summarizerVersion, SUMMARIZER_VERSION);
    assert.strictEqual(d.forUpdatedAt, 42);
  });

  test('returns undefined when there is no user text', () => {
    assert.strictEqual(extractiveDigest([assistant('a1', 'hi')], 1), undefined);
    assert.strictEqual(extractiveDigest([], 1), undefined);
  });

  test('clips a long request and outcome', () => {
    const d = extractiveDigest([user('u1', 'x'.repeat(500)), assistant('a1', 'y'.repeat(500))], 1)!;
    assert.strictEqual(d.title.length <= 161, true);
    assert.strictEqual(d.outcome.length <= 201, true);
  });
});

suite('indexLine and digestText', () => {
  test('indexLine joins title and outcome and counts edited files', () => {
    const d = extractiveDigest([user('u1', 'Fix it'), assistant('a1', 'Done')], 1)!;
    d.filesEdited = ['a.ts', 'b.ts'];
    assert.strictEqual(indexLine(d), 'Fix it → Done · 2 files edited');
  });

  test('indexLine omits the outcome and files when absent', () => {
    const d = extractiveDigest([user('u1', 'Just asking')], 1)!;
    assert.strictEqual(indexLine(d), 'Just asking');
  });

  test('digestText renders llm-only fields when present', () => {
    const d = extractiveDigest([user('u1', 'Fix it'), assistant('a1', 'Done')], 1)!;
    d.learned = 'The cache key ignored cwd';
    d.decisions = ['Key on cwd'];
    d.nextSteps = ['Add a test'];
    const text = digestText(d);
    assert.strictEqual(text.includes('Learned: The cache key ignored cwd'), true);
    assert.strictEqual(text.includes('- Key on cwd'), true);
    assert.strictEqual(text.includes('- Add a test'), true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `yarn test:unit` — Expected: FAIL, module `../../memory/digest` not found.

- [ ] **Step 3: Implement `src/memory/digest.ts`**

```ts
import type { TranscriptItem } from '../protocol/messages';

export const SUMMARIZER_VERSION = 1;

const TITLE_MAX = 160;
const REQUEST_MAX = 400;
const OUTCOME_MAX = 200;

export interface SessionDigest {
  title: string;
  request: string;
  outcome: string;
  filesEdited: string[];
  learned?: string;
  decisions?: string[];
  nextSteps?: string[];
  source: 'extractive' | 'llm';
  summarizerVersion: number;
  forUpdatedAt: number;
}

export const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();
export const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);

/** Top-level items only: a subagent's children are its own work, summarised by its own spawn card. */
export function extractiveDigest(items: TranscriptItem[], forUpdatedAt: number): SessionDigest | undefined {
  let request = '';
  let outcome = '';
  const edited = new Set<string>();
  for (const item of items) {
    if (item.role === 'user' && request === '') { request = squash(item.text); }
    if (item.role === 'assistant') {
      const text = squash(item.text);
      if (text !== '') { outcome = text; }
    }
    if (item.role === 'tool' && item.tool.kind === 'file-edit') {
      for (const file of item.tool.files) { edited.add(file.path); }
    }
  }
  if (request === '') { return undefined; }
  return {
    title: clip(request, TITLE_MAX),
    request: clip(request, REQUEST_MAX),
    outcome: clip(outcome, OUTCOME_MAX),
    filesEdited: [...edited],
    source: 'extractive',
    summarizerVersion: SUMMARIZER_VERSION,
    forUpdatedAt,
  };
}

export function indexLine(d: SessionDigest): string {
  let out = d.title;
  if (d.outcome !== '') { out += ` → ${d.outcome}`; }
  const n = d.filesEdited.length;
  if (n > 0) { out += ` · ${n} ${n === 1 ? 'file' : 'files'} edited`; }
  return out;
}

export function digestText(d: SessionDigest): string {
  const lines = [`Title: ${d.title}`, `Request: ${d.request}`];
  if (d.outcome !== '') { lines.push(`Outcome: ${d.outcome}`); }
  if (d.learned) { lines.push(`Learned: ${d.learned}`); }
  if (d.decisions && d.decisions.length > 0) { lines.push('Decisions:', ...d.decisions.map((x) => `- ${x}`)); }
  if (d.nextSteps && d.nextSteps.length > 0) { lines.push('Next steps:', ...d.nextSteps.map((x) => `- ${x}`)); }
  if (d.filesEdited.length > 0) { lines.push(`Files edited: ${d.filesEdited.join(', ')}`); }
  lines.push(`(${d.source} summary)`);
  return lines.join('\n');
}
```

- [ ] **Step 4: Make `digestSession` a wrapper**

Replace `src/memory/session-digest.ts` with:

```ts
import type { TranscriptItem } from '../protocol/messages';
import { extractiveDigest, indexLine } from './digest';

/** The extractive one-liner. Kept for the memory-off history path. */
export function digestSession(items: TranscriptItem[]): string {
  const digest = extractiveDigest(items, 0);
  return digest ? indexLine(digest) : '';
}
```

- [ ] **Step 5: Run tests and commit**

Run: `yarn test:unit` — Expected: PASS (the existing session-digest test still passes; output is byte-identical).

```bash
git add src/memory src/test/unit/digest.test.ts
git commit -m "feat: add the structured session digest model"
```

---

### Task 4: Store the digest (schema v2)

**Files:**
- Modify: `src/memory/types.ts`, `src/memory/fts-memory-store.ts`
- Delete: `src/memory/extractive-summarizer.ts`, `src/test/unit/extractive-summarizer.test.ts`
- Modify: `src/test/unit/fts-memory-store.test.ts`, `src/test/unit/session-manager-memory.test.ts`, `src/extension.ts`
- Test: `src/test/unit/fts-memory-store.test.ts`

**Interfaces:**
- Consumes: `SessionDigest`, `extractiveDigest`, `indexLine` (Task 3).
- Produces:
  - `SessionRecord { sessionId; providerId; cwd; closedAt: number; items: TranscriptItem[]; digest?: SessionDigest }` (no `title`; `digest` defaults to `extractiveDigest(items, closedAt)`)
  - `type DigestMeta = Pick<SessionDigest, 'source' | 'summarizerVersion' | 'forUpdatedAt'>`
  - `MemoryStore.getDigest(sessionId: SessionId): Promise<SessionDigest | undefined>`
  - `MemoryStore.digestMeta(): Promise<Map<SessionId, DigestMeta>>`
  - `new FtsMemoryStore(dbPath, transcripts, schemaVersion?)` (summarizer argument removed)

- [ ] **Step 1: Write the failing tests**

Append to `fts-memory-store.test.ts` (and see Step 2 for the mechanical edits to the file's existing calls):

```ts
  test('index() stores a digest that getDigest() and digestMeta() return', async () => {
    const store = new FtsMemoryStore(await tempDbPath(), noopReader);
    await store.index({
      sessionId: 's1', providerId: 'claude', cwd: '/repo', closedAt: 1000,
      items: [userItem('u1', 'Fix the flaky login test')],
    });
    const digest = await store.getDigest('s1');
    assert.strictEqual(digest?.title, 'Fix the flaky login test');
    assert.strictEqual(digest?.source, 'extractive');
    const meta = (await store.digestMeta()).get('s1');
    assert.strictEqual(meta?.forUpdatedAt, 1000);
  });

  test('an explicit digest wins over the extractive default and is what search shows', async () => {
    const store = new FtsMemoryStore(await tempDbPath(), noopReader);
    const items = [userItem('u1', 'Fix the flaky login test')];
    await store.index({
      sessionId: 's1', providerId: 'claude', cwd: '/repo', closedAt: 1000, items,
      digest: {
        title: 'Login retry', request: 'Fix the flaky login test', outcome: 'Added a retry to the auth fixture',
        filesEdited: [], source: 'llm', summarizerVersion: 1, forUpdatedAt: 1000,
      },
    });
    const hits = await store.search('flaky login');
    assert.strictEqual(hits[0].snippet, 'Login retry → Added a retry to the auth fixture');
    assert.strictEqual((await store.digestMeta()).get('s1')?.source, 'llm');
  });

  test('forget() removes the digest as well', async () => {
    const store = new FtsMemoryStore(await tempDbPath(), noopReader);
    await store.index({
      sessionId: 's1', providerId: 'claude', cwd: '/repo', closedAt: 1000,
      items: [userItem('u1', 'Fix it')],
    });
    await store.forget('s1');
    assert.strictEqual(await store.getDigest('s1'), undefined);
    assert.strictEqual((await store.digestMeta()).size, 0);
  });

  test('a schema bump drops the digests table with the FTS table', async () => {
    const dbPath = await tempDbPath();
    const first = new FtsMemoryStore(dbPath, noopReader, 1);
    await first.index({
      sessionId: 's1', providerId: 'claude', cwd: '/repo', closedAt: 1000,
      items: [userItem('u1', 'Fix it')],
    });
    const second = new FtsMemoryStore(dbPath, noopReader, 2);
    assert.strictEqual((await second.digestMeta()).size, 0);
  });
```

- [ ] **Step 2: Mechanical test edits, then confirm red**

Run:

```bash
sed -i "s/new ExtractiveSummarizer(), //g; /import { ExtractiveSummarizer }/d; s/title: 'Untitled', //g" src/test/unit/fts-memory-store.test.ts
git rm -q src/memory/extractive-summarizer.ts src/test/unit/extractive-summarizer.test.ts
```

Run: `yarn test:unit` — Expected: FAIL (constructor arity, missing methods).

- [ ] **Step 3: Update `src/memory/types.ts`**

Remove the `Summarizer` interface. Change `SessionRecord` and `MemoryStore`:

```ts
import type { SessionDigest } from './digest';

/** What `MemoryStore.index()` needs to make one session findable later. */
export interface SessionRecord {
  sessionId: SessionId;
  providerId: string;
  cwd: string;
  closedAt: number;
  /** The full transcript at index time — the caller already has this in memory. */
  items: TranscriptItem[];
  /** Absent means "build the extractive digest from `items`". */
  digest?: SessionDigest;
}

export type DigestMeta = Pick<SessionDigest, 'source' | 'summarizerVersion' | 'forUpdatedAt'>;
```

and add to `MemoryStore`:

```ts
  /** The stored digest for one session, if any. */
  getDigest(sessionId: SessionId): Promise<SessionDigest | undefined>;
  /** Cheap: every stored digest's freshness, so a caller can skip current ones. */
  digestMeta(): Promise<Map<SessionId, DigestMeta>>;
```

Update the `MemoryStore` doc comment's "Called once a session archives. Never called on a live session." to "Called when a session archives, and by the history and reindex passes for any session with content."

- [ ] **Step 4: Update `src/memory/fts-memory-store.ts`**

Constructor and schema (replace the constructor, drop the `summarizer` field and its import):

```ts
  constructor(
    dbPath: string,
    private readonly transcripts: TranscriptReader,
    schemaVersion: number = SCHEMA_VERSION,
  ) {
    this.db = new DatabaseSync(dbPath);
    const { user_version: onDiskVersion } = this.db.prepare('PRAGMA user_version').get() as {
      user_version: number;
    };
    if (onDiskVersion !== schemaVersion) {
      this.db.exec('DROP TABLE IF EXISTS sessions_fts; DROP TABLE IF EXISTS digests;');
      this.db.exec(`PRAGMA user_version = ${schemaVersion};`);
    }
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
        title, summary, text,
        sessionId UNINDEXED, providerId UNINDEXED, cwd UNINDEXED,
        firstItemId UNINDEXED, closedAt UNINDEXED
      );
      CREATE TABLE IF NOT EXISTS digests (
        sessionId TEXT PRIMARY KEY, source TEXT NOT NULL, summarizerVersion INTEGER NOT NULL,
        forUpdatedAt INTEGER NOT NULL, json TEXT NOT NULL
      );
    `);
  }
```

Set `const SCHEMA_VERSION = 2;`, keep its explanatory comment and add "v2 adds the `digests` table and derives the FTS row from it." Then:

```ts
  async index(record: SessionRecord): Promise<void> {
    const digest = record.digest ?? extractiveDigest(record.items, record.closedAt);
    const firstItemId = record.items[0]?.id;
    if (!firstItemId || !digest) { return; }
    const text = record.items
      .map((i) => ('text' in i ? i.text : ''))
      .filter((t) => t.length > 0)
      .join('\n');

    this.db.exec('BEGIN');
    try {
      this.deleteRows(record.sessionId);
      this.db.prepare(`
        INSERT INTO sessions_fts (title, summary, text, sessionId, providerId, cwd, firstItemId, closedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        digest.title, indexLine(digest), text,
        record.sessionId, record.providerId, record.cwd, firstItemId, record.closedAt,
      );
      this.db.prepare(`
        INSERT INTO digests (sessionId, source, summarizerVersion, forUpdatedAt, json)
        VALUES (?, ?, ?, ?, ?)
      `).run(record.sessionId, digest.source, digest.summarizerVersion, digest.forUpdatedAt, JSON.stringify(digest));
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  async forget(sessionId: SessionId): Promise<void> {
    this.deleteRows(sessionId);
  }

  private deleteRows(sessionId: SessionId): void {
    this.db.prepare('DELETE FROM sessions_fts WHERE sessionId = ?').run(sessionId);
    this.db.prepare('DELETE FROM digests WHERE sessionId = ?').run(sessionId);
  }

  async getDigest(sessionId: SessionId): Promise<SessionDigest | undefined> {
    const row = this.db.prepare('SELECT json FROM digests WHERE sessionId = ?').get(sessionId) as
      { json: string } | undefined;
    return row ? JSON.parse(row.json) as SessionDigest : undefined;
  }

  async digestMeta(): Promise<Map<SessionId, DigestMeta>> {
    const rows = this.db.prepare('SELECT sessionId, source, summarizerVersion, forUpdatedAt FROM digests').all() as
      Array<{ sessionId: string; source: 'extractive' | 'llm'; summarizerVersion: number; forUpdatedAt: number }>;
    return new Map(rows.map((r) => [r.sessionId, {
      source: r.source, summarizerVersion: r.summarizerVersion, forUpdatedAt: r.forUpdatedAt,
    }]));
  }
```

Add imports: `import { extractiveDigest, indexLine, type SessionDigest } from './digest';` and `DigestMeta` in the `./types` import; remove `Summarizer` from it. Update the class doc comment: rows are now per-session digests.

- [ ] **Step 5: Fix every other caller**

In `extension.ts`, drop `new ExtractiveSummarizer(),` from the `FtsMemoryStore` call and delete the `ExtractiveSummarizer` import. In `session-manager-memory.test.ts` add to `RecordingMemoryStore`:

```ts
  async getDigest(): Promise<undefined> { return undefined; }
  async digestMeta(): Promise<Map<string, never>> { return new Map(); }
```

and to the inline `memory: MemoryStore` object: `getDigest: async () => undefined, digestMeta: async () => new Map(),`. Do the same in `fakeMemory` in `self-control-mcp-server.test.ts`. Run `yarn check-types` and add the two methods to any other fake it flags.

In `session-manager.ts`, `indexForMemory` passes `title: state.title`; remove that property (Task 9 replaces the whole method).

- [ ] **Step 6: Verify and commit**

Run: `yarn check-types && yarn lint && yarn test:unit` — Expected: pass.

```bash
git add -A src
git commit -m "feat: store a structured digest per session and drop the raw-prompt summarizer"
```

---

### Task 5: `StartOptions.withoutSelfControl`

**Files:**
- Modify: `src/providers/types.ts:129-143`, `src/providers/claude/claude-provider.ts:600`, `src/providers/codex/codex-provider.ts:458`, `src/providers/opencode/opencode-provider.ts:292`
- Test: `src/test/unit/claude-provider.test.ts`, `src/test/unit/codex-provider.test.ts`, `src/test/unit/opencode-provider.test.ts` (create if absent; see step 1)

**Interfaces:**
- Produces: `StartOptions.withoutSelfControl?: boolean`. When true the run's `mcpServers`/`mcp_servers` carry no `marcode_self_control` entry.

- [ ] **Step 1: Write the failing tests**

`claude-provider.test.ts`, after the `'start() adds the self-control MCP server...'` test:

```ts
  test('start() omits the self-control MCP server when withoutSelfControl is set', async () => {
    const fake = fakeLoadQuery();
    const provider = new ClaudeProvider(fake.load as never, { url: 'http://127.0.0.1:1234/mcp', token: 'tok' });
    const run = provider.start({
      cwd: '/tmp', permissionMode: 'default', sessionId: 's', withoutSelfControl: true,
    });
    run.send('hi');
    await flushMicrotasks();
    assert.strictEqual(fake.calls[0].options.mcpServers, undefined);
    await run.dispose();
  });
```

`codex-provider.test.ts`, after the `'thread/start includes an mcp_servers config override...'` test:

```ts
  test('thread/start sends no mcp_servers override when withoutSelfControl is set', async () => {
    const { provider, respondTo, sent } = providerWithStub({
      selfControlMcp: { url: 'http://127.0.0.1:1/mcp', token: 'tok' },
    });
    const run = provider.start({
      cwd: '/tmp', permissionMode: 'default', sessionId: 's', withoutSelfControl: true,
    });
    run.send('hi');
    await respondTo('thread/start', { thread: { id: 'th_1' } });
    const started = sent().find((f) => f.method === 'thread/start');
    assert.strictEqual((started?.params as { config?: unknown }).config, undefined);
  });
```

For OpenCode the flag is a one-line passthrough into `AcpRun`'s options, already covered by `acp-run.test.ts`'s `'newSession carries an empty mcpServers list when no self-control config is given'`. Add a test there proving the passthrough contract on the option `AcpRun` receives:

```ts
  test('a run built without selfControlMcp carries an empty mcpServers list even when the provider has one', async () => {
    const p = peer();
    const run = new AcpRun(p.child, {
      cwd: '/w', permissionMode: 'default', tools: openCodeTools,
      modeId: openCodeModeId, clientName: 'mar-code', sessionId: 's',
      selfControlMcp: undefined,
    });
    const init = await p.waitFor('initialize');
    p.emit({ jsonrpc: '2.0', id: init.id, result: frames.initialize });
    const created = await p.waitFor('session/new');
    assert.deepStrictEqual((created.params as { mcpServers: unknown }).mcpServers, []);
    p.emit({ jsonrpc: '2.0', id: created.id, result: frames.newSession });
    await run.dispose();
  });
```

- [ ] **Step 2: Run to verify the first two fail**

Run: `yarn test:unit` — Expected: FAIL (type error surfaces at runtime as the flag being ignored: `mcpServers` still present).

- [ ] **Step 3: Implement**

`providers/types.ts`, inside `StartOptions`:

```ts
  /**
   * Leaves the self-control MCP server off this run. For internal, tool-less
   * runs (the digest summarizer) that must never reach `marcode__*` tools.
   */
  withoutSelfControl?: boolean;
```

Claude: change the gate at line 600 to
`...(this.selfControlMcp && !opts.withoutSelfControl ? {`.

Codex (`codex-provider.ts`, `start()`): change to
`...opts, selfControlMcp: opts.withoutSelfControl ? undefined : this.opts.selfControlMcp, systemPrompt: this.opts.systemPrompt,`.

OpenCode (`opencode-provider.ts`, `start()`): change line 292 to
`selfControlMcp: opts.withoutSelfControl ? undefined : this.selfControlMcp,`.

- [ ] **Step 4: Verify and commit**

Run: `yarn check-types && yarn test:unit` — Expected: pass.

```bash
git add -A src
git commit -m "feat: let a provider run start without the self-control MCP server"
```

---

### Task 6: LLM prompt builder and reply parser

**Files:**
- Create: `src/host/digest/llm-prompt.ts`
- Test: `src/test/unit/llm-prompt.test.ts`

**Interfaces:**
- Consumes: `SessionDigest`, `SUMMARIZER_VERSION`, `squash`, `clip` (Task 3).
- Produces: `buildSummaryPrompt(items: TranscriptItem[]): string`; `parseLlmDigest(reply: string, base: SessionDigest): SessionDigest` (throws on an unusable reply).

- [ ] **Step 1: Write the failing test**

```ts
import * as assert from 'node:assert';
import { suite, test } from 'mocha';
import { extractiveDigest } from '../../memory/digest';
import { buildSummaryPrompt, parseLlmDigest } from '../../host/digest/llm-prompt';
import type { TranscriptItem } from '../../protocol/messages';

const user = (id: string, text: string): TranscriptItem => ({ id, ts: 0, role: 'user', text });
const assistant = (id: string, text: string): TranscriptItem => ({ id, ts: 0, role: 'assistant', text });
const base = () => extractiveDigest([user('u1', 'Fix login'), assistant('a1', 'Done')], 7)!;

suite('buildSummaryPrompt', () => {
  test('keeps user prompts and each turn\'s last assistant text, and drops earlier assistant chatter', () => {
    const prompt = buildSummaryPrompt([
      user('u1', 'Fix login'), assistant('a1', 'Looking at it'), assistant('a2', 'Added a retry'),
      user('u2', 'Thanks'), assistant('a3', 'Welcome'),
    ]);
    assert.strictEqual(prompt.includes('USER: Fix login'), true);
    assert.strictEqual(prompt.includes('ASSISTANT: Added a retry'), true);
    assert.strictEqual(prompt.includes('Looking at it'), false);
  });

  test('caps the conversation and marks the omitted middle', () => {
    const items: TranscriptItem[] = [];
    for (let i = 0; i < 200; i++) { items.push(user(`u${i}`, 'q'.repeat(500)), assistant(`a${i}`, 'r'.repeat(500))); }
    const prompt = buildSummaryPrompt(items);
    assert.strictEqual(prompt.length < 20_000, true);
    assert.strictEqual(prompt.includes('middle omitted'), true);
  });

  test('tells the model to answer with one JSON object and use no tools', () => {
    const prompt = buildSummaryPrompt([user('u1', 'hi')]);
    assert.strictEqual(prompt.includes('ONE JSON object'), true);
    assert.strictEqual(prompt.includes('Do not use any tools'), true);
  });
});

suite('parseLlmDigest', () => {
  const reply = JSON.stringify({
    title: 'Login retry', request: 'Fix login', outcome: 'Added a retry',
    learned: 'Fixture raced', decisions: ['Retry twice'], nextSteps: [],
  });

  test('parses a bare JSON object into an llm digest that keeps the base identity', () => {
    const d = parseLlmDigest(reply, base());
    assert.strictEqual(d.source, 'llm');
    assert.strictEqual(d.title, 'Login retry');
    assert.strictEqual(d.forUpdatedAt, 7);
    assert.deepStrictEqual(d.decisions, ['Retry twice']);
    assert.strictEqual(d.learned, 'Fixture raced');
  });

  test('parses JSON wrapped in a markdown fence and prose', () => {
    const d = parseLlmDigest(`Here you go:\n\`\`\`json\n${reply}\n\`\`\`\nHope that helps.`, base());
    assert.strictEqual(d.outcome, 'Added a retry');
  });

  test('throws on a reply with no JSON object', () => {
    assert.throws(() => parseLlmDigest('I could not summarize this.', base()), /no JSON object/);
  });

  test('throws when title or outcome is missing', () => {
    assert.throws(() => parseLlmDigest('{"title":"x"}', base()), /missing title or outcome/);
  });

  test('clips an overlong title', () => {
    const d = parseLlmDigest(JSON.stringify({ title: 't'.repeat(300), outcome: 'o' }), base());
    assert.strictEqual(d.title.length <= 81, true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `yarn test:unit` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/host/digest/llm-prompt.ts`**

```ts
import { clip, squash, SUMMARIZER_VERSION, type SessionDigest } from '../../memory/digest';
import type { TranscriptItem } from '../../protocol/messages';

const USER_MAX = 600;
const ASSISTANT_MAX = 800;
const TOTAL_MAX = 16_000;
const FILES_MAX = 30;

const INSTRUCTIONS = [
  'You are summarizing a finished coding-agent session so a future session can find and reuse its work.',
  'Do not use any tools. Reply with ONE JSON object and nothing else, with exactly these keys:',
  'title (string, max 80 chars, what the session was about),',
  'request (string, the user\'s goal),',
  'outcome (string, max 200 chars, what was concluded or done),',
  'learned (string, durable facts worth remembering; may be empty),',
  'decisions (array of short strings), nextSteps (array of short strings).',
].join(' ');

export function buildSummaryPrompt(items: TranscriptItem[]): string {
  const lines: string[] = [];
  const edited = new Set<string>();
  let pending = '';
  const flush = () => {
    if (pending !== '') { lines.push(`ASSISTANT: ${clip(pending, ASSISTANT_MAX)}`); pending = ''; }
  };
  for (const item of items) {
    if (item.role === 'user') {
      flush();
      lines.push(`USER: ${clip(squash(item.text), USER_MAX)}`);
    } else if (item.role === 'assistant') {
      const text = squash(item.text);
      if (text !== '') { pending = text; }
    } else if (item.role === 'tool' && item.tool.kind === 'file-edit') {
      for (const file of item.tool.files) { edited.add(file.path); }
    }
  }
  flush();
  let body = lines.join('\n');
  if (body.length > TOTAL_MAX) {
    const half = TOTAL_MAX / 2;
    body = `${body.slice(0, half)}\n[…middle omitted…]\n${body.slice(-half)}`;
  }
  const files = [...edited].slice(0, FILES_MAX);
  return [
    INSTRUCTIONS, '', '<conversation>', body, '</conversation>',
    ...(files.length > 0 ? [`Files edited: ${files.join(', ')}`] : []),
  ].join('\n');
}

const text = (value: unknown, max: number): string =>
  (typeof value === 'string' ? clip(squash(value), max) : '');

const list = (value: unknown): string[] =>
  (Array.isArray(value)
    ? value.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => clip(squash(x), 160)).slice(0, 8)
    : []);

/** Throws on a reply with no usable title and outcome; the caller keeps the extractive digest. */
export function parseLlmDigest(reply: string, base: SessionDigest): SessionDigest {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start < 0 || end <= start) { throw new Error('no JSON object in summarizer reply'); }
  const raw = JSON.parse(reply.slice(start, end + 1)) as Record<string, unknown>;
  const title = text(raw.title, 80);
  const outcome = text(raw.outcome, 240);
  if (title === '' || outcome === '') { throw new Error('summarizer reply missing title or outcome'); }
  const learned = text(raw.learned, 600);
  return {
    ...base,
    title,
    request: text(raw.request, 400) || base.request,
    outcome,
    ...(learned !== '' ? { learned } : {}),
    decisions: list(raw.decisions),
    nextSteps: list(raw.nextSteps),
    source: 'llm',
    summarizerVersion: SUMMARIZER_VERSION,
  };
}
```

- [ ] **Step 4: Run tests and commit**

Run: `yarn check-types && yarn test:unit` — Expected: pass.

```bash
git add src/host/digest/llm-prompt.ts src/test/unit/llm-prompt.test.ts
git commit -m "feat: build the summarizer prompt and parse its reply"
```

---

### Task 7: `LlmSummarizer` (the hidden run)

**Files:**
- Create: `src/host/digest/llm-summarizer.ts`
- Test: `src/test/unit/llm-summarizer.test.ts`

**Interfaces:**
- Consumes: `AgentProvider`, `AgentRun`, `EffortLevel`, `StartOptions.withoutSelfControl` (Task 5); `buildSummaryPrompt`, `parseLlmDigest` (Task 6).
- Produces: `class LlmSummarizer { constructor(o: { provider: AgentProvider; model: string; effort: EffortLevel; cwd: string; timeoutMs?: number }); summarize(items: TranscriptItem[], base: SessionDigest): Promise<SessionDigest> }` (rejects on any failure).

- [ ] **Step 1: Write the failing test**

```ts
import * as assert from 'node:assert';
import { suite, test } from 'mocha';
import { extractiveDigest } from '../../memory/digest';
import { LlmSummarizer } from '../../host/digest/llm-summarizer';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { AgentEvent } from '../../providers/types';
import type { TranscriptItem } from '../../protocol/messages';

const items: TranscriptItem[] = [
  { id: 'u1', ts: 0, role: 'user', text: 'Fix login' },
  { id: 'a1', ts: 0, role: 'assistant', text: 'Done' },
];
const base = () => extractiveDigest(items, 9)!;
const okReply = JSON.stringify({ title: 'Login', outcome: 'Fixed' });

const summarizer = (script: (text: string) => AgentEvent[], timeoutMs = 2000) => {
  const provider = new FakeProvider(script);
  return { provider, s: new LlmSummarizer({ provider, model: 'fake-small', effort: 'low', cwd: '/tmp', timeoutMs }) };
};

suite('LlmSummarizer', () => {
  test('starts a run without self-control on the configured model and effort, and returns the parsed digest', async () => {
    const { provider, s } = summarizer(() => [
      { kind: 'text', delta: okReply }, { kind: 'turn-end', reason: 'done' },
    ]);
    const digest = await s.summarize(items, base());
    assert.strictEqual(digest.source, 'llm');
    assert.strictEqual(digest.title, 'Login');
    const start = provider.starts[0];
    assert.strictEqual(start.withoutSelfControl, true);
    assert.strictEqual(start.model, 'fake-small');
    assert.strictEqual(start.effort, 'low');
    assert.strictEqual(start.cwd, '/tmp');
  });

  test('sends the built prompt, not the raw transcript', async () => {
    const { provider, s } = summarizer(() => [
      { kind: 'text', delta: okReply }, { kind: 'turn-end', reason: 'done' },
    ]);
    await s.summarize(items, base());
    assert.strictEqual(provider.sent[0].text.includes('<conversation>'), true);
  });

  test('denies a tool permission request and rejects on the resulting empty reply', async () => {
    const { provider, s } = summarizer(() => [{
      kind: 'permission', id: 'p1', tool: { kind: 'command', label: 'Bash', command: 'ls' },
    }]);
    await assert.rejects(() => s.summarize(items, base()));
    assert.deepStrictEqual(provider.decisions.get('p1'), { allow: false, reason: 'The summarizer may not use tools.' });
  });

  test('rejects on an error turn-end', async () => {
    const { s } = summarizer(() => [{ kind: 'turn-end', reason: 'error', error: 'auth failed' }]);
    await assert.rejects(() => s.summarize(items, base()), /auth failed/);
  });

  test('rejects on a timeout and still disposes the run', async () => {
    const { s } = summarizer(() => [], 30);
    await assert.rejects(() => s.summarize(items, base()), /timed out/);
  });

  test('rejects when the reply is not usable JSON', async () => {
    const { s } = summarizer(() => [
      { kind: 'text', delta: 'sorry, no' }, { kind: 'turn-end', reason: 'done' },
    ]);
    await assert.rejects(() => s.summarize(items, base()), /no JSON object/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `yarn test:unit` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/host/digest/llm-summarizer.ts`**

```ts
import { randomUUID } from 'node:crypto';
import type { SessionDigest } from '../../memory/digest';
import type { TranscriptItem } from '../../protocol/messages';
import type { AgentProvider, AgentRun, EffortLevel } from '../../providers/types';
import { buildSummaryPrompt, parseLlmDigest } from './llm-prompt';

export interface LlmSummarizerOptions {
  provider: AgentProvider;
  model: string;
  effort: EffortLevel;
  /** Deliberately not a session's cwd: a project directory would load its CLAUDE.md into every summary. */
  cwd: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 90_000;

export class LlmSummarizer {
  constructor(private readonly o: LlmSummarizerOptions) {}

  async summarize(items: TranscriptItem[], base: SessionDigest): Promise<SessionDigest> {
    const run = this.o.provider.start({
      cwd: this.o.cwd,
      model: this.o.model,
      effort: this.o.effort,
      permissionMode: 'default',
      sessionId: `digest-${randomUUID()}`,
      withoutSelfControl: true,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('summarizer timed out')), this.o.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        );
      });
      const reply = await Promise.race([this.collect(run, buildSummaryPrompt(items)), timeout]);
      return parseLlmDigest(reply, base);
    } finally {
      if (timer) { clearTimeout(timer); }
      await run.dispose().catch(() => undefined);
    }
  }

  private async collect(run: AgentRun, prompt: string): Promise<string> {
    let reply = '';
    run.send(prompt);
    for await (const event of run.events) {
      if (event.kind === 'text') {
        reply += event.delta;
      } else if (event.kind === 'permission') {
        run.respondToTool(event.id, { allow: false, reason: 'The summarizer may not use tools.' });
      } else if (event.kind === 'question') {
        throw new Error('summarizer asked a question');
      } else if (event.kind === 'turn-end') {
        if (event.reason === 'error') { throw new Error(event.error ?? 'summarizer run failed'); }
        return reply;
      }
    }
    throw new Error('summarizer run ended without a reply');
  }
}
```

- [ ] **Step 4: Run tests and commit**

Run: `yarn check-types && yarn lint && yarn test:unit` — Expected: pass.

```bash
git add src/host/digest/llm-summarizer.ts src/test/unit/llm-summarizer.test.ts
git commit -m "feat: add the hidden tool-less summarizer run"
```

---

### Task 8: `DigestService`

**Files:**
- Create: `src/host/digest/digest-service.ts`
- Test: `src/test/unit/digest-service.test.ts`

**Interfaces:**
- Consumes: `MemoryStore` (`index`, `digestMeta`, `getDigest`), `extractiveDigest`, `SUMMARIZER_VERSION`, an object with `summarize(items, base): Promise<SessionDigest>` (the `LlmSummarizer` shape).
- Produces:

```ts
export interface DigestSession { id: SessionId; providerId: string; cwd: string; title: string; archived: boolean; updatedAt: number }
export interface DigestSource {
  sessions(): DigestSession[];
  transcript(id: SessionId): Promise<TranscriptItem[]>;
  /** `forUpdatedAt` of the projection currently on the session, if any. */
  projected(id: SessionId): number | undefined;
}
export type DigestScope = 'all' | 'missing-llm';
export interface DigestProgress { phase: 'extractive' | 'llm' | 'done' | 'cancelled'; done: number; total: number }
export interface DigestEstimate { sessions: number; approxInputTokens: number }
export interface DigestServiceOptions {
  store: MemoryStore;
  source: DigestSource;
  summarizer?: { summarize(items: TranscriptItem[], base: SessionDigest): Promise<SessionDigest> };
  onDigest(id: SessionId, digest: SessionDigest): void;
  onSettled(): void;
  onProgress(p: DigestProgress): void;
}
class DigestService {
  setSummarizer(s: DigestServiceOptions['summarizer']): void;
  hasSummarizer(): boolean;
  refresh(id: SessionId): Promise<void>;          // extractive + index one session
  upgrade(id: SessionId): Promise<void>;          // LLM digest for one closed session; never rejects
  resummarize(id: SessionId): Promise<void>;      // refresh then upgrade
  ensureCurrent(): Promise<void>;                 // extractive for stale/missing, project current ones
  estimate(scope: DigestScope): Promise<DigestEstimate>;
  reindex(scope: DigestScope): Promise<void>;
  cancel(): void;
  stop(): void;
}
```

Rules encoded in the code below: a digest is *current* when `forUpdatedAt === session.updatedAt` and `summarizerVersion === SUMMARIZER_VERSION`. Every write is a separate queue job, so a close-time `refresh` interleaves with a running `reindex`. `ensureCurrent` never overwrites a current digest. `upgrade` skips live (non-archived) sessions.

- [ ] **Step 1: Write the failing test**

```ts
import * as assert from 'node:assert';
import { suite, test } from 'mocha';
import { DigestService, type DigestProgress, type DigestSession, type DigestSource } from '../../host/digest/digest-service';
import { SUMMARIZER_VERSION, type SessionDigest } from '../../memory/digest';
import type { DigestMeta, MemoryStore, SessionRecord } from '../../memory/types';
import type { TranscriptItem } from '../../protocol/messages';

const transcript = (text: string): TranscriptItem[] => [
  { id: 'u', ts: 0, role: 'user', text }, { id: 'a', ts: 0, role: 'assistant', text: 'ok' },
];

class FakeStore implements MemoryStore {
  digests = new Map<string, SessionDigest>();
  indexed: string[] = [];
  async index(r: SessionRecord) {
    const d = r.digest!;
    this.digests.set(r.sessionId, d);
    this.indexed.push(r.sessionId);
  }
  async search() { return []; }
  async fetch() { return { sessionId: '', items: [] }; }
  async forget() {}
  async getDigest(id: string) { return this.digests.get(id); }
  async digestMeta() {
    return new Map<string, DigestMeta>([...this.digests].map(([id, d]) => [id, {
      source: d.source, summarizerVersion: d.summarizerVersion, forUpdatedAt: d.forUpdatedAt,
    }]));
  }
}

function rig(sessions: DigestSession[], opts: {
  summarize?: (items: TranscriptItem[], base: SessionDigest) => Promise<SessionDigest>;
} = {}) {
  const store = new FakeStore();
  const projected = new Map<string, number>();
  const progress: DigestProgress[] = [];
  let settled = 0;
  const source: DigestSource = {
    sessions: () => sessions,
    transcript: async (id) => transcript(`task ${id}`),
    projected: (id) => projected.get(id),
  };
  const service = new DigestService({
    store, source,
    summarizer: opts.summarize ? { summarize: opts.summarize } : undefined,
    onDigest: (id, d) => { projected.set(id, d.forUpdatedAt); },
    onSettled: () => { settled++; },
    onProgress: (p) => progress.push(p),
  });
  return { store, service, progress, settled: () => settled, projected };
}

const session = (id: string, over: Partial<DigestSession> = {}): DigestSession => ({
  id, providerId: 'claude', cwd: '/r', title: `t-${id}`, archived: true, updatedAt: 10, ...over,
});

const llmDigest = (base: SessionDigest): SessionDigest => ({ ...base, source: 'llm', title: 'LLM title' });

suite('DigestService', () => {
  test('refresh writes an extractive digest and projects it', async () => {
    const { store, service, projected } = rig([session('a')]);
    await service.refresh('a');
    assert.strictEqual(store.digests.get('a')?.source, 'extractive');
    assert.strictEqual(projected.get('a'), 10);
  });

  test('untitled sessions are skipped', async () => {
    const { store, service } = rig([session('a', { title: 'Untitled' })]);
    await service.refresh('a');
    assert.strictEqual(store.digests.size, 0);
  });

  test('a failing store write is logged and does not reject', async () => {
    const { store, service } = rig([session('a')]);
    store.index = async () => { throw new Error('disk full'); };
    await assert.doesNotReject(service.refresh('a'));
  });

  test('upgrade replaces the extractive digest with the llm one for a closed session', async () => {
    const { store, service } = rig([session('a')], { summarize: async (_i, base) => llmDigest(base) });
    await service.refresh('a');
    await service.upgrade('a');
    assert.strictEqual(store.digests.get('a')?.source, 'llm');
  });

  test('upgrade skips a live session', async () => {
    const { store, service } = rig([session('a', { archived: false })], { summarize: async (_i, b) => llmDigest(b) });
    await service.refresh('a');
    await service.upgrade('a');
    assert.strictEqual(store.digests.get('a')?.source, 'extractive');
  });

  test('a failing summarizer keeps the extractive digest and does not reject', async () => {
    const { store, service } = rig([session('a')], { summarize: async () => { throw new Error('timeout'); } });
    await service.refresh('a');
    await assert.doesNotReject(service.upgrade('a'));
    assert.strictEqual(store.digests.get('a')?.source, 'extractive');
  });

  test('ensureCurrent fills missing digests, leaves current ones alone, and settles once', async () => {
    const { store, service, settled } = rig([session('a'), session('b')]);
    await service.refresh('a');
    store.indexed.length = 0;
    const before = settled();
    await service.ensureCurrent();
    assert.deepStrictEqual(store.indexed, ['b']);
    assert.strictEqual(settled() - before, 1);
  });

  test('ensureCurrent projects a current stored digest that the session has not been given yet', async () => {
    const { store, service, projected } = rig([session('a')]);
    await service.refresh('a');
    projected.clear();
    store.indexed.length = 0;
    await service.ensureCurrent();
    assert.strictEqual(projected.get('a'), 10);
    assert.deepStrictEqual(store.indexed, []);
  });

  test('a stale digest (older updatedAt) is rebuilt', async () => {
    const sessions = [session('a')];
    const { store, service } = rig(sessions);
    await service.refresh('a');
    sessions[0] = session('a', { updatedAt: 20 });
    await service.ensureCurrent();
    assert.strictEqual(store.digests.get('a')?.forUpdatedAt, 20);
  });

  test('reindex missing-llm builds extractive first, then upgrades closed sessions, newest first', async () => {
    const order: string[] = [];
    const { store, service, progress } = rig(
      [session('old', { updatedAt: 1 }), session('new', { updatedAt: 5 }), session('live', { archived: false, updatedAt: 9 })],
      { summarize: async (_i, base) => { order.push(base.title); return llmDigest(base); } },
    );
    await service.reindex('missing-llm');
    assert.strictEqual(store.digests.get('new')?.source, 'llm');
    assert.strictEqual(store.digests.get('old')?.source, 'llm');
    assert.strictEqual(store.digests.get('live')?.source, 'extractive');
    assert.deepStrictEqual(order, ['task new', 'task old']);
    assert.strictEqual(progress[progress.length - 1].phase, 'done');
  });

  test('re-running skips sessions whose llm digest is already current', async () => {
    let calls = 0;
    const { service } = rig([session('a')], { summarize: async (_i, b) => { calls++; return llmDigest(b); } });
    await service.reindex('missing-llm');
    await service.reindex('missing-llm');
    assert.strictEqual(calls, 1);
  });

  test('scope all rebuilds even current llm digests', async () => {
    let calls = 0;
    const { service } = rig([session('a')], { summarize: async (_i, b) => { calls++; return llmDigest(b); } });
    await service.reindex('missing-llm');
    await service.reindex('all');
    assert.strictEqual(calls, 2);
  });

  test('without a summarizer reindex only does the extractive pass', async () => {
    const { store, service } = rig([session('a')]);
    await service.reindex('all');
    assert.strictEqual(store.digests.get('a')?.source, 'extractive');
  });

  test('estimate counts closed sessions that still need an llm digest', async () => {
    const { service } = rig(
      [session('a'), session('b'), session('live', { archived: false })],
      { summarize: async (_i, b) => llmDigest(b) },
    );
    assert.deepStrictEqual(await service.estimate('missing-llm'), { sessions: 2, approxInputTokens: 6000 });
  });

  test('estimate is zero with no summarizer configured', async () => {
    const { service } = rig([session('a')]);
    assert.deepStrictEqual(await service.estimate('all'), { sessions: 0, approxInputTokens: 0 });
  });

  test('cancel stops a running reindex and reports cancelled', async () => {
    const gate: { release?: () => void } = {};
    const { service, progress } = rig(
      [session('a'), session('b'), session('c')],
      {
        summarize: (_i, base) => new Promise((resolve) => {
          gate.release = () => resolve(llmDigest(base));
        }),
      },
    );
    const run = service.reindex('all');
    await new Promise((r) => setTimeout(r, 20));
    service.cancel();
    gate.release?.();
    await run;
    assert.strictEqual(progress[progress.length - 1].phase, 'cancelled');
  });

  test('a close-time refresh is not starved behind a long reindex', async () => {
    const many = Array.from({ length: 50 }, (_, i) => session(`s${i}`));
    const { store, service } = rig(many);
    const run = service.reindex('all');
    await service.refresh('s49');
    const at = store.indexed.indexOf('s49');
    assert.strictEqual(at >= 0 && at < 49, true);
    await run;
  });

  test('a session removed while the model is summarizing is not indexed', async () => {
    const sessions = [session('a')];
    const gate: { release?: () => void } = {};
    const { store, service } = rig(sessions, {
      summarize: (_i, base) => new Promise((resolve) => { gate.release = () => resolve(llmDigest(base)); }),
    });
    await service.refresh('a');
    const upgrading = service.upgrade('a');
    await new Promise((r) => setTimeout(r, 20));
    sessions.length = 0;
    gate.release?.();
    await upgrading;
    assert.strictEqual(store.digests.get('a')?.source, 'extractive');
  });

  test('a failing digestMeta is logged and does not reject ensureCurrent', async () => {
    const { store, service } = rig([session('a')]);
    store.digestMeta = async () => { throw new Error('locked'); };
    await assert.doesNotReject(service.ensureCurrent());
  });

  test('stop makes queued work a no-op', async () => {
    const { store, service } = rig([session('a')]);
    service.stop();
    await service.refresh('a');
    assert.strictEqual(store.digests.size, 0);
  });

  test('current summarizer version constant is used for currency', async () => {
    const { store, service } = rig([session('a')]);
    await service.refresh('a');
    assert.strictEqual(store.digests.get('a')?.summarizerVersion, SUMMARIZER_VERSION);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `yarn test:unit` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/host/digest/digest-service.ts`**

```ts
import { extractiveDigest, SUMMARIZER_VERSION, type SessionDigest } from '../../memory/digest';
import type { DigestMeta, MemoryStore } from '../../memory/types';
import type { SessionId, TranscriptItem } from '../../protocol/messages';

export interface DigestSession {
  id: SessionId; providerId: string; cwd: string; title: string; archived: boolean; updatedAt: number;
}

export interface DigestSource {
  sessions(): DigestSession[];
  transcript(id: SessionId): Promise<TranscriptItem[]>;
  /** `forUpdatedAt` of the projection currently on the session, if any. */
  projected(id: SessionId): number | undefined;
}

export type DigestScope = 'all' | 'missing-llm';
export interface DigestProgress { phase: 'extractive' | 'llm' | 'done' | 'cancelled'; done: number; total: number }
export interface DigestEstimate { sessions: number; approxInputTokens: number }

type Summarizer = { summarize(items: TranscriptItem[], base: SessionDigest): Promise<SessionDigest> };

export interface DigestServiceOptions {
  store: MemoryStore;
  source: DigestSource;
  summarizer?: Summarizer;
  onDigest(id: SessionId, digest: SessionDigest): void;
  onSettled(): void;
  onProgress(p: DigestProgress): void;
}

const APPROX_TOKENS_PER_SESSION = 3000;
const SETTLE_EVERY = 10;

const isCurrent = (meta: DigestMeta | undefined, session: DigestSession): boolean =>
  meta !== undefined && meta.forUpdatedAt === session.updatedAt && meta.summarizerVersion === SUMMARIZER_VERSION;

export class DigestService {
  private summarizer: Summarizer | undefined;
  private queue: Promise<void> = Promise.resolve();
  private cancelled = false;
  private stopped = false;
  private reindexing: Promise<void> | undefined;

  constructor(private readonly o: DigestServiceOptions) {
    this.summarizer = o.summarizer;
  }

  setSummarizer(summarizer: Summarizer | undefined): void { this.summarizer = summarizer; }
  hasSummarizer(): boolean { return this.summarizer !== undefined; }
  cancel(): void { this.cancelled = true; }
  stop(): void { this.stopped = true; this.cancelled = true; }

  /** One job at a time; every write is its own job so a close-time write can slip between a reindex's. */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private find(id: SessionId): DigestSession | undefined {
    return this.o.source.sessions().find((s) => s.id === id);
  }

  private async writeExtractive(session: DigestSession): Promise<boolean> {
    if (this.stopped || session.title === 'Untitled') { return false; }
    try {
      const items = await this.o.source.transcript(session.id);
      const digest = extractiveDigest(items, session.updatedAt);
      if (!digest) { return false; }
      await this.o.store.index({
        sessionId: session.id, providerId: session.providerId, cwd: session.cwd,
        closedAt: session.updatedAt, items, digest,
      });
      this.o.onDigest(session.id, digest);
      return true;
    } catch (err) {
      console.error('[mar-code] digest failed for', session.id, err);
      return false;
    }
  }

  private async writeLlm(session: DigestSession): Promise<boolean> {
    const summarizer = this.summarizer;
    if (this.stopped || !summarizer || !session.archived || session.title === 'Untitled') { return false; }
    try {
      const items = await this.o.source.transcript(session.id);
      const base = extractiveDigest(items, session.updatedAt);
      if (!base) { return false; }
      const digest = await summarizer.summarize(items, base);
      // The session may have been deleted while the model was thinking; indexing now would resurrect it.
      if (this.stopped || !this.find(session.id)) { return false; }
      await this.o.store.index({
        sessionId: session.id, providerId: session.providerId, cwd: session.cwd,
        closedAt: session.updatedAt, items, digest,
      });
      this.o.onDigest(session.id, digest);
      return true;
    } catch (err) {
      console.error('[mar-code] llm digest failed for', session.id, err);
      return false;
    }
  }

  async refresh(id: SessionId): Promise<void> {
    await this.enqueue(async () => {
      const session = this.find(id);
      if (session && await this.writeExtractive(session)) { this.o.onSettled(); }
    });
  }

  async upgrade(id: SessionId): Promise<void> {
    await this.enqueue(async () => {
      const session = this.find(id);
      if (session && await this.writeLlm(session)) { this.o.onSettled(); }
    });
  }

  async resummarize(id: SessionId): Promise<void> {
    await this.refresh(id);
    await this.upgrade(id);
  }

  async ensureCurrent(): Promise<void> {
    await this.enqueue(async () => {
      try {
        const meta = await this.o.store.digestMeta();
        let touched = false;
        for (const session of this.o.source.sessions()) {
          if (this.stopped) { return; }
          if (session.title === 'Untitled') { continue; }
          const stored = meta.get(session.id);
          if (!isCurrent(stored, session)) {
            if (await this.writeExtractive(session)) { touched = true; }
          } else if (this.o.source.projected(session.id) !== session.updatedAt) {
            const digest = await this.o.store.getDigest(session.id);
            if (digest) { this.o.onDigest(session.id, digest); touched = true; }
          }
        }
        if (touched) { this.o.onSettled(); }
      } catch (err) {
        console.error('[mar-code] digest refresh failed', err);
      }
    });
  }

  private llmTargets(scope: DigestScope, meta: Map<SessionId, DigestMeta>): DigestSession[] {
    if (!this.summarizer) { return []; }
    return this.o.source.sessions()
      .filter((s) => s.archived && s.title !== 'Untitled')
      .filter((s) => scope === 'all' || !(meta.get(s.id)?.source === 'llm' && isCurrent(meta.get(s.id), s)))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async estimate(scope: DigestScope): Promise<DigestEstimate> {
    const sessions = this.llmTargets(scope, await this.o.store.digestMeta()).length;
    return { sessions, approxInputTokens: sessions * APPROX_TOKENS_PER_SESSION };
  }

  reindex(scope: DigestScope): Promise<void> {
    this.reindexing ??= this.runReindex(scope)
      .catch((err) => { console.error('[mar-code] memory reindex failed', err); })
      .finally(() => { this.reindexing = undefined; });
    return this.reindexing;
  }

  private async runReindex(scope: DigestScope): Promise<void> {
    this.cancelled = false;
    const meta = await this.o.store.digestMeta();
    const all = this.o.source.sessions().filter((s) => s.title !== 'Untitled');
    const extractive = all
      .filter((s) => scope === 'all' || !isCurrent(meta.get(s.id), s))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const llm = this.llmTargets(scope, meta);

    let done = 0;
    for (const session of extractive) {
      if (this.cancelled) { return this.finish('cancelled', done, extractive.length); }
      await this.enqueue(() => this.writeExtractive(session));
      done++;
      this.o.onProgress({ phase: 'extractive', done, total: extractive.length });
      if (done % SETTLE_EVERY === 0) { this.o.onSettled(); }
    }
    this.o.onSettled();

    done = 0;
    for (const session of llm) {
      if (this.cancelled) { return this.finish('cancelled', done, llm.length); }
      await this.enqueue(() => this.writeLlm(session));
      done++;
      this.o.onProgress({ phase: 'llm', done, total: llm.length });
      if (done % SETTLE_EVERY === 0) { this.o.onSettled(); }
    }
    this.finish('done', done, llm.length);
  }

  private finish(phase: 'done' | 'cancelled', done: number, total: number): void {
    this.o.onSettled();
    this.o.onProgress({ phase, done, total });
  }
}
```

- [ ] **Step 4: Run tests and commit**

Run: `yarn check-types && yarn lint && yarn test:unit` — Expected: pass. If the "not starved" test is flaky, it is because `enqueue` chains onto the tail; the assertion only requires `s49` to be indexed before the loop finishes, which the per-session queue jobs guarantee.

```bash
git add src/host/digest/digest-service.ts src/test/unit/digest-service.test.ts
git commit -m "feat: add the digest service with a serial queue, reindex and resume"
```

---

### Task 9: Wire the service into `SessionManager`

**Files:**
- Modify: `src/host/session-manager.ts` (imports; `indexForMemory` at ~1814; `runSummaries`/`ensureSummaries` at ~1828-1854; `dispose` at ~1899; new methods)
- Modify: `src/test/unit/session-manager-memory.test.ts`, `src/test/unit/session-manager-summaries.test.ts`
- Test: same two files

**Interfaces:**
- Consumes: `DigestService` and its option types (Task 8), `indexLine` (Task 3), `MemoryStore.getDigest`.
- Produces on `SessionManager`:
  - `setSummarizer(s?: { summarize(items, base): Promise<SessionDigest> }): void`
  - `memoryStatus(): { enabled: boolean; llm: boolean }`
  - `memoryEstimate(scope: DigestScope): Promise<DigestEstimate>`
  - `memoryReindex(scope: DigestScope): Promise<void>`
  - `memoryResummarize(id: SessionId): Promise<void>`
  - `memoryCancel(): void`
  - emits `{ t: 'memory-progress', phase, done, total }` (type added in Task 11; until then cast with `as never`? No: do Task 11's message type first if implementing out of order. In sequence, this task adds the emit call and Task 11 adds the type; to keep each task green, add the `memory-progress` variant to `HostToWebview` here — see step 3.)

- [ ] **Step 1: Write the failing tests**

Append to `session-manager-summaries.test.ts`:

```ts
import { FtsMemoryStore } from '../../memory/fts-memory-store';

async function memoryRig() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-summaries-mem-'));
  const store = new TranscriptStore(dir);
  const memory = new FtsMemoryStore(path.join(dir, 'memory.sqlite'), { tail: (id, n) => store.tail(id, n) });
  const sent: HostToWebview[] = [];
  const providers = new Map<string, AgentProvider>([['fake', new FakeProvider()]]);
  const manager = new SessionManager(
    store, providers, (m) => sent.push(m), undefined, undefined, undefined, undefined, undefined, memory,
  );
  await manager.init();
  return { sent, manager, memory };
}

suite('SessionManager summaries with memory enabled', () => {
  test('the history summary is a projection of the stored digest', async () => {
    const { manager, memory } = await memoryRig();
    const session = await manager.create('fake', '/repo');
    session.send('Investigate the flaky login test');
    await manager.close(session.state.id);
    await manager.ensureSummaries();
    const s = manager.summaries().find((x) => x.id === session.state.id)!;
    const digest = await memory.getDigest(session.state.id);
    assert.strictEqual(s.summary?.text.startsWith('Investigate the flaky login test'), true);
    assert.strictEqual(s.summary?.forUpdatedAt, digest?.forUpdatedAt);
    await manager.dispose();
  });

  test('a current digest is not rewritten and ensureSummaries emits nothing', async () => {
    const { manager, sent } = await memoryRig();
    const session = await manager.create('fake', '/repo');
    session.send('Hello there');
    await manager.close(session.state.id);
    await manager.ensureSummaries();
    sent.length = 0;
    await manager.ensureSummaries();
    assert.strictEqual(sent.length, 0);
    await manager.dispose();
  });

  test('memoryStatus reports enabled with no llm by default', async () => {
    const { manager } = await memoryRig();
    assert.deepStrictEqual(manager.memoryStatus(), { enabled: true, llm: false });
    await manager.dispose();
  });

  test('memoryStatus reports disabled with no store', async () => {
    const { manager } = await rig();
    assert.deepStrictEqual(manager.memoryStatus(), { enabled: false, llm: false });
    await manager.dispose();
  });

  test('memoryReindex emits progress and a final done', async () => {
    const { manager, sent } = await memoryRig();
    const session = await manager.create('fake', '/repo');
    session.send('Hello there');
    await manager.close(session.state.id);
    sent.length = 0;
    await manager.memoryReindex('all');
    const phases = sent.filter((m) => m.t === 'memory-progress').map((m) => (m as { phase: string }).phase);
    assert.strictEqual(phases[phases.length - 1], 'done');
    await manager.dispose();
  });

  test('memory methods are safe no-ops with memory disabled', async () => {
    const { manager } = await rig();
    await assert.doesNotReject(manager.memoryReindex('all'));
    assert.deepStrictEqual(await manager.memoryEstimate('all'), { sessions: 0, approxInputTokens: 0 });
    await manager.dispose();
  });
});
```

The existing four legacy tests in this file use `rig()` (no memory store) and must keep passing unchanged: that is the memory-disabled behaviour.

- [ ] **Step 2: Run to verify it fails**

Run: `yarn test:unit` — Expected: FAIL (`memoryStatus` etc. undefined).

- [ ] **Step 3: Implement in `session-manager.ts`**

Add imports:

```ts
import { DigestService, type DigestEstimate, type DigestScope } from './digest/digest-service';
import { indexLine, type SessionDigest } from '../memory/digest';
import type { TranscriptItem } from '../protocol/messages';
```

(drop the `digestSession` import only if nothing else uses it; the legacy `runSummaries` still does, so keep it.)

Add a field and construct the service in the constructor body (after `memory` is assigned; the constructor already has `private readonly memory?: MemoryStore`):

```ts
  private readonly digests?: DigestService;
```

at the end of the constructor:

```ts
    if (this.memory) {
      this.digests = new DigestService({
        store: this.memory,
        source: {
          sessions: () => [...this.meta.values()].map((s) => ({
            id: s.id, providerId: s.providerId, cwd: s.cwd, title: s.title,
            archived: s.archived, updatedAt: s.updatedAt,
          })),
          transcript: async (id) => (await this.store.tail(id, Number.MAX_SAFE_INTEGER)).items,
          projected: (id) => this.meta.get(id)?.summary?.forUpdatedAt,
        },
        // Written without touching `updatedAt`: it is the history sort key and this cache's key.
        onDigest: (id, digest) => { this.project(id, digest); },
        onSettled: () => { if (!this.disposed) { this.changed(); } },
        onProgress: (p) => { this.emit({ t: 'memory-progress', ...p }); },
      });
    }
```

Add the projection and the public API next to `ensureSummaries`:

```ts
  private project(id: SessionId, digest: SessionDigest): void {
    const state = this.meta.get(id);
    if (state) { state.summary = { text: indexLine(digest), forUpdatedAt: digest.forUpdatedAt }; }
  }

  setSummarizer(summarizer: { summarize(items: TranscriptItem[], base: SessionDigest): Promise<SessionDigest> } | undefined): void {
    this.digests?.setSummarizer(summarizer);
  }

  memoryStatus(): { enabled: boolean; llm: boolean } {
    return { enabled: this.digests !== undefined, llm: this.digests?.hasSummarizer() ?? false };
  }

  async memoryEstimate(scope: DigestScope): Promise<DigestEstimate> {
    return this.digests ? this.digests.estimate(scope) : { sessions: 0, approxInputTokens: 0 };
  }

  async memoryReindex(scope: DigestScope): Promise<void> { await this.digests?.reindex(scope); }
  async memoryResummarize(id: SessionId): Promise<void> { await this.digests?.resummarize(id); }
  memoryCancel(): void { this.digests?.cancel(); }
```

Replace `ensureSummaries`:

```ts
  /** Concurrent callers (sidebar + tab) share one run. */
  ensureSummaries(): Promise<void> {
    this.summaryRun ??= (this.digests ? this.digests.ensureCurrent() : this.runSummaries())
      .finally(() => { this.summaryRun = undefined; });
    return this.summaryRun;
  }
```

Replace `indexForMemory` with:

```ts
  /**
   * Awaited by `archive()` so a session is searchable the moment `close()` resolves.
   * Only the cheap extractive write is awaited; the LLM upgrade is fire-and-forget,
   * and `DigestService` never rejects, so neither can fail a lifecycle transition.
   */
  private async digestClosed(id: SessionId): Promise<void> {
    if (!this.digests) { return; }
    await this.digests.refresh(id);
    void this.digests.upgrade(id);
  }
```

In `archive()` replace `await this.indexForMemory(id, state);` with `await this.digestClosed(id);`. In the shutdown block (`liveSessions.map((s) => this.indexForMemory(...))`) replace with:

```ts
    await Promise.all(liveSessions.map((s) => this.digests?.refresh(s.state.id)));
    this.digests?.stop();
```

- [ ] **Step 4: Add the progress message type**

In `src/protocol/messages.ts`, in `HostToWebview`:

```ts
  | { t: 'memory-progress'; phase: 'extractive' | 'llm' | 'done' | 'cancelled'; done: number; total: number }
```

If `yarn check-types` flags an exhaustive `switch` on `msg.t` in `src/webview/reducer.ts` or `src/review/reducer.ts`, add `case 'memory-progress': return state;` there. (`history/reducer.ts` and the webview reducer already fall through `default`.)

- [ ] **Step 5: Update `session-manager-memory.test.ts`**

The three existing tests assert on `memory.indexed[0].sessionId`; they pass through the service now. Add the two fake methods (done in Task 4). Add one test proving the digest reaches the store:

```ts
  test('archiving indexes an extractive digest', async () => {
    const store = new TranscriptStore(await tempRoot());
    const providers = new Map<string, AgentProvider>([['fake', new FakeProvider()]]);
    const memory = new RecordingMemoryStore();
    const manager = new SessionManager(
      store, providers, () => {}, undefined, undefined, undefined, undefined, undefined, memory,
    );
    const session = await manager.create('fake', '/repo');
    session.send('Investigate the flaky login test');
    await manager.close(session.state.id);
    assert.strictEqual(memory.indexed[0].digest?.source, 'extractive');
  });
```

- [ ] **Step 6: Verify and commit**

Run: `yarn check-types && yarn lint && yarn test:unit` — Expected: pass.

```bash
git add -A src
git commit -m "feat: route session digests through the digest service"
```

---

### Task 10: Recall tiers and the pointer block

**Files:**
- Modify: `src/host/self-control-mcp-server.ts` (`marcode__recall` description, `marcode__recall_fetch`)
- Modify: `src/memory/prime-block.ts`
- Test: `src/test/unit/self-control-mcp-server.test.ts`, `src/test/unit/prime-block.test.ts`

**Interfaces:**
- Consumes: `MemoryStore.getDigest`, `digestText` (Task 3/4).
- Produces: `marcode__recall_fetch({ sessionId, itemId?, detail?: 'digest' | 'transcript' })`; default `digest` returns `digestText(digest)`; `transcript` requires `itemId` and returns the `MemoryDetail` as today.

- [ ] **Step 1: Write the failing tests**

In `self-control-mcp-server.test.ts` change the existing `'marcode__recall_fetch returns MemoryStore.fetch()\'s slice'` call to pass `detail: 'transcript'`, and add:

```ts
  test('marcode__recall_fetch returns the digest by default', async () => {
    const memory = fakeMemory({
      getDigest: async (id) => (id === 's1'
        ? {
            title: 'Login retry', request: 'Fix login', outcome: 'Added a retry', filesEdited: ['a.ts'],
            source: 'llm', summarizerVersion: 1, forUpdatedAt: 1, learned: 'Fixture raced',
          }
        : undefined),
    });
    const server = new SelfControlMcpServer(fakeManager(), memory);
    const config = await server.start();
    const result = await callTool(config, 'marcode__recall_fetch', { sessionId: 's1' });
    assert.strictEqual(result.content[0].text.includes('Learned: Fixture raced'), true);
    await server.dispose();
  });

  test('marcode__recall_fetch says so when a session has no digest', async () => {
    const server = new SelfControlMcpServer(fakeManager(), fakeMemory({ getDigest: async () => undefined }));
    const config = await server.start();
    const result = await callTool(config, 'marcode__recall_fetch', { sessionId: 'nope' });
    assert.strictEqual(result.isError, true);
    await server.dispose();
  });

  test('marcode__recall_fetch transcript detail needs an itemId', async () => {
    const server = new SelfControlMcpServer(fakeManager(), fakeMemory({}));
    const config = await server.start();
    const result = await callTool(config, 'marcode__recall_fetch', { sessionId: 's1', detail: 'transcript' });
    assert.strictEqual(result.isError, true);
    await server.dispose();
  });
```

In `prime-block.test.ts` update the recall-fetch assertion:

```ts
    assert.strictEqual(block.includes('marcode__recall_fetch'), true);
    assert.strictEqual(block.includes('sessionId'), true);
```

and change the hit-line assertion from `'sessionId=s3 itemId=u3'` to `'sessionId=s3'`.

- [ ] **Step 2: Run to verify it fails**

Run: `yarn test:unit` — Expected: FAIL.

- [ ] **Step 3: Implement the tool change**

Replace the `marcode__recall_fetch` registration body (inside the `if (this.memory)` block from Task 2, using the local `memory`):

```ts
      mcp.registerTool(
        'marcode__recall_fetch',
        {
          title: 'Fetch a past session\'s digest or transcript slice',
          description: 'Marcode-specific companion to marcode__recall. By default returns that OTHER '
            + 'session\'s digest (request, outcome, what it learned, decisions, files edited) — call it '
            + 'with just a sessionId from a marcode__recall result. Pass detail "transcript" and that '
            + 'result\'s itemId to read a bounded slice of the raw conversation instead. Never call this '
            + 'with an id you invented.',
          inputSchema: {
            sessionId: z.string().describe('A sessionId from a marcode__recall result.'),
            itemId: z.string().optional().describe('The itemId from that result. Only for detail "transcript".'),
            detail: z.enum(['digest', 'transcript']).optional().describe('Defaults to "digest".'),
          },
        },
        async ({ sessionId, itemId, detail }) => {
          if (detail === 'transcript') {
            if (!itemId) {
              return { isError: true, content: [{ type: 'text' as const, text: 'detail "transcript" needs an itemId from marcode__recall.' }] };
            }
            const slice = await memory.fetch({ sessionId, itemId });
            return { content: [{ type: 'text' as const, text: JSON.stringify(slice) }] };
          }
          const digest = await memory.getDigest(sessionId);
          if (!digest) {
            return { isError: true, content: [{ type: 'text' as const, text: 'No digest for that session. Try detail "transcript".' }] };
          }
          return { content: [{ type: 'text' as const, text: digestText(digest) }] };
        },
      );
```

Add `import { digestText } from '../memory/digest';`. Update the `marcode__recall` description's last sentence to: `Returns one-line pointers, not transcripts — call marcode__recall_fetch with a result's sessionId to read its digest.`

- [ ] **Step 4: Update `prime-block.ts`**

```ts
export function buildMemoryBlock(hits: MemoryHit[]): string | undefined {
  const keep = hits.filter((h) => h.score >= MIN_SCORE).slice(0, MAX_HITS);
  if (keep.length === 0) { return undefined; }
  const lines = keep.map((h) => `- ${h.snippet} (sessionId=${h.sessionId})`);
  return [
    '<marcode-memory>',
    'Earlier Marcode sessions in this workspace that may relate to this task. '
      + 'Call marcode__recall_fetch with a sessionId to read its digest; ignore them if unrelated.',
    ...lines,
    '</marcode-memory>',
  ].join('\n');
}
```

- [ ] **Step 5: Re-measure the score floor against digest-shaped rows**

Run this once and confirm a real match still scores above `MIN_SCORE` (2.5) and a single shared common word stays below it; adjust `MIN_SCORE` and its comment only if it does not:

```bash
cat > src/score-tmp.ts <<'EOF'
import { FtsMemoryStore } from './memory/fts-memory-store';
import { queryTermsOf } from './memory/prime-block';
(async () => {
  const s = new FtsMemoryStore(':memory:', { tail: async () => ({ items: [], hasMore: false }) });
  const docs = ['Investigate the flaky login test on CI and add retry to the auth fixture',
    'Refactor the transcript store to page JSONL lazily', 'Add usage strip percentages to the panel header',
    'Fix the review tab collapse state persisting across reloads', 'Write the fleet diff attribution claims for shared trees'];
  for (let i = 0; i < docs.length; i++) {
    await s.index({ sessionId: 's' + i, providerId: 'claude', cwd: '/r', closedAt: i,
      items: [{ id: 'u' + i, ts: 0, role: 'user', text: docs[i] }, { id: 'a' + i, ts: 0, role: 'assistant', text: 'Done.' }] });
  }
  for (const q of ['the login test is flaky again on CI, can you look', 'add a test for the new button']) {
    const hits = await s.search(queryTermsOf(q).join(' '), { match: 'any' });
    console.log(q, hits.map((h) => [h.sessionId, +h.score.toFixed(2)]));
  }
})();
EOF
node --require tsx/cjs src/score-tmp.ts; rm src/score-tmp.ts
```

- [ ] **Step 6: Verify and commit**

Run: `yarn check-types && yarn lint && yarn test:unit` — Expected: pass.

```bash
git add -A src
git commit -m "feat: tier recall into pointer, digest and transcript slice"
```

---

### Task 11: Protocol and router for memory actions

**Files:**
- Modify: `src/protocol/messages.ts` (near `request-history-summaries`, ~484, and `HostToWebview`)
- Modify: `src/host/message-router.ts` (case at ~649, `KNOWN_MESSAGE_TAGS` at ~728)
- Modify: `src/host/post-bus.ts:65`
- Test: `src/test/unit/history-router.test.ts`, `src/test/unit/post-bus.test.ts`

**Interfaces:**
- Produces (types only):
  - `WebviewToHost`: `{ t: 'memory-estimate'; scope: DigestScopeWire }`, `{ t: 'memory-reindex'; scope: DigestScopeWire }`, `{ t: 'memory-resummarize'; id: SessionId }`, `{ t: 'memory-cancel' }` where `type DigestScopeWire = 'all' | 'missing-llm'`
  - `HostToWebview`: `{ t: 'memory-status'; enabled: boolean; llm: boolean }`, `{ t: 'memory-estimate'; scope: DigestScopeWire; sessions: number; approxInputTokens: number }` (`memory-progress` was added in Task 9)
- Router: `request-history-summaries` additionally answers with `memory-status`; the four new tags call the matching `manager.memory*` method; `memory-estimate` replies via `this.emit`.

- [ ] **Step 1: Write the failing tests**

Read the top of `history-router.test.ts` for its rig (it constructs a `MessageRouter` over a fake manager) and add, using that rig's `router`, `sent` and `manager` names:

```ts
  test('request-history-summaries answers with memory-status', async () => {
    await router.handle({ t: 'request-history-summaries' });
    const status = sent.find((m) => m.t === 'memory-status');
    assert.deepStrictEqual(status, { t: 'memory-status', enabled: true, llm: false });
  });

  test('memory-estimate replies with the manager estimate', async () => {
    await router.handle({ t: 'memory-estimate', scope: 'missing-llm' });
    assert.deepStrictEqual(sent.find((m) => m.t === 'memory-estimate'), {
      t: 'memory-estimate', scope: 'missing-llm', sessions: 2, approxInputTokens: 6000,
    });
  });

  test('memory-estimate with nothing to summarize starts the reindex instead of asking', async () => {
    const zero = { ...manager, memoryEstimate: async () => ({ sessions: 0, approxInputTokens: 0 }) };
    const r = new MessageRouter(zero as never, (m) => sent.push(m), '/repo', editor);
    calls.length = 0;
    sent.length = 0;
    await r.handle({ t: 'memory-estimate', scope: 'missing-llm' });
    assert.deepStrictEqual(calls, ['reindex:missing-llm']);
    assert.strictEqual(sent.some((m) => m.t === 'memory-estimate'), false);
  });

  test('memory-reindex, memory-resummarize and memory-cancel reach the manager', async () => {
    await router.handle({ t: 'memory-reindex', scope: 'all' });
    await router.handle({ t: 'memory-resummarize', id: 's1' });
    await router.handle({ t: 'memory-cancel' });
    assert.deepStrictEqual(calls, ['reindex:all', 'resummarize:s1', 'cancel']);
  });
```

and extend that file's fake manager with `memoryStatus: () => ({ enabled: true, llm: false })`, `memoryEstimate: async () => ({ sessions: 2, approxInputTokens: 6000 })`, `memoryReindex: async (scope) => { calls.push(`reindex:${scope}`); }`, `memoryResummarize: async (id) => { calls.push(`resummarize:${id}`); }`, `memoryCancel: () => { calls.push('cancel'); }` and a `const calls: string[] = []`.

In `post-bus.test.ts` add:

```ts
  test('HISTORY_WANTS takes memory-progress but not memory-status (that is a direct answer)', () => {
    assert.strictEqual(HISTORY_WANTS({ t: 'memory-progress', phase: 'done', done: 1, total: 1 }), true);
    assert.strictEqual(HISTORY_WANTS({ t: 'memory-status', enabled: true, llm: false }), false);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `yarn test:unit` — Expected: FAIL.

- [ ] **Step 3: Implement**

`messages.ts`:

```ts
export type DigestScopeWire = 'all' | 'missing-llm';
```

in `WebviewToHost` after `| { t: 'request-history-summaries' }`:

```ts
  | { t: 'memory-estimate'; scope: DigestScopeWire }
  | { t: 'memory-reindex'; scope: DigestScopeWire }
  | { t: 'memory-resummarize'; id: SessionId }
  | { t: 'memory-cancel' }
```

in `HostToWebview`:

```ts
  | { t: 'memory-status'; enabled: boolean; llm: boolean }
  | { t: 'memory-estimate'; scope: DigestScopeWire; sessions: number; approxInputTokens: number }
```

`message-router.ts`, replace the `request-history-summaries` case and add the new cases:

```ts
      case 'request-history-summaries':
        await this.manager.ensureSummaries();
        this.emit({ t: 'memory-status', ...this.manager.memoryStatus() });
        return;

      case 'memory-estimate': {
        const estimate = await this.manager.memoryEstimate(msg.scope);
        // Nothing to confirm when no model call is coming: the extractive pass is free, so just run it.
        if (estimate.sessions === 0) {
          await this.manager.memoryReindex(msg.scope);
          return;
        }
        this.emit({ t: 'memory-estimate', scope: msg.scope, ...estimate });
        return;
      }

      case 'memory-reindex':
        await this.manager.memoryReindex(msg.scope);
        return;

      case 'memory-resummarize':
        await this.manager.memoryResummarize(msg.id);
        return;

      case 'memory-cancel':
        this.manager.memoryCancel();
        return;
```

and add `'memory-estimate', 'memory-reindex', 'memory-resummarize', 'memory-cancel'` to `KNOWN_MESSAGE_TAGS`. If the router's `manager` parameter is typed as an interface (not `SessionManager`), add the five `memory*` signatures to it.

`post-bus.ts`:

```ts
export const HISTORY_WANTS = (msg: HostToWebview): boolean =>
  msg.t === 'sessions-changed' || msg.t === 'memory-progress';
```

Update its doc comment: history additionally takes reindex progress; `memory-status` and `memory-estimate` are direct answers via its own router.

- [ ] **Step 4: Verify and commit**

Run: `yarn check-types && yarn lint && yarn test:unit` — Expected: pass. If check-types flags an exhaustive `switch` on `HostToWebview['t']` in another reducer, add a no-op case for `memory-status` and `memory-estimate`.

```bash
git add -A src
git commit -m "feat: add memory reindex, estimate, resummarize and cancel messages"
```

---

### Task 12: History tab — status, estimate, progress, per-row and bulk actions

**Files:**
- Modify: `src/history/reducer.ts`, `src/history/history-app.tsx`, `src/history/history-toolbar.tsx`, `src/history/history-row.tsx`
- Create: `src/history/memory-strip.tsx`
- Test: `src/test/dom/history-app.test.tsx`

**Interfaces:**
- Consumes: `memory-status`, `memory-estimate`, `memory-progress` (host→history); `memory-estimate`, `memory-reindex`, `memory-resummarize`, `memory-cancel` (history→host).
- Produces: `HistoryState` gains `memory?: { enabled: boolean; llm: boolean }`, `estimate?: { scope; sessions; approxInputTokens }`, `progress?: { phase; done; total }`. Nothing new renders unless `memory.enabled`.

UI rules (Operate mode, native VS Code feel): one thin strip under the toolbar, only when memory is enabled. States: idle shows a single outline `Button` "Index memory"; after `memory-estimate` with `llm` it shows "Summarize N sessions (~Xk tokens)?" with `Start` and `Cancel`; without `llm` it starts immediately (no cost to confirm); while progress is running it shows `phase done/total` and a `Stop` button. Rows gain an icon `Button` "Re-summarize" (`RefreshCwIcon`) next to pin, only when enabled.

- [ ] **Step 1: Write the failing DOM tests**

Append to `history-app.test.tsx`:

```tsx
suite('history memory actions', () => {
  setup(() => { resetHost(); });

  test('nothing memory-related renders until the host says memory is enabled', () => {
    renderHistory();
    hydrate(sessions());
    assert.strictEqual(screen.queryByRole('button', { name: 'Index memory' }) === null, true);
    assert.strictEqual(screen.queryByRole('button', { name: 'Re-summarize Alpha' }) === null, true);
  });

  test('with memory enabled a row can be re-summarized', async () => {
    renderHistory();
    hydrate(sessions());
    sendFromHost({ t: 'memory-status', enabled: true, llm: false });
    await userEvent.click(await screen.findByRole('button', { name: 'Re-summarize alpha-name' }));
    assert.deepStrictEqual(posted().filter((m) => m.t === 'memory-resummarize'), [
      { t: 'memory-resummarize', id: 'a' },
    ]);
  });

  test('without an llm summarizer the bulk action reindexes immediately', async () => {
    renderHistory();
    hydrate(sessions());
    sendFromHost({ t: 'memory-status', enabled: true, llm: false });
    await userEvent.click(await screen.findByRole('button', { name: 'Index memory' }));
    assert.deepStrictEqual(posted().filter((m) => m.t === 'memory-reindex'), [
      { t: 'memory-reindex', scope: 'missing-llm' },
    ]);
  });

  test('with an llm summarizer the bulk action asks for the estimate and waits for confirmation', async () => {
    renderHistory();
    hydrate(sessions());
    sendFromHost({ t: 'memory-status', enabled: true, llm: true });
    await userEvent.click(await screen.findByRole('button', { name: 'Index memory' }));
    assert.deepStrictEqual(posted().filter((m) => m.t === 'memory-estimate'), [
      { t: 'memory-estimate', scope: 'missing-llm' },
    ]);
    assert.strictEqual(posted().some((m) => m.t === 'memory-reindex'), false);
    sendFromHost({ t: 'memory-estimate', scope: 'missing-llm', sessions: 120, approxInputTokens: 360000 });
    assert.strictEqual(
      (await screen.findByText('Summarize 120 sessions (~360k tokens)?')).textContent,
      'Summarize 120 sessions (~360k tokens)?',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Start' }));
    assert.deepStrictEqual(posted().filter((m) => m.t === 'memory-reindex'), [
      { t: 'memory-reindex', scope: 'missing-llm' },
    ]);
  });

  test('progress shows the phase and can be stopped', async () => {
    renderHistory();
    hydrate(sessions());
    sendFromHost({ t: 'memory-status', enabled: true, llm: true });
    sendFromHost({ t: 'memory-progress', phase: 'llm', done: 3, total: 10 });
    assert.strictEqual((await screen.findByText('Summarizing 3/10')).textContent, 'Summarizing 3/10');
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    assert.deepStrictEqual(posted().filter((m) => m.t === 'memory-cancel'), [{ t: 'memory-cancel' }]);
  });

  test('done clears the progress strip', async () => {
    renderHistory();
    hydrate(sessions());
    sendFromHost({ t: 'memory-status', enabled: true, llm: true });
    sendFromHost({ t: 'memory-progress', phase: 'llm', done: 3, total: 10 });
    sendFromHost({ t: 'memory-progress', phase: 'done', done: 10, total: 10 });
    assert.strictEqual(screen.queryByText('Summarizing 3/10') === null, true);
    assert.strictEqual(screen.queryByRole('button', { name: 'Index memory' }) !== null, true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `yarn test:dom` — Expected: FAIL.

- [ ] **Step 3: Reducer**

```ts
import type { HostToWebview, SessionSummary } from '../protocol/messages';

export interface MemoryStatus { enabled: boolean; llm: boolean }
export interface MemoryEstimate { scope: 'all' | 'missing-llm'; sessions: number; approxInputTokens: number }
export interface MemoryProgress { phase: 'extractive' | 'llm'; done: number; total: number }

/** Narrow on purpose: no panes, no transcripts — see `HISTORY_WANTS`. */
export interface HistoryState {
  ready: boolean;
  sessions: SessionSummary[];
  memory?: MemoryStatus;
  estimate?: MemoryEstimate;
  progress?: MemoryProgress;
}

export const initialHistoryState: HistoryState = { ready: false, sessions: [] };

export function reduceHistory(state: HistoryState, msg: HostToWebview): HistoryState {
  switch (msg.t) {
    case 'hydrate': return { ...state, ready: true, sessions: msg.sessions };
    case 'sessions-changed': return { ...state, sessions: msg.sessions };
    case 'memory-status': return { ...state, memory: { enabled: msg.enabled, llm: msg.llm } };
    case 'memory-estimate': {
      const { scope, sessions, approxInputTokens } = msg;
      return { ...state, estimate: { scope, sessions, approxInputTokens } };
    }
    case 'memory-progress':
      if (msg.phase === 'done' || msg.phase === 'cancelled') {
        return { ...state, estimate: undefined, progress: undefined };
      }
      return { ...state, estimate: undefined, progress: { phase: msg.phase, done: msg.done, total: msg.total } };
    default: return state;
  }
}
```

- [ ] **Step 4: `src/history/memory-strip.tsx`**

```tsx
import { Button } from '@/components/ui/button';
import { useStore } from './store';

const kTokens = (n: number): string => `${Math.round(n / 1000)}k`;

export function MemoryStrip() {
  const { state, post } = useStore();
  const { memory, estimate, progress } = state;
  if (!memory?.enabled) { return null; }

  let body;
  if (progress) {
    const label = progress.phase === 'llm' ? 'Summarizing' : 'Indexing';
    body = (
      <>
        <span aria-live="polite">{`${label} ${progress.done}/${progress.total}`}</span>
        <Button variant="outline" size="sm" onClick={() => post({ t: 'memory-cancel' })}>Stop</Button>
      </>
    );
  } else if (memory.llm && estimate && estimate.sessions > 0) {
    body = (
      <>
        <span>{`Summarize ${estimate.sessions} sessions (~${kTokens(estimate.approxInputTokens)} tokens)?`}</span>
        <Button size="sm" onClick={() => post({ t: 'memory-reindex', scope: estimate.scope })}>Start</Button>
      </>
    );
  } else {
    body = (
      <Button
        variant="outline"
        size="sm"
        onClick={() => post(memory.llm
          ? { t: 'memory-estimate', scope: 'missing-llm' }
          : { t: 'memory-reindex', scope: 'missing-llm' })}
      >
        Index memory
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
      {body}
    </div>
  );
}
```

The reducer clears the estimate on any progress message, so a confirmed estimate never lingers once the run starts.

- [ ] **Step 5: Mount the strip and add the row action**

`history-app.tsx`: import `MemoryStrip` and render `<MemoryStrip />` directly after `<HistoryToolbar ... />`.

`history-row.tsx`: import `RefreshCwIcon` from `lucide-react`; read `const { state, post } = useStore();` and add, before the pin button inside the actions `div`:

```tsx
          {state.memory?.enabled && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Re-summarize ${session.name}`}
              onClick={() => post({ t: 'memory-resummarize', id: session.id })}
            >
              <RefreshCwIcon aria-hidden />
            </Button>
          )}
```

- [ ] **Step 6: Run the DOM tests, the detector, and commit**

Run: `yarn test:dom && yarn check-types && yarn lint` — Expected: pass.

Run the UI gate the project requires over the touched files (find the skill dir first, it is the `impeccable` skill's `scripts/detect.mjs`):

```bash
node <impeccable-skill-dir>/scripts/detect.mjs --json src/history/memory-strip.tsx src/history/history-row.tsx src/history/history-app.tsx
```

Expected exit 0. A non-zero exit is a failing check; fix its findings before committing.

```bash
git add -A src
git commit -m "feat: add memory indexing and re-summarize actions to the history tab"
```

---

### Task 13: Extension wiring — summarizer and the reindex command

**Files:**
- Modify: `src/extension.ts` (after all providers are registered; command registrations near `:614`)
- Modify: `package.json` (`contributes.commands`, after `marcode.history.open`)

**Interfaces:**
- Consumes: `validateSummarizer`, `LlmSummarizer`, `manager.setSummarizer`, `manager.memoryStatus`, `manager.memoryEstimate`, `manager.memoryReindex`.

- [ ] **Step 1: Wire the summarizer**

In `extension.ts`, add imports:

```ts
import * as os from 'node:os';
import { LlmSummarizer } from './host/digest/llm-summarizer';
import { validateSummarizer } from './shared/memory-settings';
```

(`os` may already be imported; do not duplicate.) After the provider-instances loop (so every registered id, instances included, is in `providers`) and before the default cwd is resolved, add:

```ts
  if (memory) {
    const { setting, warnings } = validateSummarizer(
      vscode.workspace.getConfiguration().get<unknown>(MEMORY_SUMMARIZER_SETTING),
      providers.keys(),
    );
    for (const warning of warnings) { void vscode.window.showWarningMessage(warning); }
    if (setting.mode === 'llm') {
      manager.setSummarizer(new LlmSummarizer({
        provider: providers.get(setting.provider) as AgentProvider,
        model: setting.model,
        effort: setting.effort,
        cwd: os.tmpdir(),
      }));
    }
  }
```

`validateSummarizer` only returns `llm` when the provider id is in `providers.keys()`, so the lookup cannot be undefined; that is how Review Focus #3 (unregistered provider) resolves to one warning and extractive digests.

- [ ] **Step 2: Register the command**

Next to the other `registerCommand` calls:

```ts
    vscode.commands.registerCommand('marcode.memory.reindex', async () => {
      const status = manager.memoryStatus();
      if (!status.enabled) {
        void vscode.window.showInformationMessage('Marcode memory is off (marcode.memory.enabled).');
        return;
      }
      let detail = 'Rebuild the memory index for every session. No model cost.';
      if (status.llm) {
        const est = await manager.memoryEstimate('missing-llm');
        if (est.sessions > 0) {
          detail += ` Then summarize ${est.sessions} closed sessions with the configured model `
            + `(about ${Math.round(est.approxInputTokens / 1000)}k input tokens).`;
        }
      }
      const start = 'Start';
      if (await vscode.window.showInformationMessage(detail, { modal: true }, start) !== start) { return; }
      void manager.memoryReindex('missing-llm').then(() => {
        void vscode.window.showInformationMessage('Marcode memory reindex finished.');
      });
    }),
```

- [ ] **Step 3: Declare the command**

In `package.json` `contributes.commands`, after the `marcode.history.open` entry:

```json
      {
        "command": "marcode.memory.reindex",
        "title": "Marcode: Rebuild memory index"
      }
```

(Add the comma after the previous entry's closing brace.)

- [ ] **Step 4: Verify and commit**

Run: `yarn check-types && yarn lint && yarn run compile && yarn test:unit` — Expected: all pass.

```bash
git add -A src package.json
git commit -m "feat: wire the LLM summarizer and the memory reindex command"
```

---

### Task 14: Docs, full gates, manual check

**Files:**
- Modify: `CLAUDE.md` (architecture table, invariants)

- [ ] **Step 1: Update `CLAUDE.md`**

Add these rows to the path table:

| `src/memory/digest.ts` | `SessionDigest`, the extractive digest, `indexLine` (the one-line pointer) |
| `src/host/digest/digest-service.ts` | The only writer of a digest: serial queue, close-time refresh, reindex with resume |
| `src/host/digest/llm-summarizer.ts` | Hidden, tool-less `AgentRun` (started `withoutSelfControl`) that writes an LLM digest |
| `src/host/digest/llm-prompt.ts` | Trimmed summary prompt and the tolerant JSON reply parser |
| `src/shared/memory-settings.ts` | `marcode.memory.enabled` and `marcode.memory.summarizer` ids and validation |

and add this invariant to the Invariants list:

```
- **One digest per session, one writer.** `DigestService` alone assigns a `SessionDigest`; the
  history tab's `SessionState.summary` is a projection of it and the FTS row is derived from
  it, so history and recall cannot disagree. Writing one never touches `updatedAt`. The LLM
  summarizer runs only on closed sessions and always falls back to the extractive digest.
  `marcode.memory.enabled = false` removes the store, service, priming and recall tools
  entirely; the history tab then keeps the legacy in-memory extractive summary.
```

- [ ] **Step 2: Run every gate**

```bash
yarn check-types && yarn lint && yarn run compile && yarn test:unit && yarn test:dom
```

Expected: all pass.

- [ ] **Step 3: Manual check in the Extension Development Host (F5)**

1. With defaults: close a session that did some work, open the history tab, confirm its summary shows and `Re-summarize` and `Index memory` are visible. Start a new session with a related prompt and confirm the agent's first turn was primed (a `<marcode-memory>` pointer appears in the provider's input, not in the transcript).
2. Set `marcode.memory.enabled` to `false`, reload: history still shows summaries, no `Index memory` button, the agent has no `marcode__recall` tool.
3. Set `marcode.memory.summarizer` to `{ "mode": "llm", "provider": "claude", "model": "<a model id you have>" }`, reload, run `Marcode: Rebuild memory index`, confirm the estimate dialog, and confirm digests upgrade. Stop it midway, re-run, and confirm it resumes rather than restarting.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document the session digest memory and the memory.enabled switch"
```

---

## Self-Review

**Spec coverage**

| Spec section | Task |
|---|---|
| `memory.enabled`, disabled behaviour, nudge relocation | 1, 2, 9 (legacy path), 14 |
| One record, one writer (`SessionDigest`, `indexLine`, `DigestService`) | 3, 8, 9 |
| Storage (`digests` table, schema bump, projection, `updatedAt` untouched) | 4, 9 |
| `marcode.memory.summarizer` setting, required `model`, effort default | 1, 13 |
| LLM summarizer (hidden run, tool-less, no MCP, trimmed input, fallback) | 5, 6, 7, 8 |
| Recall tiers (pointer, digest, transcript) | 10 |
| Reindex (two passes, estimate, cancel, resume, per-row, command) | 8, 11, 12, 13 |
| Protocol (`memory-*`, `HISTORY_WANTS`) | 9, 11 |
| Closed sessions only for LLM | 8 (`upgrade` skips live; `llmTargets` filters `archived`) |

**Placeholder scan:** none; every code step shows the code.

**Type consistency:** `SessionDigest` fields, `DigestMeta`, `DigestScope` (service) and `DigestScopeWire` (protocol) are the same union `'all' | 'missing-llm'`; `DigestProgress.phase` includes `done`/`cancelled` and the history reducer clears progress on both. `LlmSummarizer.summarize(items, base)` matches the `Summarizer` shape `DigestService` and `SessionManager.setSummarizer` accept.

**Known soft spots to watch during execution:** Task 2 and Task 11 tests borrow request/URL shapes from neighbouring tests in the same files (`callFor`, the history router rig); the executor should mirror the nearest existing helper rather than guess. Task 12's DOM tests assume `sendFromHost` accepts the new `memory-*` shapes now that the types exist.
