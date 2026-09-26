# Always Allow Implementation Plan

> **Status: dropped 2026-09-26.** Not shipped: session-scoped rules widen what an agent can do unprompted (edits + test runner = code execution; broad read rules). If revisited, prefer provider-native mechanisms (Claude suggestions pinned to the session destination, Codex acceptForSession, ACP allow_always). Only the compact diff preview and the fixed button row landed.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permission cards offer "Always allow"; Marcode remembers a narrow per-session rule in memory and auto-answers matching requests on every provider. Edit approvals get a compact diff preview; Deny/Allow keep a fixed position.

**Architecture:** A pure `permission-rules.ts` derives a rule key + label from the canonical `ToolCall`. `AgentSession` holds a `Set` of keys, auto-answers matching `permission` events through the normal `respondToTool` path, and stamps `alwaysRule` on the persisted permission item so the card can show the button. Providers are untouched.

**Tech Stack:** TypeScript, React 19, Tailwind v4, shadcn (Base UI) `Button`, mocha (`yarn test:unit`, `yarn test:dom`).

**Spec:** `docs/superpowers/specs/2026-09-26-always-allow-design.md`

**Deviation from spec:** `alwaysRule` rides the permission *item* only, not `PermissionRequest`. The card reads `item`; `pending` is only used for liveness, so duplicating it there adds nothing.

## Global Constraints

- Work only in `e:\Efebia\marcode-always-allow` on branch `feat/always-allow`; run `cd /e/Efebia/marcode-always-allow && test "$(git branch --show-current)" = feat/always-allow` before every commit; pin every gate command with its own `cd`.
- `src/protocol/messages.ts` is types-only; nothing under `src/providers/` or `src/protocol/` imports `vscode`; `message-router.ts` stays `vscode`-free.
- Every session-addressed message carries `SessionId`.
- Rules are in-memory, per `AgentSession`, never persisted, cleared on dispose.
- shadcn `Button` only, `cn` for classNames, short Tailwind token utilities, filenames kebab-case.
- DOM tests: real `StoreProvider` + `sendFromHost`; never pass a DOM node to an assertion (compare booleans/strings/counts).
- Use guarded `yarn test:unit` / `yarn test:dom`, never `:raw`.
- Commits: conventional prefixes, no Claude/Anthropic trailer. `yarn lint`, `yarn check-types`, `yarn run compile` must pass before the final commit.
- Comments minimal: only non-obvious "why".

## Review Focus

- Chained shell command (`git status && rm -rf x`, `a | b`, `` `x` ``, `$(x)`, newline, redirect, trailing `&`): no rule, no button. Pinned in Task 1.
- Env-prefixed or wrapper commands (`FOO=1 make`, `sudo x`, `bash x.sh`, `env x`): no rule. Pinned in Task 1.
- File edits that delete or rename: no rule (only create/modify are "any file"). Pinned in Task 1.
- `always: true` on a deny, on an unknown requestId, or on an ineligible request: must not store a rule and must not throw. Pinned in Task 3.
- A rule granted in one session must not auto-answer in another session, and must not survive `dispose`. Pinned in Task 3.
- Double click on Always allow: exactly one post. Pinned in Task 4.

---

### Task 1: Rule engine

**Files:**
- Create: `src/host/permission-rules.ts`
- Test: `src/test/unit/permission-rules.test.ts`

**Interfaces:**
- Consumes: `ToolCall` from `src/providers/canonical/tool-call.ts`.
- Produces: `interface PermissionRule { key: string; label: string }`, `ruleFor(tool: ToolCall): PermissionRule | undefined`.

- [ ] **Step 1: Write the failing test**

```ts
import * as assert from 'assert';
import { ruleFor } from '../../host/permission-rules';
import type { ToolCall } from '../../providers/canonical/tool-call';

const cmd = (command: string): ToolCall => ({ kind: 'command', label: 'Bash', command });

suite('ruleFor', () => {
  test('a shell command keys on first word + subcommand', () => {
    assert.deepStrictEqual(ruleFor(cmd('git status --short')), {
      key: 'command:git status', label: 'Always allow `git status`',
    });
  });

  test('a single-word command keys on that word', () => {
    assert.strictEqual(ruleFor(cmd('ls'))?.key, 'command:ls');
  });

  test('a flag as second token keys on the first word only when nothing else follows', () => {
    assert.strictEqual(ruleFor(cmd('ls -la'))?.key, 'command:ls');
    assert.strictEqual(ruleFor(cmd('git -C x status')), undefined);
  });

  test('chained, piped, substituted, redirected and multi-line commands get no rule', () => {
    for (const c of [
      'git status && rm -rf x', 'a || b', 'a; b', 'a | b', 'echo `x`', 'echo $(x)',
      'echo hi > f', 'cat < f', 'sleep 1 &', 'a\nb',
    ]) {
      assert.strictEqual(ruleFor(cmd(c)), undefined, c);
    }
  });

  test('env-prefixed and wrapper commands get no rule', () => {
    for (const c of ['FOO=1 make', 'sudo ls', 'env ls', 'bash x.sh', 'sh -c x', 'eval x', 'xargs ls', 'pwsh -c x']) {
      assert.strictEqual(ruleFor(cmd(c)), undefined, c);
    }
  });

  test('an empty command gets no rule', () => {
    assert.strictEqual(ruleFor(cmd('   ')), undefined);
  });

  test('create/modify edits key on the kind; delete/rename get no rule', () => {
    const edit = (op: 'create' | 'modify' | 'delete' | 'rename'): ToolCall => ({
      kind: 'file-edit', label: 'Edit', files: [{ path: '/a', op }],
    });
    assert.deepStrictEqual(ruleFor(edit('modify')), { key: 'file-edit', label: 'Always allow file edits' });
    assert.strictEqual(ruleFor(edit('create'))?.key, 'file-edit');
    assert.strictEqual(ruleFor(edit('delete')), undefined);
    assert.strictEqual(ruleFor(edit('rename')), undefined);
    assert.strictEqual(ruleFor({ kind: 'file-edit', label: 'Edit', files: [] }), undefined);
  });

  test('mcp keys on server + tool', () => {
    assert.deepStrictEqual(
      ruleFor({ kind: 'mcp', label: 'create_pr', server: 'github', tool: 'create_pr' }),
      { key: 'mcp:github:create_pr', label: 'Always allow github create_pr' },
    );
  });

  test('plan, other and the rest get no rule', () => {
    assert.strictEqual(ruleFor({ kind: 'plan', label: 'Plan', text: 'x' }), undefined);
    assert.strictEqual(ruleFor({ kind: 'other', label: 'X', raw: {} }), undefined);
    assert.strictEqual(ruleFor({ kind: 'web', label: 'Fetch', url: 'https://x' }), undefined);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /e/Efebia/marcode-always-allow && yarn test:unit 2>&1 | tail -30`
Expected: FAIL, cannot find module `../../host/permission-rules`.

- [ ] **Step 3: Implement**

```ts
import type { ToolCall } from '../providers/canonical/tool-call';

export interface PermissionRule { key: string; label: string }

const CHAIN = /&&|\|\||[;|`<>&\n\r]|\$\(/;
const WRAPPERS = new Set([
  'sudo', 'doas', 'env', 'eval', 'exec', 'xargs', 'bash', 'sh', 'zsh', 'fish', 'pwsh',
  'powershell', 'cmd', 'nohup', 'time',
]);
const SUBCOMMAND = /^[a-z][\w:-]*$/i;

function commandRule(command: string): PermissionRule | undefined {
  if (CHAIN.test(command)) { return undefined; }
  const [first, second, third] = command.trim().split(/\s+/);
  if (!first || first.includes('=') || WRAPPERS.has(first.toLowerCase())) { return undefined; }
  if (second && SUBCOMMAND.test(second)) {
    return { key: `command:${first} ${second}`, label: `Always allow \`${first} ${second}\`` };
  }
  // `ls -la` is fine (flags trail the verb); `git -C x status` hides the verb behind a flag's value.
  if (second?.startsWith('-') && third !== undefined && !third.startsWith('-')) { return undefined; }
  return { key: `command:${first}`, label: `Always allow \`${first}\`` };
}

export function ruleFor(tool: ToolCall): PermissionRule | undefined {
  switch (tool.kind) {
    case 'command':
      return commandRule(tool.command);
    case 'file-edit':
      if (tool.files.length === 0 || tool.files.some((f) => f.op === 'delete' || f.op === 'rename')) {
        return undefined;
      }
      return { key: 'file-edit', label: 'Always allow file edits' };
    case 'mcp':
      return { key: `mcp:${tool.server}:${tool.tool}`, label: `Always allow ${tool.server} ${tool.tool}` };
    default:
      return undefined;
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd /e/Efebia/marcode-always-allow && yarn test:unit 2>&1 | tail -30`
Expected: PASS for all `ruleFor` tests. If `git -C x status` yields a rule, fix the `third` check, not the test.

- [ ] **Step 5: Commit**

```bash
cd /e/Efebia/marcode-always-allow && test "$(git branch --show-current)" = feat/always-allow \
  && git add src/host/permission-rules.ts src/test/unit/permission-rules.test.ts \
  && git commit -m "feat: permission rule derivation for always-allow"
```

---

### Task 2: Wire types and router passthrough

**Files:**
- Modify: `src/protocol/messages.ts` (permission item ~line 93; `permission-decision` ~line 552)
- Modify: `src/host/message-router.ts:573-575`
- Modify: `src/host/agent-session.ts:599` (signature only; behavior in Task 3)
- Test: `src/test/unit/message-router.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `alwaysRule?: { label: string }` on the `role: 'permission'` transcript item; `{ t: 'permission-decision'; …; always?: true }`; `AgentSession.respondToPermission(requestId: string, decision: ToolDecision, always?: boolean): void`.

- [ ] **Step 1: Write the failing test** — copy the existing `permission-decision` router test in `src/test/unit/message-router.test.ts` (grep `permission-decision`), then add:

```ts
test('permission-decision forwards always to the session', async () => {
  // build the router/manager exactly as the neighbouring permission-decision test does
  // send: { t: 'permission-decision', id: 's1', requestId: 'r1', decision: { allow: true }, always: true }
  // assert the recorded respondToPermission call args deepStrictEqual ['r1', { allow: true }, true]
});
```

Fill the body by mirroring the neighbouring test's fake session (it records `respondToPermission` args); update its recorder to capture the third argument.

- [ ] **Step 2: Run** `cd /e/Efebia/marcode-always-allow && yarn test:unit 2>&1 | tail -30` → FAIL (third arg undefined / type error).

- [ ] **Step 3: Implement**

`messages.ts` permission item:

```ts
  | (ItemBase & {
      role: 'permission'; requestId: string; tool: ToolCall;
      state: 'pending' | 'allowed' | 'denied'; reason?: string;
      meta?: PermissionMeta;
      /** Present only when Marcode can remember "always allow" for this request. */
      alwaysRule?: { label: string };
    })
```

`permission-decision` message: append `always?: true`:

```ts
  | { t: 'permission-decision'; id: SessionId; requestId: string; decision: ToolDecision; always?: true }
```

`message-router.ts`:

```ts
      case 'permission-decision':
        this.manager.get(msg.id)?.respondToPermission(msg.requestId, msg.decision, msg.always === true);
        return;
```

`agent-session.ts`: `respondToPermission(requestId: string, decision: ToolDecision, _always = false): void` (unused until Task 3).

- [ ] **Step 4: Run** `cd /e/Efebia/marcode-always-allow && yarn check-types && yarn test:unit 2>&1 | tail -30` → PASS (fix any exhaustive-switch fixture in `src/test/unit/protocol.test.ts` if it flags).

- [ ] **Step 5: Commit** (branch assert as in Task 1) `feat: carry always flag on permission-decision`.

---

### Task 3: AgentSession rule store and auto-answer

**Files:**
- Modify: `src/host/agent-session.ts` (fields near line 133; `respondToPermission` line 599; `permission` case line 1108; dispose)
- Test: `src/test/unit/agent-session-always-allow.test.ts` (copy the harness — `baseState`, `RecordingSink`, `settle`, store setup — from the top of `src/test/unit/agent-session.test.ts`)

**Interfaces:**
- Consumes: `ruleFor`, `PermissionRule` (Task 1); `always` param and `alwaysRule` field (Task 2).
- Produces: behavior — matching requests are answered `{allow:true}` immediately; item stored as `state:'allowed'`, `reason:'Auto-allowed: <label>'`; ineligible/no-match requests carry `alwaysRule` only when `ruleFor` returns one.

- [ ] **Step 1: Write failing tests** (harness copied; `ls`-command scripts as in the existing permission test):

```ts
const ls = { kind: 'command', label: 'Bash', command: 'ls' } as const;
const perm = (id: string, tool: object = ls) => ({ kind: 'permission', id, tool }) as const;

test('a pending request carries alwaysRule when a rule is derivable', async () => {
  const provider = new FakeProvider(() => [perm('r1')]);
  const session = new AgentSession(baseState(), provider, store, sink);
  session.send('go'); await settle();
  const item = (await session.snapshot()).items.find((i) => i.role === 'permission');
  assert.deepStrictEqual((item as { alwaysRule?: unknown }).alwaysRule, { label: 'Always allow `ls`' });
  await session.dispose();
});

test('a plan request carries no alwaysRule', async () => {
  const provider = new FakeProvider(() => [perm('r1', { kind: 'plan', label: 'Plan', text: 'x' })]);
  const session = new AgentSession(baseState(), provider, store, sink);
  session.send('go'); await settle();
  const item = (await session.snapshot()).items.find((i) => i.role === 'permission');
  assert.strictEqual('alwaysRule' in (item as object), false);
  await session.dispose();
});

test('always:true stores the rule and the next matching request is auto-allowed', async () => {
  let n = 0;
  const provider = new FakeProvider(() => [perm(`r${++n}`)]);
  const session = new AgentSession(baseState(), provider, store, sink);
  session.send('one'); await settle();
  session.respondToPermission('r1', { allow: true }, true); await settle();
  session.send('two'); await settle();
  assert.deepStrictEqual(provider.decisions.get('r2'), { allow: true });
  assert.notStrictEqual(session.state.status, 'awaiting-approval');
  const items = (await session.snapshot()).items.filter((i) => i.role === 'permission') as
    { state: string; reason?: string }[];
  assert.strictEqual(items[1].state, 'allowed');
  assert.strictEqual(items[1].reason, 'Auto-allowed: Always allow `ls`');
  assert.strictEqual((await session.snapshot()).pending.length, 0);
  await session.dispose();
});

test('a different command is not matched by the rule', async () => {
  const cmds = ['ls', 'pwd'];
  let n = 0;
  const provider = new FakeProvider(() => [
    perm(`r${++n}`, { kind: 'command', label: 'Bash', command: cmds[n - 1] }),
  ]);
  const session = new AgentSession(baseState(), provider, store, sink);
  session.send('one'); await settle();
  session.respondToPermission('r1', { allow: true }, true); await settle();
  session.send('two'); await settle();
  assert.strictEqual(session.state.status, 'awaiting-approval');
  await session.dispose();
});

test('always on a deny, an unknown id or an ineligible request stores nothing', async () => {
  let n = 0;
  const provider = new FakeProvider(() => [perm(`r${++n}`)]);
  const session = new AgentSession(baseState(), provider, store, sink);
  session.send('one'); await settle();
  session.respondToPermission('nope', { allow: true }, true);
  session.respondToPermission('r1', { allow: false, reason: 'x' }, true); await settle();
  session.send('two'); await settle();
  assert.strictEqual(session.state.status, 'awaiting-approval');
  await session.dispose();
});

test('rules are per session', async () => {
  let n = 0;
  const mk = () => new AgentSession(baseState(), new FakeProvider(() => [perm(`r${++n}`)]), store, sink);
  const a = mk(); const b = mk();
  a.send('x'); await settle();
  a.respondToPermission('r1', { allow: true }, true); await settle();
  b.send('x'); await settle();
  assert.strictEqual(b.state.status, 'awaiting-approval');
  await a.dispose(); await b.dispose();
});
```

- [ ] **Step 2: Run** `cd /e/Efebia/marcode-always-allow && yarn test:unit 2>&1 | tail -40` → FAIL.

- [ ] **Step 3: Implement** in `agent-session.ts`:

Import `ruleFor` from `./permission-rules`. Add field next to `pending`:

```ts
  /** Rule keys the user granted "always allow" this run; never persisted. */
  private alwaysAllow = new Set<string>();
```

In `respondToPermission`, before `if (!this.pending.delete(requestId))`:

```ts
    const parked = this.pending.get(requestId);
    const rule = always && decision.allow && parked ? ruleFor(parked.tool) : undefined;
```

and immediately after the `pending.delete` guard: `if (rule) { this.alwaysAllow.add(rule.key); }`.

(Adjust the `_always` param name to `always`.)

In the `permission` case, replace item construction and parking:

```ts
        const rule = ruleFor(event.tool);
        const auto = rule !== undefined && this.alwaysAllow.has(rule.key);
        const meta = event.meta ? { meta: event.meta } : {};
        const item: TranscriptItem = {
          id: nextId('p'), ts: Date.now(), role: 'permission',
          requestId: event.id, tool: event.tool,
          state: auto ? 'allowed' : 'pending',
          ...(auto ? { reason: `Auto-allowed: ${rule.label}` } : {}),
          ...(rule && !auto ? { alwaysRule: { label: rule.label } } : {}),
          ...meta,
        };
        this.permissionItems.set(event.id, item);
        if (!auto) { this.pending.set(event.id, { requestId: event.id, tool: event.tool, ...meta }); }
```

Keep the existing append/nesting block unchanged. Replace the tail (`this.setStatus('awaiting-approval'); …`) with:

```ts
        if (auto) {
          try { this.run.respondToTool(event.id, { allow: true }); }
          catch (err) { this.fail(err instanceof Error ? err.message : String(err)); }
          return;
        }
        this.setStatus('awaiting-approval');
        this.refreshActivityLabel();
        return;
```

`dispose()` needs no change (instance-scoped `Set` dies with the session); add `this.alwaysAllow.clear()` there only if `dispose` already resets other maps.

Also add `alwaysRule` to the reducer's `applyPatch` only if the card reads it from `pending` — it does not (it reads `item`), so no reducer change.

- [ ] **Step 4: Run** `cd /e/Efebia/marcode-always-allow && yarn test:unit 2>&1 | tail -40` → all PASS, including the existing permission tests (they use `ls` commands: confirm none now auto-answer because no rule was granted).

- [ ] **Step 5: Commit** (branch assert) `feat: auto-answer matching permission requests from session rules`.

---

### Task 4: Card UI, compact diff, stable button row

**Files:**
- Modify: `src/webview/components/permission-card.tsx` (live-request block, lines ~150-190)
- Modify: `src/webview/components/tool-body.tsx` (`ToolBody` props + `ClampedLines`, lines 16, 49, 207-240)
- Test: `src/test/dom/permission-card.test.tsx`

**Interfaces:**
- Consumes: `item.alwaysRule` (Task 2); `permission-decision.always` (Task 2).
- Produces: `ToolBody` optional prop `clamp?: { head: number; tail: number }` passed through to `clampLines(text, head, tail)`.

- [ ] **Step 1: Write failing DOM tests** (append to the suite; uses existing `LIVE`, `hydrateWith`):

```ts
  test('Always allow shows only when the item carries a rule', () => {
    renderWithStore(<PermissionCard item={permission({ alwaysRule: { label: 'Always allow file edits' } })} sessionId="a" />);
    hydrateWith(LIVE);
    screen.getByRole('button', { name: 'Always allow file edits' });
  });

  test('no rule, no Always allow button', () => {
    renderWithStore(<PermissionCard item={permission()} sessionId="a" />);
    hydrateWith(LIVE);
    assert.strictEqual(screen.queryAllByRole('button', { name: /always allow/i }).length, 0);
  });

  test('clicking Always allow posts an allow carrying always', async () => {
    renderWithStore(<PermissionCard item={permission({ alwaysRule: { label: 'Always allow file edits' } })} sessionId="a" />);
    hydrateWith(LIVE);
    await userEvent.click(screen.getByRole('button', { name: 'Always allow file edits' }));
    assert.deepStrictEqual(posted().at(-1), {
      t: 'permission-decision', id: 'a', requestId: 'r1', decision: { allow: true }, always: true,
    });
  });

  test('a double click on Always allow posts once', async () => {
    renderWithStore(<PermissionCard item={permission({ alwaysRule: { label: 'Always allow file edits' } })} sessionId="a" />);
    hydrateWith(LIVE);
    const btn = screen.getByRole('button', { name: 'Always allow file edits' });
    await userEvent.click(btn);
    const after = posted().length;
    await userEvent.click(btn);
    assert.strictEqual(posted().length, after);
  });

  test('Deny and Allow stay first in the same order with or without Always allow', () => {
    const names = () => screen.getAllByRole('button').map((b) => b.textContent);
    const first = renderWithStore(<PermissionCard item={permission()} sessionId="a" />);
    hydrateWith(LIVE);
    const without = names().slice(0, 2);
    first.unmount();
    renderWithStore(<PermissionCard item={permission({ alwaysRule: { label: 'Always allow file edits' } })} sessionId="a" />);
    hydrateWith(LIVE);
    assert.deepStrictEqual(names().slice(0, 2), without);
    assert.deepStrictEqual(without, ['Deny', 'Allow']);
  });

  test('a long edit previews compactly with a reveal', () => {
    const after = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    const tool: ToolCall = { kind: 'file-edit', label: 'Write', files: [{ path: '/a', op: 'create', edits: [{ after }] }] };
    renderWithStore(<PermissionCard item={permission({ tool })} sessionId="a" />);
    hydrateWith([{ requestId: 'r1', tool }]);
    screen.getByText(/more lines/);
  });
```

Check `renderWithStore` returns an `unmount` (see `src/test/dom/harness.tsx`); if it does not, render the two cards in separate tests instead.

- [ ] **Step 2: Run** `cd /e/Efebia/marcode-always-allow && yarn test:dom 2>&1 | tail -40` → FAIL.

- [ ] **Step 3: Implement**

`tool-body.tsx`: give `ToolBody` a `clamp?: { head: number; tail: number }` prop, thread it to the `diff` and `command`/`output` `ClampedLines` usages (`ClampedLines` gets the same optional prop and calls `clampLines(lines.join('\n'), clamp?.head, clamp?.tail)` and uses `clamped.tail` accordingly; leave defaults 12/8 for every existing caller).

`permission-card.tsx`: extend `decide`:

```ts
  const decide = (allow: boolean, always = false) => {
    setAnswered(true);
    post({
      t: 'permission-decision', id: sessionId, requestId: item.requestId,
      decision: allow ? { allow: true } : { allow: false, reason: 'Denied by user' },
      ...(always ? { always: true as const } : {}),
    });
  };
```

In the live "Allow X?" block, pass `clamp={{ head: 4, tail: 2 }}` to `ToolBody`, and add after the Allow button (inside the same `flex gap-2` row, so Deny and Allow keep their positions):

```tsx
        {item.alwaysRule && (
          <Button
            variant="ghost"
            size="sm"
            disabled={answered}
            onClick={() => decide(true, true)}
            title={item.alwaysRule.label}
            className="min-w-0 truncate"
          >
            {item.alwaysRule.label}
          </Button>
        )}
```

Change the row to `flex min-w-0 gap-2` and leave the "Deny is first" comment intact. The row stays a fixed sibling below the body, so preview height never moves it.

- [ ] **Step 4: Run** `cd /e/Efebia/marcode-always-allow && yarn test:dom 2>&1 | tail -40` → PASS, including existing tests (their `posted().at(-1)` deepStrictEquals have no `always` key, so the conditional spread must not add one).

- [ ] **Step 5: Commit** (branch assert) `feat: always-allow button and compact diff preview on permission cards`.

---

### Task 5: Gates and impeccable

**Files:** none new.

- [ ] **Step 1: Impeccable.** Invoke the `impeccable` skill for the changed card (button row density at 300-500px, ghost button label truncation, `Operate` mode), apply findings.
- [ ] **Step 2: Detector.** `cd /e/Efebia/marcode-always-allow && node <impeccable-skill-dir>/scripts/detect.mjs --json src/webview/components/permission-card.tsx src/webview/components/tool-body.tsx` → exit 0.
- [ ] **Step 3: Gates**, each pinned: `cd /e/Efebia/marcode-always-allow && yarn lint`; `… && yarn check-types`; `… && yarn run compile`; `… && yarn test:unit`; `… && yarn test:dom`. All pass.
- [ ] **Step 4: Update `AGENTS.md`** table with `src/host/permission-rules.ts` (one row: derives a narrow per-session "always allow" rule from a canonical `ToolCall`; in-memory only) and commit `docs: document permission rules` after the branch assert.
