# OpenCode over ACP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third agent backend — OpenCode, spoken to over the Agent Client Protocol — behind the existing `AgentProvider` interface, with the protocol half written vendor-neutrally so the next ACP agent costs a spawn recipe and a tool mapper.

**Architecture:** `src/providers/acp/` wraps `@agentclientprotocol/sdk`'s `ClientSideConnection` over a spawned child's stdio and translates `session/update` notifications into `AgentEvent`s; it never imports anything OpenCode-specific. `src/providers/opencode/` supplies the spawn recipe, the canonical tool mapping, and the `AgentProvider` implementation. Pure mapping modules are unit-tested against frames captured from the real binary; the run class is tested against a scripted in-process ACP peer.

**Tech Stack:** TypeScript, `@agentclientprotocol/sdk` ^1.3.0, Node 22 `child_process`, mocha (`yarn test:unit`), esbuild.

**Spec:** `docs/superpowers/specs/2026-08-17-opencode-acp-provider-design.md`

## Global Constraints

- Nothing under `src/providers/` imports `vscode`. Registration in `src/extension.ts` is the only place that may.
- `src/protocol/messages.ts` stays types-only. This plan does not modify it.
- Errors are state, never exceptions: a failing backend puts the session into `error` with a transcript item. `setModel`, `setEffort`, `setPermissionMode`, `respondToTool`, `respondToQuestion` return `void` and must never reject.
- Filenames are kebab-case. Component identifiers stay PascalCase.
- `threadScope` for OpenCode is `'cwd'`. A cross-directory `session/load` must never be attempted.
- Percentages, not token counts, on every share. The only permitted token quote is `ContextBreakdown.usedTokens` / `windowTokens`.
- Measured against **opencode 1.18.18**. Protocol version `1`.
- Client capabilities are advertised as `{ fs: { readTextFile: false, writeTextFile: false }, terminal: false }`. Do not implement `readTextFile`, `writeTextFile` or the terminal methods.
- `yarn lint`, `yarn check-types` and `yarn run compile` must pass before every commit.
- Conventional-commit prefixes. No `Co-Authored-By` trailer.

## File Structure

**Create:**

| Path | Responsibility |
|---|---|
| `src/providers/acp/acp-client.ts` | `AcpChild` duplex shape, node-stream → Web-stream adapter, `connectAcp()` |
| `src/providers/acp/map-updates.ts` | `SessionUpdate` → `AgentEvent[]`, `UsageUpdate` → `ContextBreakdown`. Pure. |
| `src/providers/acp/config-options.ts` | `configOptions` → `ModelInfo[]`, current model, mode ids, effort. Pure. |
| `src/providers/acp/permissions.ts` | Option-id selection and the auto-answer policy per `PermissionMode`. Pure. |
| `src/providers/acp/acp-run.ts` | `AcpRun implements AgentRun` — session lifecycle, prompt queue, parked permissions, load-replay gate |
| `src/providers/opencode/opencode-provider.ts` | `OpenCodeProvider implements AgentProvider`, `spawnOpenCodeAcp()` |
| `src/providers/opencode/map-tools.ts` | ACP `ToolCallUpdate` → canonical `ToolCall` / `ToolOutput`. Pure. |
| `src/test/fixtures/opencode-acp-frames.json` | Frames captured from opencode 1.18.18 |
| `src/test/unit/acp-map-updates.test.ts` | |
| `src/test/unit/acp-config-options.test.ts` | |
| `src/test/unit/acp-permissions.test.ts` | |
| `src/test/unit/acp-run.test.ts` | |
| `src/test/unit/opencode-map-tools.test.ts` | |
| `src/test/unit/opencode-provider.test.ts` | |
| `docs/opencode-acp-manual-verification.md` | The manual pass that cannot run in CI |

**Modify:** `package.json` (dependency, `enabledProviders` enum + default, `hiiiidCode.opencode.path`), `src/extension.ts` (registration), `src/shared/providers.ts` (known ids — verify the exact path when you get there), `src/webview/components/mcp-status.ts` (+ its consumer) for the MCP line, `README.md`.

---

### Task 1: Dependency and captured fixtures

**Files:**
- Modify: `package.json`
- Create: `src/test/fixtures/opencode-acp-frames.json`

**Interfaces:**
- Produces: the fixture file, consumed by Tasks 2 and 3.

- [ ] **Step 1: Add the SDK**

```bash
yarn add @agentclientprotocol/sdk@^1.3.0
```

This is the maintained package (1.3.0, 2026-07-21, zero dependencies). It is **not** `@zed-industries/agent-client-protocol`, which is the abandoned predecessor stuck at 0.4.5 and would contradict the wire we measured.

- [ ] **Step 2: Confirm esbuild handles the ESM-only package**

The package is `"type": "module"` with import-only exports; the host bundle is node/CJS. Run `yarn run compile` and confirm it succeeds. If esbuild complains, add `"@agentclientprotocol/sdk"` to the host build's explicitly-bundled set rather than marking it external — an external ESM import would break at runtime in the CJS host.

- [ ] **Step 3: Write the fixture file**

Frames captured from opencode 1.18.18. Copy verbatim:

```json
{
  "initialize": {
    "protocolVersion": 1,
    "agentCapabilities": {
      "loadSession": true,
      "mcpCapabilities": { "http": true, "sse": true },
      "promptCapabilities": { "embeddedContext": true, "image": true },
      "sessionCapabilities": { "close": {}, "fork": {}, "list": {}, "resume": {} }
    },
    "authMethods": [
      { "id": "opencode-login", "name": "Login with opencode",
        "description": "Run `opencode auth login` in the terminal" }
    ],
    "agentInfo": { "name": "OpenCode", "version": "1.18.18" }
  },
  "newSession": {
    "sessionId": "ses_ff0400c8affe2kYFjqc6OUHpG3",
    "configOptions": [
      { "id": "model", "name": "Model", "category": "model", "type": "select",
        "currentValue": "opencode/big-pickle",
        "options": [
          { "value": "opencode/big-pickle", "name": "OpenCode Zen/Big Pickle" },
          { "value": "opencode/hy3-free", "name": "OpenCode Zen/Hy3 Free" }
        ] },
      { "id": "mode", "name": "Session Mode", "category": "mode", "type": "select",
        "currentValue": "build",
        "options": [
          { "value": "build", "name": "build",
            "description": "The default agent. Executes tools based on configured permissions." },
          { "value": "plan", "name": "plan", "description": "Plan mode. Disallows all edit tools." }
        ] }
    ]
  },
  "updates": {
    "agentMessageChunk": {
      "sessionUpdate": "agent_message_chunk",
      "messageId": "msg_00fc001c3001tST90eYIeTsHrL",
      "content": { "type": "text", "text": "Done" }
    },
    "agentThoughtChunk": {
      "sessionUpdate": "agent_thought_chunk",
      "messageId": "msg_00fc001c3001tST90eYIeTsHrL",
      "content": { "type": "text", "text": "I should write the file" }
    },
    "userMessageChunk": {
      "sessionUpdate": "user_message_chunk",
      "messageId": "msg_00fc06fef0011QBpOqce2lnFhS",
      "content": { "type": "text", "text": "Think briefly, then create a file" }
    },
    "bashToolCall": {
      "sessionUpdate": "tool_call",
      "toolCallId": "call_149d4cd4e9d34517851b27d4",
      "title": "bash",
      "kind": "execute",
      "status": "pending",
      "locations": [{ "path": "C:\\Users\\Marco\\AppData\\Local\\Temp\\opencode-acp-spike\\sandbox" }],
      "rawInput": { "cwd": "C:\\Users\\Marco\\AppData\\Local\\Temp\\opencode-acp-spike\\sandbox" }
    },
    "bashToolCallInProgress": {
      "sessionUpdate": "tool_call_update",
      "toolCallId": "call_149d4cd4e9d34517851b27d4",
      "status": "in_progress",
      "kind": "execute",
      "title": "echo hi",
      "locations": [{ "path": "C:\\Users\\Marco\\AppData\\Local\\Temp\\opencode-acp-spike\\sandbox" }],
      "rawInput": { "command": "echo hi", "cwd": "C:\\Users\\Marco\\AppData\\Local\\Temp\\opencode-acp-spike\\sandbox" }
    },
    "bashToolCallCompleted": {
      "sessionUpdate": "tool_call_update",
      "toolCallId": "call_149d4cd4e9d34517851b27d4",
      "status": "completed",
      "title": "echo hi",
      "content": [{ "type": "content", "content": { "type": "text", "text": "hi\r\n" } }],
      "rawOutput": { "output": "hi\r\n", "metadata": { "exit": 0, "truncated": false } }
    },
    "editToolCallCompleted": {
      "sessionUpdate": "tool_call_update",
      "toolCallId": "call_5187bca818b9473c8bbfe792",
      "status": "completed",
      "kind": "edit",
      "title": "notes.txt",
      "locations": [{ "path": "C:\\Users\\Marco\\AppData\\Local\\Temp\\opencode-acp-spike\\sandbox\\notes.txt" }],
      "content": [{ "type": "diff",
        "path": "C:\\Users\\Marco\\AppData\\Local\\Temp\\opencode-acp-spike\\sandbox\\notes.txt",
        "oldText": null, "newText": "hi" }],
      "rawOutput": { "output": "Wrote file successfully." }
    },
    "availableCommands": {
      "sessionUpdate": "available_commands_update",
      "availableCommands": [
        { "name": "customize-opencode", "description": "Use ONLY when the user is editing opencode's own configuration" },
        { "name": "init", "description": "Create or update AGENTS.md" }
      ]
    },
    "usageUpdate": {
      "sessionUpdate": "usage_update",
      "used": 8896,
      "size": 200000,
      "cost": { "amount": 0, "currency": "USD" }
    }
  },
  "requestPermission": {
    "sessionId": "ses_ff03f902affeyFUbwdSgzPrCT2",
    "toolCall": {
      "toolCallId": "call_5187bca818b9473c8bbfe792",
      "title": "C:\\Users\\Marco\\AppData\\Local\\Temp\\opencode-acp-spike\\sandbox\\notes.txt",
      "kind": "edit",
      "status": "pending",
      "locations": [{ "path": "C:\\Users\\Marco\\AppData\\Local\\Temp\\opencode-acp-spike\\sandbox\\notes.txt" }],
      "content": [{ "type": "diff",
        "path": "C:\\Users\\Marco\\AppData\\Local\\Temp\\opencode-acp-spike\\sandbox\\notes.txt",
        "oldText": null, "newText": "hi" }]
    },
    "options": [
      { "optionId": "once", "kind": "allow_once", "name": "Allow once" },
      { "optionId": "always", "kind": "allow_always", "name": "Always allow" },
      { "optionId": "reject", "kind": "reject_once", "name": "Reject" }
    ]
  },
  "promptResponse": {
    "stopReason": "end_turn",
    "usage": { "inputTokens": 160, "outputTokens": 18, "totalTokens": 8777,
               "thoughtTokens": 23, "cachedReadTokens": 8576 }
  }
}
```

Note: the `reject` option in `requestPermission.options` was truncated in the captured log after `"Always allow"`. Confirm its exact `optionId` and `kind` during the Task 11 manual pass and correct the fixture if it differs — the production code reads the ids off the request, so only this test's expectation depends on it.

- [ ] **Step 4: Commit**

```bash
git add package.json yarn.lock src/test/fixtures/opencode-acp-frames.json
git commit -m "chore: add the ACP SDK and captured opencode frames"
```

---

### Task 2: `session/update` → `AgentEvent` (pure)

**Files:**
- Create: `src/providers/acp/map-updates.ts`
- Test: `src/test/unit/acp-map-updates.test.ts`

**Interfaces:**
- Consumes: the Task 1 fixture; `AgentEvent`, `ContextBreakdown`, `ToolCall`, `ToolOutput` from `src/providers/types`.
- Produces:
  - `type AcpToolCall = { toolCallId: string; title?: string; kind?: string; status?: string; rawInput?: unknown; rawOutput?: unknown; content?: unknown[]; locations?: { path: string }[] }`
  - `type ToolMapper = { call(c: AcpToolCall): ToolCall; output(c: AcpToolCall): ToolOutput }`
  - `function toAgentEvents(update: Record<string, unknown>, tools: ToolMapper): AgentEvent[]`
  - `function toContextBreakdown(update: { used: number; size: number }): ContextBreakdown`

- [ ] **Step 1: Write the failing test**

```typescript
import * as assert from 'assert';
import * as frames from '../fixtures/opencode-acp-frames.json';
import { toAgentEvents, toContextBreakdown, type ToolMapper } from '../../providers/acp/map-updates';

// A stand-in vendor mapper: map-updates must stay vendor-neutral, so the test
// proves it delegates rather than classifying anything itself.
const tools: ToolMapper = {
  call: (c) => ({ kind: 'other', label: c.title ?? 'call', raw: c.rawInput }),
  output: () => ({ kind: 'none' }),
};

suite('acp toAgentEvents', () => {
  test('an agent message chunk becomes a text delta', () => {
    assert.deepStrictEqual(toAgentEvents(frames.updates.agentMessageChunk, tools),
      [{ kind: 'text', delta: 'Done' }]);
  });

  test('an agent thought chunk becomes a thinking delta', () => {
    assert.deepStrictEqual(toAgentEvents(frames.updates.agentThoughtChunk, tools),
      [{ kind: 'thinking', delta: 'I should write the file' }]);
  });

  test('a user message chunk is dropped — it only appears during load replay', () => {
    assert.deepStrictEqual(toAgentEvents(frames.updates.userMessageChunk, tools), []);
  });

  test('tool_call becomes tool-start', () => {
    const events = toAgentEvents(frames.updates.bashToolCall, tools);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].kind, 'tool-start');
    assert.strictEqual((events[0] as { id: string }).id, 'call_149d4cd4e9d34517851b27d4');
  });

  test('an in_progress update emits nothing', () => {
    assert.deepStrictEqual(toAgentEvents(frames.updates.bashToolCallInProgress, tools), []);
  });

  test('a completed update becomes tool-end and re-sends the tool', () => {
    const events = toAgentEvents(frames.updates.bashToolCallCompleted, tools);
    assert.strictEqual(events.length, 1);
    const end = events[0] as { kind: string; id: string; ok: boolean; tool?: unknown };
    assert.strictEqual(end.kind, 'tool-end');
    assert.strictEqual(end.ok, true);
    // The command only ever arrives on the update — a tool-end without `tool`
    // would leave the card showing a shell call with no command forever.
    assert.strictEqual(end.tool !== undefined, true);
  });

  test('a failed update reports ok: false', () => {
    const events = toAgentEvents(
      { ...frames.updates.bashToolCallCompleted, status: 'failed' }, tools);
    assert.strictEqual((events[0] as { ok: boolean }).ok, false);
  });

  test('available_commands_update becomes a full invocables replacement', () => {
    assert.deepStrictEqual(toAgentEvents(frames.updates.availableCommands, tools), [{
      kind: 'invocables',
      entries: [
        { name: 'customize-opencode',
          description: "Use ONLY when the user is editing opencode's own configuration" },
        { name: 'init', description: 'Create or update AGENTS.md' },
      ],
    }]);
  });

  test('usage_update emits no event — it feeds contextBreakdown instead', () => {
    assert.deepStrictEqual(toAgentEvents(frames.updates.usageUpdate, tools), []);
  });

  test('an unknown variant is ignored rather than throwing', () => {
    assert.deepStrictEqual(toAgentEvents({ sessionUpdate: 'session_info_update' }, tools), []);
  });
});

suite('acp toContextBreakdown', () => {
  test('reports conversation and free as percentages of the window', () => {
    assert.deepStrictEqual(toContextBreakdown({ used: 50000, size: 200000 }), {
      systemPercent: 0, memoryPercent: 0, conversationPercent: 25, freePercent: 75,
      memoryFiles: [], usedTokens: 50000, windowTokens: 200000,
    });
  });

  test('the four percentages still sum to 100 when the division is not exact', () => {
    const b = toContextBreakdown({ used: 8896, size: 200000 });
    assert.strictEqual(
      b.systemPercent + b.memoryPercent + b.conversationPercent + b.freePercent, 100);
  });

  test('a used figure above the window clamps rather than reporting negative free space', () => {
    const b = toContextBreakdown({ used: 250000, size: 200000 });
    assert.strictEqual(b.conversationPercent, 100);
    assert.strictEqual(b.freePercent, 0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `yarn test:unit --grep "acp toAgentEvents"`
Expected: FAIL — cannot find module `../../providers/acp/map-updates`.

- [ ] **Step 3: Implement**

```typescript
import type { AgentEvent, ContextBreakdown, Invocable, ToolCall, ToolOutput } from '../types';

/** One ACP tool call, narrowed to the fields every ACP agent populates. */
export interface AcpToolCall {
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: unknown[];
  locations?: { path: string }[];
}

/**
 * The vendor half. `map-updates` decides WHICH events an update produces;
 * the mapper decides what a tool call IS. Keeping them apart is what makes
 * this file reusable by a second ACP agent.
 */
export interface ToolMapper {
  call(c: AcpToolCall): ToolCall;
  output(c: AcpToolCall): ToolOutput;
}

const textOf = (content: unknown): string | undefined => {
  const block = content as { type?: string; text?: string } | undefined;
  return block?.type === 'text' ? block.text ?? '' : undefined;
};

export function toAgentEvents(update: Record<string, unknown>, tools: ToolMapper): AgentEvent[] {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      const delta = textOf(update.content);
      return delta === undefined ? [] : [{ kind: 'text', delta }];
    }
    case 'agent_thought_chunk': {
      const delta = textOf(update.content);
      return delta === undefined ? [] : [{ kind: 'thinking', delta }];
    }
    case 'tool_call': {
      const call = update as unknown as AcpToolCall;
      return [{ kind: 'tool-start', id: call.toolCallId, tool: tools.call(call) }];
    }
    case 'tool_call_update': {
      const call = update as unknown as AcpToolCall;
      if (call.status !== 'completed' && call.status !== 'failed') { return []; }
      // `tool` is re-sent deliberately: opencode's `tool_call` for bash carries
      // no command at all, and only this update has `rawInput.command`.
      return [{
        kind: 'tool-end', id: call.toolCallId, ok: call.status === 'completed',
        output: tools.output(call), tool: tools.call(call),
      }];
    }
    case 'available_commands_update': {
      const raw = (update.availableCommands ?? []) as { name: string; description?: string }[];
      const entries: Invocable[] = raw.map((c) => (
        c.description === undefined ? { name: c.name } : { name: c.name, description: c.description }
      ));
      return [{ kind: 'invocables', entries }];
    }
    // `user_message_chunk` arrives only while a session/load replays history we
    // already hold; `usage_update` feeds contextBreakdown, not the stream.
    // Everything else is a variant this agent version does not send, and an
    // unknown variant must never take a session down.
    default:
      return [];
  }
}

/**
 * OpenCode reports one undifferentiated total, so `systemPercent` and
 * `memoryPercent` are 0 rather than guessed at: inventing a split would put
 * percentages on screen that the provider never reported.
 */
export function toContextBreakdown(update: { used: number; size: number }): ContextBreakdown {
  const size = update.size > 0 ? update.size : 1;
  const used = Math.max(0, Math.min(update.used, size));
  const conversationPercent = Math.round((used / size) * 100);
  return {
    systemPercent: 0,
    memoryPercent: 0,
    conversationPercent,
    freePercent: 100 - conversationPercent,
    memoryFiles: [],
    usedTokens: update.used,
    windowTokens: update.size,
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `yarn test:unit --grep "acp to"`
Expected: PASS. Then `yarn lint && yarn check-types`.

- [ ] **Step 5: Commit**

```bash
git add src/providers/acp/map-updates.ts src/test/unit/acp-map-updates.test.ts
git commit -m "feat: map ACP session updates onto agent events"
```

---

### Task 3: OpenCode tool mapping (pure)

**Files:**
- Create: `src/providers/opencode/map-tools.ts`
- Test: `src/test/unit/opencode-map-tools.test.ts`

**Interfaces:**
- Consumes: `AcpToolCall`, `ToolMapper` from Task 2.
- Produces: `const openCodeTools: ToolMapper` (exported as `openCodeTools`), with `toToolCall(c: AcpToolCall): ToolCall` and `toToolOutput(c: AcpToolCall): ToolOutput` exported for direct testing.

- [ ] **Step 1: Write the failing test**

```typescript
import * as assert from 'assert';
import * as frames from '../fixtures/opencode-acp-frames.json';
import { toToolCall, toToolOutput } from '../../providers/opencode/map-tools';
import type { AcpToolCall } from '../../providers/acp/map-updates';

suite('opencode toToolCall', () => {
  test('an execute call carries the command and cwd', () => {
    assert.deepStrictEqual(
      toToolCall(frames.updates.bashToolCallInProgress as unknown as AcpToolCall), {
        kind: 'command', label: 'Shell', command: 'echo hi',
        cwd: 'C:/Users/Marco/AppData/Local/Temp/opencode-acp-spike/sandbox',
      });
  });

  test('an execute call with no command yet falls back to the title', () => {
    assert.deepStrictEqual(
      toToolCall(frames.updates.bashToolCall as unknown as AcpToolCall), {
        kind: 'command', label: 'Shell', command: 'bash',
        cwd: 'C:/Users/Marco/AppData/Local/Temp/opencode-acp-spike/sandbox',
      });
  });

  test('an edit call becomes a file-edit with before/after and POSIX separators', () => {
    assert.deepStrictEqual(
      toToolCall(frames.updates.editToolCallCompleted as unknown as AcpToolCall), {
        kind: 'file-edit', label: 'Edit',
        files: [{
          path: 'C:/Users/Marco/AppData/Local/Temp/opencode-acp-spike/sandbox/notes.txt',
          op: 'create',
          edits: [{ after: 'hi' }],
        }],
      });
  });

  test('an edit over existing text is a modify, not a create', () => {
    const call = {
      toolCallId: 't', kind: 'edit', title: 'a.ts',
      content: [{ type: 'diff', path: '/w/a.ts', oldText: 'before', newText: 'after' }],
    } as unknown as AcpToolCall;
    assert.deepStrictEqual(toToolCall(call), {
      kind: 'file-edit', label: 'Edit',
      files: [{ path: '/w/a.ts', op: 'modify', edits: [{ before: 'before', after: 'after' }] }],
    });
  });

  test('a read call becomes file-read from its location', () => {
    const call = {
      toolCallId: 't', kind: 'read', title: 'read', locations: [{ path: '/w/a.ts' }],
    } as unknown as AcpToolCall;
    assert.deepStrictEqual(toToolCall(call),
      { kind: 'file-read', label: 'Read', path: '/w/a.ts' });
  });

  test('an unknown kind falls through to other, carrying its raw input', () => {
    const call = {
      toolCallId: 't', kind: 'fetch', title: 'grab it', rawInput: { url: 'https://x' },
    } as unknown as AcpToolCall;
    assert.deepStrictEqual(toToolCall(call),
      { kind: 'other', label: 'grab it', raw: { url: 'https://x' } });
  });
});

suite('opencode toToolOutput', () => {
  test('text content becomes text output', () => {
    assert.deepStrictEqual(
      toToolOutput(frames.updates.bashToolCallCompleted as unknown as AcpToolCall),
      { kind: 'text', text: 'hi\r\n' });
  });

  test('an edit reports none — its diff belongs to the call', () => {
    assert.deepStrictEqual(
      toToolOutput(frames.updates.editToolCallCompleted as unknown as AcpToolCall),
      { kind: 'none' });
  });

  test('a call with no content at all reports none', () => {
    assert.deepStrictEqual(toToolOutput({ toolCallId: 't' }), { kind: 'none' });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `yarn test:unit --grep "opencode to"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
import type { FileEdit, ToolCall, ToolOutput } from '../types';
import type { AcpToolCall, ToolMapper } from '../acp/map-updates';

/** Absolute paths reach the transcript with POSIX separators — the spelling
 *  `claim-paths.ts` expects when it attributes a fleet-diff row. */
const posix = (p: string): string => p.replace(/\\/g, '/');

interface DiffBlock { type: 'diff'; path: string; oldText?: string | null; newText?: string | null }
interface ContentBlock { type: 'content'; content?: { type?: string; text?: string } }

const diffs = (c: AcpToolCall): DiffBlock[] =>
  (c.content ?? []).filter((b): b is DiffBlock => (b as DiffBlock)?.type === 'diff');

export function toToolCall(c: AcpToolCall): ToolCall {
  const raw = (c.rawInput ?? {}) as { command?: string; cwd?: string };
  switch (c.kind) {
    case 'execute': {
      // `tool_call` arrives with no command and only `cwd`; the command lands
      // on the following `tool_call_update`. The title is the best stand-in
      // until it does.
      const command = raw.command ?? c.title ?? 'shell';
      return raw.cwd
        ? { kind: 'command', label: 'Shell', command, cwd: posix(raw.cwd) }
        : { kind: 'command', label: 'Shell', command };
    }
    case 'edit': {
      const files: FileEdit[] = diffs(c).map((d) => ({
        path: posix(d.path),
        op: d.oldText ? 'modify' : 'create',
        edits: [d.oldText ? { before: d.oldText, after: d.newText ?? '' }
                          : { after: d.newText ?? '' }],
      }));
      return { kind: 'file-edit', label: 'Edit', files };
    }
    case 'read': {
      const path = c.locations?.[0]?.path;
      if (path) { return { kind: 'file-read', label: 'Read', path: posix(path) }; }
      break;
    }
    default:
      break;
  }
  // No substring classification on the tool name. An unrecognised kind is
  // rendered as itself rather than guessed into the wrong card.
  return { kind: 'other', label: c.title ?? c.kind ?? 'Tool', raw: c.rawInput };
}

export function toToolOutput(c: AcpToolCall): ToolOutput {
  if (c.kind === 'edit') { return { kind: 'none' }; }
  const text = (c.content ?? [])
    .filter((b): b is ContentBlock => (b as ContentBlock)?.type === 'content')
    .map((b) => b.content?.text ?? '')
    .join('');
  return text ? { kind: 'text', text } : { kind: 'none' };
}

export const openCodeTools: ToolMapper = { call: toToolCall, output: toToolOutput };
```

- [ ] **Step 4: Run the tests**

Run: `yarn test:unit --grep "opencode to"`
Expected: PASS. Then `yarn lint && yarn check-types`.

- [ ] **Step 5: Commit**

```bash
git add src/providers/opencode/map-tools.ts src/test/unit/opencode-map-tools.test.ts
git commit -m "feat: map opencode tool calls onto the canonical layer"
```

---

### Task 4: Config options → models, modes, effort (pure)

**Files:**
- Create: `src/providers/acp/config-options.ts`
- Test: `src/test/unit/acp-config-options.test.ts`

**Interfaces:**
- Consumes: `ModelInfo`, `EffortLevel` from `src/providers/types`.
- Produces:
  - `interface ConfigOption { id: string; name?: string; category?: string; type?: string; currentValue?: string; options?: { value: string; name?: string; description?: string }[] }`
  - `function toModels(options: ConfigOption[]): ModelInfo[]`
  - `function currentModelId(options: ConfigOption[]): string | undefined`
  - `function modelConfigId(options: ConfigOption[]): string | undefined`
  - `function toModeIds(options: ConfigOption[]): string[]`

- [ ] **Step 1: Write the failing test**

```typescript
import * as assert from 'assert';
import * as frames from '../fixtures/opencode-acp-frames.json';
import { currentModelId, modelConfigId, toModeIds, toModels }
  from '../../providers/acp/config-options';
import type { ConfigOption } from '../../providers/acp/config-options';

const options = frames.newSession.configOptions as unknown as ConfigOption[];

suite('acp config options', () => {
  test('the model option becomes the model catalog', () => {
    assert.deepStrictEqual(toModels(options), [
      { id: 'opencode/big-pickle', displayName: 'OpenCode Zen/Big Pickle' },
      { id: 'opencode/hy3-free', displayName: 'OpenCode Zen/Hy3 Free' },
    ]);
  });

  test('a model row with no name displays its own id', () => {
    const opts: ConfigOption[] = [
      { id: 'model', category: 'model', options: [{ value: 'x/y' }] }];
    assert.deepStrictEqual(toModels(opts), [{ id: 'x/y', displayName: 'x/y' }]);
  });

  test('no model option means an empty catalog, which means unavailable', () => {
    assert.deepStrictEqual(toModels([{ id: 'mode', category: 'mode', options: [] }]), []);
  });

  test('the current value and the option id are reported for set_config_option', () => {
    assert.strictEqual(currentModelId(options), 'opencode/big-pickle');
    assert.strictEqual(modelConfigId(options), 'model');
  });

  test('mode ids come off the mode option', () => {
    assert.deepStrictEqual(toModeIds(options), ['build', 'plan']);
  });

  test('no mode option means no modes rather than an invented default', () => {
    assert.deepStrictEqual(toModeIds([{ id: 'model', category: 'model', options: [] }]), []);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `yarn test:unit --grep "acp config options"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
import type { ModelInfo } from '../types';

export interface ConfigOption {
  id: string;
  name?: string;
  category?: string;
  type?: string;
  currentValue?: string;
  options?: { value: string; name?: string; description?: string }[];
}

const byCategory = (options: ConfigOption[], category: string): ConfigOption | undefined =>
  options.find((o) => o.category === category);

/**
 * The catalog IS the availability signal: an agent that reports no model
 * option reports no models, and `SessionManager` reads that as unavailable.
 * There is deliberately no fallback list here.
 */
export function toModels(options: ConfigOption[]): ModelInfo[] {
  const model = byCategory(options, 'model');
  return (model?.options ?? []).map((o) => ({ id: o.value, displayName: o.name ?? o.value }));
}

export function currentModelId(options: ConfigOption[]): string | undefined {
  return byCategory(options, 'model')?.currentValue;
}

/** The id to pass to `session/set_config_option`; `'model'` on opencode 1.18.18. */
export function modelConfigId(options: ConfigOption[]): string | undefined {
  return byCategory(options, 'model')?.id;
}

export function toModeIds(options: ConfigOption[]): string[] {
  return (byCategory(options, 'mode')?.options ?? []).map((o) => o.value);
}
```

- [ ] **Step 4: Run the tests**

Run: `yarn test:unit --grep "acp config options"`
Expected: PASS. Then `yarn lint && yarn check-types`.

- [ ] **Step 5: Commit**

```bash
git add src/providers/acp/config-options.ts src/test/unit/acp-config-options.test.ts
git commit -m "feat: read models and modes off ACP config options"
```

---

### Task 5: Permission option selection and mode policy (pure)

**Files:**
- Create: `src/providers/acp/permissions.ts`
- Test: `src/test/unit/acp-permissions.test.ts`

**Interfaces:**
- Consumes: `PermissionMode`, `ToolDecision` from `src/providers/types`.
- Produces:
  - `interface PermissionOption { optionId: string; kind?: string; name?: string }`
  - `function chooseOption(options: PermissionOption[], decision: ToolDecision): { outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } }`
  - `function autoDecision(mode: PermissionMode): ToolDecision | undefined` — `undefined` means "surface a card to the user"

- [ ] **Step 1: Write the failing test**

```typescript
import * as assert from 'assert';
import * as frames from '../fixtures/opencode-acp-frames.json';
import { autoDecision, chooseOption, type PermissionOption }
  from '../../providers/acp/permissions';

const options = frames.requestPermission.options as PermissionOption[];

suite('acp chooseOption', () => {
  test('an allow selects the allow_once option by the id the request gave', () => {
    assert.deepStrictEqual(chooseOption(options, { allow: true }),
      { outcome: { outcome: 'selected', optionId: 'once' } });
  });

  test('a deny selects a reject option', () => {
    assert.deepStrictEqual(chooseOption(options, { allow: false }),
      { outcome: { outcome: 'selected', optionId: 'reject' } });
  });

  test('ids are never assumed — a differently-named allow option still works', () => {
    const custom: PermissionOption[] = [{ optionId: 'yes-please', kind: 'allow_once' }];
    assert.deepStrictEqual(chooseOption(custom, { allow: true }),
      { outcome: { outcome: 'selected', optionId: 'yes-please' } });
  });

  test('a deny with no reject option offered cancels rather than allowing', () => {
    const allowOnly: PermissionOption[] = [{ optionId: 'once', kind: 'allow_once' }];
    assert.deepStrictEqual(chooseOption(allowOnly, { allow: false }),
      { outcome: { outcome: 'cancelled' } });
  });

  test('an allow with no allow option offered cancels rather than picking blindly', () => {
    const rejectOnly: PermissionOption[] = [{ optionId: 'no', kind: 'reject_once' }];
    assert.deepStrictEqual(chooseOption(rejectOnly, { allow: true }),
      { outcome: { outcome: 'cancelled' } });
  });

  test('an empty option list cancels', () => {
    assert.deepStrictEqual(chooseOption([], { allow: true }), { outcome: { outcome: 'cancelled' } });
  });
});

suite('acp autoDecision', () => {
  test('bypass allows without surfacing a card', () => {
    assert.deepStrictEqual(autoDecision('bypass'), { allow: true });
  });

  test('dontAsk denies without surfacing a card', () => {
    assert.deepStrictEqual(autoDecision('dontAsk'), { allow: false });
  });

  test('default and plan surface the request to the user', () => {
    assert.strictEqual(autoDecision('default'), undefined);
    assert.strictEqual(autoDecision('plan'), undefined);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `yarn test:unit --grep "acp chooseOption"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
import type { PermissionMode, ToolDecision } from '../types';

export interface PermissionOption { optionId: string; kind?: string; name?: string }

export type PermissionOutcome =
  | { outcome: { outcome: 'selected'; optionId: string } }
  | { outcome: { outcome: 'cancelled' } };

const ALLOW_KINDS = ['allow_once', 'allow_always'];
const REJECT_KINDS = ['reject_once', 'reject_always'];

/**
 * The option id is read off the request, never assumed. opencode 1.18.18
 * happens to use `once`/`always`, but the ids are the agent's to choose and a
 * hardcoded string is a bug waiting for the next ACP agent.
 */
export function chooseOption(options: PermissionOption[], decision: ToolDecision): PermissionOutcome {
  const wanted = decision.allow ? ALLOW_KINDS : REJECT_KINDS;
  for (const kind of wanted) {
    const match = options.find((o) => o.kind === kind);
    if (match) { return { outcome: { outcome: 'selected', optionId: match.optionId } }; }
  }
  // Nothing of the requested sort was offered. Cancelling is the only honest
  // answer: picking the other sort would invert the user's decision.
  return { outcome: { outcome: 'cancelled' } };
}

/**
 * `bypass` and `dontAsk` are enforced here rather than on the wire, because
 * ACP hands the decision to the client. If the agent never asks, that is the
 * user's own opencode.json already permitting the call — which is what both
 * modes mean anyway.
 */
export function autoDecision(mode: PermissionMode): ToolDecision | undefined {
  if (mode === 'bypass') { return { allow: true }; }
  if (mode === 'dontAsk') { return { allow: false }; }
  return undefined;
}
```

- [ ] **Step 4: Run the tests**

Run: `yarn test:unit --grep "acp "`
Expected: PASS (all three ACP suites so far). Then `yarn lint && yarn check-types`.

- [ ] **Step 5: Commit**

```bash
git add src/providers/acp/permissions.ts src/test/unit/acp-permissions.test.ts
git commit -m "feat: choose ACP permission options off the request"
```

---

### Task 6: The ACP connection

**Files:**
- Create: `src/providers/acp/acp-client.ts`
- Test: covered indirectly by Task 7's scripted peer; no separate test file.

**Interfaces:**
- Consumes: `@agentclientprotocol/sdk` (`ClientSideConnection`, `ndJsonStream`, `Client`).
- Produces:
  - `interface AcpChild { stdin: NodeJS.WritableStream; stdout: NodeJS.ReadableStream; kill(): void; onFailure?(cb: (reason: string) => void): void }` — the same injectable shape `Duplex` has in `src/providers/codex/app-server.ts`, so tests never spawn anything.
  - `const CLIENT_CAPABILITIES` — the frozen capability object.
  - `function connectAcp(child: AcpChild, handlers: { sessionUpdate(params: unknown): void; requestPermission(params: unknown): Promise<unknown> }): ClientSideConnection`

- [ ] **Step 1: Implement**

```typescript
import { ClientSideConnection, ndJsonStream, type Client } from '@agentclientprotocol/sdk';

/** The child process narrowed to what this module uses, so tests inject a pair
 *  of PassThroughs instead of spawning a binary. Mirrors `Duplex` in
 *  `src/providers/codex/app-server.ts`. */
export interface AcpChild {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  kill(): void;
  onFailure?(cb: (reason: string) => void): void;
}

/**
 * We advertise no filesystem and no terminal. OpenCode calls
 * `fs/write_text_file` regardless, takes the method-not-found, and falls back
 * to its own IO — measured on 1.18.18 — so refusing costs nothing and keeps
 * the host out of the file-writing business. That also keeps fleet-diff
 * attribution reading the transcript rather than our own writes.
 */
export const CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
} as const;

export const PROTOCOL_VERSION = 1;

export interface AcpHandlers {
  sessionUpdate(params: unknown): void;
  requestPermission(params: unknown): Promise<unknown>;
}

/**
 * Node streams to Web streams, which is what `ndJsonStream` takes. `Readable`
 * and `Writable` both expose `toWeb` in Node 22.
 */
export function connectAcp(child: AcpChild, handlers: AcpHandlers): ClientSideConnection {
  const { Readable, Writable } = require('node:stream') as typeof import('node:stream');
  const input = Readable.toWeb(child.stdout as import('node:stream').Readable);
  const output = Writable.toWeb(child.stdin as import('node:stream').Writable);
  const stream = ndJsonStream(output as WritableStream<Uint8Array>,
    input as ReadableStream<Uint8Array>);

  const toClient = (): Client => ({
    sessionUpdate: (params) => { handlers.sessionUpdate(params); },
    requestPermission: (params) => handlers.requestPermission(params) as never,
    // readTextFile / writeTextFile / terminal methods are deliberately absent:
    // an absent handler is what produces the method-not-found the agent
    // expects from a client that advertised the capability as false.
  });

  return new ClientSideConnection(toClient, stream);
}
```

If `require` in an ESM-authored file trips the lint rules, use a top-level `import { Readable, Writable } from 'node:stream';` instead — the repo's host bundle is CJS, so either form compiles; follow whichever the neighbouring provider files use.

- [ ] **Step 2: Verify it compiles**

Run: `yarn check-types && yarn run compile`
Expected: both succeed. This task has no behaviour of its own to test — Task 7 exercises it end to end.

- [ ] **Step 3: Commit**

```bash
git add src/providers/acp/acp-client.ts
git commit -m "feat: wire an ACP client connection over child stdio"
```

---

### Task 7: `AcpRun` — one session

**Files:**
- Create: `src/providers/acp/acp-run.ts`
- Test: `src/test/unit/acp-run.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 4, 5, 6.
- Produces: `class AcpRun implements AgentRun` with constructor
  `new AcpRun(child: AcpChild, opts: { cwd: string; model?: string; permissionMode: PermissionMode; resumeToken?: string; tools: ToolMapper; clientName: string })`
  and the extra members `onSessionConfig(cb: (options: ConfigOption[]) => void): void`.

- [ ] **Step 1: Write the failing test**

The peer is a scripted ACP agent over a pair of `PassThrough` streams — the same technique `codex-app-server.test.ts` uses, one layer up.

```typescript
import * as assert from 'assert';
import { PassThrough } from 'node:stream';
import * as frames from '../fixtures/opencode-acp-frames.json';
import { AcpRun } from '../../providers/acp/acp-run';
import { openCodeTools } from '../../providers/opencode/map-tools';
import type { AgentEvent } from '../../providers/types';

/** A scripted ACP agent. `sent` records what the run wrote; `emit` pushes a
 *  frame back at it. */
function peer() {
  const toAgent = new PassThrough();
  const toClient = new PassThrough();
  const sent: Record<string, unknown>[] = [];
  toAgent.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) { sent.push(JSON.parse(line)); }
    }
  });
  const emit = (frame: unknown): void => { toClient.write(`${JSON.stringify(frame)}\n`); };
  const child = { stdin: toAgent, stdout: toClient, kill: () => { toClient.end(); } };
  const waitFor = async (method: string): Promise<Record<string, unknown>> => {
    for (let i = 0; i < 200; i++) {
      const hit = sent.find((f) => f.method === method);
      if (hit) { return hit; }
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`no ${method} was sent`);
  };
  return { child, sent, emit, waitFor };
}

const collect = (run: AcpRun, into: AgentEvent[]): void => {
  void (async () => { for await (const e of run.events) { into.push(e); } })();
};

suite('AcpRun', () => {
  test('initializes with protocol version 1 and no fs or terminal capability', async () => {
    const p = peer();
    const run = new AcpRun(p.child, {
      cwd: '/w', permissionMode: 'default', tools: openCodeTools, clientName: 'hiiiid-code',
    });
    const init = await p.waitFor('initialize');
    assert.deepStrictEqual((init.params as { clientCapabilities: unknown }).clientCapabilities, {
      fs: { readTextFile: false, writeTextFile: false }, terminal: false,
    });
    assert.strictEqual((init.params as { protocolVersion: number }).protocolVersion, 1);
    await run.dispose();
  });

  test('emits a session event carrying the session id as the resume token', async () => {
    const p = peer();
    const events: AgentEvent[] = [];
    const run = new AcpRun(p.child, {
      cwd: '/w', permissionMode: 'default', tools: openCodeTools, clientName: 'hiiiid-code',
    });
    collect(run, events);
    const init = await p.waitFor('initialize');
    p.emit({ jsonrpc: '2.0', id: init.id, result: frames.initialize });
    const created = await p.waitFor('session/new');
    p.emit({ jsonrpc: '2.0', id: created.id, result: frames.newSession });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepStrictEqual(events[0],
      { kind: 'session', resumeToken: 'ses_ff0400c8affe2kYFjqc6OUHpG3' });
    await run.dispose();
  });

  test('a session update reaches the event stream', async () => {
    const p = peer();
    const events: AgentEvent[] = [];
    const run = new AcpRun(p.child, {
      cwd: '/w', permissionMode: 'default', tools: openCodeTools, clientName: 'hiiiid-code',
    });
    collect(run, events);
    const init = await p.waitFor('initialize');
    p.emit({ jsonrpc: '2.0', id: init.id, result: frames.initialize });
    const created = await p.waitFor('session/new');
    p.emit({ jsonrpc: '2.0', id: created.id, result: frames.newSession });
    await new Promise((r) => setTimeout(r, 20));
    p.emit({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: 'ses_ff0400c8affe2kYFjqc6OUHpG3', update: frames.updates.agentMessageChunk } });
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(events.some((e) => e.kind === 'text' && e.delta === 'Done'), true);
    await run.dispose();
  });

  test('a permission request under default mode parks as a permission event', async () => {
    const p = peer();
    const events: AgentEvent[] = [];
    const run = new AcpRun(p.child, {
      cwd: '/w', permissionMode: 'default', tools: openCodeTools, clientName: 'hiiiid-code',
    });
    collect(run, events);
    const init = await p.waitFor('initialize');
    p.emit({ jsonrpc: '2.0', id: init.id, result: frames.initialize });
    const created = await p.waitFor('session/new');
    p.emit({ jsonrpc: '2.0', id: created.id, result: frames.newSession });
    await new Promise((r) => setTimeout(r, 20));
    p.emit({ jsonrpc: '2.0', id: 900, method: 'session/request_permission',
             params: frames.requestPermission });
    await new Promise((r) => setTimeout(r, 20));
    const parked = events.find((e) => e.kind === 'permission');
    assert.strictEqual(parked !== undefined, true);
    run.respondToTool((parked as { id: string }).id, { allow: true });
    await new Promise((r) => setTimeout(r, 20));
    const reply = p.sent.find((f) => f.id === 900 && f.result !== undefined);
    assert.deepStrictEqual(reply?.result,
      { outcome: { outcome: 'selected', optionId: 'once' } });
    await run.dispose();
  });

  test('bypass answers the permission itself and surfaces no card', async () => {
    const p = peer();
    const events: AgentEvent[] = [];
    const run = new AcpRun(p.child, {
      cwd: '/w', permissionMode: 'bypass', tools: openCodeTools, clientName: 'hiiiid-code',
    });
    collect(run, events);
    const init = await p.waitFor('initialize');
    p.emit({ jsonrpc: '2.0', id: init.id, result: frames.initialize });
    const created = await p.waitFor('session/new');
    p.emit({ jsonrpc: '2.0', id: created.id, result: frames.newSession });
    await new Promise((r) => setTimeout(r, 20));
    p.emit({ jsonrpc: '2.0', id: 901, method: 'session/request_permission',
             params: frames.requestPermission });
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(events.some((e) => e.kind === 'permission'), false);
    const reply = p.sent.find((f) => f.id === 901 && f.result !== undefined);
    assert.deepStrictEqual(reply?.result,
      { outcome: { outcome: 'selected', optionId: 'always' } });
    await run.dispose();
  });

  test('contextBreakdown reports the last usage update', async () => {
    const p = peer();
    const run = new AcpRun(p.child, {
      cwd: '/w', permissionMode: 'default', tools: openCodeTools, clientName: 'hiiiid-code',
    });
    collect(run, []);
    const init = await p.waitFor('initialize');
    p.emit({ jsonrpc: '2.0', id: init.id, result: frames.initialize });
    const created = await p.waitFor('session/new');
    p.emit({ jsonrpc: '2.0', id: created.id, result: frames.newSession });
    await new Promise((r) => setTimeout(r, 20));
    p.emit({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: 'ses_ff0400c8affe2kYFjqc6OUHpG3', update: frames.updates.usageUpdate } });
    await new Promise((r) => setTimeout(r, 20));
    const breakdown = await run.contextBreakdown!();
    assert.strictEqual(breakdown.windowTokens, 200000);
    assert.strictEqual(breakdown.usedTokens, 8896);
    await run.dispose();
  });

  test('a replayed update during session/load is suppressed', async () => {
    const p = peer();
    const events: AgentEvent[] = [];
    const run = new AcpRun(p.child, {
      cwd: '/w', permissionMode: 'default', tools: openCodeTools, clientName: 'hiiiid-code',
      resumeToken: 'ses_old',
    });
    collect(run, events);
    const init = await p.waitFor('initialize');
    p.emit({ jsonrpc: '2.0', id: init.id, result: frames.initialize });
    await p.waitFor('session/load');
    p.emit({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: 'ses_old', update: frames.updates.agentMessageChunk } });
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(events.some((e) => e.kind === 'text'), false);
    await run.dispose();
  });

  test('setModel writes the model config option', async () => {
    const p = peer();
    const run = new AcpRun(p.child, {
      cwd: '/w', permissionMode: 'default', tools: openCodeTools, clientName: 'hiiiid-code',
    });
    collect(run, []);
    const init = await p.waitFor('initialize');
    p.emit({ jsonrpc: '2.0', id: init.id, result: frames.initialize });
    const created = await p.waitFor('session/new');
    p.emit({ jsonrpc: '2.0', id: created.id, result: frames.newSession });
    await new Promise((r) => setTimeout(r, 20));
    run.setModel('opencode/hy3-free');
    const set = await p.waitFor('session/set_config_option');
    assert.deepStrictEqual(set.params, {
      sessionId: 'ses_ff0400c8affe2kYFjqc6OUHpG3', configId: 'model', value: 'opencode/hy3-free',
    });
    await run.dispose();
  });

  test('a rejected setter never rejects to the caller', async () => {
    const p = peer();
    const run = new AcpRun(p.child, {
      cwd: '/w', permissionMode: 'default', tools: openCodeTools, clientName: 'hiiiid-code',
    });
    collect(run, []);
    const init = await p.waitFor('initialize');
    p.emit({ jsonrpc: '2.0', id: init.id, result: frames.initialize });
    const created = await p.waitFor('session/new');
    p.emit({ jsonrpc: '2.0', id: created.id, result: frames.newSession });
    await new Promise((r) => setTimeout(r, 20));
    run.setModel('nope');
    const set = await p.waitFor('session/set_config_option');
    p.emit({ jsonrpc: '2.0', id: set.id,
             error: { code: -32602, message: 'model not found: nope' } });
    // The assertion is that this test finishes without an unhandled rejection.
    await new Promise((r) => setTimeout(r, 30));
    await run.dispose();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `yarn test:unit --grep "AcpRun"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Write `src/providers/acp/acp-run.ts` satisfying the tests above. The shape:

```typescript
import { connectAcp, CLIENT_CAPABILITIES, PROTOCOL_VERSION, type AcpChild } from './acp-client';
import { toAgentEvents, toContextBreakdown, type ToolMapper } from './map-updates';
import { autoDecision, chooseOption, type PermissionOption } from './permissions';
import { modelConfigId, type ConfigOption } from './config-options';
import type {
  AgentEvent, AgentRun, Attachment, ContextBreakdown, EditorContext,
  EffortLevel, PermissionMode, QuestionAnswers, ToolDecision,
} from '../types';

export interface AcpRunOptions {
  cwd: string;
  model?: string;
  permissionMode: PermissionMode;
  resumeToken?: string;
  tools: ToolMapper;
  clientName: string;
}

/** After this long with no replayed update, a `session/load` that has not
 *  answered is treated as done. Measured: opencode replays history before
 *  answering, and from a foreign directory never answers at all. */
const LOAD_IDLE_MS = 2000;

export class AcpRun implements AgentRun { /* … */ }
```

Requirements the tests pin down, each of which needs real code:

1. **Startup** is one memoized promise: `initialize({protocolVersion: PROTOCOL_VERSION, clientCapabilities: CLIENT_CAPABILITIES, clientInfo: {name: opts.clientName, version: '0.0.1'}})`, then either `newSession({cwd, mcpServers: []})` or `loadSession({sessionId: resumeToken, cwd, mcpServers: []})`. On success push `{kind: 'session', resumeToken: sessionId}`. On failure push `{kind: 'turn-end', reason: 'error', error: message}` — never throw.
2. **`mcpServers: []`** — that parameter is for a client injecting its own servers; the user's own load from their `opencode.json` regardless.
3. **Config options** from the `newSession` reply are stored (for `modelConfigId`) and handed to `onSessionConfig` subscribers. A `loadSession` reply may carry none — do not depend on it.
4. **Events** are an `AsyncIterable` backed by a queue with a waiting resolver, the same pattern `CodexRun` uses. Every `session/update` for **this** `sessionId` goes through `toAgentEvents(params.update, opts.tools)`; an update for any other session id is dropped.
5. **`usage_update`** updates a stored `ContextBreakdown` via `toContextBreakdown` and emits nothing.
6. **Load gate:** while a `loadSession` is outstanding, updates are swallowed and a timer is reset on each one; the load resolves when the RPC answers or after `LOAD_IDLE_MS` of silence, whichever is first.
7. **Permissions:** on `requestPermission`, `autoDecision(this.mode)` decides. A decision auto-answers with `chooseOption(params.options, decision)`. `undefined` parks the request in a `Map<string, (d: ToolDecision) => void>` keyed by `toolCall.toolCallId` and emits `{kind: 'permission', id, tool: opts.tools.call(params.toolCall), meta: {title: params.toolCall.title}}`. `respondToTool(id, decision)` resolves it. A pending request still parked at `dispose()` answers `{outcome: {outcome: 'cancelled'}}`.
8. **`send`** awaits startup, then `prompt({sessionId, prompt: blocks})` where blocks are `{type: 'text', text}` plus one `{type: 'image', data, mimeType}` per image attachment and a `{type: 'text'}` naming other attachments by path. Editor context is appended with the existing `formatEditorContext` helper from `src/providers/format-editor-context.ts`. On resolve, emit `{kind: 'usage', inputTokens, outputTokens}` when `usage` is present, then `{kind: 'turn-end'}` mapping `stopReason`: `end_turn` → `done`, `cancelled` → `interrupted`, anything else → `error`.
9. **`setModel`** sends `session/set_config_option {sessionId, configId: modelConfigId(configOptions) ?? 'model', value}`; **`setPermissionMode`** stores the mode and, for `plan`/`default`, sends `session/set_mode {sessionId, modeId: 'plan' | 'build'}`. Both swallow rejections into an `{kind: 'turn-end', reason: 'error'}`-free path: log and drop, since a failed setter must not end a turn.
10. **`setEffort`** is a no-op unless a `thought_level`/`reasoning` config option exists, in which case it writes it with `set_config_option`.
11. **`respondToQuestion`** is a no-op — no question surface in v1.
12. **`interrupt()`** sends the `session/cancel` notification and awaits the in-flight prompt promise.
13. **`dispose()`** cancels any in-flight prompt, answers parked permissions with `cancelled`, closes the event queue and calls `child.kill()`.

- [ ] **Step 4: Run the tests**

Run: `yarn test:unit --grep "AcpRun"`
Expected: PASS, with no unhandled-rejection warnings. Then `yarn lint && yarn check-types`.

- [ ] **Step 5: Commit**

```bash
git add src/providers/acp/acp-run.ts src/test/unit/acp-run.test.ts
git commit -m "feat: run one ACP session behind the AgentRun interface"
```

---

### Task 8: `OpenCodeProvider`

**Files:**
- Create: `src/providers/opencode/opencode-provider.ts`
- Test: `src/test/unit/opencode-provider.test.ts`

**Interfaces:**
- Consumes: Tasks 3, 4, 6, 7.
- Produces:
  - `function spawnOpenCodeAcp(binPath?: string): AcpChild`
  - `class OpenCodeProvider implements AgentProvider` with
    `new OpenCodeProvider(opts?: { binPath?: string; spawn?: (bin: string) => AcpChild })`

- [ ] **Step 1: Write the failing test**

```typescript
import * as assert from 'assert';
import { PassThrough } from 'node:stream';
import * as frames from '../fixtures/opencode-acp-frames.json';
import { OpenCodeProvider } from '../../providers/opencode/opencode-provider';

/** A spawn stub that answers initialize + session/new from the fixtures and
 *  records the frames it received. */
function scriptedSpawn() {
  const seen: Record<string, unknown>[] = [];
  const spawn = () => {
    const toAgent = new PassThrough();
    const toClient = new PassThrough();
    toAgent.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (!line.trim()) { continue; }
        const frame = JSON.parse(line) as Record<string, unknown>;
        seen.push(frame);
        if (frame.method === 'initialize') {
          toClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: frames.initialize })}\n`);
        }
        if (frame.method === 'session/new') {
          toClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: frames.newSession })}\n`);
        }
        if (frame.method === 'session/close') {
          toClient.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: {} })}\n`);
        }
      }
    });
    return { stdin: toAgent, stdout: toClient, kill: () => { toClient.end(); } };
  };
  return { spawn, seen };
}

suite('OpenCodeProvider', () => {
  test('starts with an empty catalog — models are the probe’s answer, never a default', () => {
    const provider = new OpenCodeProvider({ spawn: scriptedSpawn().spawn });
    assert.deepStrictEqual(provider.listModels(), []);
  });

  test('threadScope is cwd — a cross-directory session/load never completes', () => {
    const provider = new OpenCodeProvider({ spawn: scriptedSpawn().spawn });
    assert.strictEqual(provider.threadScope, 'cwd');
  });

  test('offers exactly the four modes it can enforce', () => {
    const provider = new OpenCodeProvider({ spawn: scriptedSpawn().spawn });
    assert.deepStrictEqual(provider.listPermissionModes().map((m) => m.id),
      ['default', 'plan', 'bypass', 'dontAsk']);
  });

  test('every offered mode carries a description saying where prompting is decided', () => {
    const provider = new OpenCodeProvider({ spawn: scriptedSpawn().spawn });
    assert.strictEqual(provider.listPermissionModes().every((m) => (m.description ?? '').length > 0), true);
  });

  test('fetchModels probes a real session and returns what it reported', async () => {
    const scripted = scriptedSpawn();
    const provider = new OpenCodeProvider({ spawn: scripted.spawn });
    const models = await provider.fetchModels('/w');
    assert.deepStrictEqual(models, [
      { id: 'opencode/big-pickle', displayName: 'OpenCode Zen/Big Pickle' },
      { id: 'opencode/hy3-free', displayName: 'OpenCode Zen/Hy3 Free' },
    ]);
    assert.deepStrictEqual(provider.listModels(), models);
  });

  test('the probe closes the session it opened rather than littering history', async () => {
    const scripted = scriptedSpawn();
    await new OpenCodeProvider({ spawn: scripted.spawn }).fetchModels('/w');
    assert.strictEqual(scripted.seen.some((f) => f.method === 'session/close'), true);
  });

  test('a spawn failure rejects with text that tells the user what to do', async () => {
    const provider = new OpenCodeProvider({ spawn: () => { throw new Error('ENOENT'); } });
    await assert.rejects(() => provider.fetchModels('/w'), (err: Error) => {
      assert.strictEqual(err.message.includes('opencode'), true);
      return true;
    });
  });

  test('fetchUsage and listInvocables are absent — no plan data over ACP', () => {
    const provider = new OpenCodeProvider({ spawn: scriptedSpawn().spawn });
    assert.strictEqual(provider.fetchUsage, undefined);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `yarn test:unit --grep "OpenCodeProvider"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
import { spawn as spawnChildProcess } from 'node:child_process';
import { connectAcp, CLIENT_CAPABILITIES, PROTOCOL_VERSION, type AcpChild } from '../acp/acp-client';
import { toModels, type ConfigOption } from '../acp/config-options';
import { AcpRun } from '../acp/acp-run';
import { openCodeTools } from './map-tools';
import type {
  AgentProvider, AgentRun, ModelInfo, PermissionModeInfo, StartOptions, ThreadScope,
} from '../types';

const STDERR_TAIL_BYTES = 2000;

/**
 * `shell: true` is not optional on Windows: `opencode` resolves to a `.cmd`
 * shim, and Node 22 refuses to spawn one directly (EINVAL) since the
 * command-injection hardening in 20.x.
 */
export function spawnOpenCodeAcp(binPath?: string): AcpChild {
  const bin = binPath ?? 'opencode';
  const child = spawnChildProcess(bin, ['acp'], {
    stdio: ['pipe', 'pipe', 'pipe'], shell: true, windowsHide: true,
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

/**
 * The four modes OpenCode can actually honor. `auto` needs a classifier ACP
 * does not provide, and `acceptEdits` is indistinguishable from `default`
 * under a config that does not ask about edits — the same reason Codex omits
 * it. Every description names where the prompting decision really lives.
 */
const OPENCODE_MODES: PermissionModeInfo[] = [
  { id: 'default', description: "OpenCode's build agent. Whether it prompts is your opencode.json." },
  { id: 'plan', description: 'Plan mode. OpenCode disallows all edit tools.' },
  { id: 'bypass', description: 'Answers every permission request with allow, without asking you.' },
  { id: 'dontAsk', description: 'Rejects anything OpenCode asks about. Calls its config already allows still run.' },
];

export class OpenCodeProvider implements AgentProvider {
  readonly id = 'opencode';
  readonly displayName = 'OpenCode';
  /**
   * Measured on 1.18.18: a `session/load` from a directory other than the one
   * that created the session replays the full history and then never answers.
   * Relocation therefore reseeds by replay rather than resuming natively.
   */
  readonly threadScope: ThreadScope = 'cwd';

  private models: ModelInfo[] = [];
  private readonly binPath?: string;
  private readonly spawn: (bin: string) => AcpChild;

  constructor(opts: { binPath?: string; spawn?: (bin: string) => AcpChild } = {}) {
    this.binPath = opts.binPath;
    this.spawn = opts.spawn ?? ((bin) => spawnOpenCodeAcp(bin));
  }

  listModels(): ModelInfo[] { return this.models; }
  listPermissionModes(): PermissionModeInfo[] { return OPENCODE_MODES; }

  /**
   * The catalog arrives with `session/new`, so the probe opens a session and
   * closes it again — an unclosed probe session would show up in the user's
   * own opencode history. Every rejection here is the unavailability reason
   * the panel shows verbatim, so it says what to do about it.
   */
  async fetchModels(cwd: string): Promise<ModelInfo[]> {
    let child: AcpChild;
    try {
      child = this.spawn(this.binPath ?? 'opencode');
    } catch {
      throw new Error('opencode not found. Install it, or set hiiiidCode.opencode.path.');
    }
    try {
      const connection = connectAcp(child, {
        sessionUpdate: () => {}, requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
      });
      await connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: CLIENT_CAPABILITIES,
        clientInfo: { name: 'hiiiid-code-probe', version: '0.0.1' },
      } as never);
      const session = await connection.newSession({ cwd, mcpServers: [] } as never) as unknown as
        { sessionId: string; configOptions?: ConfigOption[] };
      this.models = toModels(session.configOptions ?? []);
      try {
        await (connection as unknown as { closeSession(p: unknown): Promise<unknown> })
          .closeSession({ sessionId: session.sessionId });
      } catch {
        // Best effort. A probe session left open is untidy, not broken —
        // and never a reason to report the provider as unavailable.
      }
      return this.models;
    } finally {
      child.kill();
    }
  }

  start(opts: StartOptions): AgentRun {
    const child = this.spawn(this.binPath ?? 'opencode');
    return new AcpRun(child, {
      cwd: opts.cwd,
      model: opts.model,
      permissionMode: opts.permissionMode,
      resumeToken: opts.resumeToken,
      tools: openCodeTools,
      clientName: 'hiiiid-code',
    });
  }
}
```

Check the SDK's actual method name for `session/close` when you write this (the `d.ts` lists it near `setSessionMode`); if it is absent from `ClientSideConnection`, drop the close call and its test, and note the leak in the manual-verification doc instead of faking it.

- [ ] **Step 4: Run the tests**

Run: `yarn test:unit --grep "OpenCodeProvider"`
Expected: PASS. Then `yarn lint && yarn check-types`.

- [ ] **Step 5: Commit**

```bash
git add src/providers/opencode/opencode-provider.ts src/test/unit/opencode-provider.test.ts
git commit -m "feat: add the OpenCode provider over ACP"
```

---

### Task 9: Registration and settings

**Files:**
- Modify: `package.json`, `src/extension.ts`, and the module holding `KNOWN_PROVIDER_IDS` / `DEFAULT_PROVIDER_IDS` (imported by `src/extension.ts:19` — open that import to find its path)
- Test: `src/test/unit/opencode-provider.test.ts` (extend)

**Interfaces:**
- Consumes: Task 8's `OpenCodeProvider`.

- [ ] **Step 1: Add the id to the shared lists**

Add `'opencode'` to `KNOWN_PROVIDER_IDS` and to `DEFAULT_PROVIDER_IDS`. A fresh install then probes it, and an install without the binary lands in `unavailable()` with the probe's reason — which is the mechanism working, not a special case.

- [ ] **Step 2: Extend the enum and add the path setting**

In `package.json`, add `"opencode"` to `hiiiidCode.enabledProviders`'s `enum` and a matching entry to `enumDescriptions` (`"OpenCode CLI, over the Agent Client Protocol."`). Add, beside `hiiiidCode.codex.path`:

```json
"hiiiidCode.opencode.path": {
  "type": "string",
  "default": "",
  "description": "Path to the opencode binary. Empty means use opencode from PATH."
}
```

- [ ] **Step 3: Register the provider**

In `src/extension.ts`, mirroring the Codex block exactly — including normalizing `""` to `undefined`, since passing `""` through would spawn `''` and make the provider permanently unavailable:

```typescript
const openCodeProvider = enabled.has('opencode')
  ? new OpenCodeProvider({ binPath: openCodeBinPath() })
  : undefined;
if (openCodeProvider) { providers.set('opencode', openCodeProvider); }
```

Add `openCodeBinPath()` next to `codexBinPath()`, with the same `""` → `undefined` normalization and the same comment reasoning. Keep Claude registered first — `SessionPicker` uses `state.catalog[0]` for the New button.

- [ ] **Step 4: Add the registration test**

```typescript
test('the default provider set includes opencode', () => {
  // Import DEFAULT_PROVIDER_IDS from wherever extension.ts imports it.
  assert.strictEqual(DEFAULT_PROVIDER_IDS.includes('opencode'), true);
});
```

- [ ] **Step 5: Verify**

Run: `yarn test:unit && yarn lint && yarn check-types && yarn run compile`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add package.json src/extension.ts src/shared src/test/unit/opencode-provider.test.ts
git commit -m "feat: register the OpenCode provider behind the enabled-providers setting"
```

---

### Task 10: The MCP line in the webview

**Files:**
- Modify: `src/webview/components/mcp-status.ts` and its consuming component
- Test: a DOM test under `src/test/dom/` following the existing pattern

**Interfaces:**
- Consumes: nothing from earlier tasks — this is display only.

- [ ] **Step 1: Write the failing DOM test**

Mount the session surface through the real `StoreProvider`, drive it with genuine `HostToWebview` messages via `sendFromHost` (see `src/test/dom/harness.tsx`), and assert on strings and counts — **never** pass a DOM node to an assertion.

```typescript
test('an OpenCode session explains why MCP servers cannot be listed', async () => {
  const { container, sendFromHost } = mountPanel();
  sendFromHost(hydrateWith({ provider: 'opencode' }));  // follow the harness's helper names
  const text = container.textContent ?? '';
  assert.strictEqual(text.includes("MCP servers load from your opencode.json"), true);
  assert.strictEqual(text.includes('unsupported'), false);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `yarn test:dom --grep "MCP"`
Expected: FAIL — the string is absent.

- [ ] **Step 3: Implement**

Render, for `opencode` sessions only, one muted line in place of server rows:

> MCP servers load from your opencode.json. OpenCode doesn't report their status, so they can't be listed here.

The wording matters: servers **do** work: OpenCode simply reports no status. A line implying MCP is unsupported would send the user to fix something that is not broken.

Use shadcn primitives and `cn` from `@/lib/utils` — no raw HTML controls, no template-literal classNames.

- [ ] **Step 4: Run the tests**

Run: `yarn test:dom && yarn lint && yarn check-types`
Expected: PASS.

- [ ] **Step 5: Run the impeccable detector**

```bash
node <impeccable-skill-dir>/scripts/detect.mjs --json src/webview/components/mcp-status.ts <the consuming component>
```

Exit 0 is required. Exit 2 means findings — fix them; a non-zero exit is a failing check, not a suggestion.

- [ ] **Step 6: Commit**

```bash
git add src/webview/components src/test/dom
git commit -m "feat: explain the OpenCode MCP blind spot in the panel"
```

---

### Task 11: Manual verification and docs

**Files:**
- Create: `docs/opencode-acp-manual-verification.md`
- Modify: `README.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: everything.

- [ ] **Step 1: Write the manual-verification doc**

It must cover, against a real logged-in `opencode` 1.18.18+ install, with a space for each result:

1. A new OpenCode session streams text and reasoning, and the model switcher lists real models.
2. Switching the model mid-session takes effect on the next turn.
3. `plan` mode refuses an edit; `default` performs one.
4. With `permission: {edit: "ask", bash: "ask"}` in `opencode.json`, a permission card appears and both allow and deny work.
5. Under `bypass` no card appears and the edit proceeds; under `dontAsk` the call is rejected.
6. The context ring fills and its caption reads `used / window`.
7. Reloading the window restores the session and it resumes in the same directory.
8. The MCP line renders and reads correctly.
9. **Confirm the reject option's real `optionId` and `kind`** and correct `src/test/fixtures/opencode-acp-frames.json` if they differ from the fixture.
10. **Confirm the `session/load` reply shape** — the spike never observed one cleanly, and the spec flags it.

- [ ] **Step 2: Update the README**

The v1 non-goals list says "No Codex or OpenCode provider backends". Codex shipped and now OpenCode has too — correct the sentence rather than leaving it half-true.

- [ ] **Step 3: Update CLAUDE.md**

Add the new paths to the architecture table (`src/providers/acp/`, `src/providers/opencode/`) and add one invariant capturing what the spike bought:

> **ACP is the protocol layer, not a provider.** `src/providers/acp/` may not import anything vendor-specific; a new ACP agent is a spawn recipe plus a `map-tools.ts`. Client capabilities stay `false` for fs and terminal — an agent that calls them anyway falls back to its own IO, which is what keeps diff attribution reading the transcript instead of our writes.

- [ ] **Step 4: Run the full gate**

Run: `yarn lint && yarn check-types && yarn run compile && yarn test:unit && yarn test:dom`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add docs/opencode-acp-manual-verification.md README.md CLAUDE.md
git commit -m "docs: document OpenCode support and its manual verification pass"
```

---

## Self-Review

**Spec coverage:** transport and process model → Tasks 6, 8. Handshake → Tasks 6, 7. Session lifecycle and the load gate → Task 7. Event mapping → Task 2. Tool mapping → Task 3. Models and effort → Tasks 4, 7, 8. Permission modes → Tasks 5, 8. Permissions → Tasks 5, 7. Context and usage → Tasks 2, 7. MCP → Task 10. Attachments → Task 7 step 8. Testing → every task. Registration → Task 9. Open risks → Task 11's manual pass.

**Known gaps, deliberate:** `fetchUsage`/`usageWindows` are unimplemented by design; question cards are out of scope; `session/fork` is unused even though the agent advertises it.

**Two things the implementer must verify rather than trust:** the SDK's exact method name for closing a session (Task 8), and the reject option's id and kind (Task 11) — both are flagged inline at the point of use.
