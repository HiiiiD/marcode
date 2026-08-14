# hiiiid-code — Codex Provider

**Date:** 2026-08-14
**Status:** Design approved, pending implementation plan

## Overview

A second real `AgentProvider`, backed by the Codex CLI's `app-server` — an
experimental JSON-RPC service over stdio that multiplexes many conversations
("threads") in one process.

The original design named Codex as the reason `AgentProvider` exists. This
spec cashes that in. Most of the work is an adapter under
`src/providers/codex/`; the host changes are two additive fields on
`ProviderInfo` and one new shared helper.

Verified against `codex-cli 0.147.0`. All protocol claims here were read from
`codex app-server generate-ts` output, not from documentation.

## Goals

- A Codex session is a first-class peer of a Claude session: same roster, same
  panes, same transcript, same approval cards.
- Interactive tool approvals, answered from the panel. This is a hard
  requirement, and it is what picks the transport.
- Report what Codex actually supports, rather than pretending it matches
  Claude — including declining to offer a mode that would be a no-op.
- A user without Codex installed sees the panel they see today, plus one
  disabled row explaining how to get it.

## Non-goals for v1

- Streaming tool output. Codex can stream command output live; we buffer and
  emit at item completion, matching Claude. Parity, not a regression.
- `approved_for_session`, execpolicy amendments, and network-policy
  amendments. Each needs a third button on the permission card.
- Rendering `item/tool/requestUserInput` and `mcpServer/elicitation/request`.
  Both are input requests, not yes/no; see Declined Requests.
- A host-side approval classifier. See Deferred: Host Classifier.
- `turn/steer` (sending into a running turn). Codex supports it; nothing in
  the panel exposes it yet.

## Transport

Three surfaces were considered:

| Surface | Approvals | Verdict |
|---|---|---|
| `@openai/codex-sdk` | policy fixed at start | fails the hard requirement |
| `codex exec --json` | none | fails the hard requirement |
| `codex app-server` | `item/*/requestApproval` server requests | chosen |

Only `app-server` can raise an approval to the client and wait for an answer,
which is the `permission` / `respondToTool` contract in `AgentProvider`.

It is marked experimental. That cost is accepted, and mitigated under Version
Skew.

**No new dependencies.** We spawn the CLI and speak JSON-RPC over stdio. The
host bundle is already node/CJS, so `child_process` is available.

## Process model

One `codex app-server` child process for the whole extension, spawned lazily
on first need, ref-counted by live Codex sessions plus the usage strip's
activation-time pull, torn down when the last one goes.

Not one process per session: threads are already multiplexed by `threadId`,
and `ThreadStartParams` accepts `model`, `cwd`, `approvalPolicy`,
`approvalsReviewer` and `sandbox` per thread, so one process serves
differently-configured sessions. Per-session processes would multiply a large
Rust binary by the roster size, which is the thing the panel exists to make
cheap.

Crash blast radius is the cost, and it is contained: the process dies, every
Codex session transitions to `error` with a transcript item, and recovery is
`thread/resume` against the `threadId` already persisted as `resumeToken`. A
crash is a reconnect, not data loss. Restart uses backoff on next demand;
repeated failure sets `unavailable`.

Process-global requests (`account/*`, `model/list`) need no thread, which is
exactly what `fetchUsage(cwd)` and `fetchModels(cwd)` require.

## Handshake

`initialize` precedes all other traffic:

```
clientInfo:   { name: 'hiiiid-code', title: null, version }
capabilities: { experimentalApi: true,
                requestAttestation: false,
                optOutNotificationMethods: [...] }
```

`experimentalApi` is declared deliberately: the guardian notifications and
other experimental members are gated behind it.

`optOutNotificationMethods` suppresses, at the connection level, everything we
do not consume — realtime audio, `fs/changed`, `rawResponse/*`, apps,
marketplace. The socket is chatty by default.

## Module layout

Mirrors `src/providers/claude/`. Nothing here imports `vscode`, so all of it
unit-tests outside the extension host.

| File | Responsibility |
|---|---|
| `codex/app-server.ts` | child process, line-framed JSON-RPC, request/response correlation, notification dispatch by `threadId` |
| `codex/codex-provider.ts` | `AgentProvider`; owns the shared connection, answers `model/list` and `account/rateLimits/read` |
| `codex/codex-run.ts` | `AgentRun` over one thread |
| `codex/map-events.ts` | `ServerNotification` / `ServerRequest` → `AgentEvent` |
| `codex/map-settings.ts` | `PermissionMode` → the three axes; `EffortLevel` ↔ `ReasoningEffort` |
| `codex/map-usage.ts` | `RateLimitSnapshot` → `UsageWindow[]`; `ThreadTokenUsage` → `ContextBreakdown` |
| `codex/wire.ts` | hand-written types for the protocol members we consume |

`generate-ts` emits 300+ files, most of them apps, plugins, realtime audio and
fs. Vendoring all of it makes every Codex upgrade a thousand-line diff for no
reading benefit. `wire.ts` covers the ~25 members we actually consume, and a
`yarn codex:bindings` dev script regenerates the full set to a scratch
directory for diffing when Codex updates.

## Permission modes

Codex has three independent axes where the panel has one:

```ts
approvalPolicy:    AskForApproval    // untrusted | on-request | {granular:{…}} | never
sandboxPolicy:     SandboxPolicy     // read-only | workspace-write | danger-full-access
approvalsReviewer: ApprovalsReviewer // user | auto_review | guardian_subagent
```

`approvalPolicy` decides *whether* an approval is raised. `approvalsReviewer`
decides *who answers it* — this is the knob Codex's own UI labels "Approve for
me".

### Declared per provider

`PermissionMode` stays a closed union, and the provider declares which members
it offers. This is the `EffortLevel` precedent exactly: a closed union, with a
per-model subset and default.

```ts
// providers/types.ts
export interface PermissionModeInfo {
  id: PermissionMode;
  /** Provider-specific. The picker renders it as the row's second line —
   *  the same id enforces differently per provider, so the id alone is not
   *  enough for the user to choose safely. */
  description?: string;
}

interface AgentProvider {
  /** Sync, like listModels: creation and the roster read it inline.
   *  MUST include 'default' — creation falls back to it in message-router. */
  listPermissionModes(): PermissionModeInfo[];
}
```

`ProviderInfo` gains `permissionModes: PermissionModeInfo[]`, so it rides the
existing `hydrate` and `catalog` messages. No new wire message.

`src/shared/permission-catalog.ts` gets `resolvePermissionMode(modes,
requested)`, mirroring `resolveEffort` — including its "absent means no
opinion" rule, since an empty list is a catalog that has not loaded and must
not wipe a real choice. **The fallback is always `'default'`, never
`'bypass'`**, which keeps the creation-only-bypass rule in `message-router.ts`
intact even when a persisted session's mode is no longer offered.

`mode-menu.tsx` and `session-create-dialog.tsx` iterate the provider's list
instead of the hardcoded set they use today. `MODE_OF` (icon and label per id)
stays: the id space is still closed.

### Codex's five modes

| Mode | `approvalPolicy` | `sandboxPolicy` | `approvalsReviewer` |
|---|---|---|---|
| `default` | `on-request` | `workspace-write` | `user` |
| `auto` | `on-request` | `workspace-write` | `auto_review` |
| `plan` | `never` | `read-only` | `user` |
| `dontAsk` | `never` | `workspace-write` | `user` |
| `bypass` | `never` | `danger-full-access` | `user` |

`acceptEdits` is **omitted**. Under `workspace-write`, in-workspace edits do
not raise an approval at all, so a Codex `acceptEdits` would be a second name
for `default`. An honest five beats six with one that quietly does nothing —
that omission is the entire point of declaring modes per provider.

## Auto mode: the guardian

`auto` maps to `approvalsReviewer: auto_review`, Codex's own reviewer
subagent. Per its type documentation, it "uses a carefully prompted subagent
to gather relevant context and apply a risk-based decision framework before
approving or denying the request."

Flow:

1. `item/autoApprovalReview/started`
2. the reviewer runs, then `…/completed` carries `GuardianApprovalReview
   { status, riskLevel: low|medium|high|critical, userAuthorization, rationale }`
   and a typed `GuardianApprovalReviewAction`
3. **approved** — the `item/*/requestApproval` server request never reaches
   the client. The tool simply runs.
4. **denied** — terminal unless overridden via
   `thread/approveGuardianDeniedAction`.

### Auto-approvals are silent in v1

An approved guardian review produces no transcript artifact. This matches
Codex's own surfaces, and it means no new `TranscriptItem` field and no UI
pass.

Recorded because it is a real trade: silent auto-approval is
indistinguishable from no approval at all, so if `auto` ever needs an audit
trail, the shape is an additive optional `autoApproval?: { riskLevel,
rationale }` on the tool item — the same way `children` and `mcpServer` were
added, with no migration.

### Guardian denials

A denial gets a permission card of the existing shape (allow / deny). The
provider routes the answer to `thread/approveGuardianDeniedAction` — which
takes the serialized assessment event back — instead of to a `ReviewDecision`.
Internal to `codex-run.ts`. No protocol change.

## Event mapping

| Codex | `AgentEvent` |
|---|---|
| `thread/started` | `session` (`resumeToken` = `threadId`) |
| `item/agentMessage/delta` | `text` |
| `item/reasoning/textDelta`, `…/summaryTextDelta` | `thinking` |
| `item/started` | `tool-start` |
| `item/completed` | `tool-end` |
| `turn/completed`, `error` | `turn-end` |
| `thread/tokenUsage/updated` | `usage`, and feeds `contextBreakdown()` |
| `account/rateLimits/updated` | `usage-stale` |
| `mcpServer/startupStatus/updated` | `mcp-servers` |
| `skills/list`, `skills/changed` | `invocables` |
| `item/*/requestApproval` | `permission` |

`account/rateLimits/updated` carries real numbers, unlike Claude's
`rate_limit_event` — but its own documentation calls it a sparse rolling
update and says to merge into the last `account/rateLimits/read` or refetch.
We treat it as a signal and pull. This honors the existing pulled-never-pushed
invariant and avoids writing sparse-merge logic.

`ThreadItem` has 18 kinds. Those that render as tools: `commandExecution`,
`fileChange`, `mcpToolCall`, `webSearch`, `dynamicToolCall`, `plan`.
`subAgentActivity` and `collabAgentToolCall` map onto the depth-1 `children`
nesting the transcript already has.

`tool-render.ts` keys off Claude tool names (`Bash`, `Edit`, `Read`) and needs
a Codex arm. Command, diff and path blocks all already exist, so this is
mapping work, not new block types.

Parsing is tolerant: unknown notification methods and unknown `ThreadItem`
kinds are ignored, never thrown.

### Decisions

`ToolDecision` → `ReviewDecision`:

- `{ allow: true }` → `approved`
- `{ allow: false, reason }` → `{ denied: { rejection } }`

### Declined requests

`item/tool/requestUserInput` (a list of questions, `isBlocking`) and
`mcpServer/elicitation/request` (form / openai-form / url) are input requests,
not yes/no. Both are experimental and only fire if a tool or MCP server uses
them.

v1 must still answer them or the turn hangs, so both are declined with a
transcript note saying the panel cannot render this yet. Honest, and errors
stay state.

## Availability

**No new mechanism.** The host already has one, and it is the right one:
`refreshModels` doubles as the availability probe. A provider whose
`fetchModels` rejects is dropped from `catalog()`, appears in `unavailable()`
carrying the reason it gave, and rejoins the moment it answers again.
`UnavailableProvider` already rides the `hydrate` and `catalog` messages, the
reducer already keeps it, and `ModeMenu` already takes a `disabled` prop
documented as "the session's provider is unavailable".

So Codex needs to do exactly one thing: **reject `fetchModels` with a
human-readable, already-redacted one-liner.**

| Case | Detection | Rejection message |
|---|---|---|
| Binary not found | PATH probe, `hiiiidCode.codex.path` override | "Codex CLI not found. Install it, or set hiiiidCode.codex.path." |
| Not logged in | `account/read` (`requiresOpenaiAuth`) | "Not signed in to Codex. Run `codex login`." |
| `initialize` failed | handshake | the handshake error, redacted |
| Version out of range | `codex --version` | resolves, not rejects — degraded but usable |

Note the last row: an old CLI still returns models, so it stays *pickable*.
Only a version we cannot speak to at all rejects.

`SessionManager` already records the reason, already clears it on recovery,
and already drops the persisted model seed alongside it so a stale list
cannot outlive the install it described. None of that is re-implemented.

Re-probe has no polling, and needs no new plumbing either: `refreshModels(cwd)`
*is* the re-probe. Triggers are activation, an explicit Retry in the UI, and a
change to `hiiiidCode.codex.path` — the last of which the existing code
comments already anticipate.

A `hiiiidCode.codex.login` command opens a terminal running `codex login` —
that is the whole fix, and the user is already in the IDE.

**An unavailable provider never blocks reading history.** A persisted Codex
session on a machine without Codex — settings sync, a shared repo, an
uninstall — still renders its transcript, pages, and deletes. Only the
composer is disabled, carrying the provider's reason. A missing binary must
not cost the user their record of what happened. The persisted `catalog.json`
seed keeps model labels resolving for those sessions until a probe answers
either way.

One dead provider must never stall or blank out another: that is already
guaranteed by the per-provider `.catch` in `refreshModels` and `refreshUsage`.

## Version skew

`InitializeResponse` carries `userAgent`, `codexHome`, `platformFamily` and
`platformOs` — **no negotiated protocol version**. There is no clean way to
learn that Codex changed a shape under us; we would find out through a runtime
parse failure.

Mitigations, in order of value:

1. Tolerant parsing (above) — an added notification or item kind is a no-op,
   not a crash.
2. A pinned tested CLI version range; out-of-range runs degraded with a
   visible reason rather than blocking.
3. The skew test under Testing, which turns a silent runtime failure into a
   red test.

## Testing

**Unit** (mocha, from source, no `vscode`):

- `map-events` — recorded notification fixtures → `AgentEvent`. Fixtures are
  captured from a real app-server run and trimmed by hand, so they are real
  shapes rather than invented ones.
- `map-settings` — the five-mode table against the three axes, effort ↔
  `ReasoningEffort`, and `resolvePermissionMode` fallbacks, explicitly
  including "never resolves upward into `bypass`".
- `map-usage` — `RateLimitSnapshot` → `UsageWindow`, `ThreadTokenUsage` →
  `ContextBreakdown`.
- `app-server` — driven against a stub stream pair, no real binary: framing,
  request/response correlation, dispatch by `threadId`, and crash → every
  attached run reports `turn-end: error`.

**DOM:** the mode menu and create dialog rendering a provider-declared mode
list, and the `unavailable` case. Through the real `StoreProvider` with
genuine `HostToWebview` messages, asserting on booleans and strings, never on
nodes.

**Integration:** the `@vscode/test-cli` suite skips Codex — it needs a binary
and a logged-in account. An opt-in smoke test, gated on `codex` being present,
spawns the real app-server, runs `initialize` and `thread/start` in `plan`
mode, takes one trivial turn, and asserts the event sequence. Skipped, not
failed, when absent.

**Skew check:** when the CLI is installed, regenerate bindings to a temp dir
and assert every method-name string we use still exists in `ClientRequest` and
`ServerNotification`. This is the closest thing to the version negotiation the
handshake does not offer.

### `resetsAt` was measured, not assumed

`RateLimitWindow.resetsAt` is a bare `number | null` with no documented unit,
and CLAUDE.md records that mixing scales is a live bug class here — the Claude
provider carries epoch seconds on one path and ISO strings on the other.

So it was measured rather than inferred. `account/rateLimits/read` on
codex-cli 0.147.0 returned `resetsAt: 1787337648` against a wall clock of
`1786736436` seconds on 2026-08-14 — 6.96 days out on a 10080-minute window.
**Epoch seconds.** `UsageWindow.resetsAt` is epoch milliseconds, so the
adapter converts, and a test pins the conversion.

Also observed on that account: `primary` is the weekly window and `secondary`
is `null`, which is why an absent window is omitted rather than rendered as
0%. `usedPercent` is already a percentage, so the "usage surfaces show
percentages, never token counts" invariant holds without conversion.

## Deferred: host classifier

An alternative `auto` was considered: intercept every escalated approval and
have the host classify it, so `auto` means one thing across providers.

Rejected for v1 because it does not deliver what it promises. Claude's `auto`
is already Anthropic's classifier inside the SDK, so a host classifier that
covers only Codex produces a third judgment rather than a unified one — real
uniformity would require displacing Claude's native `auto` too, which is a
larger scope than adding a provider. Beyond that it costs a second vendor's
auth on the critical path (a Codex-only user could not use `auto` at all),
latency in the one interaction where the user is already blocked, and a
rebuild of a risk framework that Codex ships with per-user and enterprise
policy configuration. It is also safety-critical: a false allow runs a
destructive command, so the failure-policy and audit work exceeds the
classifier itself.

What keeps the option open at no cost: `AgentSession` already parks approvals
before creating a permission card. That stays a real seam — provider raises an
approval, session decides card-or-auto, card. The guardian just means the
provider raises fewer of them. A host classifier drops into that seam later
without touching the Codex adapter.

## Host changes summary

Everything else is additive under `src/providers/codex/`.

- `providers/types.ts` — `PermissionModeInfo`, `AgentProvider.listPermissionModes()`
- `protocol/messages.ts` — `ProviderInfo.permissionModes`
- `shared/permission-catalog.ts` — new, `resolvePermissionMode`
- `host/session-manager.ts` — carry `permissionModes` into `catalog()`
- `webview/components/permission-modes.ts` — `MODES` filtered by what the
  session's provider declares; provider description overrides the shared one
- `webview/components/mode-menu.tsx`, `session-create-dialog.tsx` — iterate
  the declared list instead of all of `MODES`
- `webview/components/tool-render.ts` — a Codex arm
- `extension.ts` — register the provider; `hiiiidCode.codex.path` setting,
  `hiiiidCode.codex.login` command

Availability needs **no host change at all** — see Availability above.

No transcript migration: no persisted shape changes.

## Effort levels

`ReasoningEffort` is an open `string` in the protocol, and each model
publishes its own `supportedReasoningEfforts`. A live `model/list` on
codex-cli 0.147.0:

| Model | Scale | Default |
|---|---|---|
| gpt-5.6-sol *(default)*, gpt-5.6-terra | low, medium, high, xhigh, max, **ultra** | low / medium |
| gpt-5.6-luna | low, medium, high, xhigh, max | medium |
| gpt-5.5, gpt-5.4, gpt-5.4-mini | low, medium, high, xhigh | medium |

`ultra` — "Maximum reasoning with automatic task delegation" — is the only
value outside `EffortLevel`, and there is no `minimal`.

**So the union gains `'ultra'` rather than the adapter filtering it away.**
Filtering would silently drop the top level of Codex's newest models, which is
a worse outcome than one more union member. Levels are already declared per
model, so Claude's models simply never list it and their sliders are
unchanged.

The adapter still skips a level it does not recognize: the union is closed and
shared with every provider, so a value added by a future Codex release must
not widen the slider for everyone by accident.

## Open questions

None blocking. One item is deliberately settled *during* implementation:

- The tested CLI version range — established once the adapter runs against a
  real thread.

The two that were open at design time are now measured and recorded above:
`resetsAt` is epoch seconds, and the effort scales are the table in Effort
Levels.
