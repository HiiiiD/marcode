# Collaboration tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `marcode__spawn_collaborators` (a lead spawns a scoped team on one tree) and `marcode__get_context_usage` (an agent reads its own context fill) to the self-control MCP server.

**Architecture:** New tools live in new files under `src/host/self-control/`, registered from `buildMcpServer`. The spawn validation inside `spawn_session` is extracted into a shared `resolveSpawn` so both tools validate identically. The context tool exposes the already-existing `SessionManager.contextBreakdown(id)`, which already does the live query, a timeout and a cached fallback.

**Tech Stack:** TypeScript, `@modelcontextprotocol/server`, zod, mocha (`yarn test:unit`).

**Spec:** [docs/superpowers/specs/2026-10-10-collaboration-tools-design.md](../specs/2026-10-10-collaboration-tools-design.md)

## Global Constraints

- `src/host/self-control-mcp-server.ts` and `src/host/self-control/**` must not import `vscode`.
- Tool names are prefixed `marcode__`; descriptions start with `Marcode-specific:`.
- `bypass` is never created: explicit request is an error, inherited is dropped to the provider default.
- `cwd` must be absolute.
- Usage surfaces read in percentages; tokens appear only as `usedTokens`/`windowTokens`, and only when the provider reported both.
- Errors are tool results with `isError: true`, never thrown.
- Comments: only non-obvious "why". Files over ~300 lines get split.
- Commit after every task, conventional prefixes, no Claude/Anthropic trailer.
- Gates before each commit: `yarn lint`, `yarn check-types`, `yarn test:unit` (guarded, never `:raw`). Pin every command with its own `cd /e/Efebia/hiiiid-code &&`.

## Review Focus

- A worker's preamble must never name a session outside the team (bystander in `list_sessions`). Test in Task 3.
- One invalid worker in the list must create nothing. Test in Task 4.
- A create failure midway must not leave half a team running. Test in Task 4 (rollback).
- A lead that cannot be identified (no `sid`) must get an error, not a team with an anonymous lead. Test in Task 4.
- Context tool on a provider with no `contextBreakdown` must return an error text, not `percent: NaN`. Test in Task 5.
- Context tool asked about a session the caller cannot see must say "Unknown session", same as the other tools. Test in Task 5.

---

### Task 1: Extract `resolveSpawn` from `spawn_session`

Pure refactor; existing `spawn_session` tests are the safety net.

**Files:**
- Create: `src/host/self-control/spawn-support.ts`
- Modify: `src/host/self-control-mcp-server.ts` (the `marcode__spawn_session` handler, ~lines 219-308)
- Test: existing `src/test/unit/self-control-mcp-server.test.ts` (no new tests; they must stay green)

**Interfaces:**
- Produces:
  - `type Caller = ReturnType<SessionManagerLike['summaries']>[number]`
  - `interface SpawnRequest { provider?: string; model?: string; effort?: EffortLevel; mode?: string; cwd: string }`
  - `interface ResolvedSpawn { providerId: string; model: string | undefined; effort: EffortLevel | undefined; mode: PermissionMode | undefined; cwd: string }`
  - `resolveSpawn(manager: Pick<SessionManagerLike, 'catalog'>, from: Caller | undefined, req: SpawnRequest): { ok: true; spawn: ResolvedSpawn } | { ok: false; error: string }`
  - `openPane(manager: SessionManagerLike, id: string): Promise<void>` (reveal, else add to visible set)
  - `sendPrompt(session: unknown, text: string): void` (guarded `send`, as today)

- [ ] **Step 1: Create `spawn-support.ts` with the logic moved verbatim**

```ts
import * as path from 'node:path';
import type { PermissionMode } from '../../protocol/messages';
import type { EffortLevel } from '../../providers/types';
import type { SessionManagerLike } from '../self-control-mcp-server';

export type Caller = ReturnType<SessionManagerLike['summaries']>[number];

export interface SpawnRequest {
  provider?: string; model?: string; effort?: EffortLevel; mode?: string; cwd: string;
}

export interface ResolvedSpawn {
  providerId: string;
  model: string | undefined;
  effort: EffortLevel | undefined;
  mode: PermissionMode | undefined;
  cwd: string;
}

type Resolution = { ok: true; spawn: ResolvedSpawn } | { ok: false; error: string };

export function resolveSpawn(
  manager: Pick<SessionManagerLike, 'catalog'>, from: Caller | undefined, req: SpawnRequest,
): Resolution {
  const providerId = req.provider ?? from?.providerId;
  if (!providerId) { return { ok: false, error: 'provider is required when the calling session cannot be identified' }; }
  const entry = manager.catalog().find((p) => p.id === providerId);
  if (!entry) { return { ok: false, error: `Unknown or unavailable provider: ${providerId}` }; }
  const effectiveModel = req.model ?? from?.model;
  // Alias-aware: a persisted canonical id can only match through an alias row's `resolvedModel`.
  const modelEntry = effectiveModel === undefined
    ? entry.models[0]
    : entry.models.find((m) => m.id === effectiveModel || m.resolvedModel === effectiveModel);
  if (effectiveModel !== undefined && !modelEntry) {
    return { ok: false, error: `Provider ${providerId} has no model ${effectiveModel}` };
  }
  // Effort belongs to the model: no effort control means none; an unpublished level falls back to the model default.
  const requestedEffort = req.effort ?? from?.effort;
  const effort = modelEntry?.effort
    ? (requestedEffort && modelEntry.effort.levels.includes(requestedEffort)
      ? requestedEffort
      : modelEntry.effort.default as EffortLevel)
    : undefined;
  const explicitMode = req.mode as PermissionMode | undefined;
  let mode = (explicitMode ?? from?.permissionMode) as PermissionMode | undefined;
  if (mode !== undefined && !entry.permissionModes.some((m) => m.id === mode)) {
    return { ok: false, error: `Provider ${providerId} has no mode ${mode}` };
  }
  // An explicit bypass would let a restricted session delegate around its restriction; an inherited one is merely dropped.
  if (explicitMode === 'bypass') { return { ok: false, error: 'spawn_session cannot create bypass-mode sessions' }; }
  if (mode === 'bypass') { mode = undefined; }
  if (!path.isAbsolute(req.cwd)) { return { ok: false, error: `cwd must be an absolute path: ${req.cwd}` }; }
  return { ok: true, spawn: { providerId, model: effectiveModel, effort, mode, cwd: req.cwd } };
}

export async function openPane(manager: SessionManagerLike, id: string): Promise<void> {
  if (manager.reveal) { await manager.reveal(id); return; }
  await manager.setVisible([...new Set([...manager.visibleIds(), id])]);
}

// `send` is not part of SessionManagerLike; a minimal fake without a real AgentSession must not blow up here.
export function sendPrompt(session: unknown, text: string): void {
  const sendable = session as { send?: (text: string) => void };
  if (typeof sendable.send === 'function') { sendable.send(text); }
}
```

- [ ] **Step 2: Replace the `spawn_session` handler body**

In `self-control-mcp-server.ts`, add `import { openPane, resolveSpawn, sendPrompt } from './self-control/spawn-support';` and replace the whole handler (from `async ({ provider, model, effort, mode, cwd, prompt }) => {` to its closing) with:

```ts
      async ({ provider, model, effort, mode, cwd, prompt }) => {
        const resolved = resolveSpawn(this.sessionManager, caller(), { provider, model, effort, mode, cwd });
        if (!resolved.ok) { return { isError: true, content: [{ type: 'text', text: resolved.error }] }; }
        const s = resolved.spawn;
        try {
          const session = await this.sessionManager.create(s.providerId, s.cwd, s.model, s.effort, s.mode);
          sendPrompt(session, prompt);
          await openPane(this.sessionManager, session.state.id);
          return { content: [{ type: 'text', text: JSON.stringify({ sessionId: session.state.name }) }] };
        } catch (err) {
          return { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] };
        }
      },
```

Remove the now-unused `path` import and `EffortLevel`/`PermissionMode` imports only if lint reports them unused.

- [ ] **Step 3: Run the spawn tests**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit 2>&1 | tail -30`
Expected: all `self-control-mcp-server` tests PASS, unchanged.

- [ ] **Step 4: Gates and commit**

```bash
cd /e/Efebia/hiiiid-code && yarn lint && yarn check-types
git add src/host/self-control src/host/self-control-mcp-server.ts
git commit -m "refactor: extract resolveSpawn from spawn_session"
```

---

### Task 2: `ContextResult.stale` and `SessionManagerLike.contextBreakdown`

**Files:**
- Modify: `src/protocol/messages.ts:367-369` (`ContextResult`)
- Modify: `src/host/session-manager.ts:1515-1538`
- Modify: `src/host/self-control-mcp-server.ts` (`SessionManagerLike`)
- Modify: `src/host/create-host.ts:~112`
- Test: `src/test/unit/session-manager.test.ts` (next to the existing `contextBreakdown` tests, ~line 868)

**Interfaces:**
- Produces:
  - `ContextResult = { ok: true; breakdown: ContextBreakdown; stale?: true } | { ok: false; reason: string }`
  - `SessionManagerLike.contextBreakdown?(id: string): Promise<ContextResult>`
  - `stale: true` is set only when a live session is mid-turn (`state.status !== 'idle'`) and the live query failed or timed out, so the cached value predates tokens spent since.

- [ ] **Step 1: Write the failing test**

Add after the `falls back to the last persisted breakdown` test in `session-manager.test.ts`. Reuse that test's setup helpers; the structure below shows the assertions that matter. Construct the manager and a live session the same way the `contextBreakdown answers ok for a live session` test (~line 822) does, with a `FakeProvider` whose run's `contextBreakdown` never resolves:

```ts
  test('contextBreakdown marks the cached fallback stale when a running session times out', async () => {
    const remembered = {
      systemPercent: 10, memoryPercent: 5, conversationPercent: 25, freePercent: 60, memoryFiles: [],
    };
    const provider = new FakeProvider(() => [], { context: remembered });
    const local = new SessionManager(store, new Map([['fake', provider]]), () => {});
    await local.init();
    const session = await local.create('fake', '/tmp');
    await session.contextBreakdown(); // records lastContext
    provider.runs[0].contextBreakdown = () => new Promise(() => {}); // never answers
    (session.state as { status: string }).status = 'running';
    (local as unknown as { contextTimeoutMs: number }).contextTimeoutMs = 20;

    const result = await local.contextBreakdown(session.state.id);

    if (!result.ok) { assert.fail(result.reason); }
    assert.strictEqual(result.stale, true);
    assert.deepStrictEqual(result.breakdown, remembered);
    await local.dispose();
  });

  test('contextBreakdown does not mark a fallback stale when the session is idle', async () => {
    const remembered = {
      systemPercent: 10, memoryPercent: 5, conversationPercent: 25, freePercent: 60, memoryFiles: [],
    };
    const provider = new FakeProvider(() => [], { context: remembered });
    const local = new SessionManager(store, new Map([['fake', provider]]), () => {});
    await local.init();
    const session = await local.create('fake', '/tmp');
    await session.contextBreakdown();
    provider.runs[0].contextBreakdown = () => Promise.reject(new Error('boom'));

    const result = await local.contextBreakdown(session.state.id);

    if (!result.ok) { assert.fail(result.reason); }
    assert.strictEqual(result.stale, undefined);
    await local.dispose();
  });
```

If `store` is not in scope in that suite, use the local variable the neighbouring tests use for their `TranscriptStore`. If `contextTimeoutMs` is `readonly`, cast as shown; do not change its declaration.

- [ ] **Step 2: Run to verify failure**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit 2>&1 | grep -A12 "marks the cached fallback stale"`
Expected: FAIL (`result.stale` is `undefined`, or a type error on `stale`).

- [ ] **Step 3: Implement**

`messages.ts`:

```ts
export type ContextResult =
  | { ok: true; breakdown: ContextBreakdown; stale?: true }
  | { ok: false; reason: string };
```

`session-manager.ts`, in the `catch` of `contextBreakdown`:

```ts
      if (remembered) {
        // Mid-turn the conversation has grown past what the last turn recorded.
        return session.state.status === 'idle'
          ? { ok: true, breakdown: remembered }
          : { ok: true, breakdown: remembered, stale: true };
      }
```

`self-control-mcp-server.ts`, import `ContextResult` from `../protocol/messages` and add to `SessionManagerLike`:

```ts
  /** The live context measurement, falling back to the last recorded one. Absent in minimal fakes. */
  contextBreakdown?(id: string): Promise<ContextResult>;
```

`create-host.ts`, in the object passed to `SelfControlMcpServer`:

```ts
    contextBreakdown: (id) => manager.contextBreakdown(id as SessionId),
```

- [ ] **Step 4: Run tests, gates, commit**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit 2>&1 | tail -15`
Expected: PASS, including both new tests.

```bash
cd /e/Efebia/hiiiid-code && yarn lint && yarn check-types
git add src/protocol/messages.ts src/host/session-manager.ts src/host/self-control-mcp-server.ts src/host/create-host.ts src/test/unit/session-manager.test.ts
git commit -m "feat: flag a mid-turn cached context fallback as stale"
```

---

### Task 3: Worker preamble builder

**Files:**
- Create: `src/host/self-control/worker-preamble.ts`
- Test: `src/test/unit/worker-preamble.test.ts`

**Interfaces:**
- Produces:
  - `interface TeamMember { name: string; task: string }`
  - `buildWorkerPreamble(o: { lead: string; self: TeamMember; siblings: TeamMember[]; scope?: string; commit: boolean }): string`
  - The returned string ends with the worker's own task, so callers send it as the whole prompt.

- [ ] **Step 1: Write the failing tests**

```ts
import * as assert from 'node:assert';
import { suite, test } from 'mocha';
import { buildWorkerPreamble } from '../../host/self-control/worker-preamble';

const base = {
  lead: 'lead-1',
  self: { name: 'w-a', task: 'write the parser' },
  siblings: [{ name: 'w-b', task: 'write the tests' }],
  commit: true,
};

suite('buildWorkerPreamble', () => {
  test('names the lead and siblings and ends with the task', () => {
    const text = buildWorkerPreamble(base);
    assert.strictEqual(text.includes('lead-1'), true);
    assert.strictEqual(text.includes('w-b: write the tests'), true);
    assert.strictEqual(text.trimEnd().endsWith('write the parser'), true);
  });

  test('never mentions a session outside the team', () => {
    const text = buildWorkerPreamble(base);
    assert.strictEqual(text.includes('bystander'), false);
    assert.strictEqual(text.includes('list_sessions'), false);
  });

  test('commit rules appear when commit is true and carry the path-limited form', () => {
    const text = buildWorkerPreamble(base);
    assert.strictEqual(text.includes('git commit -m'), true);
    assert.strictEqual(text.includes('-- <your paths>'), true);
    assert.strictEqual(text.includes('git add -A'), true); // named only as forbidden
    assert.strictEqual(text.includes('Do not push'), true);
  });

  test('commit false tells the worker to leave changes uncommitted', () => {
    const text = buildWorkerPreamble({ ...base, commit: false });
    assert.strictEqual(text.includes('git commit -m'), false);
    assert.strictEqual(text.includes('Do not commit'), true);
  });

  test('scope is quoted only when given', () => {
    assert.strictEqual(buildWorkerPreamble(base).includes('Your scope'), false);
    const text = buildWorkerPreamble({ ...base, scope: 'src/parser/' });
    assert.strictEqual(text.includes('Your scope: src/parser/'), true);
  });

  test('a lone worker has no sibling line', () => {
    const text = buildWorkerPreamble({ ...base, siblings: [] });
    assert.strictEqual(text.includes('siblings'), false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit 2>&1 | grep -B2 -A8 "worker-preamble"`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement**

```ts
export interface TeamMember { name: string; task: string }

interface PreambleInput {
  lead: string;
  self: TeamMember;
  siblings: TeamMember[];
  scope?: string;
  commit: boolean;
}

const COMMIT_RULES = [
  'Commit only files you edited yourself: `git add <your paths>`, then `git commit -m "..." -- <your paths>`.',
  'Never run `git add -A`, `git add .` or `git commit -a`.',
  'Never run `git stash`, `reset`, `clean`, `rebase`, a force-push, or `checkout`/`restore` on paths you do not own.',
  'Never `--amend` a commit you did not make.',
  'On `index.lock`, wait a few seconds and retry. Never delete the lock file.',
  'Do not push. Only the lead pushes.',
  'Follow the repository\'s commit conventions.',
];

export function buildWorkerPreamble(o: PreambleInput): string {
  const lines = [
    `You are a collaborator on a team led by session "${o.lead}". You share one working tree with the lead`
      + (o.siblings.length > 0 ? ' and your siblings:' : '.'),
    ...o.siblings.map((s) => `- ${s.name}: ${s.task}`),
    'Do not revert or overwrite changes you did not make.',
  ];
  if (o.scope) { lines.push(`Your scope: ${o.scope}. Do not edit outside it.`); }
  lines.push(
    ...(o.commit ? COMMIT_RULES : ['Do not commit. Leave your changes uncommitted for the lead to review.']),
    `When finished, call marcode__send_message to "${o.lead}" with a short result`
      + (o.commit ? ' and the hashes of the commits you made, or "no commits".' : '.'),
    '',
    `Your task: ${o.self.task}`,
  );
  return lines.join('\n');
}
```

Check `siblings` test: with no siblings the first line has no word "siblings"; with siblings it does. The lone-worker test asserts the absence of the word `siblings`, which holds.

- [ ] **Step 4: Run, gates, commit**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit 2>&1 | grep -E "buildWorkerPreamble|passing|failing"`
Expected: 6 new tests PASS, 0 failing.

```bash
cd /e/Efebia/hiiiid-code && yarn lint && yarn check-types
git add src/host/self-control/worker-preamble.ts src/test/unit/worker-preamble.test.ts
git commit -m "feat: worker preamble for collaborator sessions"
```

---

### Task 4: `marcode__spawn_collaborators`

**Files:**
- Create: `src/host/self-control/register-collaborators.ts`
- Modify: `src/host/self-control-mcp-server.ts` (register call, server `instructions`)
- Test: `src/test/unit/self-control-mcp-server.test.ts` (new suite block at the end of the file's top-level suite)

**Interfaces:**
- Consumes: `resolveSpawn`, `openPane`, `sendPrompt`, `Caller` (Task 1); `buildWorkerPreamble` (Task 3).
- Produces:
  - `interface ToolDeps { sessionManager: SessionManagerLike; caller: () => Caller | undefined }` (exported from `register-collaborators.ts`; Task 5 imports it from `./tool-deps`, so put it in its own file `src/host/self-control/tool-deps.ts` now).
  - `registerCollaboratorsTool(mcp: McpServer, deps: ToolDeps): void`
  - Tool input: `{ cwd?: string; workers: { task: string; scope?: string; commit?: boolean; provider?: string; model?: string; effort?: EffortLevel }[] }`, `workers` 1 to 8 entries.
  - Tool output text: `JSON.stringify({ workers: [{ sessionId: string; task: string }], note: string })`.

- [ ] **Step 1: Write the failing tests**

Append inside `suite('SelfControlMcpServer', ...)`. `callToolAs` and `fakeManager` already exist in the file.

```ts
  suite('spawn_collaborators', () => {
    const catalog = () => [{
      id: 'claude', models: [{ id: 'sonnet' }], permissionModes: [{ id: 'default' }],
    }];
    const lead = {
      id: 'lead', name: 'Lead', providerId: 'claude', model: 'sonnet',
      permissionMode: 'default' as const, status: 'idle', cwd: '/repo',
    };
    const bystander = { ...lead, id: 'by', name: 'bystander' };

    function teamManager(sent: Record<string, string>, created: string[] = [], closed: string[] = []) {
      let n = 0;
      return fakeManager({
        catalog,
        summaries: () => [lead, bystander],
        visibleIds: () => ['lead', 'by'],
        create: async () => {
          n += 1;
          const id = `w${n}`;
          created.push(id);
          return { state: { id, name: `worker${n}` }, send: (t: string) => { sent[id] = t; } } as never;
        },
        close: async (id) => { closed.push(id); },
      });
    }

    test('spawns every worker, inherits cwd, and each prompt names only the team', async () => {
      const sent: Record<string, string> = {};
      const server = new SelfControlMcpServer(teamManager(sent));
      const config = await server.start();
      const res = await callToolAs(config, 'lead', 'marcode__spawn_collaborators', {
        workers: [{ task: 'parser', scope: 'src/p/' }, { task: 'tests' }],
      });
      assert.strictEqual(res.isError, undefined);
      const out = JSON.parse(res.content[0].text) as { workers: { sessionId: string; task: string }[] };
      assert.deepStrictEqual(out.workers.map((w) => w.sessionId), ['worker1', 'worker2']);
      assert.strictEqual(sent.w1.includes('worker2: tests'), true);
      assert.strictEqual(sent.w1.includes('Your scope: src/p/'), true);
      assert.strictEqual(sent.w1.includes('"Lead"'), true);
      assert.strictEqual(sent.w1.includes('bystander'), false);
      assert.strictEqual(sent.w2.includes('bystander'), false);
      await server.dispose();
    });

    test('commit false is honoured per worker', async () => {
      const sent: Record<string, string> = {};
      const server = new SelfControlMcpServer(teamManager(sent));
      const config = await server.start();
      await callToolAs(config, 'lead', 'marcode__spawn_collaborators', {
        workers: [{ task: 'a', commit: false }, { task: 'b' }],
      });
      assert.strictEqual(sent.w1.includes('Do not commit'), true);
      assert.strictEqual(sent.w2.includes('git commit -m'), true);
      await server.dispose();
    });

    test('one invalid worker creates nothing', async () => {
      const created: string[] = [];
      const server = new SelfControlMcpServer(teamManager({}, created));
      const config = await server.start();
      const res = await callToolAs(config, 'lead', 'marcode__spawn_collaborators', {
        workers: [{ task: 'ok' }, { task: 'bad', provider: 'nope' }],
      });
      assert.strictEqual(res.isError, true);
      assert.strictEqual(res.content[0].text.includes('nope'), true);
      assert.deepStrictEqual(created, []);
      await server.dispose();
    });

    test('an explicit bypass worker is rejected before anything is created', async () => {
      const created: string[] = [];
      const server = new SelfControlMcpServer(teamManager({}, created));
      const config = await server.start();
      const res = await callToolAs(config, 'lead', 'marcode__spawn_collaborators', {
        workers: [{ task: 'x' }],
        cwd: 'relative/path',
      });
      assert.strictEqual(res.isError, true);
      assert.deepStrictEqual(created, []);
      await server.dispose();
    });

    test('a create failure midway closes the workers already created', async () => {
      const created: string[] = [];
      const closed: string[] = [];
      const base = teamManager({}, created, closed);
      let calls = 0;
      const server = new SelfControlMcpServer({
        ...base,
        create: async (...a) => {
          calls += 1;
          if (calls === 2) { throw new Error('provider exploded'); }
          return base.create(...a);
        },
      });
      const config = await server.start();
      const res = await callToolAs(config, 'lead', 'marcode__spawn_collaborators', {
        workers: [{ task: 'a' }, { task: 'b' }],
      });
      assert.strictEqual(res.isError, true);
      assert.strictEqual(res.content[0].text.includes('provider exploded'), true);
      assert.deepStrictEqual(closed, ['w1']);
      await server.dispose();
    });

    test('an unidentifiable caller gets an error and no team', async () => {
      const created: string[] = [];
      const server = new SelfControlMcpServer(teamManager({}, created));
      const config = await server.start();
      const res = await callTool(config, 'marcode__spawn_collaborators', { workers: [{ task: 'a' }] });
      assert.strictEqual(res.isError, true);
      assert.deepStrictEqual(created, []);
      await server.dispose();
    });
  });
```

The fourth test's name says bypass but exercises the relative-`cwd` guard through the shared resolver; rename it to `a relative cwd is rejected before anything is created`.

- [ ] **Step 2: Run to verify failure**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit 2>&1 | grep -A6 "spawn_collaborators"`
Expected: FAIL (`Tool marcode__spawn_collaborators not found` surfaces as `isError`/undefined result).

- [ ] **Step 3: Implement**

`tool-deps.ts`:

```ts
import type { SessionManagerLike } from '../self-control-mcp-server';
import type { Caller } from './spawn-support';

export interface ToolDeps {
  sessionManager: SessionManagerLike;
  caller: () => Caller | undefined;
}
```

`register-collaborators.ts`:

```ts
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { openPane, resolveSpawn, sendPrompt, type ResolvedSpawn } from './spawn-support';
import type { ToolDeps } from './tool-deps';
import { buildWorkerPreamble } from './worker-preamble';

const MAX_WORKERS = 8;

const fail = (text: string) => ({ isError: true as const, content: [{ type: 'text' as const, text }] });

export function registerCollaboratorsTool(mcp: McpServer, { sessionManager, caller }: ToolDeps): void {
  mcp.registerTool(
    'marcode__spawn_collaborators',
    {
      title: 'Spawn a team of collaborator sessions',
      description: 'Marcode-specific: you become the lead of a small team. Creates one new top-level '
        + 'Marcode session per entry in `workers`, all in the SAME working tree (`cwd`, default: yours), '
        + 'each in its own pane. Every worker is told only about you and its teammates from this call — '
        + 'never about other sessions — plus its `scope` (files or folders it owns), safe git rules for a '
        + 'shared tree, and to report back to you with marcode__send_message. Workers commit their own '
        + 'files unless `commit` is false; they never push, only you do. Unlike marcode__spawn_session '
        + 'this is one call for the whole team. Not subagents of this conversation. Before you push, '
        + 'run `git status` and `git log` to confirm every worker finished and nothing is left dirty.',
      inputSchema: z.object({
        cwd: z.string().optional().describe('Absolute working directory shared by the team. Omit to use yours.'),
        workers: z.array(z.object({
          task: z.string().describe('What this worker should do.'),
          scope: z.string().optional().describe('Files or folders this worker owns; it is told not to edit outside.'),
          commit: z.boolean().optional().describe('Whether the worker commits its own files. Default true.'),
          provider: z.string().optional().describe('Provider id. Omit to inherit yours.'),
          model: z.string().optional().describe('Model id (see marcode__list_models). Omit to inherit yours.'),
          effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']).optional()
            .describe('Effort level. Omit to inherit yours.'),
        })).min(1).max(MAX_WORKERS),
      }),
    },
    async ({ cwd, workers }) => {
      const from = caller();
      if (!from) { return fail('Could not identify the calling session.'); }
      const teamCwd = cwd ?? from.cwd;
      const plans: ResolvedSpawn[] = [];
      for (const [i, w] of workers.entries()) {
        const r = resolveSpawn(sessionManager, from, { ...w, cwd: teamCwd });
        if (!r.ok) { return fail(`workers[${i}]: ${r.error}`); }
        plans.push(r.spawn);
      }
      const created: { id: string; name: string; session: unknown }[] = [];
      try {
        for (const s of plans) {
          const session = await sessionManager.create(s.providerId, s.cwd, s.model, s.effort, s.mode);
          created.push({ id: session.state.id, name: session.state.name, session });
        }
      } catch (err) {
        // Nothing was sent yet, so each is still empty and close discards it outright.
        for (const c of created) { await sessionManager.close(c.id).catch(() => undefined); }
        return fail(err instanceof Error ? err.message : String(err));
      }
      const team = created.map((c, i) => ({ name: c.name, task: workers[i].task }));
      for (const [i, c] of created.entries()) {
        sendPrompt(c.session, buildWorkerPreamble({
          lead: from.name,
          self: team[i],
          siblings: team.filter((_, j) => j !== i),
          scope: workers[i].scope,
          commit: workers[i].commit !== false,
        }));
        await openPane(sessionManager, c.id);
      }
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            workers: team.map((t) => ({ sessionId: t.name, task: t.task })),
            note: 'Workers report back with marcode__send_message. Before pushing, run git status and git log.',
          }),
        }],
      };
    },
  );
}
```

In `self-control-mcp-server.ts`, after the `caller` const in `buildMcpServer`, add:

```ts
    registerCollaboratorsTool(mcp, { sessionManager: this.sessionManager, caller });
```

with the import, and extend the server `instructions` string: after `marcode__spawn_session ... to start a new one (...)` add `, marcode__spawn_collaborators to start a whole team on one working tree`.

- [ ] **Step 4: Run, gates, commit**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit 2>&1 | grep -E "spawn_collaborators|passing|failing"`
Expected: 6 new tests PASS, 0 failing.

```bash
cd /e/Efebia/hiiiid-code && yarn lint && yarn check-types
git add src/host/self-control src/host/self-control-mcp-server.ts src/test/unit/self-control-mcp-server.test.ts
git commit -m "feat: marcode__spawn_collaborators tool"
```

---

### Task 5: `marcode__get_context_usage`

**Files:**
- Create: `src/host/self-control/register-context-usage.ts`
- Modify: `src/host/self-control-mcp-server.ts` (register call, `instructions`)
- Test: `src/test/unit/self-control-mcp-server.test.ts`

**Interfaces:**
- Consumes: `ToolDeps` (Task 4), `SessionManagerLike.contextBreakdown` (Task 2).
- Produces:
  - `registerContextUsageTool(mcp: McpServer, deps: ToolDeps): void`
  - Input: `{ name?: string }` (omitted = the caller; a name must be a pane-visible session, as in the other tools).
  - Output text: `JSON.stringify({ percent: number; usedTokens?: number; windowTokens?: number; stale?: true })` where `percent = Math.round(100 - freePercent)`.

- [ ] **Step 1: Write the failing tests**

```ts
  suite('get_context_usage', () => {
    const me = {
      id: 'me', name: 'Me', providerId: 'claude', model: 'sonnet',
      permissionMode: 'default' as const, status: 'running', cwd: '/repo',
    };
    const other = { ...me, id: 'ot', name: 'Other' };
    const breakdown = {
      systemPercent: 10, memoryPercent: 5, conversationPercent: 25, freePercent: 60, memoryFiles: [],
      usedTokens: 80_000, windowTokens: 200_000,
    };

    test('reports the caller\'s own percentage and window', async () => {
      let asked = '';
      const server = new SelfControlMcpServer(fakeManager({
        summaries: () => [me, other], visibleIds: () => ['me', 'ot'],
        contextBreakdown: async (id) => { asked = id; return { ok: true, breakdown }; },
      }));
      const config = await server.start();
      const res = await callToolAs(config, 'me', 'marcode__get_context_usage', {});
      assert.strictEqual(res.isError, undefined);
      assert.deepStrictEqual(JSON.parse(res.content[0].text), { percent: 40, usedTokens: 80_000, windowTokens: 200_000 });
      assert.strictEqual(asked, 'me');
      await server.dispose();
    });

    test('a name targets another visible session', async () => {
      let asked = '';
      const server = new SelfControlMcpServer(fakeManager({
        summaries: () => [me, other], visibleIds: () => ['me', 'ot'],
        contextBreakdown: async (id) => { asked = id; return { ok: true, breakdown }; },
      }));
      const config = await server.start();
      await callToolAs(config, 'me', 'marcode__get_context_usage', { name: 'other' });
      assert.strictEqual(asked, 'ot');
      await server.dispose();
    });

    test('a session the caller cannot see is unknown', async () => {
      const server = new SelfControlMcpServer(fakeManager({
        summaries: () => [me, other], visibleIds: () => ['me'],
        contextBreakdown: async () => ({ ok: true, breakdown }),
      }));
      const config = await server.start();
      const res = await callToolAs(config, 'me', 'marcode__get_context_usage', { name: 'Other' });
      assert.strictEqual(res.isError, true);
      assert.strictEqual(res.content[0].text.includes('Unknown session'), true);
      await server.dispose();
    });

    test('tokens are omitted when the provider reported neither, and stale is passed through', async () => {
      const { usedTokens: _u, windowTokens: _w, ...bare } = breakdown;
      const server = new SelfControlMcpServer(fakeManager({
        summaries: () => [me], visibleIds: () => ['me'],
        contextBreakdown: async () => ({ ok: true, breakdown: bare, stale: true }),
      }));
      const config = await server.start();
      const res = await callToolAs(config, 'me', 'marcode__get_context_usage', {});
      assert.deepStrictEqual(JSON.parse(res.content[0].text), { percent: 40, stale: true });
      await server.dispose();
    });

    test('a provider that cannot report becomes an error, never a number', async () => {
      const server = new SelfControlMcpServer(fakeManager({
        summaries: () => [me], visibleIds: () => ['me'],
        contextBreakdown: async () => ({ ok: false, reason: 'This provider does not report context usage' }),
      }));
      const config = await server.start();
      const res = await callToolAs(config, 'me', 'marcode__get_context_usage', {});
      assert.strictEqual(res.isError, true);
      assert.strictEqual(res.content[0].text.includes('does not report'), true);
      await server.dispose();
    });

    test('a manager without contextBreakdown is an error', async () => {
      const server = new SelfControlMcpServer(fakeManager({ summaries: () => [me], visibleIds: () => ['me'] }));
      const config = await server.start();
      const res = await callToolAs(config, 'me', 'marcode__get_context_usage', {});
      assert.strictEqual(res.isError, true);
      await server.dispose();
    });

    test('no sid and no name cannot be answered', async () => {
      const server = new SelfControlMcpServer(fakeManager({ contextBreakdown: async () => ({ ok: true, breakdown }) }));
      const config = await server.start();
      const res = await callTool(config, 'marcode__get_context_usage', {});
      assert.strictEqual(res.isError, true);
      await server.dispose();
    });
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit 2>&1 | grep -A6 "get_context_usage"`
Expected: FAIL (tool not found).

- [ ] **Step 3: Implement**

```ts
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ToolDeps } from './tool-deps';

const fail = (text: string) => ({ isError: true as const, content: [{ type: 'text' as const, text }] });

export function registerContextUsageTool(mcp: McpServer, { sessionManager, caller }: ToolDeps): void {
  mcp.registerTool(
    'marcode__get_context_usage',
    {
      title: 'How full is a session\'s context window',
      description: 'Marcode-specific: returns how much of the context window a session has used, as a '
        + '`percent`, plus `usedTokens`/`windowTokens` when the provider reports them. With no `name` it '
        + 'measures YOU — call it during long work to decide when to wrap up or hand off before the '
        + 'window runs out. Measured live when the provider allows, so it can lag by up to one model '
        + 'call; `stale: true` means the live query failed mid-turn and the figure is from the end of '
        + 'the previous turn, so the real value is higher. Unrelated to any built-in context command. '
        + 'Pass `name` (from marcode__list_sessions) to check a teammate instead.',
      inputSchema: z.object({
        name: z.string().optional().describe('Another session\'s name. Omit to measure yourself.'),
      }),
    },
    async ({ name }) => {
      let targetId: string | undefined;
      if (name === undefined) {
        targetId = caller()?.id;
        if (!targetId) { return fail('Could not identify the calling session.'); }
      } else {
        const visible = new Set(sessionManager.visibleIds());
        targetId = sessionManager.summaries()
          .find((s) => s.name.toLowerCase() === name.toLowerCase() && visible.has(s.id))?.id;
        if (!targetId) { return fail(`Unknown session: ${name}`); }
      }
      if (!sessionManager.contextBreakdown) { return fail('Context usage is not available in this window.'); }
      const res = await sessionManager.contextBreakdown(targetId);
      if (!res.ok) { return fail(res.reason); }
      const b = res.breakdown;
      const out = {
        percent: Math.round(100 - b.freePercent),
        ...(b.usedTokens !== undefined && b.windowTokens !== undefined
          ? { usedTokens: b.usedTokens, windowTokens: b.windowTokens } : {}),
        ...(res.stale ? { stale: true } : {}),
      };
      return { content: [{ type: 'text' as const, text: JSON.stringify(out) }] };
    },
  );
}
```

Register in `buildMcpServer` next to the collaborators call, and add `marcode__get_context_usage to see how full your context window is` to the `instructions` string.

- [ ] **Step 4: Run, gates, commit**

Run: `cd /e/Efebia/hiiiid-code && yarn test:unit 2>&1 | grep -E "get_context_usage|passing|failing"`
Expected: 7 new tests PASS, 0 failing.

```bash
cd /e/Efebia/hiiiid-code && yarn lint && yarn check-types && yarn run compile
git add src/host/self-control src/host/self-control-mcp-server.ts src/test/unit/self-control-mcp-server.test.ts
git commit -m "feat: marcode__get_context_usage tool"
```

---

### Task 6: Docs and the mid-turn probe (the spec's open risk)

**Files:**
- Modify: `AGENTS.md` (architecture table, two rows)
- Modify: `docs/superpowers/specs/2026-10-10-collaboration-tools-design.md` (outcome of the probe, plus two corrections below)

- [ ] **Step 1: Add the table rows to `AGENTS.md`** after the `self-control-mcp-server.ts` row:

```
| `src/host/self-control/` | The self-control tools' parts: `spawn-support.ts` (`resolveSpawn` shared by `spawn_session` and `spawn_collaborators`), `worker-preamble.ts` (what a collaborator is told), `register-collaborators.ts`, `register-context-usage.ts` |
```

- [ ] **Step 2: Correct the spec**

In the spec: (a) the failure-midway paragraph now reads "a failure while creating worker K closes the workers already created (still empty, so discarded) and reports the error"; (b) `get_context_usage` takes `name`, not `sessionId`, matching the other tools; (c) `stale` is set only when the session is mid-turn.

- [ ] **Step 3: Run the probe** (manual, needs a real Claude session; a compiled build loaded with F5)

1. Open two Claude sessions, A and B, both visible.
2. In A, ask it to run a Bash command `sleep 90`.
3. While that runs, in B ask it to call `marcode__get_context_usage` with `name` = A's name. Time the reply.
4. Expected if the open risk is fine: reply in about 1 to 3s with no `stale`. If it comes back after about 3s with `stale: true`, or only after the sleep ends, the SDK queues the control request behind the running tool.

- [ ] **Step 4: Record the outcome in the spec** under "Open risk": which case occurred, with the measured latency. If it queued, add a follow-up item: derive a running figure from per-assistant-message `usage` in the stream, and do not ship that in this plan.

- [ ] **Step 5: Commit**

```bash
cd /e/Efebia/hiiiid-code
git add AGENTS.md docs/superpowers/specs/2026-10-10-collaboration-tools-design.md
git commit -m "docs: self-control tool rows and mid-turn context probe result"
```
