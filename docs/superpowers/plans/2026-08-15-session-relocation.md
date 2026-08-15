# Session Relocation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a session move between working trees — following an agent into a
worktree it just created, and coming back — carrying its conversation.

**Architecture:** Our transcript is the conversation; a provider thread is a
cache of it. A session keeps one resume token per thread the provider
distinguishes (`resumeTokens`, keyed by `threadKey()`), so returning to a
directory it has already run in is a native resume. Crossing into a directory
with no thread seeds a fresh one from a replay of our own transcript.
Relocation itself is `archive()` → `open()` with `cwd` changed.

**Tech Stack:** TypeScript, mocha (`suite`/`test` globals, run from source
through `tsx/cjs`), jsdom for DOM tests, React 19, Tailwind v4, `child_process`
for git.

**Spec:** [../specs/2026-08-15-session-relocation-design.md](../specs/2026-08-15-session-relocation-design.md)

## Global Constraints

- Nothing under `src/providers/`, `src/protocol/`, or `src/host/message-router.ts`
  imports `vscode`. `src/host/worktree-detect.ts`, `src/host/replay.ts` and
  `src/host/git-worktree.ts` must not either — they are unit-tested outside the
  extension host.
- `src/protocol/messages.ts` is types-only. No runtime code.
- Every protocol message addressed to a session carries an explicit `SessionId`.
- Errors are state, never exceptions. A git failure or a failed relocation
  produces a transcript item; nothing rejects across `postMessage`.
- Filenames are kebab-case. Component identifiers stay PascalCase.
- **Never pass a DOM node to an assertion.** Compare booleans, strings or
  counts. `assert.strictEqual(el === null, true)`, never
  `assert.strictEqual(el, null)`.
- DOM tests drive components through the real `StoreProvider`, with state
  arriving as genuine `HostToWebview` messages via `sendFromHost`. Never mock
  `useStore`.
- UI: shadcn components from `@/components/ui/*` only. No bare `<button>`.
  Compose classNames with `cn` from `@/lib/utils`.
- `yarn lint`, `yarn check-types` and `yarn run compile` must pass before every
  commit.
- Conventional-commit prefixes. No `Co-Authored-By` trailer.
- **`yarn test:unit` is transpile-only** (`tsx/cjs` erases types without
  checking them). A test that asserts only about types passes against a type
  that does not exist. Red-first for a type-level test means `yarn check-types`,
  never the test runner.
- **Adding any `WebviewToHost` or `HostToWebview` arm trips
  `src/test/unit/protocol.test.ts`**, whose `assertNever` guard is the only
  exhaustive dispatch over those unions. Extend it in the same task. The webview
  reducer narrows with `role === 'x'` and has no exhaustive switch, so it needs
  nothing.
- **A new inbound message ALSO needs its tag in `KNOWN_MESSAGE_TAGS` in
  `src/host/message-router.ts`.** This is a hand-maintained runtime `Set`
  checked before the switch: a tag missing from it is silently dropped as
  malformed while every type check passes. Nothing catches this but a test that
  actually posts the message. Tasks adding several messages must add several
  tags.
- **Route with `await`, not `void`.** Handlers that touch the filesystem can
  reject (EPERM/EBUSY are routine on Windows); `await` puts them inside
  `handle()`'s catch-all, while `void` produces an unhandled rejection at the
  `onDidReceiveMessage` callback.
- **The transcript's role switch lives in
  `src/webview/components/transcript-item.tsx`**, not `transcript.tsx`.

**Milestones.** Tasks 1–8 deliver relocation end to end and are independently
shippable. Tasks 9–11 add bringing a branch back and the stale-tree sweep; they
can become their own branch if you want the first half to land sooner.

---

### Task 1: Worktree detection

**Files:**
- Create: `src/host/worktree-detect.ts`
- Test: `src/test/unit/worktree-detect.test.ts`

**Interfaces:**
- Consumes: `ToolCall` from `src/providers/canonical/tool-call.ts`
- Produces: `detectWorktreeAdd(tool: ToolCall, ok: boolean): string | undefined`

- [ ] **Step 1: Write the failing test**

```ts
import * as assert from 'assert';
import { detectWorktreeAdd } from '../../host/worktree-detect';
import type { ToolCall } from '../../providers/canonical/tool-call';

function cmd(command: string): ToolCall {
  return { kind: 'command', label: 'Bash', command };
}

suite('detectWorktreeAdd', () => {
  test('finds the path with -b', () => {
    assert.strictEqual(
      detectWorktreeAdd(cmd('git worktree add ../trees/feat-x -b feat-x'), true),
      '../trees/feat-x',
    );
  });

  test('finds the path before a commitish', () => {
    assert.strictEqual(
      detectWorktreeAdd(cmd('git worktree add ../trees/hotfix origin/main'), true),
      '../trees/hotfix',
    );
  });

  test('handles --detach', () => {
    assert.strictEqual(
      detectWorktreeAdd(cmd('git worktree add --detach ../trees/probe'), true),
      '../trees/probe',
    );
  });

  test('handles a quoted path with spaces', () => {
    assert.strictEqual(
      detectWorktreeAdd(cmd('git worktree add "../my trees/feat x" -b feat-x'), true),
      '../my trees/feat x',
    );
  });

  test('finds it in an && chain', () => {
    assert.strictEqual(
      detectWorktreeAdd(cmd('cd /repo && git worktree add ../t/a -b a && cd ../t/a'), true),
      '../t/a',
    );
  });

  test('ignores a failed command', () => {
    assert.strictEqual(detectWorktreeAdd(cmd('git worktree add ../t/a'), false), undefined);
  });

  test('ignores other worktree subcommands', () => {
    assert.strictEqual(detectWorktreeAdd(cmd('git worktree list'), true), undefined);
    assert.strictEqual(detectWorktreeAdd(cmd('git worktree remove ../t/a'), true), undefined);
  });

  test('ignores every non-command kind', () => {
    const read: ToolCall = { kind: 'file-read', label: 'Read', path: '/a/b.ts' };
    assert.strictEqual(detectWorktreeAdd(read, true), undefined);
  });

  test('returns nothing when no path can be read', () => {
    assert.strictEqual(detectWorktreeAdd(cmd('git worktree add'), true), undefined);
    assert.strictEqual(detectWorktreeAdd(cmd('git worktree add -b only-a-branch'), true), undefined);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:unit --grep "detectWorktreeAdd"`
Expected: FAIL — `Cannot find module '../../host/worktree-detect'`

- [ ] **Step 3: Write minimal implementation**

```ts
// Recognizes `git worktree add` in a canonical command call and returns the
// path it creates. Deliberately narrow: scripts, aliases and non-git tools are
// not chased. A missed detection costs nothing that is not already lost; a
// wrong one would relocate a session into a directory nobody asked for, so
// anything unparseable returns undefined.
//
// No `vscode` import: this is unit-tested outside the extension host.

import type { ToolCall } from '../providers/canonical/tool-call';

/** Splits on whitespace, keeping quoted runs together and stripping the quotes. */
function tokenize(segment: string): string[] {
  const out: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(segment)) !== null) {
    out.push(match[1] ?? match[2] ?? match[3]);
  }
  return out;
}

/** Flags that take a value, so the value is never mistaken for the path. */
const VALUED = new Set(['-b', '-B', '--reason', '--lock-reason']);

export function detectWorktreeAdd(tool: ToolCall, ok: boolean): string | undefined {
  if (!ok || tool.kind !== 'command') { return undefined; }

  for (const segment of tool.command.split(/&&|\|\||;/)) {
    const words = tokenize(segment);
    const at = words.findIndex((w, i) =>
      w === 'worktree' && words[i - 1]?.endsWith('git') && words[i + 1] === 'add');
    if (at === -1) { continue; }

    const rest = words.slice(at + 2);
    for (let i = 0; i < rest.length; i++) {
      const word = rest[i];
      if (VALUED.has(word)) { i++; continue; }
      if (word.startsWith('-')) { continue; }
      return word;
    }
  }
  return undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test:unit --grep "detectWorktreeAdd"`
Expected: PASS, 9 passing

- [ ] **Step 5: Lint, types, commit**

```bash
yarn lint && yarn check-types
git add src/host/worktree-detect.ts src/test/unit/worktree-detect.test.ts
git commit -m "feat: detect git worktree add in a canonical command call"
```

---

### Task 2: Transcript replay

**Files:**
- Create: `src/host/replay.ts`
- Test: `src/test/unit/replay.test.ts`

**Interfaces:**
- Consumes: `TranscriptItem` from `src/protocol/messages.ts`
- Produces: `buildSeed(items: TranscriptItem[], budgetChars?: number): string`
  — returns `''` for an empty transcript.

- [ ] **Step 1: Write the failing test**

```ts
import * as assert from 'assert';
import { buildSeed } from '../../host/replay';
import type { TranscriptItem } from '../../protocol/messages';

function user(id: string, text: string): TranscriptItem {
  return { id, ts: 1, role: 'user', text };
}
function assistant(id: string, text: string): TranscriptItem {
  return { id, ts: 2, role: 'assistant', text };
}
function bash(id: string, command: string): TranscriptItem {
  return {
    id, ts: 3, role: 'tool', toolId: `x-${id}`, state: 'ok',
    tool: { kind: 'command', label: 'Bash', command },
    output: { kind: 'text', text: 'a'.repeat(5000) },
  };
}

suite('buildSeed', () => {
  test('returns empty string for an empty transcript', () => {
    assert.strictEqual(buildSeed([]), '');
  });

  test('frames the seed as narration, not instruction', () => {
    const seed = buildSeed([user('u1', 'add a login form')]);
    assert.strictEqual(seed.includes('already happened'), true);
    assert.strictEqual(seed.includes('Do not redo'), true);
  });

  test('keeps user messages verbatim', () => {
    assert.strictEqual(buildSeed([user('u1', 'add a login form')]).includes('add a login form'), true);
  });

  test('keeps assistant text', () => {
    assert.strictEqual(buildSeed([assistant('a1', 'I added it')]).includes('I added it'), true);
  });

  test('summarizes a tool call without its output', () => {
    const seed = buildSeed([bash('t1', 'yarn test')]);
    assert.strictEqual(seed.includes('yarn test'), true);
    assert.strictEqual(seed.includes('aaaa'), false);
  });

  test('names files touched by an edit', () => {
    const edit: TranscriptItem = {
      id: 't2', ts: 3, role: 'tool', toolId: 'x2', state: 'ok',
      tool: {
        kind: 'file-edit', label: 'Edit',
        files: [{ path: '/repo/src/a.ts', op: 'modify' }],
      },
    };
    assert.strictEqual(buildSeed([edit]).includes('/repo/src/a.ts'), true);
  });

  test('preserves order', () => {
    const seed = buildSeed([user('u1', 'FIRST'), assistant('a1', 'SECOND')]);
    assert.strictEqual(seed.indexOf('FIRST') < seed.indexOf('SECOND'), true);
  });

  test('drops the oldest lines to fit the budget, keeping the newest', () => {
    const many = Array.from({ length: 50 }, (_, i) => user(`u${i}`, `message-${i}`));
    const seed = buildSeed(many, 400);
    assert.strictEqual(seed.length <= 400, true);
    assert.strictEqual(seed.includes('message-49'), true);
    assert.strictEqual(seed.includes('message-0'), false);
  });

  test('says so when it dropped earlier turns', () => {
    const many = Array.from({ length: 50 }, (_, i) => user(`u${i}`, `message-${i}`));
    assert.strictEqual(buildSeed(many, 400).includes('Earlier turns omitted'), true);
  });

  test('never exceeds the budget even when one line alone is oversized', () => {
    const seed = buildSeed([user('u1', 'x'.repeat(10_000))], 300);
    assert.strictEqual(seed.length <= 300, true);
  });

  test('skips permission and error items', () => {
    const items: TranscriptItem[] = [
      { id: 'p1', ts: 4, role: 'permission', requestId: 'r1', state: 'allowed',
        tool: { kind: 'command', label: 'Bash', command: 'rm -rf /tmp/x' } },
      { id: 'e1', ts: 5, role: 'error', message: 'provider exploded' },
      user('u1', 'keep me'),
    ];
    const seed = buildSeed(items);
    assert.strictEqual(seed.includes('rm -rf'), false);
    assert.strictEqual(seed.includes('provider exploded'), false);
    assert.strictEqual(seed.includes('keep me'), true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:unit --grep "buildSeed"`
Expected: FAIL — `Cannot find module '../../host/replay'`

- [ ] **Step 3: Write minimal implementation**

```ts
// Projects our transcript into a seed message for a provider thread that has
// no history of this conversation — a fresh tree, or a different vendor.
//
// Reads canonical `ToolCall`s rather than provider vocabulary, which is what
// makes a seed portable: a Codex-produced transcript summarized from raw wire
// types would hand Claude the words `commandExecution` and `fileChange`.
//
// Lossy by construction. Tool outputs are dropped — they are the bulk of the
// bytes and the agent can re-read files itself. Where a conclusion depended on
// an output we dropped, the agent re-runs the command.
//
// No `vscode` import: unit-tested outside the extension host.

import type { ToolCall, TranscriptItem } from '../protocol/messages';

const PREAMBLE = [
  'The following is a record of work that has already happened in this',
  'conversation, before it moved to this directory. It is context, not a task.',
  'Do not redo any of it. Continue from where it leaves off.',
].join(' ');

const OMITTED = '[Earlier turns omitted to fit context.]';

/** Default budget in characters. Roughly 6k tokens. */
const DEFAULT_BUDGET = 24_000;

function describe(tool: ToolCall): string {
  switch (tool.kind) {
    case 'command': return `ran: ${tool.command}`;
    case 'file-edit': return `edited: ${tool.files.map((f) => `${f.path} (${f.op})`).join(', ')}`;
    case 'file-read': return `read: ${tool.path}`;
    case 'search': return `searched for ${tool.pattern}${tool.scope ? ` in ${tool.scope}` : ''}`;
    case 'web': return `web: ${tool.url ?? tool.query ?? tool.label}`;
    case 'todos': return `updated todos (${tool.items.length} items)`;
    case 'plan': return 'wrote a plan';
    case 'subagent': return `subagent ${tool.action}${tool.agent ? `: ${tool.agent}` : ''}`;
    case 'mcp': return `called ${tool.server}/${tool.tool}`;
    default: return `used ${tool.label}`;
  }
}

function lineFor(item: TranscriptItem): string | undefined {
  switch (item.role) {
    case 'user': return `USER: ${item.text}`;
    case 'assistant': return item.text.trim() ? `ASSISTANT: ${item.text}` : undefined;
    case 'tool': return `TOOL (${item.state}): ${describe(item.tool)}`;
    // A permission is an interaction with the panel, not conversation content,
    // and an error describes a run that no longer exists.
    default: return undefined;
  }
}

export function buildSeed(items: TranscriptItem[], budgetChars = DEFAULT_BUDGET): string {
  const lines = items.map(lineFor).filter((l): l is string => l !== undefined);
  if (lines.length === 0) { return ''; }

  const header = `${PREAMBLE}\n\n`;
  const kept: string[] = [];
  let used = header.length;

  // Newest first, because the end of a conversation is what the next turn
  // continues from. Reversed back before joining.
  for (let i = lines.length - 1; i >= 0; i--) {
    const cost = lines[i].length + 1;
    if (used + cost > budgetChars) { break; }
    kept.unshift(lines[i]);
    used += cost;
  }

  if (kept.length === lines.length) { return `${header}${kept.join('\n')}`; }

  // The notice costs bytes the loop above did not reserve, so pay for it by
  // dropping further oldest lines. Trimming the string instead would cut the
  // tail — the newest turns, which are exactly the ones worth keeping.
  let withNotice = `${header}${OMITTED}\n${kept.join('\n')}`;
  while (withNotice.length > budgetChars && kept.length > 0) {
    kept.shift();
    withNotice = `${header}${OMITTED}\n${kept.join('\n')}`;
  }
  // A single oversized line can still overrun; the budget is a hard ceiling.
  return withNotice.length <= budgetChars
    ? withNotice
    : withNotice.slice(0, budgetChars);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test:unit --grep "buildSeed"`
Expected: PASS, 11 passing

- [ ] **Step 5: Lint, types, commit**

```bash
yarn lint && yarn check-types
git add src/host/replay.ts src/test/unit/replay.test.ts
git commit -m "feat: project a transcript into a seed for a fresh provider thread"
```

---

### Task 3: Per-thread resume tokens

**Files:**
- Create: `src/shared/thread-key.ts`
- Modify: `src/providers/types.ts` (add `threadScope` to `AgentProvider`)
- Modify: `src/protocol/messages.ts:52` (`resumeToken?: string` → `resumeTokens`)
- Modify: `src/host/agent-session.ts:89-95` (start), `:393` (`session` event)
- Modify: `src/providers/fake/fake-provider.ts`, `src/providers/claude/claude-provider.ts`,
  `src/providers/codex/codex-provider.ts` (declare scope)
- Test: `src/test/unit/thread-key.test.ts`

**Interfaces:**
- Produces: `threadKey(providerId: string, scope: ThreadScope, cwd: string): string`;
  `type ThreadScope = 'cwd' | 'global'`; `SessionState.resumeTokens: Record<string, string>`

There is no legacy migration: `TRANSCRIPT_VERSION` already discards any index
written before the canonical tool layer, so no session predating `resumeTokens`
survives to be read.

- [ ] **Step 1: Write the failing test**

```ts
import * as assert from 'assert';
import { threadKey } from '../../shared/thread-key';

suite('threadKey', () => {
  test('qualifies by directory under cwd scope', () => {
    assert.strictEqual(threadKey('claude', 'cwd', '/repo'), 'claude:/repo');
    assert.notStrictEqual(threadKey('claude', 'cwd', '/repo'), threadKey('claude', 'cwd', '/tree'));
  });

  test('ignores directory under global scope', () => {
    assert.strictEqual(threadKey('codex', 'global', '/repo'), 'codex');
    assert.strictEqual(threadKey('codex', 'global', '/repo'), threadKey('codex', 'global', '/tree'));
  });

  test('separates providers under both scopes', () => {
    assert.notStrictEqual(threadKey('claude', 'cwd', '/r'), threadKey('codex', 'cwd', '/r'));
    assert.notStrictEqual(threadKey('claude', 'global', '/r'), threadKey('codex', 'global', '/r'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:unit --grep "threadKey"`
Expected: FAIL — `Cannot find module '../../shared/thread-key'`

- [ ] **Step 3: Write the key module**

```ts
// Which provider thread a session's resume token belongs to.
//
// Directory-keyed history is a Claude fact, not a universal one: the CLI
// stores conversations under ~/.claude/projects/<slugified-cwd>, so a token
// does not resolve from another directory. Codex multiplexes threads by
// threadId with cwd as a per-thread start parameter. The provider declares
// which it is; the host never assumes.

import type { ThreadScope } from '../providers/types';

export function threadKey(providerId: string, scope: ThreadScope, cwd: string): string {
  return scope === 'global' ? providerId : `${providerId}:${cwd}`;
}
```

- [ ] **Step 4: Add the scope to the provider contract**

In `src/providers/types.ts`, above `AgentProvider`:

```ts
/**
 * Whether a resume token is valid only in the directory that produced it.
 *
 * 'cwd'    — history is stored per working directory (Claude:
 *            ~/.claude/projects/<slug>). Crossing directories needs a new
 *            thread, seeded by replay.
 * 'global' — a token resolves anywhere (Codex: threads keyed by threadId).
 *            Crossing directories is a native resume and costs nothing.
 *
 * Declaring 'cwd' when the truth is 'global' costs tokens. Declaring 'global'
 * when the truth is 'cwd' costs correctness: the resume silently finds
 * nothing and the agent comes up blank behind a full transcript. 'cwd' is the
 * safe default and 'global' must be measured before it is claimed.
 */
export type ThreadScope = 'cwd' | 'global';
```

and inside `interface AgentProvider`:

```ts
  readonly threadScope: ThreadScope;
```

Then add `readonly threadScope: ThreadScope = 'cwd';` as a field on
`FakeProvider`, `ClaudeProvider` and `CodexProvider`. Codex is `'cwd'` until
Task 11 measures otherwise — see the spec's Open Questions.

- [ ] **Step 5: Widen the persisted field**

In `src/protocol/messages.ts`, replace `resumeToken?: string;` on
`SessionState` with:

```ts
  /**
   * One resume token per provider thread, keyed by `threadKey()`. A session
   * that has run in several working trees holds several, so returning to one
   * it has already used is a native resume rather than a replay.
   */
  resumeTokens: Record<string, string>;
```

- [ ] **Step 6: Read and write the map in AgentSession**

In `src/host/agent-session.ts`, the constructor's `provider.start({...})` call
takes the token for the current thread:

```ts
    this.run = provider.start({
      cwd: _state.cwd,
      model: _state.model,
      effort: _state.effort,
      permissionMode: _state.permissionMode,
      resumeToken: _state.resumeTokens[
        threadKey(provider.id, provider.threadScope, _state.cwd)
      ],
    });
```

and the `session` event records under the same key:

```ts
      case 'session':
        this._state.resumeTokens[
          threadKey(this.provider.id, this.provider.threadScope, this._state.cwd)
        ] = event.resumeToken;
        this.sink.changed();
        return;
```

Import `threadKey` from `../shared/thread-key`. If `provider` is not already a
retained field on `AgentSession`, add `private readonly provider` to the
constructor parameter list.

In `SessionManager.create()`, initialize `resumeTokens: {}` in the
`SessionState` literal.

- [ ] **Step 7: Run the full unit suite**

Run: `yarn test:unit`
Expected: PASS. Fixtures building a `SessionState` need `resumeTokens: {}`;
update each one the compiler flags.

- [ ] **Step 8: Lint, types, compile, commit**

```bash
yarn lint && yarn check-types && yarn run compile
git add src/shared/thread-key.ts src/providers src/protocol/messages.ts src/host/agent-session.ts src/host/session-manager.ts src/test
git commit -m "feat: hold one resume token per provider thread"
```

---

### Task 4: The relocation transcript item

**Files:**
- Modify: `src/protocol/messages.ts` (item union, `WebviewToHost`)
- Test: `src/test/unit/relocation-protocol.test.ts`

**Interfaces:**
- Produces: `TranscriptItem` arm
  `{ role: 'relocation'; path: string; state: 'pending' | 'moved' | 'stayed' }`;
  `WebviewToHost` arm `{ t: 'answer-relocation'; id: SessionId; itemId: string; move: boolean }`

A durable item rather than a pending-approval: it survives a reload, sits at
the right point in the scroll, and stays meaningful when answered later —
nothing is blocked waiting on it.

- [ ] **Step 1: Write the failing test**

```ts
import * as assert from 'assert';
import type { TranscriptItem, WebviewToHost } from '../../protocol/messages';

suite('relocation protocol', () => {
  test('a relocation item carries a path and a state', () => {
    const item: TranscriptItem = {
      id: 'r1', ts: 1, role: 'relocation',
      path: '/repo/../trees/feat-x', state: 'pending',
    };
    assert.strictEqual(item.role === 'relocation' && item.state, 'pending');
  });

  test('answering carries the session, the item and the choice', () => {
    const msg: WebviewToHost = {
      t: 'answer-relocation', id: 's-1', itemId: 'r1', move: true,
    };
    assert.strictEqual(msg.t === 'answer-relocation' && msg.move, true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:unit --grep "relocation protocol"`
Expected: FAIL — type errors; `role: 'relocation'` is not assignable

- [ ] **Step 3: Add both arms**

In `src/protocol/messages.ts`, add to `TranscriptItem`:

```ts
  /**
   * An offer to follow an agent into a worktree it just created. Durable,
   * unlike a permission request: nothing is blocked on the answer, so it
   * survives a reload and stays meaningful when answered later. Answered
   * items render as their outcome, so the transcript reads as a record of
   * where the work happened.
   */
  | (ItemBase & {
      role: 'relocation'; path: string;
      state: 'pending' | 'moved' | 'stayed';
    })
```

and to `WebviewToHost`:

```ts
  | { t: 'answer-relocation'; id: SessionId; itemId: string; move: boolean }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test:unit --grep "relocation protocol"`
Expected: PASS, 2 passing

- [ ] **Step 5: Run the full suites to find exhaustive switches**

Run: `yarn check-types && yarn test:unit && yarn test:dom`
Expected: compiler errors in any exhaustive `switch (item.role)` — the reducer
and `transcript.tsx`. Add a `case 'relocation':` that renders nothing yet;
Task 7 fills it in.

- [ ] **Step 6: Commit**

```bash
yarn lint && yarn check-types
git add src/protocol/messages.ts src/webview src/test/unit/relocation-protocol.test.ts
git commit -m "feat: add the relocation transcript item and its answer message"
```

---

### Task 5: Emit the offer when a worktree appears

**Files:**
- Modify: `src/host/agent-session.ts:440-464` (`tool-end`)
- Test: `src/test/unit/agent-session-relocation.test.ts`

**Interfaces:**
- Consumes: `detectWorktreeAdd` (Task 1), the `relocation` item (Task 4)
- Produces: an appended `relocation` item with `state: 'pending'`

- [ ] **Step 1: Write the failing test**

Follow the existing harness in `src/test/unit/agent-session.test.ts` for
building a session over `FakeProvider` and collecting `sink.patch` calls.

```ts
import * as assert from 'assert';
import type { TranscriptItem } from '../../protocol/messages';

suite('AgentSession relocation offer', () => {
  test('appends a pending offer after a successful worktree add', async () => {
    const { session, patches, emit } = await makeSession();
    emit({ kind: 'tool-start', id: 'x1',
      tool: { kind: 'command', label: 'Bash', command: 'git worktree add ../t/a -b a' } });
    emit({ kind: 'tool-end', id: 'x1', ok: true, output: { kind: 'none' } });
    await session.snapshot();

    const offers = patches
      .map((p) => p.item)
      .filter((i): i is TranscriptItem => i?.role === 'relocation');
    assert.strictEqual(offers.length, 1);
    assert.strictEqual(offers[0].role === 'relocation' && offers[0].state, 'pending');
    assert.strictEqual(offers[0].role === 'relocation' && offers[0].path.endsWith('a'), true);
  });

  test('appends nothing when the command failed', async () => {
    const { session, patches, emit } = await makeSession();
    emit({ kind: 'tool-start', id: 'x1',
      tool: { kind: 'command', label: 'Bash', command: 'git worktree add ../t/a' } });
    emit({ kind: 'tool-end', id: 'x1', ok: false, output: { kind: 'none' } });
    await session.snapshot();

    assert.strictEqual(patches.some((p) => p.item?.role === 'relocation'), false);
  });

  test('appends nothing for an ordinary command', async () => {
    const { session, patches, emit } = await makeSession();
    emit({ kind: 'tool-start', id: 'x1',
      tool: { kind: 'command', label: 'Bash', command: 'yarn test' } });
    emit({ kind: 'tool-end', id: 'x1', ok: true, output: { kind: 'none' } });
    await session.snapshot();

    assert.strictEqual(patches.some((p) => p.item?.role === 'relocation'), false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:unit --grep "AgentSession relocation offer"`
Expected: FAIL — `offers.length` is 0, expected 1

- [ ] **Step 3: Wire detection into `tool-end`**

In `src/host/agent-session.ts`, immediately before the `return` at the end of
the `tool-end` case (after `this.replaceItem(settled)`):

```ts
        this.offerRelocation(settled.tool, event.ok);
        return;
```

Do **not** do the same on the child branch. Decided 2026-08-15: only top-level
calls raise an offer. A subagent's worktree is a side quest with no claim on
where the parent conversation lives, and a fan-out of subagents doing tree work
would post one card each. Then add the method:

```ts
  /**
   * Offers to follow the agent into a worktree it just created. The path is
   * resolved against this session's cwd because the agent's command was run
   * there, and a relative path in the transcript would be meaningless to the
   * host.
   */
  private offerRelocation(tool: ToolCall, ok: boolean): void {
    const found = detectWorktreeAdd(tool, ok);
    if (found === undefined) { return; }
    const path = resolve(this._state.cwd, found);
    if (path === this._state.cwd) { return; }
    this.appendItem({
      id: nextId('r'), ts: Date.now(), role: 'relocation', path, state: 'pending',
    });
    void this.scheduleFlush();
  }
```

Import `detectWorktreeAdd` from `./worktree-detect` and `resolve` from
`node:path`.

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test:unit --grep "AgentSession relocation offer"`
Expected: PASS, 3 passing

- [ ] **Step 5: Lint, types, commit**

```bash
yarn lint && yarn check-types
git add src/host/agent-session.ts src/test/unit/agent-session-relocation.test.ts
git commit -m "feat: offer to follow the agent into a new worktree"
```

---

### Task 6: Relocate the session

**Files:**
- Modify: `src/host/session-manager.ts` (add `relocate`)
- Modify: `src/host/message-router.ts` (route `answer-relocation`)
- Modify: `src/host/agent-session.ts` (accept and spend a seed)
- Test: `src/test/unit/session-relocate.test.ts`, `src/test/unit/message-router.test.ts`

**Interfaces:**
- Consumes: `threadKey` (Task 3), `buildSeed` (Task 2), the item (Task 4)
- Produces: `SessionManager.relocate(id: SessionId, itemId: string, move: boolean): Promise<void>`;
  `AgentSession` constructor gains an optional 5th parameter `seed?: string`

- [ ] **Step 1: Write the failing test**

```ts
import * as assert from 'assert';

suite('SessionManager.relocate', () => {
  test('moves cwd and marks the item moved', async () => {
    const { manager, session } = await withPendingOffer('/repo/../t/a');
    await manager.relocate(session.state.id, 'r1', true);
    assert.strictEqual(manager.get(session.state.id)!.state.cwd.endsWith('a'), true);
  });

  test('declining leaves cwd alone and marks the item stayed', async () => {
    const { manager, session } = await withPendingOffer('/repo/../t/a');
    const before = session.state.cwd;
    await manager.relocate(session.state.id, 'r1', false);
    assert.strictEqual(manager.get(session.state.id)!.state.cwd, before);
  });

  test('reuses an existing thread for a directory already visited', async () => {
    const { manager, session, provider } = await withPendingOffer('/repo/../t/a');
    const key = `fake:${resolve('/repo/../t/a')}`;
    session.state.resumeTokens[key] = 'known-token';
    await manager.relocate(session.state.id, 'r1', true);
    assert.strictEqual(provider.lastStart!.resumeToken, 'known-token');
  });

  test('seeds a fresh thread when the directory has no token', async () => {
    const { manager, session, provider } = await withPendingOffer('/repo/../t/a');
    await manager.relocate(session.state.id, 'r1', true);
    assert.strictEqual(provider.lastStart!.resumeToken, undefined);
    assert.strictEqual(manager.get(session.state.id)!.pendingSeedText!.length > 0, true);
  });

  test('refuses while the session is running', async () => {
    const { manager, session } = await withPendingOffer('/repo/../t/a', 'running');
    const before = session.state.cwd;
    await manager.relocate(session.state.id, 'r1', true);
    assert.strictEqual(manager.get(session.state.id)!.state.cwd, before);
  });
});
```

Build `withPendingOffer` on the existing `session-manager` test harness: create
a session over `FakeProvider`, append a `relocation` item with id `r1`, and
expose the provider's recorded `lastStart` options.

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:unit --grep "SessionManager.relocate"`
Expected: FAIL — `manager.relocate is not a function`

- [ ] **Step 3: Let a session carry a seed**

In `src/host/agent-session.ts`, add a constructor parameter after `sink`:

```ts
    /**
     * Prepended to the first send of a thread with no history of this
     * conversation. Spent once, then cleared — a second send continues a
     * thread that now remembers.
     */
    private seed?: string,
```

and in `send()`, before the text is dispatched to the run:

```ts
    const outgoing = this.seed ? `${this.seed}\n\n---\n\n${text}` : text;
    this.seed = undefined;
```

passing `outgoing` where `text` was passed to `this.run.send`. The transcript
item keeps recording `text`, never `outgoing`: the seed is context for the
provider, not something the user wrote. Expose
`get pendingSeedText(): string | undefined { return this.seed; }` for the test.

- [ ] **Step 4: Implement `relocate`**

In `src/host/session-manager.ts`:

```ts
  /**
   * Answers a pending relocation offer.
   *
   * A move is `archive()` -> `open()` with one field changed, which is why it
   * introduces almost no lifecycle: dispose the run, repoint `cwd`, and
   * rebuild. Whether the new thread resumes or is seeded is decided by
   * `threadKey` — the provider declares whether its tokens travel.
   */
  async relocate(id: SessionId, itemId: string, move: boolean): Promise<void> {
    const state = this.meta.get(id);
    const session = this.live.get(id);
    if (!state || !session) { return; }
    // A turn in flight finishes on the tree it started in. The card disables
    // its buttons for the same reason; this is the host-side guard.
    if (move && state.status !== 'idle') { return; }

    const item = await this.store.find(id, itemId);
    if (!item || item.role !== 'relocation' || item.state !== 'pending') { return; }

    const settled: TranscriptItem = { ...item, state: move ? 'moved' : 'stayed' };
    await session.replaceRelocation(settled);
    if (!move) { return; }

    const provider = this.providers.get(state.providerId);
    if (!provider) { return; }

    await session.dispose();
    this.live.delete(id);
    state.cwd = item.path;
    state.updatedAt = Date.now();

    const key = threadKey(provider.id, provider.threadScope, state.cwd);
    const seed = state.resumeTokens[key]
      ? undefined
      : buildSeed((await this.store.tail(id, 200)).items);

    const moved = new AgentSession(state, provider, this.store, this, seed);
    this.live.set(id, moved);
    this.catalogSvc.ensure(this.keyOf(state), provider, state.cwd);
    this.changed();
    if (this.visible.has(id)) {
      this.emit({ t: 'session-snapshot', session: await moved.snapshot() });
    }
  }
```

Import `threadKey` from `../shared/thread-key` and `buildSeed` from `./replay`.
Add `replaceRelocation(item: TranscriptItem): Promise<void>` to `AgentSession`
as a thin wrapper over `this.replaceItem(item)` followed by
`this.scheduleFlush()`. If `TranscriptStore` has no `find(id, itemId)`, add one
that scans `tail()` for a matching item id.

- [ ] **Step 5: Route the message**

In `src/host/message-router.ts`, alongside the other session cases:

```ts
      case 'answer-relocation':
        void this.manager.relocate(msg.id, msg.itemId, msg.move);
        return;
```

Add a router test asserting the call reaches the manager with those three
arguments, matching the style of the existing cases.

- [ ] **Step 6: Give the Codex app-server a teardown grace period**

Relocation is dispose-then-reconstruct, so moving the only Codex session drops
the shared app-server's refcount to zero and immediately respawns a large Rust
binary. In `src/providers/codex/codex-provider.ts`, delay teardown when the
count reaches zero by 5 seconds and cancel it if a new session attaches in that
window. Add a unit test over the existing codex-provider harness asserting that
a dispose followed immediately by a `start()` reuses the same connection.

- [ ] **Step 7: Run the suites**

Run: `yarn test:unit`
Expected: PASS

- [ ] **Step 8: Lint, types, compile, commit**

```bash
yarn lint && yarn check-types && yarn run compile
git add src/host src/providers/codex src/test
git commit -m "feat: relocate a session into another working tree"
```

---

### Task 7: The relocation card

**Files:**
- Create: `src/webview/components/relocation-card.tsx`
- Modify: `src/webview/components/transcript.tsx` (render the arm)
- Test: `src/test/dom/relocation-card.test.tsx`

**Interfaces:**
- Consumes: the `relocation` item (Task 4), `answer-relocation` (Task 4)
- Produces: `RelocationCard({ sessionId, item }: { sessionId: SessionId; item: TranscriptItem & { role: 'relocation' } })`

- [ ] **Step 1: Write the failing test**

```tsx
import * as assert from 'assert';
import { screen } from '@testing-library/dom';
import { mountPane, sendFromHost, posted, click } from './harness';

suite('RelocationCard', () => {
  test('offers the move when pending', async () => {
    const { container } = await mountPane();
    sendFromHost(snapshotWith({
      id: 'r1', ts: 1, role: 'relocation', path: '/repo/trees/feat-x', state: 'pending',
    }));
    assert.strictEqual(container.textContent!.includes('feat-x'), true);
    assert.strictEqual(screen.getByRole('button', { name: /move/i }).getAttribute('disabled') === null, true);
  });

  test('posts answer-relocation with move true', async () => {
    await mountPane();
    sendFromHost(snapshotWith({
      id: 'r1', ts: 1, role: 'relocation', path: '/repo/trees/feat-x', state: 'pending',
    }));
    click(screen.getByRole('button', { name: /move/i }));
    const msg = posted().find((m) => m.t === 'answer-relocation');
    assert.strictEqual(msg !== undefined, true);
    assert.strictEqual(msg!.move, true);
    assert.strictEqual(msg!.itemId, 'r1');
  });

  test('posts move false when declined', async () => {
    await mountPane();
    sendFromHost(snapshotWith({
      id: 'r1', ts: 1, role: 'relocation', path: '/repo/trees/feat-x', state: 'pending',
    }));
    click(screen.getByRole('button', { name: /stay/i }));
    assert.strictEqual(posted().find((m) => m.t === 'answer-relocation')!.move, false);
  });

  test('disables the move while the session is running', async () => {
    await mountPane();
    sendFromHost(snapshotWith({
      id: 'r1', ts: 1, role: 'relocation', path: '/repo/trees/feat-x', state: 'pending',
    }));
    sendFromHost({ t: 'session-status', id: 's-1', status: 'running' });
    assert.strictEqual(
      screen.getByRole('button', { name: /move/i }).hasAttribute('disabled'), true);
  });

  test('renders the outcome once answered, with no buttons', async () => {
    const { container } = await mountPane();
    sendFromHost(snapshotWith({
      id: 'r1', ts: 1, role: 'relocation', path: '/repo/trees/feat-x', state: 'moved',
    }));
    assert.strictEqual(container.textContent!.includes('Moved to'), true);
    assert.strictEqual(screen.queryByRole('button', { name: /move/i }) === null, true);
  });
});
```

`snapshotWith` builds a `session-snapshot` message whose `items` is `[item]`,
following the existing DOM harness.

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:dom --grep "RelocationCard"`
Expected: FAIL — nothing renders; `getByRole` throws

- [ ] **Step 3: Build the card**

Use `Button` from `@/components/ui/button` and `cn` from `@/lib/utils`. Match
the existing `permission-card.tsx` for card chrome, spacing and tone. Pending
state shows the basename of `path` as the heading, the line "Move this session
there? Its history stays here.", and `Move` / `Stay` buttons. Answered state
shows `Moved to <basename>` or `Stayed`, muted, no buttons. `Move` is disabled
unless the session's status is `idle`.

- [ ] **Step 4: Render it from the transcript**

Replace the placeholder `case 'relocation':` added in Task 4 — it is at
`src/webview/components/transcript-item.tsx:49` and currently returns `null` —
with a `<RelocationCard sessionId={sessionId} item={item} />`, matching how the
neighbouring `case 'permission':` passes `item` and `sessionId`.

- [ ] **Step 5: Run test to verify it passes**

Run: `yarn test:dom --grep "RelocationCard"`
Expected: PASS, 5 passing

- [ ] **Step 6: Run the UI gate**

```bash
node <impeccable-skill-dir>/scripts/detect.mjs --json src/webview/components/relocation-card.tsx src/webview/components/transcript.tsx
```

Exit 0 is clean; exit 2 means findings, which are failures and must be fixed.

- [ ] **Step 7: Lint, types, compile, commit**

```bash
yarn lint && yarn check-types && yarn run compile
git add src/webview src/test/dom/relocation-card.test.tsx
git commit -m "feat: render the relocation offer as a transcript card"
```

---

### Task 8: End-to-end check of the first milestone

**Files:**
- Test: `src/test/unit/relocation-e2e.test.ts`

**Interfaces:**
- Consumes: everything in Tasks 1–7

- [ ] **Step 1: Write the failing test**

```ts
import * as assert from 'assert';

suite('relocation end to end', () => {
  test('worktree add, accept, send — the seed rides the first message', async () => {
    const { manager, session, provider } = await liveSession();
    await session.send('plan the feature');
    provider.emit({ kind: 'tool-start', id: 'x1',
      tool: { kind: 'command', label: 'Bash', command: 'git worktree add ../t/a -b a' } });
    provider.emit({ kind: 'tool-end', id: 'x1', ok: true, output: { kind: 'none' } });
    await session.snapshot();

    const offer = (await manager.snapshotItems(session.state.id))
      .find((i) => i.role === 'relocation')!;
    await manager.relocate(session.state.id, offer.id, true);

    const moved = manager.get(session.state.id)!;
    assert.strictEqual(moved.state.cwd.endsWith('a'), true);

    await moved.send('now implement it');
    assert.strictEqual(provider.lastSent!.includes('already happened'), true);
    assert.strictEqual(provider.lastSent!.includes('plan the feature'), true);
    assert.strictEqual(provider.lastSent!.endsWith('now implement it'), true);
  });

  test('a second send in the same tree carries no seed', async () => {
    const { manager, session, provider } = await relocatedSession();
    await manager.get(session.state.id)!.send('one');
    await manager.get(session.state.id)!.send('two');
    assert.strictEqual(provider.lastSent, 'two');
  });

  test('moving back to a visited tree resumes rather than seeding', async () => {
    const { manager, session, provider } = await relocatedSession();
    const id = session.state.id;
    const root = session.state.cwd;
    manager.get(id)!.state.resumeTokens[`fake:${root}`] = 'root-token';
    await manager.relocateTo(id, root);
    assert.strictEqual(provider.lastStart!.resumeToken, 'root-token');
    assert.strictEqual(manager.get(id)!.pendingSeedText, undefined);
  });
});
```

`relocateTo(id, cwd)` is a test-only convenience on the manager that appends a
`relocation` item and immediately answers it; add it beside `relocate`, or
inline those two calls in the test if you prefer no extra surface.

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:unit --grep "relocation end to end"`
Expected: FAIL until the harness helpers exist

- [ ] **Step 3: Make it pass**

Fill in the harness helpers over `FakeProvider`, recording `lastSent` and
`lastStart`. No production change should be needed; if one is, that is a real
gap in Tasks 1–7 and belongs there.

- [ ] **Step 4: Run everything**

Run: `yarn test:unit && yarn test:dom && yarn lint && yarn check-types && yarn run compile`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/test/unit/relocation-e2e.test.ts src/host
git commit -m "test: cover relocation end to end"
```

**Milestone: relocation ships here.** Tasks 9–11 add bring-back and the sweep.

---

### Task 9: Git operations for bringing a branch back

**Files:**
- Create: `src/host/git-worktree.ts`
- Test: `src/test/unit/git-worktree.test.ts`

**Interfaces:**
- Produces:
  - `treeStatus(dir: string): Promise<TreeStatus>` where
    `TreeStatus = { isRepo: boolean; root: string; branch?: string; clean: boolean; isWorktree: boolean; mainRoot?: string }`
  - `bringBackPlan(worktreeDir: string): Promise<BringBackPlan>` where
    `BringBackPlan = { ok: true; branch: string; worktree: string; mainRoot: string } | { ok: false; reason: string }`
  - `bringBack(plan: BringBackPlan & { ok: true }): Promise<{ ok: boolean; reason?: string }>`

- [ ] **Step 1: Write the failing test**

Build real repositories in the scratchpad with `execFile`; no mocking of git.

```ts
import * as assert from 'assert';
import { treeStatus, bringBackPlan } from '../../host/git-worktree';

suite('git-worktree', () => {
  test('reports a non-repository', async () => {
    const dir = await tempDir();
    assert.strictEqual((await treeStatus(dir)).isRepo, false);
  });

  test('reports a clean repository and its branch', async () => {
    const repo = await tempRepo();
    const status = await treeStatus(repo);
    assert.strictEqual(status.isRepo, true);
    assert.strictEqual(status.clean, true);
    assert.strictEqual(typeof status.branch, 'string');
  });

  test('reports a dirty repository', async () => {
    const repo = await tempRepo();
    await writeFile(join(repo, 'dirty.txt'), 'x');
    assert.strictEqual((await treeStatus(repo)).clean, false);
  });

  test('identifies a worktree and its main root', async () => {
    const { tree, repo } = await tempRepoWithWorktree('feat-x');
    const status = await treeStatus(tree);
    assert.strictEqual(status.isWorktree, true);
    assert.strictEqual(status.mainRoot, repo);
  });

  test('plans a bring-back for a clean pair', async () => {
    const { tree } = await tempRepoWithWorktree('feat-x');
    const plan = await bringBackPlan(tree);
    assert.strictEqual(plan.ok, true);
    assert.strictEqual(plan.ok === true && plan.branch, 'feat-x');
  });

  test('refuses when the main tree is dirty, and says which', async () => {
    const { tree, repo } = await tempRepoWithWorktree('feat-x');
    await writeFile(join(repo, 'dirty.txt'), 'x');
    const plan = await bringBackPlan(tree);
    assert.strictEqual(plan.ok, false);
    assert.strictEqual(plan.ok === false && plan.reason.includes('main'), true);
  });

  test('refuses when the worktree is dirty, and says which', async () => {
    const { tree } = await tempRepoWithWorktree('feat-x');
    await writeFile(join(tree, 'dirty.txt'), 'x');
    const plan = await bringBackPlan(tree);
    assert.strictEqual(plan.ok, false);
    assert.strictEqual(plan.ok === false && plan.reason.includes('worktree'), true);
  });

  test('refuses for a directory that is not a worktree', async () => {
    const repo = await tempRepo();
    assert.strictEqual((await bringBackPlan(repo)).ok, false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:unit --grep "git-worktree"`
Expected: FAIL — `Cannot find module '../../host/git-worktree'`

- [ ] **Step 3: Implement it**

Use `promisify(execFile)` with `git` and an explicit `cwd`. Never `shell: true`.
`treeStatus` runs `rev-parse --is-inside-work-tree`, `rev-parse --show-toplevel`,
`branch --show-current`, `status --porcelain`, and
`rev-parse --path-format=absolute --git-common-dir` to find the main root.
`bringBackPlan` composes those into a single `ok`/`reason` answer.
`bringBack` runs `git worktree remove <tree>` in the main root, then
`git checkout <branch>` there — in that order, because git refuses the same
branch in two trees. Every rejection is a returned reason; nothing throws.

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test:unit --grep "git-worktree"`
Expected: PASS, 8 passing

- [ ] **Step 5: Lint, types, commit**

```bash
yarn lint && yarn check-types
git add src/host/git-worktree.ts src/test/unit/git-worktree.test.ts
git commit -m "feat: plan and perform bringing a worktree branch back"
```

---

### Task 10: The bring-back action

**Files:**
- Modify: `src/protocol/messages.ts` (`request-bring-back`, `bring-back`, `bring-back-plan`)
- Modify: `src/host/session-manager.ts`, `src/host/message-router.ts`
- Create: `src/webview/components/bring-back-dialog.tsx`
- Modify: `src/webview/components/pane-header.tsx`
- Test: `src/test/unit/bring-back.test.ts`, `src/test/dom/bring-back-dialog.test.tsx`

**Interfaces:**
- Consumes: `bringBackPlan`, `bringBack` (Task 9), `relocate` (Task 6)
- Produces: `SessionManager.bringBack(id: SessionId): Promise<void>`;
  `{ t: 'request-bring-back'; id: SessionId }`, `{ t: 'bring-back'; id: SessionId }`,
  `{ t: 'bring-back-plan'; id: SessionId; plan: BringBackPlan }`

- [ ] **Step 1: Write the failing test**

```ts
suite('SessionManager.bringBack', () => {
  test('emits a plan describing the two steps', async () => {
    const { manager, session, emitted } = await sessionInWorktree('feat-x');
    await manager.requestBringBack(session.state.id);
    const msg = emitted().find((m) => m.t === 'bring-back-plan');
    assert.strictEqual(msg !== undefined, true);
    assert.strictEqual(msg!.plan.ok, true);
  });

  test('refuses and does not move the session when the main tree is dirty', async () => {
    const { manager, session, repo } = await sessionInWorktree('feat-x');
    await writeFile(join(repo, 'dirty.txt'), 'x');
    const before = session.state.cwd;
    await manager.bringBack(session.state.id);
    assert.strictEqual(manager.get(session.state.id)!.state.cwd, before);
  });

  test('on success the worktree is gone and the session sits in the main root', async () => {
    const { manager, session, repo } = await sessionInWorktree('feat-x');
    await manager.bringBack(session.state.id);
    assert.strictEqual(manager.get(session.state.id)!.state.cwd, repo);
    assert.strictEqual(existsSync(join(repo, '..', 'trees', 'feat-x')), false);
  });

  test('a failed git step leaves an error item and no move', async () => {
    const { manager, session } = await sessionInWorktree('feat-x', { breakGit: true });
    const before = session.state.cwd;
    await manager.bringBack(session.state.id);
    assert.strictEqual(manager.get(session.state.id)!.state.cwd, before);
    const items = await manager.snapshotItems(session.state.id);
    assert.strictEqual(items.some((i) => i.role === 'error'), true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:unit --grep "SessionManager.bringBack"`
Expected: FAIL — `manager.requestBringBack is not a function`

- [ ] **Step 3: Implement the host side**

`requestBringBack(id)` calls `bringBackPlan(state.cwd)` and emits
`bring-back-plan`. `bringBack(id)` re-plans (state can change between the
dialog opening and the click), returns after appending an `error` item if the
plan is not `ok`, then runs `bringBack(plan)`, and only on success relocates
the session to `plan.mainRoot` through the same path Task 6 built — git first,
cwd second, so a git failure leaves the session untouched. Delete the departing
tree's entry from `state.resumeTokens`, so a future worktree at that path
cannot resume unrelated work.

- [ ] **Step 4: Build the dialog**

`Dialog` and `Button` from `@/components/ui/*`. Lists the two steps as bullets,
shows `plan.reason` as a warning when not `ok`, and disables the confirm button
in that case. Opened from an item in the pane header's existing overflow menu,
shown only when the session's cwd is a worktree.

- [ ] **Step 5: Write the DOM test**

Assert: the dialog lists both steps; a not-`ok` plan renders its reason and
disables confirm; confirming posts `bring-back` with the session id. Through
the real `StoreProvider`, with `bring-back-plan` delivered via `sendFromHost`.

- [ ] **Step 6: Run the suites and the UI gate**

```bash
yarn test:unit --grep "bringBack" && yarn test:dom --grep "bring-back"
node <impeccable-skill-dir>/scripts/detect.mjs --json src/webview/components/bring-back-dialog.tsx src/webview/components/pane-header.tsx
```

- [ ] **Step 7: Lint, types, compile, commit**

```bash
yarn lint && yarn check-types && yarn run compile
git add src/protocol src/host src/webview src/test
git commit -m "feat: bring a worktree branch back into the main tree"
```

---

### Task 11: Stale trees, and the opt-in smoke test

**Files:**
- Create: `src/webview/components/stale-trees.tsx`
- Modify: `src/host/session-manager.ts` (`staleTrees()`)
- Create: `src/test/unit/relocation-smoke.test.ts`
- Test: `src/test/dom/stale-trees.test.tsx`

**Interfaces:**
- Consumes: `treeStatus` (Task 9), `resumeTokens` (Task 3)
- Produces: `SessionManager.staleTrees(): Promise<StaleTree[]>` where
  `StaleTree = { path: string; branch?: string; clean: boolean; sessionId?: SessionId }`

- [ ] **Step 1: Write the failing DOM test**

Assert the panel lists one row per tree with its branch and a dirty marker, that
a clean row's Remove is enabled, and that a dirty row's is disabled with its
reason shown. Real `StoreProvider`, genuine messages, no DOM nodes in asserts.

- [ ] **Step 2: Implement `staleTrees` and the panel**

Every distinct directory appearing in any session's `resumeTokens` keys or
`cwd`, resolved through `treeStatus`, with rows for trees whose session is gone
marked as unowned. Removal reuses Task 9's refusals.

- [ ] **Step 3: Write the opt-in smoke test**

Gated exactly like `src/test/unit/codex-smoke.test.ts` — skipped, never failed,
when the CLI is absent or signed out. It creates a real worktree, moves a real
session into it, seeds a fresh thread, then asks the agent what it was working
on and asserts the reply names the task. This is the only test that shows
replay reconstitutes a conversation rather than producing well-formed text.

Add a second case for the spec's open question: start a thread in one directory,
resume it from another, and record whether the conversation survives. If it
does for Codex, flip `CodexProvider.threadScope` to `'global'` and note the
measurement in the spec.

- [ ] **Step 4: Run everything**

Run: `yarn test:unit && yarn test:dom && yarn lint && yarn check-types && yarn run compile`
Expected: PASS, smoke skipped unless opted in

- [ ] **Step 5: Run critique before merge**

Per CLAUDE.md, run `critique` over `src/webview` and compare against
`.impeccable/critique/`. The score is expected to hold or rise.

- [ ] **Step 6: Commit**

```bash
git add src/host src/webview src/test
git commit -m "feat: sweep stale worktrees, and smoke-test relocation"
```

---

## Self-Review

**Spec coverage.** Thread scope and `resumeTokens` → Task 3. Replay → Task 2,
spent in Task 6. Detection → Task 1, wired in Task 5. Move-out card → Tasks 4
and 7. Relocation itself, ordering, and catalog re-probe → Task 6. Codex
refcount grace → Task 6 Step 6. Bring-back with its git preconditions and
git-before-cwd ordering → Tasks 9 and 10. `resumeTokens` pruning on tree
removal → Task 10 Step 3. Stale-tree surface → Task 11. Both open questions →
Task 11 Step 3. The migration the spec removed is deliberately absent.

**Type consistency.** `detectWorktreeAdd(tool, ok)`, `buildSeed(items, budget)`,
`threadKey(providerId, scope, cwd)`, `SessionManager.relocate(id, itemId, move)`,
`treeStatus`/`bringBackPlan`/`bringBack` are spelled identically everywhere they
appear. The `relocation` item's states are `pending` | `moved` | `stayed`
throughout.

**Known soft spots**, flagged rather than hidden: Task 6 assumes a
`TranscriptStore.find(id, itemId)` that may need adding, and Task 8's harness
helpers (`liveSession`, `relocatedSession`, `snapshotItems`) are described
rather than written, because they extend an existing test harness this plan
does not reproduce.
