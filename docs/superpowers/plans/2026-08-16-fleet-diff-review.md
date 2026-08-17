# Fleet Diff Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One surface listing every file each session changed, grouped by session, refreshing while agents work, opening into VS Code's own diff editor.

**Architecture:** Content comes from git (one `git diff --numstat -M <base>` per working tree, plus `ls-files --others` for untracked). Attribution comes from the transcript — every provider already emits a canonical `{ kind: 'file-edit' }` `ToolCall` carrying paths, so the host knows which session wrote where. The two are joined in `SessionManager`, sent as a flat per-tree payload, and grouped by session in the webview.

**Tech Stack:** TypeScript, Node 22, `node:child_process.execFile` (never `shell: true`), React 19, Tailwind v4, vendored Base-UI-backed shadcn, mocha (unit + jsdom DOM), `@vscode/test-cli` (integration).

**Spec:** `docs/superpowers/specs/2026-08-16-fleet-diff-review-design.md`

## Global Constraints

Copied from the spec and `CLAUDE.md`. Every task's requirements implicitly include these.

- `src/protocol/messages.ts` is **types-only**. No runtime code, no `vscode` import.
- Nothing under `src/providers/` or `src/protocol/` imports `vscode`. Neither does `src/host/message-router.ts` or `src/host/fleet-diff.ts`.
- **Errors are state, never exceptions.** Every git failure is a returned reason. Nothing added here may reject across `postMessage`.
- **Never `shell: true`.** `execFile` with an argv array and an explicit `cwd`.
- Every protocol message addressed to a session carries an explicit `SessionId`. Fleet-diff messages are panel-wide and deliberately carry none.
- Filenames kebab-case, including React components. Component identifiers PascalCase.
- **No raw HTML controls.** `Button`, `Dialog`, etc. from `@/components/ui/*`. Compose classNames with `cn` from `@/lib/utils` — never template literals.
- **Never pass a DOM node to an assertion.** `assert.strictEqual(x === null, true)`, never `assert.strictEqual(x, null)`. See the harness doc comment; the node-valued form allocated 3.5GB in 4 seconds on 2026-08-14.
- DOM tests drive components through the real `StoreProvider` with genuine `HostToWebview` messages via `sendFromHost`. Never mock `useStore`.
- `yarn lint`, `yarn check-types`, `yarn run compile` must pass before every commit.
- Conventional-commit prefixes. No `Co-Authored-By` trailer.
- Render cap: **500** files per tree, remainder reported in `omitted`. Never truncate silently.
- `REVIEW_PX = 700`. `NARROW_PX = 500` is unchanged.
- Refresh debounce: **750ms**.

---

## File Structure

**Create:**

| Path | Responsibility |
|---|---|
| `src/host/fleet-diff.ts` | Git plumbing: base resolution, numstat/untracked parsing. No `vscode`. Sibling of `git-worktree.ts`, same two rules. |
| `src/host/claim-paths.ts` | Pure path handling: `ToolCall` → absolute claimed paths; absolute → repo-relative POSIX. |
| `src/host/diff-content-provider.ts` | `TextDocumentContentProvider` for the `hiiiid-diff:` scheme, backed by `git show`. The only new file importing `vscode`. |
| `src/webview/components/fleet-diff.tsx` | The surface: trees → sessions → file rows. |
| `src/webview/components/fleet-diff-groups.ts` | Pure grouping of a flat `TreeDiff` into session groups + unattributed. No React, no `@/` aliases — required from the mocha harness, like `pane-layout.ts`. |
| `src/test/unit/fleet-diff.test.ts` | Real git, real repos, no mocks. |
| `src/test/unit/claim-paths.test.ts` | Pure. |
| `src/test/unit/fleet-diff-manager.test.ts` | Assembly + attribution, real git. |
| `src/test/unit/fleet-diff-groups.test.ts` | Pure grouping. |
| `src/test/dom/fleet-diff.test.tsx` | Surface + gating, real `StoreProvider`. |

**Modify:**

| Path | Change |
|---|---|
| `src/protocol/messages.ts` | `ChangeOp`, `FileChange`, `DiffBase`, `TreeDiff`; three message arms. |
| `src/host/agent-session.ts` | Record claimed paths on `tool-end`; expose `claimedPaths`. |
| `src/host/session-manager.ts` | `fleetDiff()`, `requestFleetDiff()`, claim cache + backfill. |
| `src/host/message-router.ts` | Two arms, `KNOWN_MESSAGE_TAGS`, `EditorContextHost.openDiff`. |
| `src/host/panel-view-provider.ts` | Nothing structural — `editor` is already threaded. |
| `src/extension.ts` | Register the content provider; implement `openDiff`. |
| `src/webview/reducer.ts` | `fleetDiff`, `fleetDiffDirty` slices. |
| `src/webview/components/use-is-narrow.ts` | Becomes `usePanelWidth`; `REVIEW_PX`. |
| `src/webview/app.tsx` | Derived surface mount. |
| `src/webview/components/session-picker.tsx` | Entry button. |

### Refinements to the spec (deliberate, agreed here)

Three places where implementation is cleaner than the spec's sketch. Each is a strict improvement, not a scope change:

1. **`DiffBase` is a named exported type**, not an inline union on `TreeDiff`. Same shape.
2. **Claims are stored as absolute platform paths**, converted to repo-relative only at diff-assembly time. The spec implies normalizing at claim time, which would need the tree root — an async git call — inside a synchronous `tool-end` handler. Storing absolute defers that to where the root is already known.
3. **Freshness is driven entirely client-side.** The spec describes host-side debounced refetch. But `session-status` is ungated (it fans out for every session, visible or not) and `session-patch` already carries settled `file-edit` tool items for visible ones. So the reducer bumps a `fleetDiffDirty` counter and the surface debounces a re-request off it. Zero host plumbing, same behaviour, and the debounce is testable as a pure reducer increment.

---

## Task 1: Protocol types and git plumbing

**Files:**
- Modify: `src/protocol/messages.ts` (add payload types near `StaleTree`)
- Create: `src/host/fleet-diff.ts`
- Test: `src/test/unit/fleet-diff.test.ts`

**Interfaces:**
- Consumes: `treeStatus`, `samePath` from `src/host/git-worktree.ts`
- Produces:
  - `ChangeOp`, `FileChange`, `DiffBase`, `TreeDiff` (protocol, type-only)
  - `parseNumstat(out: string): RawChange[]`
  - `resolveBase(dir: string): Promise<DiffBase>`
  - `treeChanges(dir: string): Promise<{ base: DiffBase; files: RawChange[]; omitted: number } | { reason: string }>`
  - `RawChange = Omit<FileChange, 'claimedBy'>`
  - `FILE_CAP = 500`

- [x] **Step 1: Add the payload types to the protocol**

In `src/protocol/messages.ts`, beside the existing `StaleTree` interface:

```ts
export type ChangeOp = 'create' | 'modify' | 'delete' | 'rename';

/**
 * How a tree's diff was anchored. Named rather than inline because the UI
 * quotes it: `head` means the diff shows uncommitted work only, which is a
 * materially different reading of a session than "everything since the
 * branch point", and a number nobody can locate is not an answer.
 */
export type DiffBase =
  | { kind: 'merge-base'; ref: string; sha: string }
  | { kind: 'head' };

export interface FileChange {
  /** Repo-relative, POSIX separators — the spelling git reports. */
  path: string;
  /** Set only for a rename; the path the file moved from. */
  from?: string;
  op: ChangeOp;
  /** Undefined for a binary file, where git reports no line counts. */
  insertions?: number;
  deletions?: number;
  /**
   * Sessions whose transcripts claim a write to this path. Empty is a real
   * answer, not a gap: a change made by a shell command, a build or the user
   * has no tool call behind it and no session may be named for it.
   */
  claimedBy: SessionId[];
}

export interface TreeDiff {
  /** Resolved absolute path of the working tree root. */
  root: string;
  branch?: string;
  /** Sessions occupying this tree, roster order. */
  sessions: SessionId[];
  base: DiffBase;
  files: FileChange[];
  /** Files beyond the render cap, omitted from `files`. Never truncate silently. */
  omitted: number;
  /** Why this tree has no diff. Set means `files` is empty. */
  reason?: string;
}
```

- [x] **Step 2: Write the failing tests**

Create `src/test/unit/fleet-diff.test.ts`. Copy the `tempDir` / `initRepo` helpers from `src/test/unit/stale-trees.test.ts:26-41` verbatim — real git, no mocks, same rule.

```ts
// Fleet diff's git plumbing: what changed in a tree, and against what.
//
// Real git, real repositories, no mocking — the same rule the stale-tree
// sweep sets. A diff answered from a mock would be answering about a
// repository nobody has.

import * as assert from 'assert';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { parseNumstat, resolveBase, treeChanges } from '../../host/fleet-diff';

const run = promisify(execFile);
const roots: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), 'hiiiid-fdiff-')));
  roots.push(dir);
  return dir;
}

async function initRepo(dir: string): Promise<void> {
  await run('git', ['init', '-b', 'main', dir], { windowsHide: true });
  await run('git', ['config', 'user.email', 'test@example.invalid'], { cwd: dir, windowsHide: true });
  await run('git', ['config', 'user.name', 'Test'], { cwd: dir, windowsHide: true });
  await run('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir, windowsHide: true });
  await fs.writeFile(join(dir, 'README.md'), 'seed\n');
  await run('git', ['add', 'README.md'], { cwd: dir, windowsHide: true });
  await run('git', ['commit', '-m', 'seed'], { cwd: dir, windowsHide: true });
}

async function commitAll(dir: string, message: string): Promise<void> {
  await run('git', ['add', '-A'], { cwd: dir, windowsHide: true });
  await run('git', ['commit', '-m', message], { cwd: dir, windowsHide: true });
}

suite('fleet-diff git plumbing', function () {
  this.timeout(60_000);

  teardown(async () => {
    while (roots.length > 0) {
      await fs.rm(roots.pop()!, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  test('parseNumstat reads counts, renames and binary files', () => {
    const rows = parseNumstat([
      '3\t1\tsrc/a.ts',
      '0\t7\tsrc/gone.ts',
      '-\t-\tassets/logo.png',
      '2\t2\tsrc/{old => new}.ts',
    ].join('\n'));

    assert.strictEqual(rows.length, 4);
    assert.strictEqual(rows[0].path, 'src/a.ts');
    assert.strictEqual(rows[0].insertions, 3);
    assert.strictEqual(rows[0].deletions, 1);
    assert.strictEqual(rows[2].insertions, undefined);
    assert.strictEqual(rows[2].deletions, undefined);
    assert.strictEqual(rows[3].op, 'rename');
    assert.strictEqual(rows[3].from, 'src/old.ts');
    assert.strictEqual(rows[3].path, 'src/new.ts');
  });

  test('a repo with no remote and no other branch falls back to head', async () => {
    const dir = await tempDir();
    await initRepo(dir);
    const base = await resolveBase(dir);
    assert.strictEqual(base.kind, 'head');
  });

  test('committed and uncommitted changes arrive merged, in one answer', async () => {
    const dir = await tempDir();
    await initRepo(dir);
    await run('git', ['checkout', '-b', 'work'], { cwd: dir, windowsHide: true });
    await fs.writeFile(join(dir, 'committed.ts'), 'a\n');
    await commitAll(dir, 'work');
    await fs.writeFile(join(dir, 'dirty.ts'), 'b\n');

    const result = await treeChanges(dir);
    assert.strictEqual('reason' in result, false);
    if ('reason' in result) { return; }
    assert.strictEqual(result.base.kind, 'merge-base');
    const paths = result.files.map((f) => f.path).sort();
    assert.deepStrictEqual(paths, ['committed.ts', 'dirty.ts']);
  });

  test('an untracked file is a create, with no counts', async () => {
    const dir = await tempDir();
    await initRepo(dir);
    await fs.writeFile(join(dir, 'brand-new.ts'), 'x\n');

    const result = await treeChanges(dir);
    if ('reason' in result) { assert.fail(result.reason); }
    const row = result.files.find((f) => f.path === 'brand-new.ts');
    assert.strictEqual(row?.op, 'create');
    assert.strictEqual(row?.insertions, undefined);
  });

  test('a non-ASCII path is not octal-escaped', async () => {
    const dir = await tempDir();
    await initRepo(dir);
    await fs.writeFile(join(dir, 'café.ts'), 'x\n');

    const result = await treeChanges(dir);
    if ('reason' in result) { assert.fail(result.reason); }
    assert.strictEqual(result.files.some((f) => f.path === 'café.ts'), true);
  });

  test('a directory that is not a repository answers with a reason', async () => {
    const dir = await tempDir();
    const result = await treeChanges(dir);
    assert.strictEqual('reason' in result, true);
  });

  test('the file cap reports what it omitted', async () => {
    const dir = await tempDir();
    await initRepo(dir);
    for (let i = 0; i < 505; i++) {
      await fs.writeFile(join(dir, `f${i}.ts`), 'x\n');
    }
    const result = await treeChanges(dir);
    if ('reason' in result) { assert.fail(result.reason); }
    assert.strictEqual(result.files.length, 500);
    assert.strictEqual(result.omitted, 5);
  });
});
```

- [x] **Step 3: Run the tests to verify they fail**

Run: `yarn test:unit --grep "fleet-diff git plumbing"`
Expected: FAIL — `Cannot find module '../../host/fleet-diff'`.

- [x] **Step 4: Implement `src/host/fleet-diff.ts`**

```ts
// What changed in a working tree, and against what.
//
// The same two rules as `git-worktree.ts`, and for the same reasons:
//
//  - **Every failure is a returned reason, never a throw.** A tree that
//    cannot be read becomes a row saying why, exactly as a refused
//    `bringBackPlan` stays a `StaleTree` row.
//  - **Never `shell: true`.** Paths contain spaces, and this is the boundary
//    where a directory name would otherwise become shell syntax.
//
// No `vscode` import: this is unit-tested outside the extension host.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ChangeOp, DiffBase, FileChange } from '../protocol/messages';

const execFileAsync = promisify(execFile);

export type RawChange = Omit<FileChange, 'claimedBy'>;

/**
 * A tree with more changed files than this is a tree nobody reviews in a
 * sidebar. The remainder is *reported*, never silently dropped — a truncated
 * list reads as "that's everything" when it isn't.
 */
export const FILE_CAP = 500;

/**
 * `core.quotepath=false` on every call: git otherwise escapes non-ASCII paths
 * into octal (`"caf\303\251.ts"`), which would never match a path a provider
 * reported and would silently lose that file's attribution.
 */
async function git(cwd: string, args: string[]) {
  try {
    const { stdout } = await execFileAsync(
      'git', ['-c', 'core.quotepath=false', ...args],
      { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
    );
    return { ok: true as const, out: stdout.trimEnd() };
  } catch (error) {
    const shaped = error as { stderr?: string; message?: string };
    return { ok: false as const, err: (shaped.stderr ?? shaped.message ?? 'git failed').trim() };
  }
}

const FALLBACK_REFS = ['origin/main', 'origin/master', 'main', 'master'];

/**
 * The ref this tree's work should be read against, in descending order of
 * confidence. `head` is the honest floor: it means the answer covers
 * uncommitted work only, and the UI says so rather than implying a branch
 * point it could not find.
 */
export async function resolveBase(dir: string): Promise<DiffBase> {
  const candidates: string[] = [];

  const symbolic = await git(dir, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (symbolic.ok && symbolic.out !== '') {
    candidates.push(symbolic.out.replace(/^refs\/remotes\//, ''));
  }
  candidates.push(...FALLBACK_REFS);

  for (const ref of candidates) {
    const exists = await git(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (!exists.ok || exists.out === '') { continue; }
    const mergeBase = await git(dir, ['merge-base', ref, 'HEAD']);
    if (!mergeBase.ok || mergeBase.out === '') { continue; }
    // A base identical to HEAD anchors nothing beyond what HEAD already
    // anchors, and claiming a branch point that is HEAD would put a
    // misleading ref in the caption.
    const head = await git(dir, ['rev-parse', 'HEAD']);
    if (head.ok && head.out === mergeBase.out) { return { kind: 'head' }; }
    return { kind: 'merge-base', ref, sha: mergeBase.out };
  }

  return { kind: 'head' };
}

/** `src/{old => new}.ts` and `old.ts => new.ts` are both git rename spellings. */
function splitRename(raw: string): { from?: string; path: string } {
  const braced = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(raw);
  if (braced) {
    const [, prefix, before, after, suffix] = braced;
    return {
      from: `${prefix}${before}${suffix}`.replace(/\/\//g, '/'),
      path: `${prefix}${after}${suffix}`.replace(/\/\//g, '/'),
    };
  }
  const at = raw.indexOf(' => ');
  if (at >= 0) {
    return { from: raw.slice(0, at).trim(), path: raw.slice(at + 4).trim() };
  }
  return { path: raw };
}

/**
 * `--numstat` is three tab-separated fields. A binary file reports `-` for
 * both counts, which becomes `undefined` rather than 0 — zero would read as
 * "nothing changed", and something plainly did.
 */
export function parseNumstat(out: string): RawChange[] {
  const rows: RawChange[] = [];
  for (const line of out.split('\n')) {
    if (line.trim() === '') { continue; }
    const [ins, del, ...rest] = line.split('\t');
    if (rest.length === 0) { continue; }
    const { from, path } = splitRename(rest.join('\t'));
    const insertions = ins === '-' ? undefined : Number(ins);
    const deletions = del === '-' ? undefined : Number(del);
    // `--numstat` cannot distinguish a delete from a modify — that needs
    // `--name-status`, a third command for a distinction the row already
    // implies (all deletions, no insertions). Rename is the one op it does
    // report, via the arrow spelling, so it is the one op read here.
    const op: ChangeOp = from !== undefined ? 'rename' : 'modify';
    rows.push({ path, from, op, insertions, deletions });
  }
  return rows;
}

/**
 * The whole change set for one tree, in two commands.
 *
 * `git diff <base>` — deliberately with no `..HEAD` — compares the *working
 * tree* against the base, so committed and uncommitted changes arrive
 * together, already merged per path. Committed-only and uncommitted-only
 * would each need their own command and then a merge pass; this needs
 * neither, and it is what lets the surface be live during a turn.
 *
 * `ls-files --others` is the second command because `diff` cannot see an
 * untracked file, and an agent creating a new file is the most common change
 * there is.
 */
export async function treeChanges(
  dir: string,
): Promise<{ base: DiffBase; files: RawChange[]; omitted: number } | { reason: string }> {
  const inside = await git(dir, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.out !== 'true') {
    return { reason: `${dir} is not a git repository.` };
  }

  const base = await resolveBase(dir);
  const against = base.kind === 'merge-base' ? base.sha : 'HEAD';

  const diff = await git(dir, ['diff', '--numstat', '-M', against]);
  if (!diff.ok) { return { reason: `Could not read this tree's changes: ${diff.err}` }; }

  const untracked = await git(dir, ['ls-files', '--others', '--exclude-standard']);
  const files = parseNumstat(diff.out);
  if (untracked.ok) {
    for (const path of untracked.out.split('\n')) {
      if (path.trim() === '') { continue; }
      // No counts: reading every new file on every refresh, during a turn, is
      // a cost this view refuses to pay for a number nobody sorts by.
      files.push({ path, op: 'create' });
    }
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  const omitted = Math.max(0, files.length - FILE_CAP);
  return { base, files: files.slice(0, FILE_CAP), omitted };
}
```

- [x] **Step 5: Run the tests to verify they pass**

Run: `yarn test:unit --grep "fleet-diff git plumbing"`
Expected: PASS, 7 passing.

- [x] **Step 6: Verify and commit**

Run: `yarn lint && yarn check-types`
Expected: both clean.

```bash
git add src/protocol/messages.ts src/host/fleet-diff.ts src/test/unit/fleet-diff.test.ts
git commit -m "feat: read a working tree's change set against its branch point"
```

---

## Task 2: Claimed-path normalization

**Files:**
- Create: `src/host/claim-paths.ts`
- Test: `src/test/unit/claim-paths.test.ts`

**Interfaces:**
- Consumes: `ToolCall`, `FileEdit` from `src/providers/canonical/tool-call.ts`; `samePath` from `src/host/git-worktree.ts`
- Produces:
  - `claimedPaths(tool: ToolCall, cwd: string): string[]` — absolute, platform separators
  - `toRepoRelative(absolute: string, root: string): string | undefined` — POSIX repo-relative, or undefined if outside `root`

This is the spec's named bug site, so it is its own task with its own tests.

- [x] **Step 1: Write the failing tests**

Create `src/test/unit/claim-paths.test.ts`:

```ts
// Turning a provider's idea of a path into git's idea of a path.
//
// Pure, and tested hard, because this is where attribution silently fails:
// a path that does not match is not an error, it is a file that quietly
// belongs to nobody.

import * as assert from 'assert';
import { isAbsolute, join } from 'node:path';
import { claimedPaths, toRepoRelative } from '../../host/claim-paths';
import type { ToolCall } from '../../providers/canonical/tool-call';

const root = isAbsolute('/repo') && process.platform !== 'win32' ? '/repo' : 'C:\\repo';
const inRoot = (...parts: string[]) => join(root, ...parts);

function edit(...paths: string[]): ToolCall {
  return {
    kind: 'file-edit',
    label: 'Edit',
    files: paths.map((path) => ({ path, op: 'modify' as const })),
  };
}

suite('claim paths', () => {
  test('an absolute POSIX path from a provider resolves unchanged', () => {
    const posix = root.replace(/\\/g, '/');
    const claimed = claimedPaths(edit(`${posix}/src/a.ts`), root);
    assert.strictEqual(claimed.length, 1);
    assert.strictEqual(toRepoRelative(claimed[0], root), 'src/a.ts');
  });

  test('a relative path resolves against the session cwd', () => {
    const claimed = claimedPaths(edit('src/b.ts'), inRoot('nested'));
    assert.strictEqual(toRepoRelative(claimed[0], root), 'nested/src/b.ts');
  });

  test('a path outside the tree is dropped, never clamped', () => {
    const outside = process.platform === 'win32' ? 'C:\\elsewhere\\x.ts' : '/elsewhere/x.ts';
    assert.strictEqual(toRepoRelative(outside, root), undefined);
  });

  test('the root itself is not a file in the root', () => {
    assert.strictEqual(toRepoRelative(root, root), undefined);
  });

  test('a sibling directory sharing a prefix is not inside the root', () => {
    const sibling = `${root}-other`;
    assert.strictEqual(toRepoRelative(join(sibling, 'a.ts'), root), undefined);
  });

  test('every file in a multi-file edit is claimed', () => {
    const claimed = claimedPaths(edit('a.ts', 'b.ts', 'c.ts'), root);
    assert.strictEqual(claimed.length, 3);
  });

  test('a deletion is still a claim', () => {
    const tool: ToolCall = {
      kind: 'file-edit', label: 'Edit',
      files: [{ path: 'gone.ts', op: 'delete' }],
    };
    assert.strictEqual(claimedPaths(tool, root).length, 1);
  });

  test('a rename claims both sides', () => {
    const tool: ToolCall = {
      kind: 'file-edit', label: 'Edit',
      files: [{ path: 'new.ts', op: 'rename' }],
    };
    assert.strictEqual(claimedPaths(tool, root).length, 1);
  });

  test('a tool that is not a file edit claims nothing', () => {
    const tool: ToolCall = { kind: 'command', label: 'Bash', command: 'ls' };
    assert.deepStrictEqual(claimedPaths(tool, root), []);
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `yarn test:unit --grep "claim paths"`
Expected: FAIL — `Cannot find module '../../host/claim-paths'`.

- [x] **Step 3: Implement `src/host/claim-paths.ts`**

```ts
// Provider paths in, git paths out.
//
// `FileEdit.path` is "absolute where the provider gave one, POSIX
// separators" — otherwise relative to the session's cwd. Git reports
// repo-relative POSIX. Everything between those two spellings lives here, in
// one place, because a second spelling of this rule elsewhere is a second
// thing to get wrong on one platform only.
//
// No `vscode` import.

import { relative, resolve } from 'node:path';
import { samePath } from './git-worktree';
import type { ToolCall } from '../providers/canonical/tool-call';

/**
 * Every path a tool call wrote, absolute, in the platform's own spelling.
 *
 * Absolute rather than repo-relative on purpose: the tree root is an async
 * git question, and this is called from a synchronous `tool-end` handler.
 * The conversion to repo-relative happens at diff-assembly time, where the
 * root is already known.
 */
export function claimedPaths(tool: ToolCall, cwd: string): string[] {
  if (tool.kind !== 'file-edit') { return []; }
  return tool.files.map((file) => resolve(cwd, file.path));
}

/**
 * `absolute` expressed relative to `root`, POSIX-separated, or undefined when
 * it is not inside `root` at all.
 *
 * A path outside the tree is dropped rather than clamped. An agent writing
 * outside its own tree is a real event, but it is not this tree's diff, and a
 * clamped path would attach it to a file that has nothing to do with it.
 *
 * Case sensitivity is `samePath`'s rule — case-insensitive on win32 only —
 * reached by comparing the round trip rather than respelling it here.
 */
export function toRepoRelative(absolute: string, root: string): string | undefined {
  const full = resolve(absolute);
  const base = resolve(root);
  if (samePath(full, base)) { return undefined; }

  const rel = relative(base, full);
  // `relative` answers with `..` segments for anything outside, and an
  // absolute path when the two sit on different win32 drives. The round trip
  // is compared through `samePath`, never with `!==`: on win32 a strict
  // compare would reject `E:\Repo\a.ts` against `e:\repo\a.ts` and silently
  // drop the claim for a file that is plainly inside the tree.
  if (rel === '' || rel.startsWith('..')) { return undefined; }
  if (!samePath(resolve(base, rel), full)) { return undefined; }

  return rel.split('\\').join('/');
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `yarn test:unit --grep "claim paths"`
Expected: PASS, 9 passing.

- [x] **Step 5: Verify and commit**

Run: `yarn lint && yarn check-types`

```bash
git add src/host/claim-paths.ts src/test/unit/claim-paths.test.ts
git commit -m "feat: normalize provider edit paths onto git's spelling"
```

---

## Task 3: Sessions record what they wrote

**Files:**
- Modify: `src/host/agent-session.ts` (the `tool-end` case, around `:546-576`)
- Test: `src/test/unit/fleet-diff-manager.test.ts` (first suite only; the file grows in Task 4)

**Interfaces:**
- Consumes: `claimedPaths` from Task 2
- Produces: `AgentSession.claimedPaths: ReadonlySet<string>` (absolute platform paths)

**Critical detail:** `tool-end` has two exits. The subagent branch returns early at `agent-session.ts:571`, before `offerRelocation`. Relocation skips subagents deliberately — a subagent's worktree has no claim on where the parent conversation lives. **Attribution must not skip them:** a subagent's edit changes this session's tree and is this session's change on disk. So the recording call goes *above* the `if (parentRoot)` branch.

- [x] **Step 1: Write the failing test**

Create `src/test/unit/fleet-diff-manager.test.ts` with this first suite. The `FakeProvider` constructor takes a function from prompt text to `AgentEvent[]` (see `src/extension.ts:70-77` for the shape).

```ts
// Attribution: which session wrote which file, from the transcript rather
// than from git — because git sees one dirty tree when three sessions share
// a root, and the panel is the only thing that knows more.

import * as assert from 'assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { join, resolve } from 'node:path';
import { SessionManager } from '../../host/session-manager';
import { TranscriptStore } from '../../host/transcript-store';
import type { HostToWebview } from '../../protocol/messages';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { AgentProvider } from '../../providers/types';

const roots: string[] = [];
const managers: SessionManager[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), 'hiiiid-claims-')));
  roots.push(dir);
  return dir;
}

/** Drains the fake provider's synchronous event queue. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) { await new Promise((r) => setImmediate(r)); }
}

async function managerWith(script: ConstructorParameters<typeof FakeProvider>[0]) {
  const storage = await tempDir();
  const store = new TranscriptStore(storage);
  const providers = new Map<string, AgentProvider>([['fake', new FakeProvider(script)]]);
  const emitted: HostToWebview[] = [];
  const manager = new SessionManager(store, providers, (m) => emitted.push(m));
  managers.push(manager);
  await manager.init();
  return { manager, store, emitted: () => emitted };
}

suite('AgentSession claimed paths', function () {
  this.timeout(30_000);

  teardown(async () => {
    while (managers.length > 0) { await managers.pop()!.dispose(); }
    while (roots.length > 0) {
      await fs.rm(roots.pop()!, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  test('a file edit is claimed, absolute, resolved against the session cwd', async () => {
    const { manager } = await managerWith(() => [
      { kind: 'tool-start', id: 't1', tool: { kind: 'file-edit', label: 'Edit', files: [{ path: 'src/a.ts', op: 'modify' }] } },
      { kind: 'tool-end', id: 't1', ok: true, output: { kind: 'none' } },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const cwd = await tempDir();
    const session = await manager.create('fake', cwd);
    session.send('edit it');
    await settle();

    assert.deepStrictEqual([...session.claimedPaths], [resolve(cwd, 'src/a.ts')]);
  });

  test("a subagent's edit is claimed by the parent session", async () => {
    const { manager } = await managerWith(() => [
      { kind: 'tool-start', id: 'p1', tool: { kind: 'subagent', label: 'Task', action: 'spawn' } },
      { kind: 'tool-start', id: 'c1', parentId: 'p1', tool: { kind: 'file-edit', label: 'Edit', files: [{ path: 'sub.ts', op: 'modify' }] } },
      { kind: 'tool-end', id: 'c1', ok: true, output: { kind: 'none' } },
      { kind: 'tool-end', id: 'p1', ok: true, output: { kind: 'none' } },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const cwd = await tempDir();
    const session = await manager.create('fake', cwd);
    session.send('delegate it');
    await settle();

    assert.strictEqual(session.claimedPaths.has(resolve(cwd, 'sub.ts')), true);
  });

  test('a failed edit is still a claim, because the file may still have moved', async () => {
    const { manager } = await managerWith(() => [
      { kind: 'tool-start', id: 't1', tool: { kind: 'file-edit', label: 'Edit', files: [{ path: 'x.ts', op: 'modify' }] } },
      { kind: 'tool-end', id: 't1', ok: false, output: { kind: 'text', text: 'boom' } },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const cwd = await tempDir();
    const session = await manager.create('fake', cwd);
    session.send('try it');
    await settle();

    assert.strictEqual(session.claimedPaths.has(resolve(cwd, 'x.ts')), true);
  });

  test('a command claims nothing', async () => {
    const { manager } = await managerWith(() => [
      { kind: 'tool-start', id: 't1', tool: { kind: 'command', label: 'Bash', command: 'ls' } },
      { kind: 'tool-end', id: 't1', ok: true, output: { kind: 'text', text: '' } },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const session = await manager.create('fake', await tempDir());
    session.send('list it');
    await settle();

    assert.strictEqual(session.claimedPaths.size, 0);
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `yarn test:unit --grep "AgentSession claimed paths"`
Expected: FAIL — `session.claimedPaths is undefined`.

- [x] **Step 3: Implement the recording in `src/host/agent-session.ts`**

Add the import at the top of the file:

```ts
import { claimedPaths } from './claim-paths';
```

Add the field and accessor beside the other private maps (`toolItems`, `childrenByParent`):

```ts
  /**
   * Every absolute path this session's tool calls have written, this launch.
   *
   * Not persisted, and deliberately: a claim describes a tree at an instant,
   * and a restored claim would describe an install nobody checked this
   * launch — the same reason a failed model probe never reaches
   * `catalog.json`. `SessionManager` rebuilds the pre-launch part from the
   * transcript on demand instead.
   */
  private readonly claims = new Set<string>();

  get claimedPaths(): ReadonlySet<string> {
    return this.claims;
  }
```

In the `tool-end` case, insert the recording call immediately after `this.reportShellNoise(settled);` (currently `agent-session.ts:561`) — **above** the `const parentRoot = this.childOf.get(event.id);` line:

```ts
        // Above the subagent branch below on purpose. `offerRelocation` skips
        // subagent tool-ends because a subagent's worktree has no claim on
        // where the parent conversation lives; attribution is the opposite
        // case — a subagent's edit changed *this* session's tree and is this
        // session's change on disk, so it must be recorded before that early
        // return.
        //
        // Recorded whether or not the call succeeded: a failed edit can still
        // have moved bytes, and a claim is "this session wrote here", not
        // "this session succeeded here". The diff decides what is actually
        // there; a claimed path with no diff is simply never listed.
        for (const path of claimedPaths(settled.tool, this._state.cwd)) {
          this.claims.add(path);
        }
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `yarn test:unit --grep "AgentSession claimed paths"`
Expected: PASS, 4 passing.

- [x] **Step 5: Run the full unit suite for regressions**

Run: `yarn test:unit`
Expected: PASS. The relocation suites in particular must stay green — the insertion sits directly above the branch they cover.

- [x] **Step 6: Verify and commit**

Run: `yarn lint && yarn check-types`

```bash
git add src/host/agent-session.ts src/test/unit/fleet-diff-manager.test.ts
git commit -m "feat: record the paths a session's tool calls write"
```

---

## Task 4: Assembling the fleet diff

**Files:**
- Modify: `src/host/session-manager.ts`
- Test: `src/test/unit/fleet-diff-manager.test.ts` (second suite)

**Interfaces:**
- Consumes: `treeChanges`, `FILE_CAP` (Task 1); `toRepoRelative` (Task 2); `AgentSession.claimedPaths` (Task 3); existing private `knownDirectories`, `occupantOf`, `samePath`, `treeStatus`
- Produces:
  - `SessionManager.fleetDiff(): Promise<TreeDiff[]>`
  - `SessionManager.requestFleetDiff(): Promise<void>` (emits `{ t: 'fleet-diff', trees }`)

- [x] **Step 1: Write the failing tests**

Append to `src/test/unit/fleet-diff-manager.test.ts`. Add these imports at the top of the file:

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
```

And this helper beside `managerWith`:

```ts
async function initRepo(dir: string): Promise<void> {
  await run('git', ['init', '-b', 'main', dir], { windowsHide: true });
  await run('git', ['config', 'user.email', 'test@example.invalid'], { cwd: dir, windowsHide: true });
  await run('git', ['config', 'user.name', 'Test'], { cwd: dir, windowsHide: true });
  await run('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir, windowsHide: true });
  await fs.writeFile(join(dir, 'README.md'), 'seed\n');
  await run('git', ['add', 'README.md'], { cwd: dir, windowsHide: true });
  await run('git', ['commit', '-m', 'seed'], { cwd: dir, windowsHide: true });
}

/** A provider script that claims `path` and then ends the turn. */
function claims(path: string) {
  return () => [
    { kind: 'tool-start' as const, id: 't1', tool: { kind: 'file-edit' as const, label: 'Edit', files: [{ path, op: 'modify' as const }] } },
    { kind: 'tool-end' as const, id: 't1', ok: true, output: { kind: 'none' as const } },
    { kind: 'turn-end' as const, reason: 'done' as const },
  ];
}
```

```ts
suite('SessionManager.fleetDiff', function () {
  this.timeout(60_000);

  teardown(async () => {
    while (managers.length > 0) { await managers.pop()!.dispose(); }
    while (roots.length > 0) {
      await fs.rm(roots.pop()!, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  test('a changed file is listed and attributed to the session that wrote it', async () => {
    const repo = await tempDir();
    await initRepo(repo);
    const { manager } = await managerWith(claims('feature.ts'));
    const session = await manager.create('fake', repo);
    session.send('write it');
    await settle();
    await fs.writeFile(join(repo, 'feature.ts'), 'hello\n');

    const trees = await manager.fleetDiff();
    assert.strictEqual(trees.length, 1);
    const row = trees[0].files.find((f) => f.path === 'feature.ts');
    assert.deepStrictEqual(row?.claimedBy, [session.state.id]);
  });

  test('a change nobody claimed is listed with an empty claim set', async () => {
    const repo = await tempDir();
    await initRepo(repo);
    const { manager } = await managerWith(() => [{ kind: 'turn-end', reason: 'done' }]);
    await manager.create('fake', repo);
    await settle();
    // Made by a shell command, a build, or the user — no tool call behind it.
    await fs.writeFile(join(repo, 'by-hand.ts'), 'x\n');

    const trees = await manager.fleetDiff();
    const row = trees[0].files.find((f) => f.path === 'by-hand.ts');
    assert.deepStrictEqual(row?.claimedBy, []);
  });

  test('two sessions in one tree produce one row naming both', async () => {
    const repo = await tempDir();
    await initRepo(repo);
    const { manager } = await managerWith(claims('shared.ts'));
    const a = await manager.create('fake', repo);
    a.send('go');
    await settle();
    const b = await manager.create('fake', repo);
    b.send('go');
    await settle();
    await fs.writeFile(join(repo, 'shared.ts'), 'x\n');

    const trees = await manager.fleetDiff();
    assert.strictEqual(trees.length, 1);
    assert.strictEqual(trees[0].sessions.length, 2);
    const row = trees[0].files.find((f) => f.path === 'shared.ts');
    assert.strictEqual(row?.claimedBy.length, 2);
  });

  test('a claim for a path outside the tree is dropped', async () => {
    const repo = await tempDir();
    await initRepo(repo);
    const elsewhere = await tempDir();
    const { manager } = await managerWith(claims(join(elsewhere, 'stray.ts').split('\\').join('/')));
    const session = await manager.create('fake', repo);
    session.send('go');
    await settle();
    await fs.writeFile(join(repo, 'real.ts'), 'x\n');

    const trees = await manager.fleetDiff();
    const row = trees[0].files.find((f) => f.path === 'real.ts');
    assert.deepStrictEqual(row?.claimedBy, []);
  });

  test('a session in a plain directory is not a tree at all', async () => {
    const plain = await tempDir();
    const { manager } = await managerWith(() => [{ kind: 'turn-end', reason: 'done' }]);
    await manager.create('fake', plain);

    assert.deepStrictEqual(await manager.fleetDiff(), []);
  });

  test('claims survive a session being closed and reopened, via the transcript', async () => {
    const repo = await tempDir();
    await initRepo(repo);
    const { manager } = await managerWith(claims('restored.ts'));
    const session = await manager.create('fake', repo);
    const id = session.state.id;
    session.send('go');
    await settle();
    await manager.close(id);
    await fs.writeFile(join(repo, 'restored.ts'), 'x\n');

    const trees = await manager.fleetDiff();
    const row = trees[0].files.find((f) => f.path === 'restored.ts');
    assert.deepStrictEqual(row?.claimedBy, [id]);
  });

  test('requestFleetDiff emits the trees on the wire', async () => {
    const repo = await tempDir();
    await initRepo(repo);
    const { manager, emitted } = await managerWith(() => [{ kind: 'turn-end', reason: 'done' }]);
    await manager.create('fake', repo);
    await manager.requestFleetDiff();

    const msg = emitted().filter((m) => m.t === 'fleet-diff').pop();
    assert.strictEqual(msg?.t, 'fleet-diff');
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `yarn test:unit --grep "SessionManager.fleetDiff"`
Expected: FAIL — `manager.fleetDiff is not a function`.

- [x] **Step 3: Implement in `src/host/session-manager.ts`**

Add imports:

```ts
import { treeChanges } from './fleet-diff';
import { claimedPaths, toRepoRelative } from './claim-paths';
import type { SessionId, TreeDiff } from '../protocol/messages';
```

`claimedPaths` is used by `claimsOf`'s backfill below; `toRepoRelative` by `fleetDiff`. If `SessionId` is already imported in this file, extend that line rather than adding a second one.

Add the claim cache field beside `live` / `meta` / `visible`:

```ts
  /**
   * Claims rebuilt from a session's transcript, once per session per launch.
   *
   * A live `AgentSession` only knows what it wrote since it was constructed —
   * a session restored from `index.json`, or one rebuilt by `moveTo`, starts
   * empty. This is the pre-launch half, read from the JSONL the first time
   * anything asks. Cached in memory and never persisted: see
   * `AgentSession.claims` for why a stored claim would be a lie.
   */
  private readonly backfilled = new Map<SessionId, Set<string>>();
```

Add the methods beside `staleTrees` / `requestStaleTrees`:

```ts
  /**
   * Every absolute path `id` is known to have written — the live session's
   * own record unioned with what its transcript remembers from before this
   * launch.
   */
  private async claimsOf(id: SessionId): Promise<Set<string>> {
    let prior = this.backfilled.get(id);
    if (!prior) {
      prior = new Set<string>();
      const state = this.meta.get(id);
      if (state) {
        // A limit past any real transcript: `tail` slices from
        // `max(0, len - limit)`, so this reads the whole file.
        const { items } = await this.store.tail(id, Number.MAX_SAFE_INTEGER);
        for (const item of items) {
          if (item.role !== 'tool') { continue; }
          for (const path of claimedPaths(item.tool, state.cwd)) { prior.add(path); }
          for (const child of item.children ?? []) {
            if (child.role !== 'tool') { continue; }
            for (const path of claimedPaths(child.tool, state.cwd)) { prior.add(path); }
          }
        }
      }
      this.backfilled.set(id, prior);
    }
    const live = this.live.get(id)?.claimedPaths;
    return live ? new Set([...prior, ...live]) : prior;
  }

  /**
   * What the fleet has changed, one row per working tree.
   *
   * A tree is the unit git can answer for; a session is the unit the user
   * thinks in. Both travel: the tree carries its occupants, each file carries
   * the sessions claiming it, and the webview derives the session grouping.
   * Sending it pre-grouped would duplicate any file two sessions claim, and
   * make the shared-file case unrepresentable without a second, contradicting
   * copy of its diff.
   *
   * Non-repositories are dropped rather than listed with a reason: a session
   * running in a plain directory has nothing to review, and a permanent row
   * saying so is noise. A directory that *is* a repository but cannot be read
   * stays, carrying why — that one is a fault worth surfacing.
   */
  async fleetDiff(): Promise<TreeDiff[]> {
    const rows: TreeDiff[] = [];

    for (const dir of this.knownDirectories()) {
      const status = await treeStatus(dir);
      if (!status.isRepo) { continue; }
      // Two remembered paths can resolve to one tree. One tree, one row.
      if (rows.some((row) => samePath(row.root, status.root))) { continue; }

      const occupants = this.sessionsIn(status.root);
      // A tree nobody sits in is somebody's abandoned worktree; the
      // stale-tree sweep is where that is dealt with, not here.
      if (occupants.length === 0) { continue; }

      const changes = await treeChanges(status.root);
      if ('reason' in changes) {
        rows.push({
          root: status.root, branch: status.branch, sessions: occupants,
          base: { kind: 'head' }, files: [], omitted: 0, reason: changes.reason,
        });
        continue;
      }

      const claimsBySession = new Map<SessionId, Set<string>>();
      for (const id of occupants) {
        const absolute = await this.claimsOf(id);
        const relative = new Set<string>();
        for (const path of absolute) {
          const rel = toRepoRelative(path, status.root);
          if (rel !== undefined) { relative.add(rel); }
        }
        claimsBySession.set(id, relative);
      }

      rows.push({
        root: status.root,
        branch: status.branch,
        sessions: occupants,
        base: changes.base,
        omitted: changes.omitted,
        files: changes.files.map((file) => ({
          ...file,
          // A rename's old path is claimed too: the session that moved a file
          // wrote both sides of it, and matching only the new path would
          // orphan every rename an agent made.
          claimedBy: occupants.filter((id) => {
            const claimed = claimsBySession.get(id);
            return claimed !== undefined
              && (claimed.has(file.path) || (file.from !== undefined && claimed.has(file.from)));
          }),
        })),
      });
    }

    return rows.sort((a, b) => a.root.localeCompare(b.root));
  }

  /**
   * Every non-archived session sitting in `root`, roster order.
   *
   * `occupantOf` answers with one session because a bring-back moves exactly
   * one; this answers with all of them, because a shared root is precisely
   * the case this surface exists to disambiguate.
   */
  private sessionsIn(root: string): SessionId[] {
    const ids: SessionId[] = [];
    for (const state of this.meta.values()) {
      if (state.archived) { continue; }
      if (samePath(resolve(state.cwd), root)) { ids.push(state.id); }
    }
    return ids;
  }

  /** Read-only, like `requestStaleTrees`: safe to ask whenever the panel wants. */
  async requestFleetDiff(): Promise<void> {
    const trees = await this.fleetDiff();
    if (this.disposed) { return; }
    this.emit({ t: 'fleet-diff', trees });
  }
```

- [x] **Step 4: Add the host-to-webview message arm**

In `src/protocol/messages.ts`, add to the `HostToWebview` union:

```ts
  /**
   * The answer to `request-fleet-diff`. A complete replacement, never a
   * delta: it describes disk at an instant, and a merged delta would let a
   * stale row outlive the change it described.
   */
  | { t: 'fleet-diff'; trees: TreeDiff[] }
```

- [x] **Step 5: Run the tests to verify they pass**

Run: `yarn test:unit --grep "SessionManager.fleetDiff"`
Expected: PASS, 7 passing.

- [x] **Step 6: Verify and commit**

Run: `yarn lint && yarn check-types && yarn test:unit`

```bash
git add src/host/session-manager.ts src/protocol/messages.ts src/test/unit/fleet-diff-manager.test.ts
git commit -m "feat: assemble the fleet diff from git content and transcript claims"
```

---

## Task 5: Wiring — router arms and the diff editor

**Files:**
- Modify: `src/protocol/messages.ts` (two `WebviewToHost` arms)
- Modify: `src/host/message-router.ts`
- Create: `src/host/diff-content-provider.ts`
- Modify: `src/extension.ts`
- Test: `src/test/unit/fleet-diff-router.test.ts`

**Interfaces:**
- Consumes: `SessionManager.requestFleetDiff` (Task 4)
- Produces: `EditorContextHost.openDiff(root: string, path: string, base: DiffBase): void`; `registerDiffContentProvider(): vscode.Disposable`; `DIFF_SCHEME = 'hiiiid-diff'`; `diffUri(root, path, sha)`

- [x] **Step 1: Add the webview-to-host arms**

In `src/protocol/messages.ts`, add to `WebviewToHost`:

```ts
  /**
   * "What has the fleet changed?" Read-only and deliberately not
   * session-addressed: a working tree is the unit git can answer for, and
   * two sessions sharing one tree share one answer.
   */
  | { t: 'request-fleet-diff' }

  /**
   * Open one file's change in VS Code's own diff editor. Carries the tree
   * because a repo-relative path is meaningless without it, and the base
   * because the left-hand side is that file at the branch point.
   */
  | { t: 'open-file-diff'; root: string; path: string; base: DiffBase }
```

- [x] **Step 2: Write the failing router test**

Create `src/test/unit/fleet-diff-router.test.ts`:

```ts
// The two fleet-diff arms. The router imports no `vscode`, which is what
// lets this run outside the extension host at all.

import * as assert from 'assert';
import { MessageRouter, type EditorContextHost } from '../../host/message-router';
import type { DiffBase, HostToWebview } from '../../protocol/messages';

function routerWith() {
  const calls: string[] = [];
  const opened: { root: string; path: string }[] = [];
  const manager = {
    requestFleetDiff: async () => { calls.push('requestFleetDiff'); },
  } as unknown as ConstructorParameters<typeof MessageRouter>[0];
  const editor: EditorContextHost = {
    current: () => null,
    reveal: () => {},
    openDiff: (root, path) => { opened.push({ root, path }); },
  };
  const emitted: HostToWebview[] = [];
  const router = new MessageRouter(manager, (m) => emitted.push(m), '/tmp', editor);
  return { router, calls, opened, emitted };
}

const BASE: DiffBase = { kind: 'merge-base', ref: 'origin/main', sha: 'abc123' };

suite('fleet-diff routing', () => {
  test('request-fleet-diff reaches the manager', async () => {
    const { router, calls } = routerWith();
    await router.handle({ t: 'request-fleet-diff' });
    assert.deepStrictEqual(calls, ['requestFleetDiff']);
  });

  test('open-file-diff reaches the editor host', async () => {
    const { router, opened } = routerWith();
    await router.handle({ t: 'open-file-diff', root: '/repo', path: 'src/a.ts', base: BASE });
    assert.deepStrictEqual(opened, [{ root: '/repo', path: 'src/a.ts' }]);
  });

  test('an unknown tag is still dropped as malformed', async () => {
    const { router, calls, opened } = routerWith();
    await router.handle({ t: 'not-a-real-message' } as never);
    assert.strictEqual(calls.length + opened.length, 0);
  });
});
```

- [x] **Step 3: Run the test to verify it fails**

Run: `yarn test:unit --grep "fleet-diff routing"`
Expected: FAIL — `openDiff` is not on `EditorContextHost`.

- [x] **Step 4: Implement the router changes**

In `src/host/message-router.ts`, extend the seam:

```ts
export interface EditorContextHost {
  current(): EditorContext | null;
  reveal(path: string, startLine?: number): void;
  /**
   * Opens `path` in VS Code's diff editor, against its content at `base`.
   * Here rather than in the router because it needs the `vscode` API, which
   * this module must not import; `src/extension.ts` supplies the real one.
   */
  openDiff(root: string, path: string, base: DiffBase): void;
}

const NO_EDITOR: EditorContextHost = {
  current: () => null, reveal: () => {}, openDiff: () => {},
};
```

Add `DiffBase` to the type import from `../protocol/messages`.

Add the two cases beside `request-stale-trees`:

```ts
      // Awaited for the same reason as the sweep — it shells out to git — and
      // unaddressed for the same reason too: a working tree is the unit git
      // can answer for, and two sessions in one tree share one answer.
      case 'request-fleet-diff':
        await this.manager.requestFleetDiff();
        return;

      case 'open-file-diff':
        this.editor.openDiff(msg.root, msg.path, msg.base);
        return;
```

Add both tags to `KNOWN_MESSAGE_TAGS`:

```ts
  'request-fleet-diff', 'open-file-diff',
```

- [x] **Step 5: Run the router test to verify it passes**

Run: `yarn test:unit --grep "fleet-diff routing"`
Expected: PASS, 3 passing.

- [x] **Step 6: Implement the content provider**

Create `src/host/diff-content-provider.ts`:

```ts
// The left-hand side of every fleet diff.
//
// `vscode.diff` wants two URIs. The right-hand side is the file on disk; the
// left is that file at the branch point, which exists nowhere on disk. This
// provider supplies it from `git show`.
//
// Deliberately not delegating to the built-in git extension's `git:` scheme
// or its `git.openChange` command: both are another extension's internal
// surface, unversioned for our use, and a diff link that broke on a machine
// where they changed would be untraceable from here.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';

const execFileAsync = promisify(execFile);

export const DIFF_SCHEME = 'hiiiid-diff';

/**
 * `root` rides in the authority-free `query`, not the path: a Windows tree
 * root is `e:\repo`, and putting a drive letter in a URI path produces a URI
 * that round-trips to something else.
 */
export function diffUri(root: string, path: string, sha: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: DIFF_SCHEME,
    path: `/${path}`,
    query: JSON.stringify({ root, sha }),
  });
}

export function registerDiffContentProvider(): vscode.Disposable {
  return vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, {
    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
      let root: string;
      let sha: string;
      try {
        ({ root, sha } = JSON.parse(uri.query) as { root: string; sha: string });
      } catch {
        return '';
      }
      // An untracked or newly created file has no content at the base, and
      // an empty left-hand side is exactly right: the diff reads as all-added.
      if (sha === '') { return ''; }

      const path = uri.path.replace(/^\//, '');
      try {
        const { stdout } = await execFileAsync(
          'git', ['-c', 'core.quotepath=false', 'show', `${sha}:${path}`],
          { cwd: root, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
        );
        return stdout;
      } catch {
        // The file did not exist at the base — a create. Same answer, and
        // not an error worth a dialog: errors are state here too.
        return '';
      }
    },
  });
}
```

- [x] **Step 7: Wire it in `src/extension.ts`**

Add the imports:

```ts
import { DIFF_SCHEME, diffUri, registerDiffContentProvider } from './host/diff-content-provider';
import type { DiffBase } from './protocol/messages';
```

Add `openDiff` to the `editorHost` literal (currently `extension.ts:126-131`):

```ts
  const editorHost = {
    current: () => tracker.current,
    reveal: (target: string, startLine?: number) => {
      void revealFile(target, startLine);
    },
    openDiff: (root: string, target: string, base: DiffBase) => {
      void openFileDiff(root, target, base);
    },
  };
```

Register the provider in the `context.subscriptions.push(...)` call:

```ts
    registerDiffContentProvider(),
```

Add the function beside `revealFile`:

```ts
/**
 * Opens one file's change in VS Code's own diff editor.
 *
 * The panel lists; VS Code renders. A side-by-side, syntax-highlit,
 * navigable diff already exists in this window, and reimplementing a worse
 * one inside a 300px sidebar would be the wrong half of the job.
 */
async function openFileDiff(root: string, target: string, base: DiffBase): Promise<void> {
  try {
    const right = vscode.Uri.file(path.join(root, target));
    const left = diffUri(root, target, base.kind === 'merge-base' ? base.sha : 'HEAD');
    const label = base.kind === 'merge-base' ? base.ref : 'HEAD';
    await vscode.commands.executeCommand(
      'vscode.diff', left, right, `${target} (${label} → working tree)`,
    );
  } catch (err) {
    // A row can outlive the file it names — reverted, deleted, or swept with
    // its worktree. Failing to open one is not worth a user-facing error, the
    // same call this file already makes for a dead transcript chip.
    console.error('[hiiiid-code] could not open diff for', target, err);
  }
}
```

`DIFF_SCHEME` is imported for the `localResourceRoots`-adjacent review in Step 8; if lint flags it as unused, drop it from the import.

- [x] **Step 8: Verify the whole host side compiles and passes**

Run: `yarn lint && yarn check-types && yarn run compile && yarn test:unit`
Expected: all clean.

- [x] **Step 9: Commit**

```bash
git add src/protocol/messages.ts src/host/message-router.ts src/host/diff-content-provider.ts src/extension.ts src/test/unit/fleet-diff-router.test.ts
git commit -m "feat: route fleet diff requests and open changes in the diff editor"
```

---

## Task 6: Client state and the width threshold

**Files:**
- Modify: `src/webview/reducer.ts`
- Modify: `src/webview/components/use-is-narrow.ts`
- Modify: `src/webview/app.tsx`
- Modify: `src/webview/components/pane-group.tsx`, `src/webview/components/session-picker.tsx` (prop rename only)
- Test: `src/test/unit/fleet-diff-reducer.test.ts`

**Interfaces:**
- Consumes: `TreeDiff` (Task 1); `fleet-diff` message (Task 4)
- Produces:
  - `ClientState.fleetDiff: TreeDiff[] | undefined`
  - `ClientState.fleetDiffDirty: number`
  - `usePanelWidth(ref): number`, `NARROW_PX = 500`, `REVIEW_PX = 700`

- [x] **Step 1: Write the failing reducer tests**

Create `src/test/unit/fleet-diff-reducer.test.ts`:

```ts
// The client's fleet-diff slices. `fleetDiffDirty` is the whole freshness
// mechanism: the reducer counts the events that could have changed a diff,
// and the surface debounces a re-request off the count.

import * as assert from 'assert';
import { initialState, reduce } from '../../webview/reducer';
import type { TreeDiff } from '../../protocol/messages';

const TREE: TreeDiff = {
  root: '/repo', branch: 'main', sessions: ['s1'],
  base: { kind: 'merge-base', ref: 'origin/main', sha: 'abc' },
  files: [{ path: 'a.ts', op: 'modify', insertions: 1, deletions: 0, claimedBy: ['s1'] }],
  omitted: 0,
};

suite('fleet diff reducer', () => {
  test('undefined until something answers', () => {
    assert.strictEqual(initialState.fleetDiff, undefined);
  });

  test('an answer replaces wholesale', () => {
    const once = reduce(initialState, { t: 'fleet-diff', trees: [TREE] });
    const twice = reduce(once, { t: 'fleet-diff', trees: [] });
    assert.deepStrictEqual(twice.fleetDiff, []);
  });

  test('an empty answer is not the same as no answer', () => {
    const state = reduce(initialState, { t: 'fleet-diff', trees: [] });
    assert.strictEqual(state.fleetDiff === undefined, false);
    assert.strictEqual(state.fleetDiff?.length, 0);
  });

  test('a settled file-edit tool marks the diff dirty', () => {
    const state = reduce(initialState, {
      t: 'session-patch', id: 's1',
      patch: {
        op: 'replace',
        item: {
          id: 'i1', ts: 0, role: 'tool', state: 'ok',
          tool: { kind: 'file-edit', label: 'Edit', files: [{ path: 'a.ts', op: 'modify' }] },
        },
      },
    });
    assert.strictEqual(state.fleetDiffDirty, 1);
  });

  test('a command tool does not mark it dirty', () => {
    const state = reduce(initialState, {
      t: 'session-patch', id: 's1',
      patch: {
        op: 'replace',
        item: {
          id: 'i1', ts: 0, role: 'tool', state: 'ok',
          tool: { kind: 'command', label: 'Bash', command: 'ls' },
        },
      },
    });
    assert.strictEqual(state.fleetDiffDirty, 0);
  });

  test('a session going idle marks it dirty, even with no pane', () => {
    const state = reduce(initialState, { t: 'session-status', id: 's1', status: 'idle' });
    assert.strictEqual(state.fleetDiffDirty, 1);
  });

  test('a session going busy does not', () => {
    const state = reduce(initialState, { t: 'session-status', id: 's1', status: 'running' });
    assert.strictEqual(state.fleetDiffDirty, 0);
  });

  test('hydrate clears the answer and the counter', () => {
    const dirty = reduce(
      reduce(initialState, { t: 'fleet-diff', trees: [TREE] }),
      { t: 'session-status', id: 's1', status: 'idle' },
    );
    const fresh = reduce(dirty, {
      t: 'hydrate', sessions: [], layout: { orientation: 'vertical', panes: [] },
      snapshots: [], catalog: [], unavailable: [], usage: {},
    });
    assert.strictEqual(fresh.fleetDiff, undefined);
    assert.strictEqual(fresh.fleetDiffDirty, 0);
  });
});
```

If `session-status`'s `status` literal `'running'` is not the busy status in this codebase, use whichever non-`idle` status `SessionStatus` declares — check `src/protocol/messages.ts` and adjust the string, not the assertion.

- [x] **Step 2: Run the tests to verify they fail**

Run: `yarn test:unit --grep "fleet diff reducer"`
Expected: FAIL — `fleetDiff` is not on `ClientState`.

- [x] **Step 3: Add the state slices**

In `src/webview/reducer.ts`, add to `ClientState`:

```ts
  /**
   * The host's last fleet answer. `undefined` means nobody has asked — which
   * is not the same as `[]`, "asked, and nothing has changed". The two render
   * differently, and collapsing them would make an idle fleet look like a
   * broken one.
   */
  fleetDiff: TreeDiff[] | undefined;
  /**
   * Bumped whenever something happened that could have changed a diff: a
   * settled `file-edit` tool call, or a session going idle.
   *
   * The counter, rather than a boolean, so the surface's debounce can key an
   * effect on it and coalesce a burst of edits into one request. Deliberately
   * client-side: `session-status` is ungated (it fans out for every session,
   * visible or not) and `session-patch` already carries settled tool items
   * for the visible ones, so the host needs no new plumbing to make this live.
   */
  fleetDiffDirty: number;
```

Add to `initialState`:

```ts
  fleetDiff: undefined,
  fleetDiffDirty: 0,
```

Add `TreeDiff` to the type import list at the top of the file.

- [x] **Step 4: Add the reducer cases**

Add a `fleet-diff` case beside `stale-trees`:

```ts
    case 'fleet-diff':
      // Wholesale, never merged, for the same reason the sweep is: it
      // describes disk at an instant, and a merged delta would let a stale
      // row outlive the change it described.
      return { ...state, fleetDiff: msg.trees };
```

In the `hydrate` return literal, beside the cleared `staleTrees`:

```ts
        // Cleared with the sweep and for the same reason — and the counter
        // with it, so a reload does not immediately re-request off a count
        // that describes a webview that no longer exists.
        fleetDiff: undefined, fleetDiffDirty: 0,
```

In the `session-status` case, replace the two `return` statements so both carry the bump:

```ts
    case 'session-status': {
      const sessions = state.sessions.map((s) =>
        s.id === msg.id ? { ...s, status: msg.status } : s);
      // Idle is when a turn's writes have landed. Ungated, so this is the one
      // signal that reaches the client for a session with no pane on screen.
      const fleetDiffDirty = msg.status === 'idle'
        ? state.fleetDiffDirty + 1
        : state.fleetDiffDirty;
      const pane = state.byId[msg.id];
      if (!pane) { return { ...state, sessions, fleetDiffDirty }; }
      return {
        ...state,
        sessions,
        fleetDiffDirty,
        byId: {
          ...state.byId,
          [msg.id]: { ...pane, summary: { ...pane.summary, status: msg.status } },
        },
      };
    }
```

In the `session-patch` case, bump on a settled file edit. Note the guard order — the existing early return for a missing pane must still happen, but the bump must not depend on it:

```ts
    case 'session-patch': {
      // Counted before the pane guard: a file edit changed the tree whether
      // or not this client is rendering that session's transcript.
      const edited = msg.patch.op === 'replace'
        && msg.patch.item.role === 'tool'
        && msg.patch.item.state !== 'running'
        && msg.patch.item.tool.kind === 'file-edit';
      const fleetDiffDirty = edited ? state.fleetDiffDirty + 1 : state.fleetDiffDirty;

      const pane = state.byId[msg.id];
      if (!pane) { return edited ? { ...state, fleetDiffDirty } : state; }
      return {
        ...state,
        fleetDiffDirty,
        byId: { ...state.byId, [msg.id]: applyPatch(pane, msg.patch) },
      };
    }
```

Check the running-state literal against `TranscriptItem`'s tool `state` union in `src/protocol/messages.ts` and use whatever it actually spells; the intent is "not still in flight".

- [x] **Step 5: Run the reducer tests to verify they pass**

Run: `yarn test:unit --grep "fleet diff reducer"`
Expected: PASS, 8 passing.

- [x] **Step 6: Widen the width hook**

Rewrite `src/webview/components/use-is-narrow.ts`:

```ts
import { useEffect, useState } from 'react';

/**
 * Below this width the split can only stack — `PaneGroup` forces vertical
 * orientation and `SessionPicker` disables the orientation toggle.
 */
export const NARROW_PX = 500;

/**
 * Below this width the fleet diff surface is not offered at all.
 *
 * A file list with churn counts and session chips needs room to be scannable;
 * in a 300px column it is a wall of truncated paths, which is the failure
 * this threshold exists to prevent rather than to style around.
 */
export const REVIEW_PX = 700;

/**
 * The measured width of the element behind `ref`.
 *
 * There is exactly one call site — `App`, against the panel root — and every
 * threshold is derived from the number it returns. Each consumer used to run
 * its own `ResizeObserver` against its own root element; because
 * `contentRect` is a content-box measurement and those roots carry different
 * padding, they could disagree by 16-32px near a threshold — one reporting
 * narrow while the other did not, for the same actual panel width. One
 * observer on one element makes that disagreement structurally impossible
 * rather than merely unlikely, and that property is why a second threshold
 * is derived here instead of getting a second hook.
 *
 * `0` before the first measurement, which reads as "not narrow, not wide
 * enough to review" — the conservative pair for a width nobody has measured.
 */
export function usePanelWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) { return; }
    const observer = new ResizeObserver(([entry]) => {
      setWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);

  return width;
}
```

`useIsNarrow` is deleted. `0 < NARROW_PX` is true, so an unmeasured panel reads as narrow — which is what `useIsNarrow` returning `false` initially did *not* do. Verify the DOM suite: if any existing test depends on the pre-measurement state being non-narrow, keep the old semantics by deriving `narrow` as `width > 0 && width < NARROW_PX` in `App` and note why in a comment.

- [x] **Step 7: Update `App`**

In `src/webview/app.tsx`, replace the hook call:

```ts
import { NARROW_PX, REVIEW_PX, usePanelWidth } from './components/use-is-narrow';
```

```ts
  const width = usePanelWidth(rootRef);
  const narrow = width > 0 && width < NARROW_PX;
  const canReview = width >= REVIEW_PX;
```

- [x] **Step 8: Verify no regressions**

Run: `yarn test:unit && yarn test:dom && yarn lint && yarn check-types`
Expected: all pass. `SessionPicker` and `PaneGroup` keep their `narrow: boolean` prop — nothing about their signatures changed.

- [x] **Step 9: Commit**

```bash
git add src/webview/reducer.ts src/webview/components/use-is-narrow.ts src/webview/app.tsx src/test/unit/fleet-diff-reducer.test.ts
git commit -m "feat: hold the fleet diff in client state and measure the panel once"
```

---

## Task 7: Grouping the flat payload

**Files:**
- Create: `src/webview/components/fleet-diff-groups.ts`
- Test: `src/test/unit/fleet-diff-groups.test.ts`

**Interfaces:**
- Consumes: `TreeDiff`, `FileChange`, `SessionId` (Task 1)
- Produces: `groupTree(tree: TreeDiff): SessionGroup[]`, `type SessionGroup = { sessionId: SessionId | null; files: FileChange[]; insertions: number; deletions: number }`

Pure, no React and no `@/` aliases, so it can be required from the mocha harness — the same rule `pane-layout.ts` states in its header.

- [x] **Step 1: Write the failing tests**

Create `src/test/unit/fleet-diff-groups.test.ts`:

```ts
// Turning the flat wire payload into the tree → session → files shape the
// user reads. Pure: no React, no DOM, no store.

import * as assert from 'assert';
import { groupTree } from '../../webview/components/fleet-diff-groups';
import type { FileChange, TreeDiff } from '../../protocol/messages';

function file(path: string, claimedBy: string[], ins = 1, del = 0): FileChange {
  return { path, op: 'modify', insertions: ins, deletions: del, claimedBy };
}

function tree(files: FileChange[], sessions = ['s1', 's2']): TreeDiff {
  return {
    root: '/repo', branch: 'main', sessions,
    base: { kind: 'merge-base', ref: 'origin/main', sha: 'abc' },
    files, omitted: 0,
  };
}

suite('fleet diff grouping', () => {
  test('a file lands under the session that claimed it', () => {
    const groups = groupTree(tree([file('a.ts', ['s1'])]));
    assert.strictEqual(groups.length, 1);
    assert.strictEqual(groups[0].sessionId, 's1');
    assert.strictEqual(groups[0].files.length, 1);
  });

  test('an unclaimed file lands in the unattributed group, which sorts last', () => {
    const groups = groupTree(tree([file('none.ts', []), file('a.ts', ['s1'])]));
    assert.strictEqual(groups[groups.length - 1].sessionId, null);
  });

  test('a file two sessions claim appears under both', () => {
    const groups = groupTree(tree([file('shared.ts', ['s1', 's2'])]));
    assert.strictEqual(groups.length, 2);
    assert.strictEqual(groups.every((g) => g.files.length === 1), true);
  });

  test('churn totals per group', () => {
    const groups = groupTree(tree([file('a.ts', ['s1'], 3, 2), file('b.ts', ['s1'], 4, 1)]));
    assert.strictEqual(groups[0].insertions, 7);
    assert.strictEqual(groups[0].deletions, 3);
  });

  test('a binary file contributes no churn but still lists', () => {
    const binary: FileChange = { path: 'logo.png', op: 'modify', claimedBy: ['s1'] };
    const groups = groupTree(tree([binary]));
    assert.strictEqual(groups[0].files.length, 1);
    assert.strictEqual(groups[0].insertions, 0);
  });

  test('a session that claimed nothing gets no empty group', () => {
    const groups = groupTree(tree([file('a.ts', ['s1'])], ['s1', 's2']));
    assert.strictEqual(groups.some((g) => g.sessionId === 's2'), false);
  });

  test('groups follow roster order, not file order', () => {
    const groups = groupTree(tree([file('b.ts', ['s2']), file('a.ts', ['s1'])], ['s1', 's2']));
    assert.deepStrictEqual(groups.map((g) => g.sessionId), ['s1', 's2']);
  });

  test('an empty tree groups to nothing', () => {
    assert.deepStrictEqual(groupTree(tree([])), []);
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `yarn test:unit --grep "fleet diff grouping"`
Expected: FAIL — module not found.

- [x] **Step 3: Implement `src/webview/components/fleet-diff-groups.ts`**

```ts
// The flat wire payload, grouped the way it is read.
//
// The host sends a tree carrying files, and each file carrying the sessions
// that claimed it. That shape is deliberate: pre-grouping on the wire would
// duplicate every file two sessions claim, and make the shared-file case
// unrepresentable without a second, contradicting copy of its diff. The
// duplication belongs here, in the view, where it is a rendering choice
// rather than a fact about the data.
//
// No React and no `@/` aliases: this is required directly from the mocha
// harness, the same rule `pane-layout.ts` follows.

import type { FileChange, SessionId, TreeDiff } from '../../protocol/messages';

export interface SessionGroup {
  /** `null` is the unattributed group — see `groupTree`. */
  sessionId: SessionId | null;
  files: FileChange[];
  insertions: number;
  deletions: number;
}

function churn(files: FileChange[]): { insertions: number; deletions: number } {
  let insertions = 0;
  let deletions = 0;
  for (const file of files) {
    // A binary file reports no counts. Adding 0 would be a lie of the same
    // size, but a smaller one than treating `undefined` as arithmetic.
    insertions += file.insertions ?? 0;
    deletions += file.deletions ?? 0;
  }
  return { insertions, deletions };
}

/**
 * One group per session that claimed something, in roster order, then the
 * unattributed group.
 *
 * A session with no claims gets no group at all: an empty group would read as
 * "this session did nothing", when what happened is that everything it did is
 * already gone from the working tree, or it never touched this tree.
 *
 * Unattributed sorts last because it is the group that needs explaining, and
 * a header explaining it should not be the first thing between the user and
 * the changes they came to read.
 */
export function groupTree(tree: TreeDiff): SessionGroup[] {
  const groups: SessionGroup[] = [];

  for (const sessionId of tree.sessions) {
    const files = tree.files.filter((f) => f.claimedBy.includes(sessionId));
    if (files.length === 0) { continue; }
    groups.push({ sessionId, files, ...churn(files) });
  }

  const unclaimed = tree.files.filter((f) => f.claimedBy.length === 0);
  if (unclaimed.length > 0) {
    groups.push({ sessionId: null, files: unclaimed, ...churn(unclaimed) });
  }

  return groups;
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `yarn test:unit --grep "fleet diff grouping"`
Expected: PASS, 8 passing.

- [x] **Step 5: Commit**

Run: `yarn lint && yarn check-types`

```bash
git add src/webview/components/fleet-diff-groups.ts src/test/unit/fleet-diff-groups.test.ts
git commit -m "feat: group a tree's changes by the session that claimed them"
```

---

## Task 8: The surface

**Files:**
- Create: `src/webview/components/fleet-diff.tsx`
- Modify: `src/webview/app.tsx`
- Modify: `src/webview/components/session-picker.tsx`
- Test: `src/test/dom/fleet-diff.test.tsx`

**Interfaces:**
- Consumes: `groupTree`, `SessionGroup` (Task 7); `ClientState.fleetDiff` / `fleetDiffDirty`, `REVIEW_PX` (Task 6); `request-fleet-diff` / `open-file-diff` (Task 5)
- Produces: `FleetDiff` component (props: `{ onClose: () => void }`)

**Before writing any JSX**, invoke the `impeccable` skill and let it route — this is a new surface, so its `shape` flow applies. After the component exists, run the mechanical detector over every changed file under `src/webview/components/`:
`node <impeccable-skill-dir>/scripts/detect.mjs --json src/webview/components/fleet-diff.tsx src/webview/components/session-picker.tsx`
Exit 0 is clean; exit 2 is a failing check, not a suggestion.

- [x] **Step 1: Write the failing DOM tests**

Create `src/test/dom/fleet-diff.test.tsx`. Note the assertion rule — booleans, strings and counts only, never a node.

```tsx
// The fleet diff surface, driven the way the host drives it: real
// StoreProvider, genuine HostToWebview messages, assertions reading what the
// webview posted back.

import * as assert from 'assert';
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { posted, renderApp, resetHost, sendFromHost } from './harness';
import { resizeTo } from './setup';
import type { HostToWebview, TreeDiff } from '../../protocol/messages';

const TREE: TreeDiff = {
  root: '/repo', branch: 'feat-x', sessions: ['s1'],
  base: { kind: 'merge-base', ref: 'origin/main', sha: 'abc123' },
  files: [
    { path: 'src/a.ts', op: 'modify', insertions: 3, deletions: 1, claimedBy: ['s1'] },
    { path: 'src/orphan.ts', op: 'modify', insertions: 1, deletions: 0, claimedBy: [] },
  ],
  omitted: 0,
};

function hydrate(): HostToWebview {
  return {
    t: 'hydrate',
    sessions: [{
      id: 's1', title: 'Session one', providerId: 'fake', model: 'm',
      status: 'idle', cwd: '/repo', archived: false, updatedAt: 0,
    } as never],
    layout: { orientation: 'vertical', panes: [] },
    snapshots: [], catalog: [], unavailable: [], usage: {},
  };
}

async function openSurface(): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name: /review changes/i }));
}

suite('fleet diff surface', () => {
  teardown(() => { cleanup(); resetHost(); });

  test('the entry point is absent below the review threshold', () => {
    renderApp();
    sendFromHost(hydrate());
    resizeTo(400);
    assert.strictEqual(screen.queryAllByRole('button', { name: /review changes/i }).length, 0);
  });

  test('the entry point appears at the review threshold', () => {
    renderApp();
    sendFromHost(hydrate());
    resizeTo(900);
    assert.strictEqual(screen.queryAllByRole('button', { name: /review changes/i }).length, 1);
  });

  test('opening the surface asks the host for a diff', async () => {
    renderApp();
    sendFromHost(hydrate());
    resizeTo(900);
    await openSurface();
    assert.strictEqual(posted().some((m) => m.t === 'request-fleet-diff'), true);
  });

  test('a changed file is listed under the session that claimed it', async () => {
    renderApp();
    sendFromHost(hydrate());
    resizeTo(900);
    await openSurface();
    sendFromHost({ t: 'fleet-diff', trees: [TREE] });

    assert.strictEqual(screen.getAllByText(/a\.ts/).length >= 1, true);
    assert.strictEqual(screen.getAllByText('Session one').length >= 1, true);
  });

  test('an unclaimed change is listed as unattributed', async () => {
    renderApp();
    sendFromHost(hydrate());
    resizeTo(900);
    await openSurface();
    sendFromHost({ t: 'fleet-diff', trees: [TREE] });

    assert.strictEqual(screen.getAllByText(/not attributed/i).length >= 1, true);
  });

  test('clicking a file asks the host to open its diff', async () => {
    renderApp();
    sendFromHost(hydrate());
    resizeTo(900);
    await openSurface();
    sendFromHost({ t: 'fleet-diff', trees: [TREE] });
    resetHost();

    await userEvent.click(screen.getByRole('button', { name: /src\/a\.ts/ }));
    const msg = posted().find((m) => m.t === 'open-file-diff');
    assert.strictEqual(msg?.t, 'open-file-diff');
    assert.strictEqual(msg?.t === 'open-file-diff' ? msg.path : '', 'src/a.ts');
  });

  test('the base is named, so a head-only diff cannot pass for a full one', async () => {
    renderApp();
    sendFromHost(hydrate());
    resizeTo(900);
    await openSurface();
    sendFromHost({ t: 'fleet-diff', trees: [TREE] });

    assert.strictEqual(screen.getAllByText(/origin\/main/).length >= 1, true);
  });

  test('shrinking the panel while open falls back to the panes', async () => {
    renderApp();
    sendFromHost(hydrate());
    resizeTo(900);
    await openSurface();
    sendFromHost({ t: 'fleet-diff', trees: [TREE] });
    resizeTo(400);

    assert.strictEqual(screen.queryAllByText(/not attributed/i).length, 0);
  });

  test('widening again restores it, because the intent was never cleared', async () => {
    renderApp();
    sendFromHost(hydrate());
    resizeTo(900);
    await openSurface();
    sendFromHost({ t: 'fleet-diff', trees: [TREE] });
    resizeTo(400);
    resizeTo(900);

    assert.strictEqual(screen.getAllByText(/not attributed/i).length >= 1, true);
  });

  test('an empty answer reads as nothing changed, not as nothing asked', async () => {
    renderApp();
    sendFromHost(hydrate());
    resizeTo(900);
    await openSurface();
    sendFromHost({ t: 'fleet-diff', trees: [] });

    assert.strictEqual(screen.getAllByText(/no changes/i).length >= 1, true);
  });
});
```

The `hydrate` helper casts its one summary with `as never` because `SessionSummary` has more required fields than this test cares about; if `check-types` objects, fill in the remaining fields from `SessionSummary` rather than widening the cast further.

- [x] **Step 2: Run the tests to verify they fail**

Run: `yarn test:dom --grep "fleet diff surface"`
Expected: FAIL — no "Review changes" button exists.

- [x] **Step 3: Invoke the impeccable skill for the surface's shape**

Do this before writing JSX. Follow whatever it routes to; the constraints it must respect are already fixed: Operate mode, a 700px-plus sidebar, a long-running agent turn in progress, and the file list is the thing being scanned.

- [x] **Step 4: Implement `src/webview/components/fleet-diff.tsx`**

Structure to build (exact classNames are the impeccable step's output; the behaviour below is not negotiable):

- A header row: title, a refresh `Button`, a close `Button`.
- Per tree: `root` basename and `branch`; the base caption — `origin/main` for a merge-base, and for `{ kind: 'head' }` an explicit line saying the diff covers uncommitted changes only.
- `groupTree(tree)` for the groups. A `sessionId` group is headed by that session's title from `state.sessions`; the `null` group is headed with a line saying these changes are **not attributed** to a session because nothing recorded a tool call for them.
- Per file: a `Button` whose accessible name contains the path, posting `{ t: 'open-file-diff', root: tree.root, path: file.path, base: tree.base }`. Show `+n` / `−m`, and for `claimedBy.length > 1` a marker naming the other sessions.
- `tree.omitted > 0` renders a line stating how many files are not shown.
- `tree.reason` renders instead of the file list.
- `state.fleetDiff === undefined` renders a loading line; `[]` renders "No changes".

The two effects, both in this component:

```tsx
  // Ask once on mount: the surface is the only thing that wants this, so it
  // is the only thing that asks for it.
  useEffect(() => { post({ t: 'request-fleet-diff' }); }, [post]);

  // And again, debounced, whenever the reducer counted something that could
  // have changed a diff. 750ms coalesces a burst of edits inside one turn
  // into a single request; without it a fan-out of file writes would put one
  // git invocation per tree on the host for every edit.
  useEffect(() => {
    if (state.fleetDiffDirty === 0) { return; }
    const timer = setTimeout(() => { post({ t: 'request-fleet-diff' }); }, 750);
    return () => { clearTimeout(timer); };
  }, [state.fleetDiffDirty, post]);
```

`post` is `useCallback`-stable (see `store.tsx:29-44`) and that stability is load-bearing here — an unstable `post` would re-fire the mount effect on every render.

- [x] **Step 5: Mount it in `App`**

In `src/webview/app.tsx`:

```tsx
  const [reviewOpen, setReviewOpen] = useState(false);
```

```tsx
            <SessionPicker narrow={narrow} canReview={canReview} onReview={() => { setReviewOpen(true); }} />
            <div className="min-h-0 flex-1">
              {/*
                Derived, not imperative. If the panel shrinks below REVIEW_PX
                while the surface is open, this falls back to the panes on its
                own — an imperative close would strand the user in an
                unusable surface at 300px with no visible way out — and
                widening again restores it, because the intent flag was never
                cleared.
              */}
              {reviewOpen && canReview
                ? <FleetDiff onClose={() => { setReviewOpen(false); }} />
                : <PaneGroup narrow={narrow} />}
            </div>
```

- [x] **Step 6: Add the entry button in `SessionPicker`**

Extend `SessionPickerProps` with `canReview: boolean` and `onReview: () => void`, and add the control beside the working-trees button (after the block at `session-picker.tsx:153-163`):

```tsx
      {/*
        Its own control, beside the working-trees one, for the same reason
        that one is: the menu it sits next to answers questions about layout,
        and filing "what did the fleet write" inside it would hide the only
        surface that answers for the work itself behind a word about panes.

        Gated on width rather than styled small: a file list with churn
        counts and session chips in a 300px column is a wall of truncated
        paths, which is the failure this gate exists to prevent.
      */}
      {canReview && (
        <Button
          variant="outline"
          size="icon-sm"
          className="shrink-0"
          aria-label="Review changes: every file the fleet has changed"
          onClick={onReview}
        >
          <GitCompareIcon aria-hidden />
        </Button>
      )}
```

Import `GitCompareIcon` from the same icon package `FolderGit2Icon` comes from.

- [x] **Step 7: Run the DOM tests to verify they pass**

Run: `yarn test:dom --grep "fleet diff surface"`
Expected: PASS, 10 passing.

- [x] **Step 8: Run the impeccable detector**

Run: `node <impeccable-skill-dir>/scripts/detect.mjs --json src/webview/components/fleet-diff.tsx src/webview/components/session-picker.tsx`
Expected: exit 0. Exit 2 means findings — fix them, then re-run.

- [x] **Step 9: Full verification and commit**

Run: `yarn lint && yarn check-types && yarn run compile && yarn test:unit && yarn test:dom`
Expected: all pass.

```bash
git add src/webview/components/fleet-diff.tsx src/webview/app.tsx src/webview/components/session-picker.tsx src/test/dom/fleet-diff.test.tsx
git commit -m "feat: review every file the fleet changed, grouped by session"
```

---

## Task 9: Documentation and the critique gate

**Files:**
- Modify: `CLAUDE.md` (the path table, and one invariant)
- Modify: `docs/superpowers/plans/2026-08-16-fleet-diff-review.md` (check the boxes)

- [x] **Step 1: Add the new modules to the path table in `CLAUDE.md`**

```markdown
| `src/host/fleet-diff.ts` | One tree's change set: base resolution, numstat + untracked parsing |
| `src/host/claim-paths.ts` | Provider edit paths → git's repo-relative POSIX spelling |
| `src/host/diff-content-provider.ts` | `hiiiid-diff:` scheme — a file's content at the base ref, via `git show` |
| `src/webview/components/fleet-diff.tsx` | The fleet diff surface: trees, session groups, file rows |
| `src/webview/components/fleet-diff-groups.ts` | Pure grouping of a flat `TreeDiff` into session groups |
```

- [x] **Step 2: Add the attribution invariant**

Under **Invariants**:

```markdown
- **Diff content comes from git; diff attribution comes from the transcript.**
  Git sees one dirty tree when three sessions share a root, so a file's owner is
  whichever sessions' canonical `file-edit` tool calls claimed its path — never
  inferred from git. A change with no tool call behind it (a shell command, a
  build, the user) is **unattributed**, and says so. Claims are never persisted:
  they describe a tree at an instant, and a restored claim would describe an
  install nobody checked this launch, the same reason a failed model probe never
  reaches `catalog.json`. `SessionManager` rebuilds the pre-launch half from the
  JSONL on demand.
```

- [x] **Step 3: Run the critique gate**

Per `CLAUDE.md`, before merging a UI branch: run `critique` over `src/webview` and compare against the previous run in `.impeccable/critique/`. The score is expected to go up, never down. Per the project memory, the implementer cannot run this — it needs the controller and two isolated agents.

- [x] **Step 4: Final verification and commit**

Run: `yarn lint && yarn check-types && yarn run compile && yarn test:unit && yarn test:dom && yarn test`
Expected: all pass.

```bash
git add CLAUDE.md docs/superpowers/plans/2026-08-16-fleet-diff-review.md
git commit -m "docs: record the fleet diff modules and the attribution invariant"
```

---

## Notes for the executor

- **`yarn test` (integration) is slow and launches VS Code.** Run it at Task 5 and Task 9 only.
- **Real git tests need a 60s mocha timeout.** Every suite touching git sets `this.timeout(60_000)` and uses `function () {}`, not an arrow — an arrow has no `this`.
- **`fs.realpath` on the temp dir matters on Windows**, where `tmpdir()` is a short path and git reports the long one. Every fixture here does it; do not drop it.
- **If a test fails, do not weaken the assertion.** Invoke `superpowers:systematic-debugging`. The two likeliest genuine failures are win32 path casing in Task 2 and the pre-measurement width semantics in Task 6 Step 6 — both are called out where they arise.
