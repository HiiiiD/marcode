# Question cards

**Date:** 2026-08-16
**Status:** Approved, ready for planning

## Problem

Both backends can ask the user a structured question mid-turn. The panel can answer
neither, and each one fails differently.

**Claude.** `AskUserQuestion` arrives through `canUseTool` like any other tool, because the
permission callback is not a gate for it — it is the transport. The SDK says so in the
tool's own input schema (`sdk-tools.d.ts:2400`):

```ts
  /**
   * User answers collected by the permission component
   */
  answers?: {
```

The host is expected to fill `answers` and return `{behavior:'allow', updatedInput}`.
`ClaudeProvider` instead renders an allow/deny permission card
(`src/providers/claude/claude-provider.ts:403`), so pressing Allow runs the tool with
`answers` undefined. The model receives an empty answer set and concludes it is running
without a human — which is what the agent reports, and why the bug reads as "the session is
non-interactive" rather than as a missing feature.

**Codex.** `item/tool/requestUserInput` is auto-declined
(`src/providers/codex/codex-run.ts:205`) with a transcript note reading "The panel cannot
answer this request yet." `map-events.ts:14` states the cause plainly: *"`ToolDecision`
cannot express either one."* The decline is deliberate and correct — an unanswered blocking
request hangs the turn — but it is a stopgap.

The gap is the same on both sides: there is one channel for tool permissions, a question is
not a permission, and the panel has no vocabulary for the difference.

## Scope

**In:**

- A provider-agnostic `question` event, parked by the host and answered from the panel.
- `ClaudeProvider` answering `AskUserQuestion` via `updatedInput.answers`.
- `CodexRun` answering `item/tool/requestUserInput` instead of declining it.
- Tier A permission metadata: surfacing the `title` / `description` / `decisionReason` the
  SDK already sends and the panel currently discards.
- A correctness fix to `interrupt()`, which today leaves parked requests unsettled.

**Out (see Deferred):** "always allow" via permission `suggestions`; MCP elicitation;
dismissing a question without cancelling the turn.

## Decisions

Each was taken deliberately; the rationale matters more than the choice.

1. **A parallel event, not a widened `ToolDecision`.** `kind: 'question'` sits beside
   `kind: 'permission'`, with its own transcript role and its own response method.
   Widening `ToolDecision` — which every provider implements — with a field one tool uses
   would make today's conflation load-bearing. An `InteractionRequest` abstraction over
   two instances, one of whose shapes the SDK dictates, is speculative generality.
2. **Answers are keyed by a stable `id` and valued by a list.**
   `Record<string, string[]>`. This is codex's model
   (`ToolRequestUserInputResponse`), and it is the better one. Claude keys by question text
   and comma-joins multi-select answers into one string; that is a lossy spelling applied at
   the Claude boundary, not the panel's internal format.
3. **Refusal cancels the turn.** There is no deny variant for a question. The card's
   Cancel button is the existing interrupt path. A question the user does not want to
   answer is a turn they do not want to continue.
4. **A host restart yields `stale`, computed on read.** Mirrors the `relocation`
   precedent, which already maps `queued` → `pending` for queue entries that did not
   survive. The JSONL keeps what was written; the restart-dependent reading is applied
   in `SessionManager`. Nothing rewrites history.
5. **Secret answers are never persisted.** A question may declare `secret`. The
   transcript item records that it was answered and omits that question's key from
   `answers`. The transcript stays a truthful record of the exchange without becoming a
   plaintext credential store under `context.storageUri`.
6. **Composer disable is conditional on `blocking`.** Codex distinguishes blocking from
   non-blocking requests; Claude's are always blocking. Freezing the composer for a
   request that never blocked the turn would be a state invented by the panel.
7. **Stepper layout, collapsing at one question.** One question at a time with
   `n of m`; at a single question the counter and Back/Next disappear and the card shows a
   plain Answer button. The single-question call is the common case and must not pay for
   the multi-question one.

## Neutral model

`src/providers/types.ts`:

```ts
export interface QuestionOption {
  label: string;
  description: string;
  /** Claude only. Longer comparison content; rendered as markdown. */
  preview?: string;
}

export interface QuestionSpec {
  /** Stable answer key. Claude has no id; its adapter uses the question text. */
  id: string;
  header: string;
  question: string;
  /** Absent means a free-text question with no options to choose from. */
  options?: QuestionOption[];
  multiSelect: boolean;
  /** Whether a free-text answer is offered alongside the options. */
  allowOther: boolean;
  /** The answer is a credential: mask on input, never persist. */
  secret: boolean;
}

/** Question id -> that question's answers. */
export type QuestionAnswers = Record<string, string[]>;

export interface PermissionMeta {
  title?: string; displayName?: string; description?: string;
  decisionReason?: string; blockedPath?: string;
}
```

`AgentEvent` gains two kinds and one optional field:

```ts
| { kind: 'question'; id: string; questions: QuestionSpec[]; blocking: boolean; parentId?: string }
| { kind: 'request-cancelled'; id: string }
| { kind: 'permission'; id: string; tool: ToolCall; parentId?: string; meta?: PermissionMeta }
```

`AgentRun` gains one method. `ToolDecision` is untouched:

```ts
respondToQuestion(id: string, answers: QuestionAnswers): void;
```

## Provider mapping

| Neutral | Claude (`AskUserQuestion`) | Codex (`item/tool/requestUserInput`) |
|---|---|---|
| `id` | the question text | `question.id` |
| `header` / `question` | same | same |
| `options` | always 2-4 | `options`, nullable — null becomes absent |
| `multiSelect` | `question.multiSelect` | not declared; `false` in v1 (open item) |
| `allowOther` | always `true` (schema guarantees it) | `question.isOther` |
| `secret` | always `false` | `question.isSecret` |
| `preview` | `option.preview` | not available |
| `blocking` | always `true` | `params.isBlocking` |
| answer | `{behavior:'allow', updatedInput:{...input, answers}}`, values joined `", "` | `{answers: {[id]: {answers: [...]}}}` |
| cancel | `{behavior:'deny', message:'Turn cancelled'}` | `{answers: {}}` — structurally valid, "answered nothing" |

`item/tool/requestUserInput` comes out of `DECLINED_INPUT_METHODS`.
`mcpServer/elicitation/request` stays in it.

## Provider behaviour

**Claude.** `canUseTool` branches on tool name. The parked map stops being a bare resolver
map, because an answer must be spread over the original input:

```ts
type Parked =
  | { kind: 'permission'; resolve: (d: ToolDecision) => void }
  | { kind: 'question'; input: Record<string, unknown>; resolve: (a: QuestionAnswers) => void };
```

Malformed `input.questions` — it is model-supplied — degrades to an ordinary permission
card the user can deny. Per the errors-are-state invariant, a bad shape is a degraded card,
never a rejected promise.

`options.signal` settles the parked entry. Settling deletes from the map before resolving,
so an abort and an explicit `interrupt()` cannot double-resolve. An aborted question
resolves `{behavior:'deny'}` and **never `null`** — the SDK reserves null for
"control_response already sent out-of-band", and an accidental null leaves the tool blocked
indefinitely (`sdk.d.ts:196-204`).

**`interrupt()` must settle parked entries. This is a fix, not a feature.** Today only
`dispose()` settles them, so interrupting a turn with a parked permission leaves the session
in `awaiting-approval` displaying a live card for a turn that no longer exists. It is
recoverable — answering resolves the orphan — but it is a lying state, and Decision 3
promotes it from rare to routine. Settling emits `request-cancelled` so the host converges
on the same card state whether the abort originated here or inside the SDK.

**Codex.** `approvalEventOf` grows a `question` branch; `CodexRun` tracks pending question
rpc ids beside `pendingApprovals` and responds with the mapped shape. The existing
`{answers: {}}` refusal remains the cancel path.

## Host

`AgentSession` gains `pendingQuestions` beside `pending` (line 94), and four handlers
mirroring the permission ones:

- `kind: 'question'` → append `role: 'question'`, `state: 'pending'`; record; set status.
- `answerQuestion(requestId, answers)` → delete, `replace` to `answered`, call
  `respondToQuestion`, recompute status. Same shape as lines 320-353, including the
  already-gone early return that makes a double answer a no-op.
- `kind: 'request-cancelled'` → look up in either map, `replace` to `cancelled`.
- `dispose()` → settle parked questions alongside permissions (lines 467-472).

Status reuses `awaiting-approval`. The name is imprecise for a question, but in the roster
it carries the meaning that matters — this session is waiting on you — and a rename would
touch `SessionStatus`, `status-badge`, `session-row` and the wire.

**Persistence.** The item is durable. On answer, `answers` omits the key of every question
whose spec has `secret: true`; combined with `state: 'answered'` the reading is
unambiguous — asked, answered, deliberately not recorded.

**`stale`.** `SessionManager` maps a `pending` question item with no live entry to `stale`
at read time. The JSONL is not rewritten.

**Protocol** (`src/protocol/messages.ts`, types only):

```ts
| (ItemBase & {
    role: 'question'; requestId: string; questions: QuestionSpec[]; blocking: boolean;
    state: 'pending' | 'answered' | 'cancelled' | 'stale';
    answers?: QuestionAnswers;
  })

export interface QuestionRequest { requestId: string; questions: QuestionSpec[]; blocking: boolean }
// SessionSnapshot.pendingQuestions: QuestionRequest[]  — hydrate
// PermissionRequest.meta?: PermissionMeta            — Tier A
// TranscriptItem role:'permission' gains meta?: PermissionMeta — Tier A
| { t: 'question-answer'; id: SessionId; requestId: string; answers: QuestionAnswers }
```

**Correction to this spec, made during the final review.** `pendingQuestions` was
originally specified on `SessionState`. That is wrong for the same reason `pending` is not
there: it describes a provider request waiting on an answer *right now*, so it is
in-memory host state, and a field on `SessionState` rides every `sessions-changed` summary
and every `index.json` entry — where nothing maintains it and it would read `[]` while a
question was in fact parked. It lives on `SessionSnapshot`, beside `pending`.

`MessageRouter` maps `question-answer` → `answerQuestion`, with no `vscode` import.

## Webview

`reduce` tracks pending questions off transcript patches exactly as it tracks permissions
(reducer.ts:310, 329), into its own slice; hydrate seeds both.

**`question-card.tsx`**, sibling to `permission-card.tsx`. Local state only — step index,
selections, free text. A reshown panel rebuilds from the hydrated pending list and the user
re-picks; nothing half-answered is durable. Submitting posts one `question-answer` carrying
every question's answers.

- Stepper at 2+ questions; plain Answer at one.
- Options via the vendored `radio-group`; `multiSelect` needs a **`checkbox` primitive that
  is not vendored yet**. Vendor it from the Base UI registry — no hand-rolled
  `<input type="checkbox">`.
- `allowOther` adds a `Textarea`. A question with no `options` is free-text only.
- `secret` masks the field. **No `input.tsx` is vendored** (only `input-group.tsx`);
  confirm or vendor.
- `preview` is a collapsed disclosure rendering through `markdown.tsx`. It is
  model-supplied arbitrary text and takes the same path as assistant output — no raw HTML,
  no new sanitization story.
- Cancel wires to the existing interrupt path.

**Composer.** When a blocking question is pending, the composer is disabled following the
contract already in `composer.tsx`: one visible reason line and `aria-describedby` pointing
at it, never a `title` — a `title` on a disabled element reaches neither keyboard focus nor
most screen readers. Note this is new behaviour: `readOnly` (line 75) is provider
unavailability today, and a pending permission does not block typing.

Per CLAUDE.md, every changed file under `src/webview/components/` goes through
`impeccable`'s detector, and `critique` runs before the branch merges.

## Testing

**Unit, provider** (`loadQueryFn` is injectable, so a fake `query` drives all of it):

- `AskUserQuestion` parks and emits `question`; `respondToQuestion` resolves with
  `updatedInput` equal to the original input **spread with** `answers` — asserting the
  spread, since dropping the original fields is the easy bug.
- Multi-select values reach Claude comma-joined and codex as arrays.
- Malformed `questions` degrades to a `permission` event.
- `options.signal` abort resolves deny, emits `request-cancelled`, idempotent with
  `interrupt()`.
- **Regression:** `interrupt()` settles a parked permission. Fails on today's code.
- Tier A metadata reaches the event.
- Codex: `item/tool/requestUserInput` emits `question` rather than declining;
  `mcpServer/elicitation/request` still declines.

**Unit, host:** pending item and `pendingQuestions` in state; `answerQuestion` replaces to
`answered` and calls through once; double answer is a no-op; `request-cancelled` yields
`cancelled`; `dispose` settles; `stale` is computed on read with the **JSONL still reading
`pending`**; and a secret answer's value is **absent from the written JSONL** — asserted
against file contents, not the in-memory item.

**DOM**, through the real `StoreProvider`, state arriving as genuine `transcript-patch`
messages via `sendFromHost`, assertions reading what the webview posted back:

- One question → no stepper. Three → Next/Back, one post carrying all three keys.
- `multiSelect` posts multiple values; single-select posts one.
- Free text populates the answer; an options-less question renders as text only.
- `secret` renders masked.
- `preview` collapsed by default, expands on the disclosure.
- Blocking disables the composer with the visible reason and `aria-describedby`;
  non-blocking does not.
- `cancelled` and `stale` render read-only.

Assertions compare booleans, strings and counts — never a DOM node.

## Open items

1. **RESOLVED 2026-08-16 — bypass does not suppress questions.** Probed against the real
   SDK (`@anthropic-ai/claude-agent-sdk`, model `claude-haiku-4-5`): with
   `permissionMode: 'bypassPermissions'` **and** `allowDangerouslySkipPermissions: true`,
   `canUseTool` fired for `AskUserQuestion` and the full round-trip worked — returning
   `updatedInput.answers` produced the tool result `Your questions have been answered:
   "Tabs or spaces for indentation?"="Spaces"`, and the model then answered from it.

   Three corrections to the assumption above:
   - The SDK emits `[CLAUDE_SDK_CAN_USE_TOOL_SHADOWED]` under this mode, warning that
     `canUseTool` "will not be invoked". That covers **ordinary** tools, which are
     auto-approved before the callback (measured: `Read` → 0 calls). `AskUserQuestion` is
     not a permission gate — the callback *is* its execution — so it routes through
     regardless of mode. Do not trust the warning text here; the probe overrides it.
   - The flag is **not** redundant and cannot be dropped: `sdk.d.ts:1775` — "Must be set to
     `true` when using `permissionMode: 'bypassPermissions'`."
   - `updatedInput.answers` is a `Record<questionText, string>` — a record of **single
     strings**, not an array. A wrong shape is rejected loudly, not silently:
     `The parameter 'answers' type is expected as 'record' but provided as 'array'`.
     The plan's `toSdkAnswers` (comma-joining a `string[]` into one string, keyed by
     question text) is already correct.

   No code change: `claude-provider.ts:450` stays as it is, and bypass needs no caveat.

2. **RESOLVED 2026-08-16 — codex declares no arity; v1's `multiSelect: false` stands.**
   Verified against the generated bindings, not inference:
   `codex app-server generate-ts` on codex-cli 0.147.0 (the version `wire.ts` already pins).

   `ToolRequestUserInputQuestion` is `{ id, header, question, isOther, isSecret,
   options: Array<ToolRequestUserInputOption> | null }` — no `multiSelect`, and no other
   field carrying arity. `ToolRequestUserInputAnswer` is `{ answers: Array<string> }`, so
   codex is structurally list-native per question, but never *says* whether more than one
   is permitted. Mapping `multiSelect: false` is therefore a panel-side default, not a
   translation, and a one-element list satisfies the wire shape.

   The rest of that shape is already modelled by `QuestionSpec`: `isSecret` → `secret`,
   `isOther` → `allowOther`, `options: null` → absent `options` (free-text). Params carry
   `isBlocking` plus a `@deprecated autoResolutionMs`, which stays unmapped.

   Still worth confirming against codex's own UI before a v2 that offers multi-select on
   the codex side — but nothing in v1 blocks on it.

## Deferred

- **Tier B — "always allow"** via permission `suggestions`. Needs a third `ToolDecision`
  variant, a mirror of `PermissionUpdate` that does not drag the SDK into the webview
  bundle through `src/protocol/messages.ts`, and a decision about which
  `PermissionUpdateDestination` the panel writes. That last one is a UX question with a
  persistence consequence, not an implementation detail. Recorded in project memory as
  `permission-suggestions-unused`.
- **MCP elicitation** (`mcpServer/elicitation/request`). A JSON-schema-driven form with
  accept/decline/cancel, not a multiple-choice question. Stays declined.
- **Dismiss without cancelling.** Currently refusing a question cancels the turn. If a
  softer escape proves necessary, it needs its own answer for what the model receives in
  place of the tool result.
