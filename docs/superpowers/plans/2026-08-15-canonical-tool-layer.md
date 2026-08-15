# Canonical Tool Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move tool-call classification out of the webview renderer and into each provider's adapter, so adding a provider never touches `src/webview/`.

**Architecture:** A closed `ToolCall` union lives in `src/providers/canonical/tool-call.ts`. Each provider gets a `map-tools.ts` that turns its own typed wire payload into one. `AgentEvent`'s tool arms and `TranscriptItem`'s tool/permission arms carry that union instead of `name: string` + `input: unknown`. `tool-render.ts` switches on ten kinds and nothing else. Rollout is expand → migrate → contract: the new field lands optional so every commit compiles and every test stays green, then the old fields are deleted in one final task.

**Tech Stack:** TypeScript, esbuild (two bundles: node/CJS host, browser/IIFE webview), React 19, Tailwind v4, mocha (`--ui tdd`, run from source through `tsx/cjs`), jsdom for DOM tests.

**Spec:** [docs/superpowers/specs/2026-08-15-canonical-tool-layer-design.md](../specs/2026-08-15-canonical-tool-layer-design.md)

## Global Constraints

- `src/protocol/messages.ts` is **types-only**. No runtime code, no `vscode` import.
- Nothing under `src/providers/` or `src/protocol/` imports `vscode`. Neither does `src/host/message-router.ts`.
- Errors are state, never exceptions. A mapper that cannot classify returns `{ kind: 'other', … }`; it never throws on a malformed payload.
- Filenames are kebab-case, including React components. Component identifiers stay PascalCase.
- **Never pass a DOM node to an assertion.** Compare booleans, strings or counts — `assert.strictEqual(el === null, true)`, never `assert.strictEqual(el, null)`. A jsdom node handed to a failing `assert` walks the whole document graph (3.5GB in 4 seconds, 2026-08-14).
- DOM tests drive components through the real `StoreProvider` with genuine `HostToWebview` messages via `sendFromHost`. Never mock `useStore`, never hand-build a `ClientState`.
- UI: shadcn components from `@/components/ui/*`; compose classNames with `cn` from `@/lib/utils`, never template literals.
- `yarn lint`, `yarn check-types` and `yarn run compile` must all pass before every commit.
- Conventional-commit prefixes: `feat:`, `fix:`, `test:`, `chore:`, `docs:`.
- Commit messages carry **no** `Co-Authored-By: Claude` or any Anthropic/Claude attribution trailer.

**Verification commands used throughout:**

```bash
yarn test:unit                                              # all unit tests
npx mocha --ui tdd --require tsx/cjs src/test/unit/X.test.ts # one unit file
yarn test:dom                                               # all DOM tests
yarn check-types && yarn lint
```

---

### Task 1: The canonical type module

**Files:**
- Create: `src/providers/canonical/tool-call.ts`
- Create: `src/test/unit/tool-call.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ToolCall`, `ToolOutput`, `FileEdit`, `Field`, `TodoStatus` types; `parseMcpName(raw: string): { server: string; tool: string } | undefined`; `toTodoStatus(raw: unknown): TodoStatus`.

- [ ] **Step 1: Write the failing test**

Create `src/test/unit/tool-call.test.ts`:

```ts
import * as assert from 'assert';
import { parseMcpName, toTodoStatus } from '../../providers/canonical/tool-call';

suite('parseMcpName', () => {
  test('splits server and tool', () => {
    assert.deepStrictEqual(parseMcpName('mcp__github__create_issue'),
      { server: 'github', tool: 'create_issue' });
  });

  test('keeps separators inside the tool name', () => {
    assert.deepStrictEqual(parseMcpName('mcp__github__list__repos'),
      { server: 'github', tool: 'list__repos' });
  });

  test('is undefined for a name without the prefix', () => {
    assert.strictEqual(parseMcpName('Bash'), undefined);
  });

  test('is undefined for a prefix with no server', () => {
    assert.strictEqual(parseMcpName('mcp____tool'), undefined);
  });

  test('is undefined for a prefix with no tool', () => {
    assert.strictEqual(parseMcpName('mcp__github__'), undefined);
  });
});

suite('toTodoStatus', () => {
  test('passes through the two non-default states', () => {
    assert.strictEqual(toTodoStatus('completed'), 'completed');
    assert.strictEqual(toTodoStatus('in_progress'), 'in_progress');
  });

  test('degrades anything else to pending', () => {
    assert.strictEqual(toTodoStatus('nonsense'), 'pending');
    assert.strictEqual(toTodoStatus(undefined), 'pending');
    assert.strictEqual(toTodoStatus(7), 'pending');
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx mocha --ui tdd --require tsx/cjs src/test/unit/tool-call.test.ts`
Expected: FAIL — `Cannot find module '../../providers/canonical/tool-call'`.

- [ ] **Step 3: Write the module**

Create `src/providers/canonical/tool-call.ts`:

```ts
// The canonical description of one tool call, produced by a provider's
// adapter and consumed by the webview renderer. A provider classifies against
// its own typed wire schema; nothing downstream ever branches on a tool's
// name. Adding a provider means adding one `map-tools.ts`, never editing
// `src/webview/components/tool-render.ts`.
//
// Imports nothing from `vscode` and nothing from `src/webview/`.

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export type Field = { label: string; value: string };

export interface FileEdit {
  /** Absolute where the provider gave one. POSIX separators. */
  path: string;
  op: 'create' | 'modify' | 'delete' | 'rename';
  /** Before/after pairs, as Claude's edit family reports them. */
  edits?: { before?: string; after?: string }[];
  /** A full unified diff, `---`/`+++`/`@@` headers included, as Codex reports it. */
  unifiedDiff?: string;
  replaceAll?: boolean;
}

/**
 * `label` is display-only: the provider's own word for the call (`Bash`,
 * `Edit`, `Shell`). Nothing branches on it — every rendering decision comes
 * off `kind` and the typed fields beside it.
 *
 * `other` is the only arm carrying `raw`, because the JSON fallback has
 * nothing else to show. Every other arm has already extracted what matters,
 * so carrying the raw input too would duplicate a large `Write`'s whole
 * content into the transcript.
 */
export type ToolCall =
  | { kind: 'command'; label: string; command: string; cwd?: string;
      background?: boolean; timeoutMs?: number; note?: string }
  | { kind: 'file-edit'; label: string; files: FileEdit[] }
  | { kind: 'file-read'; label: string; path: string;
      range?: { offset: number; limit?: number }; pages?: string }
  | { kind: 'search'; label: string; pattern: string; mode: 'content' | 'files';
      scope?: string; filters?: Field[] }
  | { kind: 'web'; label: string; query?: string; url?: string; note?: string }
  | { kind: 'todos'; label: string; items: { status: TodoStatus; text: string }[] }
  | { kind: 'plan'; label: string; text: string }
  | { kind: 'subagent'; label: string; action: 'spawn' | 'message' | 'collect';
      agent?: string; model?: string; isolation?: string; target?: string;
      summary?: string; prompt?: string; fields?: Field[] }
  | { kind: 'mcp'; label: string; server: string; tool: string; args?: unknown }
  | { kind: 'other'; label: string; fields?: Field[]; raw: unknown };

/**
 * A tool's result, already unwrapped by the adapter that understands the
 * backend's shape. `none` is a positive answer — the call produced no result
 * worth showing — and is what a Codex `fileChange` reports, since its diffs
 * belong to the call rather than to its result.
 */
export type ToolOutput =
  | { kind: 'none' }
  | { kind: 'text'; text: string }
  | { kind: 'json'; value: unknown };

const MCP_PREFIX = 'mcp__';
const MCP_SEP = '__';

/**
 * Splits `mcp__<server>__<tool>`.
 *
 * The server is the first segment after the prefix; everything after the next
 * separator is the tool, separators included — a legitimate
 * `mcp__github__list__repos` has a tool name that contains the separator, so
 * requiring exactly three segments would mis-handle it.
 *
 * Anything that does not split cleanly returns undefined. A guess would put a
 * wrong server badge on a transcript item that is then persisted and never
 * re-derived.
 */
export function parseMcpName(raw: string): { server: string; tool: string } | undefined {
  if (!raw.startsWith(MCP_PREFIX)) { return undefined; }
  const rest = raw.slice(MCP_PREFIX.length);
  const at = rest.indexOf(MCP_SEP);
  if (at <= 0) { return undefined; }
  const tool = rest.slice(at + MCP_SEP.length);
  if (!tool) { return undefined; }
  return { server: rest.slice(0, at), tool };
}

/** Anything that is not one of the two non-default states is `pending`. */
export function toTodoStatus(raw: unknown): TodoStatus {
  return raw === 'completed' || raw === 'in_progress' ? raw : 'pending';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx mocha --ui tdd --require tsx/cjs src/test/unit/tool-call.test.ts`
Expected: PASS, 8 passing.

- [ ] **Step 5: Typecheck and lint**

Run: `yarn check-types && yarn lint`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/providers/canonical/tool-call.ts src/test/unit/tool-call.test.ts
git commit -m "feat: add the canonical ToolCall union"
```

---

### Task 2: Claude tool mapper

**Files:**
- Create: `src/providers/claude/map-tools.ts`
- Create: `src/test/unit/claude-map-tools.test.ts`

**Interfaces:**
- Consumes: `ToolCall`, `ToolOutput`, `parseMcpName`, `toTodoStatus` from Task 1.
- Produces: `toToolCall(name: string, input: unknown): ToolCall`; `toToolOutput(content: unknown): ToolOutput`.

Nothing calls these yet — Task 4 wires them in. They are pure and testable on their own.

- [ ] **Step 1: Write the failing test**

Create `src/test/unit/claude-map-tools.test.ts`:

```ts
import * as assert from 'assert';
import { toToolCall, toToolOutput } from '../../providers/claude/map-tools';

suite('claude toToolCall', () => {
  test('Bash becomes a command, keeping the provider name as the label', () => {
    const call = toToolCall('Bash', {
      command: 'yarn test', description: 'run tests', timeout: 30000,
      run_in_background: true,
    });
    assert.deepStrictEqual(call, {
      kind: 'command', label: 'Bash', command: 'yarn test',
      note: 'run tests', timeoutMs: 30000, background: true,
    });
  });

  test('Edit becomes a modify with a before/after pair', () => {
    const call = toToolCall('Edit', {
      file_path: 'E:/x/src/app.ts', old_string: 'foo', new_string: 'bar',
      replace_all: true,
    });
    assert.deepStrictEqual(call, {
      kind: 'file-edit', label: 'Edit',
      files: [{
        path: 'E:/x/src/app.ts', op: 'modify',
        edits: [{ before: 'foo', after: 'bar' }], replaceAll: true,
      }],
    });
  });

  test('Write becomes a create carrying only the new content', () => {
    const call = toToolCall('Write', { file_path: '/tmp/a.txt', content: 'hello' });
    assert.deepStrictEqual(call, {
      kind: 'file-edit', label: 'Write',
      files: [{ path: '/tmp/a.txt', op: 'create', edits: [{ after: 'hello' }] }],
    });
  });

  test('Read carries its range', () => {
    const call = toToolCall('Read', { file_path: '/a.ts', offset: 10, limit: 20 });
    assert.deepStrictEqual(call, {
      kind: 'file-read', label: 'Read', path: '/a.ts',
      range: { offset: 10, limit: 20 },
    });
  });

  test('Grep and Glob differ only by mode', () => {
    const grep = toToolCall('Grep', { pattern: 'foo', path: 'src', glob: '*.ts' });
    assert.deepStrictEqual(grep, {
      kind: 'search', label: 'Grep', pattern: 'foo', mode: 'content',
      scope: 'src', filters: [{ label: 'glob', value: '*.ts' }],
    });
    const glob = toToolCall('Glob', { pattern: '**/*.ts' });
    assert.deepStrictEqual(glob, {
      kind: 'search', label: 'Glob', pattern: '**/*.ts', mode: 'files',
    });
  });

  test('WebFetch carries url and prompt', () => {
    const call = toToolCall('WebFetch', { url: 'https://x.dev/a', prompt: 'summarize' });
    assert.deepStrictEqual(call, {
      kind: 'web', label: 'WebFetch', url: 'https://x.dev/a', note: 'summarize',
    });
  });

  test('TodoWrite normalizes statuses and drops empty rows', () => {
    const call = toToolCall('TodoWrite', {
      todos: [
        { content: 'one', status: 'completed' },
        { content: 'two', status: 'weird' },
        { status: 'pending' },
      ],
    });
    assert.deepStrictEqual(call, {
      kind: 'todos', label: 'TodoWrite',
      items: [
        { status: 'completed', text: 'one' },
        { status: 'pending', text: 'two' },
      ],
    });
  });

  test('Agent spawns, SendMessage messages, TaskOutput collects', () => {
    assert.strictEqual(toToolCall('Agent', {}).kind, 'subagent');
    const spawn = toToolCall('Agent', {
      subagent_type: 'Explore', model: 'sonnet', prompt: 'find it',
    });
    assert.deepStrictEqual(spawn, {
      kind: 'subagent', label: 'Agent', action: 'spawn',
      agent: 'Explore', model: 'sonnet', prompt: 'find it',
    });
    const message = toToolCall('SendMessage', { to: 'agent-1', summary: 'ping' });
    assert.deepStrictEqual(message, {
      kind: 'subagent', label: 'SendMessage', action: 'message',
      target: 'agent-1', summary: 'ping',
    });
    const collect = toToolCall('TaskOutput', { task_id: 'task-9' });
    assert.deepStrictEqual(collect, {
      kind: 'subagent', label: 'TaskOutput', action: 'collect', target: 'task-9',
    });
  });

  test('an mcp__ name becomes an mcp call carrying its arguments', () => {
    const call = toToolCall('mcp__github__create_issue', { title: 'bug' });
    assert.deepStrictEqual(call, {
      kind: 'mcp', label: 'create_issue', server: 'github',
      tool: 'create_issue', args: { title: 'bug' },
    });
  });

  test('an unknown tool falls through to other with its raw input', () => {
    const call = toToolCall('Bananas', { a: 1 });
    assert.deepStrictEqual(call, { kind: 'other', label: 'Bananas', raw: { a: 1 } });
  });

  test('a malformed input never throws', () => {
    assert.strictEqual(toToolCall('Bash', null).kind, 'command');
    assert.strictEqual(toToolCall('Edit', 'nonsense').kind, 'file-edit');
    assert.strictEqual(toToolCall('TodoWrite', { todos: 'no' }).kind, 'todos');
  });
});

suite('claude toToolOutput', () => {
  test('a bare string is text', () => {
    assert.deepStrictEqual(toToolOutput('done'), { kind: 'text', text: 'done' });
  });

  test('content blocks join their text', () => {
    assert.deepStrictEqual(
      toToolOutput([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]),
      { kind: 'text', text: 'a\nb' },
    );
  });

  test('a stdout/stderr object joins both streams', () => {
    assert.deepStrictEqual(toToolOutput({ stdout: 'out', stderr: 'err' }),
      { kind: 'text', text: 'out\nerr' });
  });

  test('an unrecognized object stays json', () => {
    assert.deepStrictEqual(toToolOutput({ a: 1 }), { kind: 'json', value: { a: 1 } });
  });

  test('null and empty string are none', () => {
    assert.deepStrictEqual(toToolOutput(null), { kind: 'none' });
    assert.deepStrictEqual(toToolOutput(''), { kind: 'none' });
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx mocha --ui tdd --require tsx/cjs src/test/unit/claude-map-tools.test.ts`
Expected: FAIL — `Cannot find module '../../providers/claude/map-tools'`.

- [ ] **Step 3: Write the mapper**

Create `src/providers/claude/map-tools.ts`:

```ts
// Claude SDK tool calls to the canonical `ToolCall` union.
//
// Switches on the SDK's own tool names — no substring matching. A shared
// name heuristic (`includes('agent')` -> subagent) misclassifies silently:
// an MCP server named `agentql` would render as a spawned subagent. A wrong
// classification belongs in this file's tests, not in a regex every provider
// is subject to.
//
// Pure. Nothing here throws: an unreadable input yields the emptiest honest
// call, and an unrecognized name yields `other`.

import {
  parseMcpName, toTodoStatus,
  type Field, type FileEdit, type ToolCall, type ToolOutput,
} from '../canonical/tool-call';

type Rec = Record<string, unknown>;

const asRecord = (v: unknown): Rec =>
  (typeof v === 'object' && v !== null && !Array.isArray(v)) ? v as Rec : {};

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/** Drops undefined-valued keys so tests can compare whole objects. */
function compact<T extends object>(value: T): T {
  for (const key of Object.keys(value)) {
    if ((value as Rec)[key] === undefined) { delete (value as Rec)[key]; }
  }
  return value;
}

function fileEdit(record: Rec, op: FileEdit['op']): FileEdit {
  const before = str(record.old_string) ?? str(record.old_source);
  const after = str(record.new_string) ?? str(record.new_source) ?? str(record.content);
  const edits = before !== undefined || after !== undefined
    ? [compact({ before, after })]
    : undefined;
  return compact({
    path: str(record.file_path) ?? str(record.notebook_path) ?? str(record.path) ?? '',
    op,
    edits,
    replaceAll: record.replace_all === true ? true : undefined,
  });
}

function searchFilters(record: Rec): Field[] | undefined {
  const filters: Field[] = [];
  for (const key of ['glob', 'type', 'output_mode'] as const) {
    const value = str(record[key]);
    if (value) { filters.push({ label: key.replace('_', ' '), value }); }
  }
  return filters.length > 0 ? filters : undefined;
}

export function toToolCall(name: string, input: unknown): ToolCall {
  const record = asRecord(input);

  const mcp = parseMcpName(name);
  if (mcp) {
    return { kind: 'mcp', label: mcp.tool, server: mcp.server, tool: mcp.tool, args: input };
  }

  switch (name) {
    case 'Bash':
    case 'BashOutput':
    case 'KillShell':
      return compact({
        kind: 'command', label: name,
        command: str(record.command) ?? '',
        cwd: str(record.cwd),
        note: str(record.description),
        timeoutMs: num(record.timeout),
        background: record.run_in_background === true ? true : undefined,
      });

    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { kind: 'file-edit', label: name, files: [fileEdit(record, 'modify')] };

    case 'Write':
      return { kind: 'file-edit', label: name, files: [fileEdit(record, 'create')] };

    case 'Read': {
      const offset = num(record.offset);
      return compact({
        kind: 'file-read', label: name,
        path: str(record.file_path) ?? '',
        range: offset !== undefined ? compact({ offset, limit: num(record.limit) }) : undefined,
        pages: str(record.pages),
      });
    }

    case 'Grep':
    case 'Glob':
      return compact({
        kind: 'search', label: name,
        pattern: str(record.pattern) ?? '',
        mode: name === 'Grep' ? 'content' : 'files',
        scope: str(record.path),
        filters: searchFilters(record),
      });

    case 'WebSearch':
    case 'WebFetch':
      return compact({
        kind: 'web', label: name,
        query: str(record.query),
        url: str(record.url),
        note: str(record.prompt),
      });

    case 'TodoWrite': {
      const todos = Array.isArray(record.todos) ? record.todos : [];
      return {
        kind: 'todos', label: name,
        items: todos
          .map(asRecord)
          .map((todo) => ({
            status: toTodoStatus(todo.status),
            text: str(todo.content) ?? str(todo.activeForm) ?? '',
          }))
          .filter((item) => item.text.length > 0),
      };
    }

    case 'Agent':
    case 'Task':
      return compact({
        kind: 'subagent', label: name, action: 'spawn',
        // `name` is the caller-chosen label an Agent call can carry instead
        // of a type; it is what SendMessage addresses later.
        agent: str(record.subagent_type) ?? str(record.name),
        model: str(record.model),
        isolation: str(record.isolation),
        prompt: str(record.prompt),
        summary: str(record.description),
      });

    case 'SendMessage':
      return compact({
        kind: 'subagent', label: name, action: 'message',
        target: str(record.to) ?? str(record.recipient),
        summary: str(record.summary),
        prompt: str(record.message) ?? str(record.content),
      });

    case 'TaskOutput':
      return compact({
        kind: 'subagent', label: name, action: 'collect',
        target: str(record.task_id),
        fields: record.block === true
          ? [{ label: 'wait', value: 'until done' }]
          : undefined,
      });

    default:
      return { kind: 'other', label: name, raw: input };
  }
}

/**
 * Unwraps a `tool_result` block's content. The Anthropic wire shape is either
 * a bare string or an array of content blocks, and the CLI is free to hand
 * back a plain object instead — all three appear.
 */
export function toToolOutput(content: unknown): ToolOutput {
  if (content === null || content === undefined) { return { kind: 'none' }; }

  if (typeof content === 'string') {
    return content.length > 0 ? { kind: 'text', text: content } : { kind: 'none' };
  }

  if (Array.isArray(content)) {
    const text = content
      .map((block) => typeof block === 'string' ? block : str(asRecord(block).text))
      .filter((part): part is string => part !== undefined && part.length > 0)
      .join('\n');
    return text.length > 0 ? { kind: 'text', text } : { kind: 'json', value: content };
  }

  const record = asRecord(content);
  const direct = str(record.text);
  if (direct) { return { kind: 'text', text: direct }; }
  const streams = [str(record.stdout), str(record.stderr)]
    .filter((part): part is string => part !== undefined);
  if (streams.length > 0) { return { kind: 'text', text: streams.join('\n') }; }

  return { kind: 'json', value: content };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx mocha --ui tdd --require tsx/cjs src/test/unit/claude-map-tools.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and lint**

Run: `yarn check-types && yarn lint`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/providers/claude/map-tools.ts src/test/unit/claude-map-tools.test.ts
git commit -m "feat: classify Claude tool calls into the canonical union"
```

---

### Task 3: Codex tool mapper

**Files:**
- Create: `src/providers/codex/map-tools.ts`
- Create: `src/test/unit/codex-map-tools.test.ts`
- Read for reference: `src/providers/codex/wire.ts` (`ThreadItem`, `FileUpdateChange`, `CommandAction`), `src/providers/codex/map-events.ts:163-172` (`displayCommand`)

**Interfaces:**
- Consumes: `ToolCall`, `ToolOutput` from Task 1.
- Produces: `toToolCall(item: ThreadItem): ToolCall | undefined`; `toToolOutput(item: ThreadItem): ToolOutput`; `approvalToolCall(method: string, params: unknown): ToolCall | undefined`; `displayCommand(command: string, actions: CommandAction[] | undefined): string` (moved here from `map-events.ts`, exported).

`toToolCall` returns `undefined` for an item kind that is not a tool — that is how `map-events.ts` will keep ignoring unmodelled items.

- [ ] **Step 1: Write the failing test**

Create `src/test/unit/codex-map-tools.test.ts`:

```ts
import * as assert from 'assert';
import { approvalToolCall, toToolCall, toToolOutput } from '../../providers/codex/map-tools';
import type { ThreadItem } from '../../providers/codex/wire';

suite('codex toToolCall', () => {
  test('commandExecution prefers the parsed actions over the escaped invocation', () => {
    const item = {
      type: 'commandExecution', id: 'i1',
      command: '"C:\\\\Program Files\\\\pwsh.exe" -Command "ls"',
      commandActions: [{ command: 'ls' }],
      cwd: 'E:/x',
    } as unknown as ThreadItem;
    assert.deepStrictEqual(toToolCall(item), {
      kind: 'command', label: 'Shell', command: 'ls', cwd: 'E:/x',
    });
  });

  test('commandExecution falls back to the raw invocation when nothing parsed', () => {
    const item = {
      type: 'commandExecution', id: 'i1', command: 'ls -la',
    } as unknown as ThreadItem;
    assert.strictEqual(
      toToolCall(item)?.kind === 'command' && toToolCall(item)?.kind, 'command');
    const call = toToolCall(item);
    assert.deepStrictEqual(call, { kind: 'command', label: 'Shell', command: 'ls -la' });
  });

  test('fileChange becomes one FileEdit per touched file, op mapped from kind', () => {
    const item = {
      type: 'fileChange', id: 'i2',
      changes: [
        { path: 'a.ts', kind: 'add', diff: '--- a\n+++ b\n@@\n+x' },
        { path: 'b.ts', kind: 'delete', diff: '--- a\n+++ b\n@@\n-y' },
        { path: 'c.ts', kind: 'update', diff: '--- a\n+++ b\n@@\n z' },
      ],
    } as unknown as ThreadItem;
    assert.deepStrictEqual(toToolCall(item), {
      kind: 'file-edit', label: 'Edit',
      files: [
        { path: 'a.ts', op: 'create', unifiedDiff: '--- a\n+++ b\n@@\n+x' },
        { path: 'b.ts', op: 'delete', unifiedDiff: '--- a\n+++ b\n@@\n-y' },
        { path: 'c.ts', op: 'modify', unifiedDiff: '--- a\n+++ b\n@@\n z' },
      ],
    });
  });

  test('mcpToolCall reads `tool`, not `toolName`', () => {
    const item = {
      type: 'mcpToolCall', id: 'i3', server: 'github', tool: 'create_issue',
    } as unknown as ThreadItem;
    assert.deepStrictEqual(toToolCall(item), {
      kind: 'mcp', label: 'create_issue', server: 'github', tool: 'create_issue',
    });
  });

  test('webSearch carries the query it has', () => {
    const item = { type: 'webSearch', id: 'i4', query: 'effect schema' } as unknown as ThreadItem;
    assert.deepStrictEqual(toToolCall(item), {
      kind: 'web', label: 'Web search', query: 'effect schema',
    });
  });

  test('plan carries its text', () => {
    const item = { type: 'plan', id: 'i5', text: 'do the thing' } as unknown as ThreadItem;
    assert.deepStrictEqual(toToolCall(item), {
      kind: 'plan', label: 'Plan', text: 'do the thing',
    });
  });

  test('dynamicToolCall is other, labelled with the tool name', () => {
    const item = { type: 'dynamicToolCall', id: 'i6', tool: 'weird' } as unknown as ThreadItem;
    assert.deepStrictEqual(toToolCall(item), {
      kind: 'other', label: 'weird', raw: item,
    });
  });

  test('an unmodelled item is not a tool', () => {
    const item = { type: 'agentMessage', id: 'i7' } as unknown as ThreadItem;
    assert.strictEqual(toToolCall(item), undefined);
  });
});

suite('codex toToolOutput', () => {
  test('a command reports its aggregated output as text', () => {
    const item = {
      type: 'commandExecution', id: 'i1', command: 'ls', aggregatedOutput: 'a\nb',
    } as unknown as ThreadItem;
    assert.deepStrictEqual(toToolOutput(item), { kind: 'text', text: 'a\nb' });
  });

  test('a fileChange has no output — its diffs belong to the call', () => {
    const item = { type: 'fileChange', id: 'i2', changes: [] } as unknown as ThreadItem;
    assert.deepStrictEqual(toToolOutput(item), { kind: 'none' });
  });

  test('a webSearch flattens results to title/url pairs', () => {
    const item = {
      type: 'webSearch', id: 'i3',
      results: [{ title: 'T', url: 'https://x.dev' }, { nothing: true }],
    } as unknown as ThreadItem;
    assert.deepStrictEqual(toToolOutput(item), {
      kind: 'text', text: 'T\nhttps://x.dev',
    });
  });
});

suite('codex approvalToolCall', () => {
  test('a command approval reads the same spelling the item will', () => {
    const call = approvalToolCall('item/commandExecution/requestApproval', {
      command: '"pwsh.exe" -Command "ls"',
      commandActions: [{ command: 'ls' }],
      cwd: 'E:/x',
      reason: 'outside the sandbox',
    });
    assert.deepStrictEqual(call, {
      kind: 'command', label: 'Shell', command: 'ls', cwd: 'E:/x',
      note: 'outside the sandbox',
    });
  });

  test('a file-change approval becomes a file-edit', () => {
    const call = approvalToolCall('item/fileChange/requestApproval', {
      changes: [{ path: 'a.ts', kind: 'update', diff: 'd' }],
    });
    assert.deepStrictEqual(call, {
      kind: 'file-edit', label: 'Edit',
      files: [{ path: 'a.ts', op: 'modify', unifiedDiff: 'd' }],
    });
  });

  test('a permissions approval is other, carrying its params', () => {
    const call = approvalToolCall('item/permissions/requestApproval', { scope: 'net' });
    assert.deepStrictEqual(call, {
      kind: 'other', label: 'Permission', raw: { scope: 'net' },
    });
  });

  test('a method that is not an approval is undefined', () => {
    assert.strictEqual(approvalToolCall('item/started', {}), undefined);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx mocha --ui tdd --require tsx/cjs src/test/unit/codex-map-tools.test.ts`
Expected: FAIL — `Cannot find module '../../providers/codex/map-tools'`.

- [ ] **Step 3: Write the mapper**

Create `src/providers/codex/map-tools.ts`:

```ts
// Codex `ThreadItem`s to the canonical `ToolCall` union.
//
// Switches on the discriminated union in wire.ts, so classification is
// exhaustive against a schema rather than guessed from a name. Codex ships no
// tool names on this wire at all — `ThreadItem.type` is an internal
// discriminant (`commandExecution`, `fileChange`) that no user has typed or
// read — so `label` carries a short human word instead. That is a label, not
// a rebranding: it says what the Claude arm's own tool name says.
//
// Approvals build their call through the same functions as items, so an
// approval card and the tool card it becomes agree by construction.

import type { Field, FileEdit, ToolCall, ToolOutput } from '../canonical/tool-call';
import type { CommandAction, FileUpdateChange, ThreadItem } from './wire';

type Rec = Record<string, unknown>;

const asRecord = (v: unknown): Rec =>
  (typeof v === 'object' && v !== null && !Array.isArray(v)) ? v as Rec : {};

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;

function compact<T extends object>(value: T): T {
  for (const key of Object.keys(value)) {
    if ((value as Rec)[key] === undefined) { delete (value as Rec)[key]; }
  }
  return value;
}

/**
 * The command to *show* for a `commandExecution`.
 *
 * `ThreadItem.command` is the escaped invocation Codex spawns — on Windows,
 * `"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "…"` with every
 * backslash doubled, which renders as a JSON-looking blob in a 300px header.
 * `commandActions` is the same call as Codex itself parsed it, and is
 * documented as being "for friendly display". The raw invocation is the
 * fallback, never the preference: a command with nothing parsed out of it is
 * still better shown than hidden.
 *
 * One shell command can decompose into several actions (a pipeline). They are
 * joined by newline rather than a made-up operator — the header is a single
 * truncated line either way, and the expanded `$` block shows them stacked
 * without claiming a `&&` that was never written.
 */
export function displayCommand(command: string, actions: CommandAction[] | undefined): string {
  const parsed = (actions ?? [])
    .map((action) => action?.command)
    .filter((c): c is string => typeof c === 'string' && c.length > 0);
  return parsed.length > 0 ? parsed.join('\n') : command;
}

/** Codex's open `FileUpdateChange.kind` string to the canonical op. */
function toOp(kind: unknown): FileEdit['op'] {
  switch (kind) {
    case 'add': return 'create';
    case 'delete': return 'delete';
    case 'rename': return 'rename';
    default: return 'modify';
  }
}

function fileEdits(changes: unknown): FileEdit[] {
  if (!Array.isArray(changes)) { return []; }
  return changes
    .map((raw) => asRecord(raw) as unknown as Partial<FileUpdateChange>)
    .filter((change): change is FileUpdateChange => typeof change.path === 'string')
    .map((change) => compact({
      path: change.path,
      op: toOp(change.kind),
      unifiedDiff: str(change.diff),
    }));
}

export function toToolCall(item: ThreadItem): ToolCall | undefined {
  switch (item.type) {
    case 'commandExecution': {
      const c = item as Extract<ThreadItem, { type: 'commandExecution' }>;
      return compact({
        kind: 'command', label: 'Shell',
        command: displayCommand(c.command, c.commandActions),
        cwd: str(c.cwd),
      });
    }

    case 'fileChange': {
      const f = item as Extract<ThreadItem, { type: 'fileChange' }>;
      return { kind: 'file-edit', label: 'Edit', files: fileEdits(f.changes) };
    }

    case 'mcpToolCall': {
      const m = item as Extract<ThreadItem, { type: 'mcpToolCall' }>;
      const tool = str(m.tool) ?? '';
      return { kind: 'mcp', label: tool || m.server, server: m.server, tool };
    }

    case 'webSearch': {
      const w = item as Extract<ThreadItem, { type: 'webSearch' }>;
      return compact({ kind: 'web', label: 'Web search', query: str(w.query) });
    }

    case 'plan': {
      const p = item as Extract<ThreadItem, { type: 'plan' }>;
      return { kind: 'plan', label: 'Plan', text: p.text };
    }

    case 'dynamicToolCall': {
      const d = item as Extract<ThreadItem, { type: 'dynamicToolCall' }>;
      return { kind: 'other', label: str(d.tool) ?? 'Tool', raw: item };
    }

    // Every other item kind is deliberately not a tool. Parsing stays
    // tolerant: an unknown item is ignored rather than rendered.
    default:
      return undefined;
  }
}

export function toToolOutput(item: ThreadItem): ToolOutput {
  if (item.type === 'commandExecution') {
    const c = item as Extract<ThreadItem, { type: 'commandExecution' }>;
    // Buffered, not streamed: `item/commandExecution/outputDelta` exists, but
    // there is no tool-output-delta event, which matches Claude's behavior.
    const text = c.aggregatedOutput ?? '';
    return text.length > 0 ? { kind: 'text', text } : { kind: 'none' };
  }

  if (item.type === 'webSearch') {
    // `results` is opaque JSON by design upstream, so this reads only the two
    // fields every result type has carried and drops the rest — a raw dump of
    // ten search hits is a screen of escaped JSON in a sidebar.
    const w = item as Extract<ThreadItem, { type: 'webSearch' }>;
    const text = (w.results ?? [])
      .map((raw) => {
        const result = asRecord(raw);
        return [str(result.title), str(result.url)]
          .filter((part): part is string => part !== undefined)
          .join('\n');
      })
      .filter((entry) => entry.length > 0)
      .join('\n\n');
    return text.length > 0 ? { kind: 'text', text } : { kind: 'none' };
  }

  // A fileChange's diffs belong to the call, not to its result: the completed
  // item revises the ToolCall, and there is nothing left to show here.
  if (item.type === 'fileChange') { return { kind: 'none' }; }

  return { kind: 'none' };
}

const APPROVAL_KINDS: Record<string, 'command' | 'file-change' | 'permissions'> = {
  'item/commandExecution/requestApproval': 'command',
  'item/fileChange/requestApproval': 'file-change',
  'item/permissions/requestApproval': 'permissions',
};

export function approvalToolCall(method: string, params: unknown): ToolCall | undefined {
  const kind = APPROVAL_KINDS[method];
  if (!kind) { return undefined; }
  const p = asRecord(params);

  if (kind === 'command') {
    return compact({
      kind: 'command', label: 'Shell',
      command: displayCommand(
        typeof p.command === 'string' ? p.command : '',
        p.commandActions as CommandAction[] | undefined,
      ),
      cwd: str(p.cwd),
      note: str(p.reason),
    });
  }

  if (kind === 'file-change') {
    return { kind: 'file-edit', label: 'Edit', files: fileEdits(p.changes) };
  }

  const fields: Field[] = [];
  const reason = str(p.reason);
  if (reason) { fields.push({ label: 'reason', value: reason }); }
  return compact({
    kind: 'other', label: 'Permission',
    fields: fields.length > 0 ? fields : undefined,
    raw: params,
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx mocha --ui tdd --require tsx/cjs src/test/unit/codex-map-tools.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and lint**

Run: `yarn check-types && yarn lint`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/providers/codex/map-tools.ts src/test/unit/codex-map-tools.test.ts
git commit -m "feat: classify Codex thread items into the canonical union"
```

---

### Task 4: Expand — carry `tool` alongside `name`/`input`

Providers start emitting a `ToolCall` on every tool event, and `AgentSession` copies it onto the transcript item. The field is **optional** for this task and the next, so every commit compiles and every existing test stays green. Task 6 makes it required and deletes the old fields.

**Files:**
- Modify: `src/providers/types.ts` — add `tool?` to the three tool arms, re-export the canonical types
- Modify: `src/protocol/messages.ts` — add `tool?` to the `tool` and `permission` item arms and to `PermissionRequest`
- Modify: `src/providers/claude/map-events.ts:221-243` — populate `tool` on `tool-start` / `tool-end`
- Modify: `src/providers/claude/claude-provider.ts` — populate `tool` on the `permission` event raised from `canUseTool`
- Modify: `src/providers/codex/map-events.ts:131-150, 249-272` — populate `tool` from `map-tools`, drop the now-duplicated `displayCommand`/`inputOf`/`outputOf`
- Modify: `src/host/agent-session.ts:411-505` — copy `tool` onto items and onto `pending`
- Test: `src/test/unit/codex-map-events.test.ts`, `src/test/unit/agent-session.test.ts`

**Interfaces:**
- Consumes: `toToolCall`/`toToolOutput` from Tasks 2 and 3, `approvalToolCall` from Task 3.
- Produces: `AgentEvent`'s `tool-start`/`tool-end`/`permission` arms each carrying `tool?: ToolCall`; `tool-end` carrying `toolOutput?: ToolOutput`; `TranscriptItem`'s tool arm carrying `tool?: ToolCall` and `toolOutput?: ToolOutput`, permission arm carrying `tool?: ToolCall`.

`toolOutput` is a temporary second name beside the existing `output: unknown`. Task 6 deletes `output` and renames `toolOutput` back to `output`.

- [ ] **Step 1: Write the failing test**

Append to `src/test/unit/codex-map-events.test.ts`:

```ts
suite('codex map-events canonical tool', () => {
  test('item/started carries a canonical command call', () => {
    const events = mapNotification('item/started', {
      item: { type: 'commandExecution', id: 'i1', command: 'ls', cwd: 'E:/x' },
    });
    assert.strictEqual(events.length, 1);
    const event = events[0];
    assert.strictEqual(event.kind, 'tool-start');
    assert.deepStrictEqual(event.kind === 'tool-start' ? event.tool : undefined, {
      kind: 'command', label: 'Shell', command: 'ls', cwd: 'E:/x',
    });
  });

  test('item/completed revises the call and carries a canonical output', () => {
    const events = mapNotification('item/completed', {
      item: {
        type: 'webSearch', id: 'i2', query: 'effect schema',
        results: [{ title: 'T', url: 'https://x.dev' }],
      },
    });
    const event = events[0];
    assert.strictEqual(event.kind, 'tool-end');
    if (event.kind !== 'tool-end') { return; }
    assert.deepStrictEqual(event.tool,
      { kind: 'web', label: 'Web search', query: 'effect schema' });
    assert.deepStrictEqual(event.toolOutput,
      { kind: 'text', text: 'T\nhttps://x.dev' });
  });
});
```

Append to `src/test/unit/agent-session.test.ts` (follow the file's existing harness for constructing a session and feeding events):

```ts
test('a tool item carries the canonical call the provider sent', () => {
  const { session, items } = startSession();
  session.handle({
    kind: 'tool-start', id: 't1', name: 'Bash', input: { command: 'ls' },
    tool: { kind: 'command', label: 'Bash', command: 'ls' },
  });
  const item = items().find((i) => i.role === 'tool');
  assert.strictEqual(item?.role === 'tool' && item.tool?.kind, 'command');
});
```

- [ ] **Step 2: Run both to make sure they fail**

Run: `npx mocha --ui tdd --require tsx/cjs src/test/unit/codex-map-events.test.ts src/test/unit/agent-session.test.ts`
Expected: FAIL — `tool` is not a property on the event / item types.

- [ ] **Step 3: Widen the types**

In `src/providers/types.ts`, re-export the canonical types and widen the three arms:

```ts
import type { ToolCall, ToolOutput } from './canonical/tool-call';
export type { ToolCall, ToolOutput } from './canonical/tool-call';

// … inside AgentEvent:
  | { kind: 'tool-start'; id: string; name: string; input: unknown;
      parentId?: string; tool?: ToolCall }
  | { kind: 'tool-end'; id: string; ok: boolean; output: unknown; input?: unknown;
      parentId?: string; tool?: ToolCall; toolOutput?: ToolOutput }
  | { kind: 'permission'; id: string; name: string; input: unknown;
      parentId?: string; tool?: ToolCall }
```

In `src/protocol/messages.ts`, re-export and widen:

```ts
import type { /* … existing … */ ToolCall, ToolOutput } from '../providers/types';
export type { /* … existing … */ ToolCall, ToolOutput };

// … inside TranscriptItem:
  | (ItemBase & {
      role: 'tool'; toolId: string; name: string; input: unknown;
      state: 'running' | 'ok' | 'error'; output?: unknown;
      children?: TranscriptItem[]; mcpServer?: string;
      tool?: ToolCall; toolOutput?: ToolOutput;
    })
  | (ItemBase & {
      role: 'permission'; requestId: string; name: string; input: unknown;
      state: 'pending' | 'allowed' | 'denied'; reason?: string;
      mcpServer?: string; tool?: ToolCall;
    })

export interface PermissionRequest {
  requestId: string; name: string; input: unknown; tool?: ToolCall;
}
```

- [ ] **Step 4: Populate `tool` in the Claude mapper**

In `src/providers/claude/map-events.ts`, import the mapper and fill the field:

```ts
import { toToolCall, toToolOutput } from './map-tools';

// tool_use branch:
        out.push({
          kind: 'tool-start', id: block.id, name: block.name, input: block.input,
          tool: toToolCall(block.name, block.input),
          ...(parentId ? { parentId } : {}),
        });

// tool_result branch:
        out.push({
          kind: 'tool-end',
          id: block.tool_use_id,
          ok: block.is_error !== true,
          output: block.content,
          toolOutput: toToolOutput(block.content),
          ...(parentId ? { parentId } : {}),
        });
```

In `src/providers/claude/claude-provider.ts`, find where the `canUseTool` callback pushes `{ kind: 'permission', … }` and add `tool: toToolCall(name, input)` using the same `name`/`input` it already passes.

- [ ] **Step 5: Populate `tool` in the Codex mapper**

In `src/providers/codex/map-events.ts`:

- Import `{ approvalToolCall, toToolCall, toToolOutput }` from `./map-tools`.
- In `startOf`, add `tool: toToolCall(item)` to the emitted event.
- In `endOf`, add `tool: toToolCall(item)` and `toolOutput: toToolOutput(item)`.
- In `approvalEventOf`, add `tool: approvalToolCall(method, params)`.
- Delete the local `displayCommand` and import it from `./map-tools` where the file still needs it, so there is exactly one copy.

- [ ] **Step 6: Carry `tool` through AgentSession**

In `src/host/agent-session.ts`:

```ts
// tool-start (around line 413):
        const item: TranscriptItem = {
          id: nextId('t'), ts: Date.now(), role: 'tool',
          toolId: event.id, name: parsed.name, input: event.input, state: 'running',
          ...(parsed.mcpServer ? { mcpServer: parsed.mcpServer } : {}),
          ...(event.tool ? { tool: event.tool } : {}),
        };

// tool-end (around line 447):
        const settled: TranscriptItem = {
          ...existing,
          state: event.ok ? 'ok' : 'error',
          output: event.output,
          ...(event.input !== undefined ? { input: event.input } : {}),
          ...(event.tool ? { tool: event.tool } : {}),
          ...(event.toolOutput ? { toolOutput: event.toolOutput } : {}),
          ...(children ? { children: [...children] } : {}),
        };

// permission (around line 480), on both the item and the pending record:
          ...(event.tool ? { tool: event.tool } : {}),
```

- [ ] **Step 7: Run the tests**

Run: `yarn test:unit`
Expected: PASS, including the two new tests. No existing test changes behavior — `tool` is additive.

- [ ] **Step 8: Typecheck, lint, compile**

Run: `yarn check-types && yarn lint && yarn run compile`
Expected: all clean.

- [ ] **Step 9: Commit**

```bash
git add src/providers src/protocol src/host src/test/unit
git commit -m "feat: carry a canonical ToolCall on every tool event"
```

---

### Task 5: Migrate — render from `tool`

The renderer stops reading names and inputs. A one-line shim covers the still-optional field; Task 6 deletes it.

**Files:**
- Modify: `src/webview/components/tool-render.ts` (full rewrite of the three `describe*` functions)
- Modify: `src/webview/components/tool-card.tsx:31,40-41`
- Modify: `src/webview/components/permission-card.tsx:22,33-35,68,74-75,103,119,128`
- Modify: `src/webview/components/subagent-window.ts:84-96`
- Test: `src/test/unit/tool-render.test.ts` (rewrite), `src/test/unit/subagent-window.test.ts`

**Interfaces:**
- Consumes: `ToolCall`, `ToolOutput` from `../../protocol/messages`.
- Produces: `describeTool(tool: ToolCall): ToolHeader`; `describeInput(tool: ToolCall): ToolBlock[]`; `describeOutput(kind: ToolCall['kind'], output: ToolOutput | undefined, state: 'running' | 'ok' | 'error'): ToolBlock[]`. `ToolHeader`, `ToolBlock`, `ToolGlyph`, `shortPath`, `clampLines` keep their current shapes and signatures.

- [ ] **Step 1: Write the failing test**

Replace `src/test/unit/tool-render.test.ts` with tests that feed `ToolCall` values:

```ts
import * as assert from 'assert';
import type { ToolCall } from '../../protocol/messages';
import { describeInput, describeOutput, describeTool } from '../../webview/components/tool-render';

suite('describeTool', () => {
  test('a command shows its command in mono', () => {
    const header = describeTool({ kind: 'command', label: 'Bash', command: 'yarn test' });
    assert.deepStrictEqual(
      { glyph: header.glyph, verb: header.verb, primary: header.primary, mono: header.mono },
      { glyph: 'terminal', verb: 'Bash', primary: 'yarn test', mono: true },
    );
  });

  test('an all-create edit gets the file-plus glyph, a modify gets file-pen', () => {
    const create: ToolCall = {
      kind: 'file-edit', label: 'Write',
      files: [{ path: '/a/b/c.ts', op: 'create' }],
    };
    assert.strictEqual(describeTool(create).glyph, 'file-plus');
    const modify: ToolCall = {
      kind: 'file-edit', label: 'Edit',
      files: [{ path: '/a/b/c.ts', op: 'modify' }],
    };
    assert.strictEqual(describeTool(modify).glyph, 'file-pen');
  });

  test('a multi-file edit counts files instead of naming one', () => {
    const header = describeTool({
      kind: 'file-edit', label: 'Edit',
      files: [{ path: 'a.ts', op: 'modify' }, { path: 'b.ts', op: 'modify' }],
    });
    assert.strictEqual(header.primary, '2 files');
  });

  test('search picks its glyph from mode', () => {
    assert.strictEqual(describeTool({
      kind: 'search', label: 'Grep', pattern: 'x', mode: 'content',
    }).glyph, 'search');
    assert.strictEqual(describeTool({
      kind: 'search', label: 'Glob', pattern: 'x', mode: 'files',
    }).glyph, 'folder-search');
  });

  test('a subagent message gets the send glyph, a spawn gets bot', () => {
    assert.strictEqual(describeTool({
      kind: 'subagent', label: 'SendMessage', action: 'message', summary: 'ping',
    }).glyph, 'send');
    assert.strictEqual(describeTool({
      kind: 'subagent', label: 'Agent', action: 'spawn', agent: 'Explore',
    }).glyph, 'bot');
  });

  test('an mcp call shows server and tool', () => {
    const header = describeTool({
      kind: 'mcp', label: 'create_issue', server: 'github', tool: 'create_issue',
    });
    assert.strictEqual(header.primary, 'github · create_issue');
  });

  test('a long primary carries a full value for the title attribute', () => {
    const long = 'x'.repeat(60);
    assert.strictEqual(describeTool({
      kind: 'command', label: 'Bash', command: long,
    }).full, long);
  });
});

suite('describeInput', () => {
  test('a command yields note, command and its scalar fields', () => {
    const blocks = describeInput({
      kind: 'command', label: 'Bash', command: 'ls', note: 'list',
      timeoutMs: 30000, background: true,
    });
    assert.deepStrictEqual(blocks, [
      { kind: 'note', text: 'list' },
      { kind: 'command', text: 'ls' },
      { kind: 'field', label: 'timeout', value: '30s' },
      { kind: 'field', label: 'mode', value: 'background' },
    ]);
  });

  test('a before/after edit becomes -/+ diff lines under its path', () => {
    const blocks = describeInput({
      kind: 'file-edit', label: 'Edit',
      files: [{ path: '/a.ts', op: 'modify', edits: [{ before: 'foo', after: 'bar' }] }],
    });
    assert.deepStrictEqual(blocks, [
      { kind: 'path', path: '/a.ts' },
      { kind: 'diff', lines: ['-foo', '+bar'] },
    ]);
  });

  test('a unified diff is stripped to its body lines', () => {
    const blocks = describeInput({
      kind: 'file-edit', label: 'Edit',
      files: [{
        path: '/a.ts', op: 'modify',
        unifiedDiff: '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new',
      }],
    });
    assert.deepStrictEqual(blocks, [
      { kind: 'path', path: '/a.ts' },
      { kind: 'diff', lines: ['-old', '+new'] },
    ]);
  });

  test('a header-only diff yields no empty diff block', () => {
    const blocks = describeInput({
      kind: 'file-edit', label: 'Edit',
      files: [{ path: '/a.ts', op: 'rename', unifiedDiff: '--- a/a.ts\n+++ b/b.ts\n' }],
    });
    assert.deepStrictEqual(blocks, [{ kind: 'path', path: '/a.ts' }]);
  });

  test('a read shows its path with a line hint', () => {
    assert.deepStrictEqual(describeInput({
      kind: 'file-read', label: 'Read', path: '/a.ts', range: { offset: 10, limit: 20 },
    }), [{ kind: 'path', path: '/a.ts', hint: 'lines 10–30' }]);
  });

  test('a read with an open-ended range says so', () => {
    assert.deepStrictEqual(describeInput({
      kind: 'file-read', label: 'Read', path: '/a.ts', range: { offset: 10 },
    }), [{ kind: 'path', path: '/a.ts', hint: 'lines 10–end' }]);
  });

  test('todos render as todo rows', () => {
    assert.deepStrictEqual(describeInput({
      kind: 'todos', label: 'TodoWrite',
      items: [{ status: 'completed', text: 'one' }],
    }), [{ kind: 'todos', items: [{ status: 'completed', text: 'one' }] }]);
  });

  test('a spawned subagent shows its brief last', () => {
    assert.deepStrictEqual(describeInput({
      kind: 'subagent', label: 'Agent', action: 'spawn',
      agent: 'Explore', model: 'sonnet', prompt: 'find it',
    }), [
      { kind: 'field', label: 'agent', value: 'Explore' },
      { kind: 'field', label: 'model', value: 'sonnet' },
      { kind: 'lines', text: 'find it', tone: 'output' },
    ]);
  });

  test('an empty other yields no block at all', () => {
    assert.deepStrictEqual(describeInput({ kind: 'other', label: 'X', raw: {} }), []);
  });

  test('a populated other falls back to pretty JSON', () => {
    const blocks = describeInput({ kind: 'other', label: 'X', raw: { a: 1 } });
    assert.strictEqual(blocks.length, 1);
    assert.strictEqual(blocks[0].kind, 'json');
  });
});

suite('describeOutput', () => {
  test('running renders nothing', () => {
    assert.deepStrictEqual(
      describeOutput('command', { kind: 'text', text: 'x' }, 'running'), []);
  });

  test('a file-read result renders in the code tone', () => {
    assert.deepStrictEqual(
      describeOutput('file-read', { kind: 'text', text: 'contents' }, 'ok'),
      [{ kind: 'lines', text: 'contents', tone: 'code' }]);
  });

  test('a command result renders in the output tone', () => {
    assert.deepStrictEqual(
      describeOutput('command', { kind: 'text', text: 'done' }, 'ok'),
      [{ kind: 'lines', text: 'done', tone: 'output' }]);
  });

  test('an error renders in the error tone', () => {
    assert.deepStrictEqual(
      describeOutput('command', { kind: 'text', text: 'boom' }, 'error'),
      [{ kind: 'lines', text: 'boom', tone: 'error' }]);
  });

  test('no output says so, and says it differently when it failed', () => {
    assert.deepStrictEqual(describeOutput('command', { kind: 'none' }, 'ok'),
      [{ kind: 'note', text: 'No output.' }]);
    assert.deepStrictEqual(describeOutput('command', { kind: 'none' }, 'error'),
      [{ kind: 'note', text: 'Failed with no output.' }]);
  });

  test('a json result renders as pretty JSON', () => {
    const blocks = describeOutput('mcp', { kind: 'json', value: { a: 1 } }, 'ok');
    assert.strictEqual(blocks[0].kind, 'json');
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx mocha --ui tdd --require tsx/cjs src/test/unit/tool-render.test.ts`
Expected: FAIL — the current `describeTool(name, input)` signature rejects a single `ToolCall` argument.

- [ ] **Step 3: Rewrite the renderer**

Rewrite `src/webview/components/tool-render.ts`. Keep verbatim: the `ToolGlyph`, `ToolHeader`, `ToolBlock`, `TodoStatus`, `Clamped` types, `shortPath`, `clampLines`, `diffBodyLines`. Delete: `key()`, `LABELS`, `asRecord`/`str`/`num`, `pathOf`, `fileChangePaths`, `outputText`, `parseJson`, `fileChangeBlocks`, `diffLines`'s record-digging form. The three exports become:

```ts
import { safeStringify } from './tool-card-format';
import type { FileEdit, ToolCall, ToolOutput } from '../../protocol/messages';

/** `full` is only worth carrying when the header will actually truncate. */
function header(glyph: ToolGlyph, verb: string, primary: string, mono: boolean): ToolHeader {
  return { glyph, verb, mono, primary, ...(primary.length > 40 ? { full: primary } : {}) };
}

export function describeTool(tool: ToolCall): ToolHeader {
  switch (tool.kind) {
    case 'command':
      return header('terminal', tool.label, tool.command, true);

    case 'file-edit': {
      const glyph = tool.files.length > 0 && tool.files.every((f) => f.op === 'create')
        ? 'file-plus'
        : 'file-pen';
      const primary = tool.files.length === 1
        ? shortPath(tool.files[0].path)
        : tool.files.length > 1 ? `${tool.files.length} files` : '';
      return header(glyph, tool.label, primary, true);
    }

    case 'file-read':
      return header('file-text', tool.label, shortPath(tool.path), true);

    case 'search':
      return header(
        tool.mode === 'content' ? 'search' : 'folder-search',
        tool.label, tool.pattern, true,
      );

    case 'web':
      return header('globe', tool.label, tool.query ?? hostOf(tool.url) ?? '', false);

    case 'todos': {
      const active = tool.items.find((item) => item.status === 'in_progress');
      const primary = active?.text
        ?? `${tool.items.length} ${tool.items.length === 1 ? 'item' : 'items'}`;
      return header('list-todo', tool.label, primary, false);
    }

    case 'plan':
      return header('list-todo', tool.label, tool.text, false);

    case 'subagent':
      return header(
        tool.action === 'message' ? 'send' : 'bot', tool.label,
        tool.agent ?? tool.summary ?? tool.target ?? '', false,
      );

    case 'mcp':
      return header('wrench', tool.label,
        tool.server && tool.tool ? `${tool.server} · ${tool.tool}` : tool.server || tool.tool,
        false);

    case 'other':
      return header('wrench', tool.label, tool.fields?.[0]?.value ?? '', false);
  }
}

function editBlocks(file: FileEdit): ToolBlock[] {
  const blocks: ToolBlock[] = [{ kind: 'path', path: file.path }];
  const lines: string[] = [];
  for (const edit of file.edits ?? []) {
    if (edit.before !== undefined) {
      lines.push(...edit.before.split('\n').map((line) => `-${line}`));
    }
    if (edit.after !== undefined) {
      lines.push(...edit.after.split('\n').map((line) => `+${line}`));
    }
  }
  if (file.unifiedDiff) { lines.push(...diffBodyLines(file.unifiedDiff)); }
  // A rename- or mode-only change has headers and no body left after
  // stripping them; an empty diff block is an empty bordered box.
  if (lines.length > 0) { blocks.push({ kind: 'diff', lines }); }
  if (file.replaceAll) {
    blocks.push({ kind: 'field', label: 'scope', value: 'all occurrences' });
  }
  return blocks;
}

export function describeInput(tool: ToolCall): ToolBlock[] {
  const blocks: ToolBlock[] = [];

  switch (tool.kind) {
    case 'command':
      if (tool.note) { blocks.push({ kind: 'note', text: tool.note }); }
      if (tool.command) { blocks.push({ kind: 'command', text: tool.command }); }
      if (tool.cwd) { blocks.push({ kind: 'path', path: tool.cwd }); }
      if (tool.timeoutMs) {
        blocks.push({ kind: 'field', label: 'timeout', value: `${tool.timeoutMs / 1000}s` });
      }
      if (tool.background) {
        blocks.push({ kind: 'field', label: 'mode', value: 'background' });
      }
      break;

    case 'file-edit':
      for (const file of tool.files) { blocks.push(...editBlocks(file)); }
      break;

    case 'file-read': {
      const hint = tool.range
        ? `lines ${tool.range.offset}–${tool.range.limit === undefined
            ? 'end' : tool.range.offset + tool.range.limit}`
        : tool.pages ? `pages ${tool.pages}` : undefined;
      blocks.push({ kind: 'path', path: tool.path, ...(hint ? { hint } : {}) });
      break;
    }

    case 'search':
      if (tool.pattern) { blocks.push({ kind: 'command', text: tool.pattern }); }
      if (tool.scope) { blocks.push({ kind: 'path', path: tool.scope }); }
      for (const filter of tool.filters ?? []) { blocks.push({ kind: 'field', ...filter }); }
      break;

    case 'web':
      if (tool.query) { blocks.push({ kind: 'field', label: 'query', value: tool.query }); }
      if (tool.url) { blocks.push({ kind: 'field', label: 'url', value: tool.url }); }
      if (tool.note) { blocks.push({ kind: 'note', text: tool.note }); }
      break;

    case 'todos':
      if (tool.items.length > 0) { blocks.push({ kind: 'todos', items: [...tool.items] }); }
      break;

    case 'plan':
      blocks.push({ kind: 'lines', text: tool.text, tone: 'output' });
      break;

    case 'subagent':
      if (tool.summary) { blocks.push({ kind: 'note', text: tool.summary }); }
      if (tool.agent) { blocks.push({ kind: 'field', label: 'agent', value: tool.agent }); }
      if (tool.target) { blocks.push({ kind: 'field', label: 'to', value: tool.target }); }
      if (tool.model) { blocks.push({ kind: 'field', label: 'model', value: tool.model }); }
      if (tool.isolation) {
        blocks.push({ kind: 'field', label: 'isolation', value: tool.isolation });
      }
      for (const field of tool.fields ?? []) { blocks.push({ kind: 'field', ...field }); }
      // The brief is the whole point of the card — a subagent's transcript is
      // not in this panel, so this is the only place its instructions appear.
      if (tool.prompt) { blocks.push({ kind: 'lines', text: tool.prompt, tone: 'output' }); }
      break;

    case 'mcp':
      if (tool.server) { blocks.push({ kind: 'field', label: 'server', value: tool.server }); }
      if (tool.tool) { blocks.push({ kind: 'field', label: 'tool', value: tool.tool }); }
      break;

    case 'other': {
      for (const field of tool.fields ?? []) { blocks.push({ kind: 'field', ...field }); }
      const empty = tool.raw === null || tool.raw === undefined
        || (typeof tool.raw === 'object' && Object.keys(tool.raw as object).length === 0);
      if (!empty) { blocks.push({ kind: 'json', text: safeStringify(tool.raw) }); }
      break;
    }
  }

  return blocks;
}

export function describeOutput(
  kind: ToolCall['kind'],
  output: ToolOutput | undefined,
  state: 'running' | 'ok' | 'error',
): ToolBlock[] {
  if (state === 'running') { return []; }

  if (output === undefined || output.kind === 'none') {
    return state === 'error'
      ? [{ kind: 'note', text: 'Failed with no output.' }]
      : [{ kind: 'note', text: 'No output.' }];
  }

  if (output.kind === 'json') { return [{ kind: 'json', text: safeStringify(output.value) }]; }

  if (output.text.trim().length === 0) {
    return state === 'error'
      ? [{ kind: 'note', text: 'Failed with no output.' }]
      : [{ kind: 'note', text: 'No output.' }];
  }

  if (state === 'error') { return [{ kind: 'lines', text: output.text, tone: 'error' }]; }

  const tone = kind === 'file-read' || kind === 'search' ? 'code' : 'output';
  return [{ kind: 'lines', text: output.text, tone }];
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) { return undefined; }
  // `URL` would throw on a model-generated non-URL, and this runs in render.
  const match = /^[a-z]+:\/\/([^/?#]+)/i.exec(url);
  return match ? match[1] : url;
}
```

- [ ] **Step 4: Run the renderer test**

Run: `npx mocha --ui tdd --require tsx/cjs src/test/unit/tool-render.test.ts`
Expected: PASS.

- [ ] **Step 5: Point the cards at `tool`**

In `src/webview/components/tool-card.tsx`, add the transitional shim and use it:

```ts
// Transitional while `tool` is still optional on the wire — deleted in the
// task that makes it required.
const tool: ToolCall = item.tool ?? { kind: 'other', label: item.name, raw: item.input };
const header = describeTool(tool);
const input = describeInput(tool);
const output = describeOutput(tool.kind, item.toolOutput, item.state);
```

In `src/webview/components/permission-card.tsx`, do the same and replace every `item.name` in prose and `aria-label`s with `tool.label`, and `item.mcpServer` with `tool.kind === 'mcp' ? tool.server : undefined`:

```ts
const tool: ToolCall = item.tool ?? { kind: 'other', label: item.name, raw: item.input };
const request = describeInput(tool);
const server = tool.kind === 'mcp' ? tool.server : undefined;
// … label: server ? `${server} ${tool.label} — ${item.state}` : `${tool.label} — ${item.state}`
// … `Allow {tool.label}?`, aria-label={`Deny ${tool.label}`}, etc.
```

- [ ] **Step 6: Point `subagentLabel` at `tool`**

In `src/webview/components/subagent-window.ts`, replace the raw-input digging:

```ts
/**
 * The agent type from a spawned subagent call, when it carries one. This is
 * the identifying fact — "Explore" tells the user what is running, where
 * "Agent" is only SDK vocabulary. The digging for `subagent_type` now happens
 * in the Claude mapper, which is where that field name is known.
 */
export function subagentLabel(item: ToolItem): string {
  const tool = item.tool;
  if (!tool) { return item.name; }
  return tool.kind === 'subagent'
    ? (tool.agent ?? tool.target ?? tool.label)
    : tool.label;
}
```

Update `src/test/unit/subagent-window.test.ts` to build items carrying a `tool` rather than a raw `input`.

- [ ] **Step 7: Run every test**

Run: `yarn test:unit && yarn test:dom`
Expected: PASS. DOM tests still exercise the shim path where their fixtures have no `tool`; that is fine for this task.

- [ ] **Step 8: Typecheck, lint, compile**

Run: `yarn check-types && yarn lint && yarn run compile`
Expected: all clean.

- [ ] **Step 9: Commit**

```bash
git add src/webview src/test/unit
git commit -m "feat: render tool cards from the canonical call"
```

---

### Task 6: Contract — delete `name` and `input`

**Files:**
- Modify: `src/providers/types.ts`, `src/protocol/messages.ts` — make `tool` required, delete `name`/`input`/`output`/`mcpServer`, rename `toolOutput` to `output`, delete `ToolDecision.updatedInput`
- Modify: `src/providers/claude/map-events.ts`, `src/providers/claude/claude-provider.ts`, `src/providers/codex/map-events.ts`, `src/providers/codex/codex-run.ts`
- Modify: `src/host/agent-session.ts`
- Delete: `src/host/mcp-tool-name.ts`, `src/test/unit/mcp-tool-name.test.ts`
- Modify: `src/host/transcript-store.ts` — `StoredIndex.version`
- Modify: `src/webview/components/tool-card.tsx`, `permission-card.tsx`, `subagent-window.ts` — drop the shims
- Test: `src/test/unit/transcript-store.test.ts`, `agent-session.test.ts`, `agent-session-nesting.test.ts`, `codex-map-events.test.ts`, `map-events.test.ts`, `protocol.test.ts`, `subagent-window.test.ts`, and the DOM fixtures under `src/test/dom/`

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: `AgentEvent`'s final tool arms — `{ kind: 'tool-start'; id; tool: ToolCall; parentId? }`, `{ kind: 'tool-end'; id; ok; output: ToolOutput; tool?: ToolCall; parentId? }`, `{ kind: 'permission'; id; tool: ToolCall; parentId? }`; `TranscriptItem`'s final tool/permission arms; `PermissionRequest` as `{ requestId: string; tool: ToolCall }`; `StoredIndex` with `version: 2`.

- [ ] **Step 1: Write the failing test**

Add to `src/test/unit/transcript-store.test.ts`:

The file's existing `setup` hook already assigns a fresh `dir` via
`fs.mkdtemp`; these tests use that same `dir`, following the pattern already
in the file.

```ts
test('an index written by an older format is discarded whole', async () => {
  await fs.writeFile(path.join(dir, 'index.json'), JSON.stringify({
    sessions: [{ id: 's1', providerId: 'fake', model: 'm', title: 't', cwd: '/x' }],
    layout: { orientation: 'vertical', panes: [{ sessionId: 's1', size: 1 }] },
  }), 'utf8');

  const store = new TranscriptStore(dir);
  const index = await store.readIndex();
  assert.strictEqual(index.sessions.length, 0);
  assert.strictEqual(index.layout.panes.length, 0);
});

test('an index at the current version round-trips', async () => {
  const store = new TranscriptStore(dir);
  await store.writeIndex({
    version: 2, sessions: [], layout: { orientation: 'vertical', panes: [] },
  });
  const index = await store.readIndex();
  assert.strictEqual(index.version, 2);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx mocha --ui tdd --require tsx/cjs src/test/unit/transcript-store.test.ts`
Expected: FAIL — `version` is not a property on `StoredIndex`, and the legacy index is currently returned as-is.

- [ ] **Step 3: Version the index**

In `src/host/transcript-store.ts`:

```ts
/**
 * Bumped when a persisted `TranscriptItem` shape changes in a way an older
 * reader cannot honor. v2 replaced every tool item's `name` + `input` with a
 * canonical `ToolCall`. An index at any other version is discarded whole —
 * old `sessions/*.jsonl` files are left on disk, orphaned and never parsed,
 * rather than deleted from inside `context.storageUri`.
 */
export const TRANSCRIPT_VERSION = 2;

export interface StoredIndex {
  version: number;
  sessions: SessionState[];
  layout: PaneLayout;
}

const EMPTY_INDEX: StoredIndex = {
  version: TRANSCRIPT_VERSION,
  sessions: [],
  layout: { orientation: 'vertical', panes: [] },
};
```

In `readIndex()`, after parsing, return `EMPTY_INDEX` when `parsed.version !== TRANSCRIPT_VERSION`. In `writeIndex()`, always stamp `version: TRANSCRIPT_VERSION`.

- [ ] **Step 4: Narrow the types**

`src/providers/types.ts`:

```ts
export type ToolDecision =
  | { allow: true }
  | { allow: false; reason?: string };

// … inside AgentEvent:
  | { kind: 'tool-start'; id: string; tool: ToolCall; parentId?: string }
  /**
   * `tool`, when present, REPLACES what tool-start reported. A backend may
   * only learn a call's real arguments when it finishes — Codex's `webSearch`
   * carries `query: ''` while running and the actual search only on
   * completion — and a card that renders the start-time arguments forever
   * would show a search with no query. Omit it and the call stands.
   */
  | { kind: 'tool-end'; id: string; ok: boolean; output: ToolOutput;
      tool?: ToolCall; parentId?: string }
  | { kind: 'permission'; id: string; tool: ToolCall; parentId?: string }
```

`src/protocol/messages.ts`:

```ts
  | (ItemBase & {
      role: 'tool'; toolId: string; tool: ToolCall;
      state: 'running' | 'ok' | 'error'; output?: ToolOutput;
      /**
       * A subagent's tool activity. Depth 1 only — a child never has children
       * of its own.
       */
      children?: TranscriptItem[];
    })
  | (ItemBase & {
      role: 'permission'; requestId: string; tool: ToolCall;
      state: 'pending' | 'allowed' | 'denied'; reason?: string;
    })

export interface PermissionRequest { requestId: string; tool: ToolCall }
```

- [ ] **Step 5: Follow the compiler**

Run `yarn check-types` and fix each error:

- `src/providers/claude/map-events.ts` — drop `name`/`input`, rename `toolOutput` to `output`, make `tool` non-optional (`toToolCall` always returns a call).
- `src/providers/claude/claude-provider.ts` — the `permission` event carries `tool` only.
- `src/providers/codex/map-events.ts` — same; `startOf`/`endOf` return `[]` when `toToolCall(item)` is `undefined`, which replaces the `TOOL_KINDS` set. Delete `TOOL_KINDS`, `inputOf` and `outputOf`. `approvalEventOf` returns `undefined` when `approvalToolCall` does.
- `src/providers/codex/codex-run.ts` — any `respondToTool` path that read `updatedInput`.
- `src/host/agent-session.ts` — delete the `parseToolName` import and both call sites; the item spreads carry `tool` directly.
- `src/webview/components/tool-card.tsx`, `permission-card.tsx`, `subagent-window.ts` — delete the `?? { kind: 'other', … }` shims; `item.tool` is now always there. `tool-card.tsx` also reads `item.output` where it read `item.toolOutput`, since the temporary second name is gone:

```ts
const header = describeTool(item.tool);
const input = describeInput(item.tool);
const output = describeOutput(item.tool.kind, item.output, item.state);
```

Then delete `src/host/mcp-tool-name.ts` and `src/test/unit/mcp-tool-name.test.ts` — `parseMcpName` in the canonical module replaces it.

- [ ] **Step 6: Update the remaining tests**

Rewrite the event literals in `agent-session.test.ts`, `agent-session-nesting.test.ts`, `codex-map-events.test.ts`, `map-events.test.ts`, `protocol.test.ts` and the DOM fixtures. The nesting file's pattern becomes:

```ts
      { kind: 'tool-start', id: 'task1',
        tool: { kind: 'subagent', label: 'Agent', action: 'spawn', agent: 'Explore' } },
      { kind: 'tool-start', id: 'c1', parentId: 'task1',
        tool: { kind: 'file-read', label: 'Read', path: 'a.ts' } },
      { kind: 'tool-end', id: 'c1', ok: true, parentId: 'task1',
        output: { kind: 'text', text: 'contents' } },
      { kind: 'tool-end', id: 'task1', ok: true,
        output: { kind: 'text', text: 'found it' } },
```

- [ ] **Step 7: Run everything**

Run: `yarn test:unit && yarn test:dom && yarn check-types && yarn lint && yarn run compile`
Expected: all green. Grep to confirm the old vocabulary is gone:

```bash
git grep -n "parseToolName\|mcpServer\|updatedInput" -- src | grep -v "canonical/tool-call.ts"
```

Expected: no output.

- [ ] **Step 8: Commit**

```bash
git add -A src docs
git commit -m "feat: drop raw tool names and inputs from the wire"
```

---

### Task 7: Fixtures, DOM coverage, and the UI gate

**Files:**
- Create: `src/providers/fake/sample-tools.ts`
- Modify: `src/test/dom/tool-card.test.tsx`, `src/test/dom/permission-card.test.tsx`, `src/test/dom/subagent-card.test.tsx`
- Modify: `src/test/unit/fake-provider.test.ts`

**Interfaces:**
- Consumes: `ToolCall` from Task 1.
- Produces: `SAMPLE_TOOL_CALLS: Record<ToolCall['kind'], ToolCall>` — one representative call per kind.

The spec called this "a scripted turn on FakeProvider". `FakeProvider` is push-driven and has no script, so the same coverage lands as an exported fixture the DOM tests and dev sessions push through `FakeRun.emit`. Same guarantee, no new machinery.

- [ ] **Step 1: Write the failing test**

Create the exhaustiveness test in `src/test/unit/fake-provider.test.ts`:

```ts
import { SAMPLE_TOOL_CALLS } from '../../providers/fake/sample-tools';
import { describeInput, describeTool } from '../../webview/components/tool-render';

test('every canonical kind has a fixture that renders a header', () => {
  const kinds: ToolCall['kind'][] = [
    'command', 'file-edit', 'file-read', 'search', 'web',
    'todos', 'plan', 'subagent', 'mcp', 'other',
  ];
  for (const kind of kinds) {
    const call = SAMPLE_TOOL_CALLS[kind];
    assert.strictEqual(call.kind, kind);
    assert.ok(describeTool(call).verb.length > 0, `${kind} has no verb`);
    assert.ok(Array.isArray(describeInput(call)), `${kind} has no blocks`);
  }
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx mocha --ui tdd --require tsx/cjs src/test/unit/fake-provider.test.ts`
Expected: FAIL — `Cannot find module '../../providers/fake/sample-tools'`.

- [ ] **Step 3: Write the fixtures**

Create `src/providers/fake/sample-tools.ts`:

```ts
// One representative call per canonical kind. Pushed through `FakeRun.emit`
// by the DOM tests and by a dev session, so every arm of the renderer is
// exercised without a live backend.

import type { ToolCall } from '../canonical/tool-call';

export const SAMPLE_TOOL_CALLS: Record<ToolCall['kind'], ToolCall> = {
  'command': { kind: 'command', label: 'Bash', command: 'yarn test:unit', note: 'run the suite' },
  'file-edit': {
    kind: 'file-edit', label: 'Edit',
    files: [{
      path: 'src/webview/components/tool-render.ts', op: 'modify',
      edits: [{ before: 'const a = 1;', after: 'const a = 2;' }],
    }],
  },
  'file-read': {
    kind: 'file-read', label: 'Read',
    path: 'src/protocol/messages.ts', range: { offset: 1, limit: 40 },
  },
  'search': {
    kind: 'search', label: 'Grep', pattern: 'describeTool', mode: 'content',
    scope: 'src', filters: [{ label: 'glob', value: '*.ts' }],
  },
  'web': { kind: 'web', label: 'WebFetch', url: 'https://example.dev/docs', note: 'summarize' },
  'todos': {
    kind: 'todos', label: 'TodoWrite',
    items: [
      { status: 'completed', text: 'Write the mapper' },
      { status: 'in_progress', text: 'Rewrite the renderer' },
      { status: 'pending', text: 'Delete the old fields' },
    ],
  },
  'plan': { kind: 'plan', label: 'Plan', text: 'Map, render, then contract.' },
  'subagent': {
    kind: 'subagent', label: 'Agent', action: 'spawn',
    agent: 'Explore', model: 'sonnet', prompt: 'Find every call site.',
  },
  'mcp': { kind: 'mcp', label: 'create_issue', server: 'github', tool: 'create_issue' },
  'other': { kind: 'other', label: 'Bananas', raw: { peeled: true } },
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx mocha --ui tdd --require tsx/cjs src/test/unit/fake-provider.test.ts`
Expected: PASS.

- [ ] **Step 5: Drive the fixtures through the DOM tests**

In `src/test/dom/tool-card.test.tsx`, add a case per kind that sends a genuine `session-patch` carrying a tool item built from `SAMPLE_TOOL_CALLS`, mounted through the real `StoreProvider` via the existing `sendFromHost` harness. Assert on strings and counts only — never hand a node to `assert`:

```tsx
test('a command card shows its command', async () => {
  const { sendFromHost } = mountPane();
  sendFromHost({
    t: 'session-patch', id: 's1',
    patch: { op: 'append', item: {
      id: 't1', ts: 1, role: 'tool', toolId: 'x', state: 'ok',
      tool: SAMPLE_TOOL_CALLS['command'],
      output: { kind: 'text', text: '12 passing' },
    } },
  });
  assert.strictEqual(screen.getByText('yarn test:unit').textContent, 'yarn test:unit');
});
```

- [ ] **Step 6: Run every test**

Run: `yarn test:unit && yarn test:dom`
Expected: all green.

- [ ] **Step 7: Run the UI gate**

Run the mechanical detector over every changed webview file:

```bash
node <impeccable-skill-dir>/scripts/detect.mjs --json \
  src/webview/components/tool-render.ts \
  src/webview/components/tool-card.tsx \
  src/webview/components/permission-card.tsx \
  src/webview/components/subagent-window.ts
```

Expected: exit 0. Exit 2 means findings — those are failing checks, not suggestions; fix them before continuing.

Then run `critique` over `src/webview` and compare against the previous run in `.impeccable/critique/`. The card visuals do not move in this change, so the score is expected to hold flat or rise. A drop means something regressed — investigate before merging.

- [ ] **Step 8: Full verification**

Run: `yarn check-types && yarn lint && yarn run compile`
Expected: all clean.

- [ ] **Step 9: Commit**

```bash
git add src/providers/fake/sample-tools.ts src/test
git commit -m "test: cover every canonical tool kind end to end"
```

---

## Notes for the executor

- **Tasks 1–3 are independent** of the rest and of each other: three pure modules with their own tests, none of them imported yet. They can be reviewed in any order.
- **Tasks 4, 5 and 6 are strictly ordered.** 4 expands (field optional, both vocabularies present), 5 migrates the readers, 6 contracts. Running 6 before 5 leaves the webview unable to compile.
- **Deviation from the spec, recorded here on purpose:** the spec says `FakeProvider` "gains a scripted turn". It has no script mechanism — it is push-driven through `FakeRun.emit` — so Task 7 ships the same coverage as an exported fixture map instead. Nothing else in the spec is implemented differently.
- If a Codex or Claude payload turns out to carry a field this plan did not anticipate, add a case to that provider's `map-tools.test.ts` first, then extend its mapper. Never extend `tool-render.ts` with provider knowledge — that is the entire point of the change.
