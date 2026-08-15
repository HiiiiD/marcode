# hiiiid-code — Canonical Tool Layer

**Date:** 2026-08-15
**Status:** Design approved, pending implementation plan

## Overview

Providers classify their own tool calls into a closed `ToolCall` union before
the call reaches the wire. The webview renders that union and never sees a
provider's tool names again.

Today `AgentEvent` is canonical about *structure* — a tool starts, a tool
ends, a permission is raised — and raw about *content*. `tool-start` carries
`name: string` and `input: unknown`, where `name` is `Bash` on the Claude arm
and `commandExecution` on the Codex arm. The consequence is
`src/webview/components/tool-render.ts`: one 90-line switch holding both
providers' vocabularies, with a `LABELS` table translating Codex's internal
discriminants into words a user has read. Every new provider adds a third
vocabulary to that switch, and the classification of a call ends up decided in
the renderer rather than by the adapter that understands the backend.

This spec moves classification to the adapters. The renderer switches on ten
kinds, forever.

## Goals

- Adding a provider means writing one `map-tools.ts`. Nothing under
  `src/webview/` changes.
- A tool call's classification is decided where the backend's wire format is
  understood, against that backend's typed schema.
- An approval card and the tool card it becomes are built by the same
  function, so they agree by construction rather than by hand-maintained
  coincidence.
- The webview keeps every display decision — glyph, truncation, clamping,
  diff-line construction, tone.

## Non-goals

- Canonicalizing the rest of `AgentEvent`. `text`, `thinking`, `usage`,
  `turn-end`, `invocables`, `mcp-servers` and `session` are unchanged. A
  t3code-style full item-lifecycle vocabulary (`item.started`/`item.updated`/
  `item.completed`, task and hook events, plan mode) buys surfaces this panel
  does not have; it is not on the table here.
- Streaming tool output. Unchanged: buffered, emitted at completion.
- Backward compatibility with transcripts already on disk. See The Break.
- A shared name-substring classifier. Explicitly rejected; see Rejected:
  Heuristic Classification.

## The canonical type

New module `src/providers/canonical/tool-call.ts` — types plus two small pure
helpers (`mcp__server__tool` name parsing, todo-status normalizing). It
imports nothing from `vscode` and nothing from `src/webview/`.

```ts
export type ToolCall =
  | { kind: 'command';   label: string; command: string; cwd?: string;
      background?: boolean; timeoutMs?: number; note?: string }
  | { kind: 'file-edit'; label: string; files: FileEdit[] }
  | { kind: 'file-read'; label: string; path: string;
      range?: { offset: number; limit?: number }; pages?: string }
  | { kind: 'search';    label: string; pattern: string; mode: 'content' | 'files';
      scope?: string; filters?: Field[] }
  | { kind: 'web';       label: string; query?: string; url?: string; note?: string }
  | { kind: 'todos';     label: string; items: { status: TodoStatus; text: string }[] }
  | { kind: 'plan';      label: string; text: string }
  | { kind: 'subagent';  label: string; action: 'spawn' | 'message' | 'collect';
      agent?: string; model?: string; isolation?: string; target?: string;
      summary?: string; prompt?: string; fields?: Field[] }
  | { kind: 'mcp';       label: string; server: string; tool: string; args?: unknown }
  | { kind: 'other';     label: string; fields?: Field[]; raw: unknown };

export interface FileEdit {
  /** Absolute, POSIX separators. */
  path: string;
  op: 'create' | 'modify' | 'delete' | 'rename';
  /** Claude's before/after pairs. */
  edits?: { before?: string; after?: string }[];
  /** Codex's full unified diff — `---`/`+++`/`@@` headers included. */
  unifiedDiff?: string;
  replaceAll?: boolean;
}

export type Field = { label: string; value: string };
export type TodoStatus = 'pending' | 'in_progress' | 'completed';
```

### Why the shape is what it is

**`label` is display-only.** It carries the provider's own word for the call —
`Bash`, `Edit`, `Shell`. Nothing branches on it. This is what retires the
`LABELS` table, which exists today only because Codex ships `ThreadItem.type`
discriminants (`commandExecution`, `fileChange`) that no user has typed or
read anywhere.

**`file-edit` accepts two edit shapes because both are facts.** Claude
genuinely reports `old_string`/`new_string` pairs; Codex genuinely reports a
full unified diff per touched file. Forcing either into the other's shape
would mean the adapter fabricating content it was not given. The renderer
builds diff lines from whichever is present.

**`other` is the only kind carrying `raw`.** The JSON fallback needs it and
has nothing else to show. Every other kind has extracted what matters, so
carrying the raw input as well would duplicate a large `Write`'s whole content
in the transcript.

**`op` replaces a glyph decision.** `file-plus` vs `file-pen` is currently
decided by whether the tool was named `Write` or `Edit`. `op: 'create'` is the
underlying fact, and it is one a provider can answer for tools this panel has
never seen.

Two distinctions today's renderer draws are deliberately dropped:
`bashoutput` collapses into `command`, and `taskoutput` into
`subagent` with `action: 'collect'`.

## Wire changes

`AgentEvent`'s three tool arms:

```ts
| { kind: 'tool-start'; id: string; tool: ToolCall; parentId?: string }
/**
 * `tool`, when present, REPLACES what tool-start reported — the same revision
 * contract the old `input` field had, and for the same reason: Codex's
 * `webSearch` reports `query: ''` while running and the real query only on
 * completion.
 */
| { kind: 'tool-end'; id: string; ok: boolean; output: ToolOutput;
    tool?: ToolCall; parentId?: string }
| { kind: 'permission'; id: string; tool: ToolCall; parentId?: string }
```

`name` and `input` leave the wire entirely.

Output gets a small union, because unwrapping it is provider-shaped work:

```ts
export type ToolOutput =
  | { kind: 'none' }
  | { kind: 'text'; text: string }
  | { kind: 'json'; value: unknown };
```

The host absorbs what `outputText()` does today — Anthropic's
string-or-content-block-array, the `{stdout, stderr}` object, Codex's
`webSearch` result list, `SendMessage`'s `{success, message}` envelope. The
webview keeps `clampLines` and picks tone from `tool.kind` (`file-read` and
`search` render as code, everything else as output).

Codex's `fileChange` stops being an output shape: its completion revises
`tool` with the unified diffs, and its `output` is `{ kind: 'none' }`. The
diff belongs to the *call*, not to its result.

`ToolDecision.updatedInput` is removed. It let the webview hand back a
modified raw input; under a canonical wire the webview holds no raw input to
modify. Nothing in the panel used it.

## Transcript changes

```ts
| (ItemBase & { role: 'tool'; toolId: string; tool: ToolCall;
                state: 'running' | 'ok' | 'error'; output?: ToolOutput;
                children?: TranscriptItem[] })
| (ItemBase & { role: 'permission'; requestId: string; tool: ToolCall;
                state: 'pending' | 'allowed' | 'denied'; reason?: string })
```

`mcpServer?: string` leaves both arms. An MCP call is
`{ kind: 'mcp', server, tool }`, so `parseMcpName` moves out of
`src/host/agent-session.ts` and into the Claude mapper — the
`mcp__<server>__<tool>` convention is Claude's, and the host has no business
knowing it.

`children` and the depth-1 subagent nesting are unchanged.

`PermissionRequest` — the pending-approval record carried on
`SessionSnapshot` and held by `AgentSession.pending` — follows the same
change:

```ts
export interface PermissionRequest { requestId: string; tool: ToolCall }
```

## The Break

`StoredIndex` gains `version: 2`. `readIndex()` returns `EMPTY_INDEX` for any
other value, including its current absence.

Existing `sessions/*.jsonl` files are left on disk: orphaned, never parsed,
never deleted. Old sessions disappear from the roster rather than
half-rendering a `role: 'tool'` item with no `tool` field. Deleting inside
`context.storageUri` is not something this change needs to do to be correct,
and orphaned files cost bytes rather than data.

There is no legacy classifier and no tolerant reader. That is the whole point
of taking the break: a compatibility path would keep today's name-keyed switch
alive in the renderer permanently, which is the thing being removed.

## Provider mappers

```
src/providers/canonical/tool-call.ts   types + shared helpers
src/providers/claude/map-tools.ts      SDK name+input -> ToolCall; SDK result -> ToolOutput
src/providers/codex/map-tools.ts       ThreadItem -> ToolCall; item -> ToolOutput
```

### Claude

Switches on the SDK's own tool names. No substring matching.

| Name | Kind |
|---|---|
| `Bash`, `BashOutput`, `KillShell` | `command` |
| `Edit`, `MultiEdit`, `NotebookEdit` | `file-edit`, `op: 'modify'` |
| `Write` | `file-edit`, `op: 'create'` |
| `Read` | `file-read` |
| `Grep` | `search`, `mode: 'content'` |
| `Glob` | `search`, `mode: 'files'` |
| `WebSearch`, `WebFetch` | `web` |
| `TodoWrite` | `todos` |
| `Agent`, `Task` | `subagent`, `action: 'spawn'` |
| `SendMessage` | `subagent`, `action: 'message'` |
| `TaskOutput` | `subagent`, `action: 'collect'` |
| `mcp__<server>__<tool>` | `mcp` |
| anything else | `other` |

An unrecognized name reaching `other` is the correct outcome, not a gap: the
SDK's tool set grows, and a tool nobody has mapped renders as its name plus
its arguments, exactly as it does today.

### Codex

Switches on `ThreadItem`'s discriminated union in `wire.ts`.

| `ThreadItem.type` | Kind |
|---|---|
| `commandExecution` | `command` — keeps `displayCommand`'s parsed-actions preference over the escaped invocation |
| `fileChange` | `file-edit`, one `FileEdit` per `FileUpdateChange`; `op` from its `kind`, `unifiedDiff` from its `diff` |
| `mcpToolCall` | `mcp` |
| `webSearch` | `web` |
| `plan` | `plan` |
| `dynamicToolCall` | `other`, with the tool name as `label` |

Unmodelled item types stay ignored, as today.

### Approvals share the path

Approval requests build a `ToolCall` through the same functions as items, not
a parallel path. Codex's `item/commandExecution/requestApproval` builds a
`command`, `item/fileChange/requestApproval` a `file-edit`,
`item/permissions/requestApproval` an `other`; Claude's `canUseTool` callback
runs the same name table.

This is the structural fix for a hazard currently handled by comment: the
approval card must show the same spelling of a command as the tool card it
becomes, which today is maintained by two call sites independently calling
`displayCommand`.

### FakeProvider

Gains a scripted turn emitting one call of every kind. It is the DOM tests'
data source and the only way every renderer arm is exercised without a live
backend.

## Renderer changes

`tool-render.ts` loses its narrowing apparatus — `key()`, `LABELS`,
`asRecord`/`str`/`num`, `pathOf`, `fileChangePaths`, `outputText`,
`parseJson` — because its input is typed. Roughly 557 lines to ~250. What
survives unchanged: `shortPath`, `clampLines`, `diffBodyLines`, and the
`ToolBlock`/`ToolHeader` vocabulary. `tool-body.tsx` is untouched.

```ts
export function describeTool(tool: ToolCall): ToolHeader;
export function describeInput(tool: ToolCall): ToolBlock[];
export function describeOutput(kind: ToolCall['kind'],
                               output: ToolOutput | undefined,
                               state: 'running' | 'ok' | 'error'): ToolBlock[];
```

Glyph resolution moves from names to facts:

| Kind | Glyph |
|---|---|
| `command` | `terminal` |
| `file-edit` | `file-plus` when every `op` is `create`, else `file-pen` |
| `file-read` | `file-text` |
| `search` | `search` for `mode: 'content'`, `folder-search` for `'files'` |
| `web` | `globe` |
| `todos`, `plan` | `list-todo` |
| `subagent` | `send` for `action: 'message'`, else `bot` |
| `mcp`, `other` | `wrench` |

`tool-card.tsx` passes `item.tool` where it passes `item.name, item.input`
today. Two other call sites read the raw fields and change with them:

- **`permission-card.tsx`** — `describeInput(item.tool)`, and every place it
  renders `item.name` in prose or an `aria-label` (`Allow {name}?`,
  `Deny {name}`) reads `item.tool.label`. Its `mcpServer` prefix comes from
  `tool.kind === 'mcp' ? tool.server : undefined`.
- **`subagent-window.ts`** — `subagentLabel` currently digs `subagent_type`
  then `name` out of the raw input, falling back to the tool name. It becomes
  `tool.kind === 'subagent' ? (tool.agent ?? tool.target ?? tool.label) :
  tool.label`. The digging moves into the Claude mapper, which is where the
  `subagent_type` field name is actually known.

## Rejected: heuristic classification

t3code classifies with lowercased substring matching on the tool name:
`includes('bash'|'shell'|'command')` → command execution,
`includes('edit'|'write'|'file')` → file change, `includes('agent')` →
subagent. It buys plausible classification for a provider nobody has written a
mapper for.

Rejected because it misfires silently and in the direction that matters. Its
first arm sends any tool whose name contains `agent` to the subagent arm — an
MCP server named `agentql` renders as a spawned subagent. A wrong
classification should be a bug in one provider's mapper, findable in that
provider's tests, not an emergent property of a shared regex that every
provider is subject to.

Per-provider mappers cost one file per backend. That is the correct price.

## Invariants

Unchanged and re-checked by this design:

- `src/protocol/messages.ts` stays types-only; it re-exports `ToolCall` and
  `ToolOutput` the way it already re-exports `ModelInfo`.
- Nothing under `src/providers/` imports `vscode` — including the new
  `canonical/` directory.
- Every session-addressed message keeps its explicit `SessionId`.
- Errors are state: a mapper that cannot classify returns `other`, never
  throws. A malformed wire payload produces a card, not an exception.
- Filenames stay kebab-case.

## Testing

- **New** `src/test/unit/claude-map-tools.test.ts` and
  `codex-map-tools.test.ts` — captured wire payloads in, asserted `ToolCall`
  out. Classification correctness lives here, and extends per provider.
- **Rewritten** `tool-render.test.ts` — fed `ToolCall` values directly. It
  stops testing two providers' vocabularies and becomes a test of ten render
  arms.
- **Updated** `agent-session.test.ts`, `codex-map-events.test.ts` for the new
  item shape.
- **DOM tests** keep driving components through the real `StoreProvider` with
  genuine `HostToWebview` messages; the messages carry canonical items.
- **Per CLAUDE.md:** `detect.mjs` over every changed file under
  `src/webview/components/`, and a `critique` run over `src/webview` compared
  against the `.impeccable/critique/` baseline before merge. Card visuals do
  not move, so the score should hold flat or rise.

## What this unlocks

A third provider — Cursor, opencode, Grok, anything speaking ACP — needs a
`map-tools.ts` and no renderer work. That is the capability the panel is for:
it owns no harness, and every differentiator comes from driving other vendors'
CLIs well.
