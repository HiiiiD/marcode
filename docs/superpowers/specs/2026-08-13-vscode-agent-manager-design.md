# hiiiid-code — Agent Manager Panel

**Date:** 2026-08-13
**Status:** Design approved, pending implementation plan

## Overview

A VS Code extension that puts a chat UI for coding agents in the secondary
sidebar. You run several agent sessions at once, watch two or three of them
side by side in resizable panes, approve the tools they want to run, and come
back later to read what happened.

The extension talks to agents through an `AgentProvider` interface. v1 ships
one implementation, Claude, via `@anthropic-ai/claude-agent-sdk`. Codex and
OpenCode are the reason the interface exists; neither is implemented in v1.

## Goals

- Manage multiple concurrent agent sessions from one panel.
- Full chat UI in the extension — not a launcher for a terminal.
- See several sessions at once in resizable split panes.
- Approve or deny tool calls in the UI.
- Read past sessions, including ones from previous windows.
- Keep agent-specific code behind one interface so a second provider is
  additive rather than invasive.

## Non-goals for v1

- Codex and OpenCode providers.
- Virtualized scrolling.
- Editor-context integration (selection, open file, diagnostics).
- Applying diffs from the UI beyond a read-only preview in the approval card.
- MCP and subagent configuration.
- Transcript retention policy — see Open Questions.

## Placement constraint

`contributes.viewsContainers` accepts `activitybar` and `panel` only. There is
no `auxiliarybar` key, so an extension cannot declare the secondary sidebar as
its default location. Verified against the contribution-points reference.

We contribute a view container to the activity bar holding a `WebviewView`. The
user drags that container into the secondary sidebar; VS Code persists the
location per profile and workspace. This is how third-party sidebar chat
extensions do it. Copilot Chat's native secondary-sidebar home comes from a
proposed chat API that is not available to us.

No programmatic relocation. `workbench.action.moveViews` is undocumented and
would be a hack in the first thing the user sees. First-run guidance instead.

The sidebar is user-resizable to arbitrary width, so split panes are viable
there and no editor-area surface is needed.

## Architecture

The extension host owns all state. Sessions keep running and appending to their
transcripts whether or not the panel is visible. The webview is a rendering
client: it mounts, asks the host to hydrate, then renders patches.

This follows from two constraints. Sessions must run in the background, and VS
Code destroys a webview when it is hidden. It also puts the tool-permission
promise in the host, so a pending approval survives collapsing the sidebar.

Rejected alternatives:

- **Webview-owned state with `retainContextWhenHidden: true`.** Fewer moving
  parts, but the flag is memory-expensive, does not survive window reload, and
  loses pending approvals when the webview goes away. Fails the background
  session requirement.
- **External daemon process.** Survives extension reload and would let other
  clients attach. Correct answer for a future OpenCode server, but for v1 it is
  a second process, an IPC transport, and an orphan-cleanup problem before a
  single message renders. Reachable later without touching the UI by swapping
  the provider implementation.

### Modules

```
src/
  extension.ts                  activate(): wire everything, register the view
  host/
    session-manager.ts          owns Map<SessionId, AgentSession>
    agent-session.ts            one conversation: transcript, status, approvals
    panel-view-provider.ts      WebviewViewProvider: html, postMessage, hydrate
    transcript-store.ts         index.json + per-session JSONL
  providers/
    types.ts                    AgentProvider, AgentEvent, ModelInfo — the seam
    claude/
      claude-provider.ts        wraps the Claude Agent SDK
      map-events.ts             SDK message -> AgentEvent
  protocol/
    messages.ts                 HostToWebview | WebviewToHost
  webview/
    main.tsx
    components/*.tsx            kebab-case filenames throughout
```

`protocol/messages.ts` is the only module both bundles import. Types only — no
runtime code, no `vscode` import — so the browser bundle stays clean.

Responsibilities, each testable alone:

- **`AgentProvider`** — start a turn, yield `AgentEvent`s, answer permission
  requests, interrupt. Knows nothing about VS Code, webviews, or sessions.
- **`AgentSession`** — one conversation. Consumes provider events, appends to
  the transcript, tracks status, holds unresolved approval resolvers. Knows
  nothing about the webview.
- **`SessionManager`** — the roster. Create, close, delete, enumerate, route.
  Knows nothing about rendering.
- **`TranscriptStore`** — durable transcripts. Append, tail-read, page backward.
- **`PanelViewProvider`** — the only module touching both `vscode` and the
  protocol. Contains no agent logic.

## The provider seam

Deliberately narrower than any single agent's API.

```ts
export interface AgentProvider {
  readonly id: string;                    // 'claude' | 'codex' | 'opencode'
  readonly displayName: string;
  listModels(): ModelInfo[];
  start(opts: StartOptions): AgentRun;
}

export interface ModelInfo {
  id: string;                             // 'claude-opus-5'
  displayName: string;
  effort?: { levels: EffortLevel[]; default: EffortLevel };  // absent = no knob
}

export interface StartOptions {
  cwd: string;
  model?: string;
  effort?: EffortLevel;
  permissionMode: PermissionMode;         // 'default' | 'acceptEdits' | 'bypass'
  resumeToken?: string;                   // provider-opaque
}

export interface AgentRun {
  send(text: string): void;
  events: AsyncIterable<AgentEvent>;
  respondToTool(id: string, decision: ToolDecision): void;
  setEffort(effort: EffortLevel): void;
  interrupt(): Promise<void>;
  dispose(): Promise<void>;
}

export type AgentEvent =
  | { kind: 'session';    resumeToken: string }
  | { kind: 'text';       delta: string }
  | { kind: 'thinking';   delta: string }
  | { kind: 'tool-start'; id: string; name: string; input: unknown }
  | { kind: 'tool-end';   id: string; ok: boolean; output: unknown }
  | { kind: 'permission'; id: string; name: string; input: unknown }
  | { kind: 'turn-end';   reason: 'done' | 'interrupted' | 'error'; error?: string }
  | { kind: 'usage';      inputTokens: number; outputTokens: number };

export type ToolDecision =
  | { allow: true; updatedInput?: unknown }
  | { allow: false; reason?: string };
```

Three decisions worth stating:

**Permission is an event, not a callback.** The SDK exposes an async
`canUseTool` callback. `claude-provider.ts` parks that promise's `resolve` in a
map keyed by id and emits a `permission` event; `respondToTool` resolves it.
The provider surface stays one uniform stream, a pending approval is ordinary
session state, and it serializes into hydrate.

**One long-lived run per session, not one per turn.** Streaming-input mode wants
an async-iterable prompt for the run's lifetime, which is also what makes
`interrupt()` work. `send()` pushes into that iterable. A run per turn would
lose interrupt and re-pay session setup.

**`resumeToken` is opaque.** Never parsed. Claude returns a session id; other
providers will return something else. Persisting it is how a session resumes
after a window reload.

**Model is fixed at session creation; effort is mutable.** These are different
kinds of change. Effort is a per-request output setting. Model is the prompt
cache key — swapping it invalidates the cache and raises a live-run restart
question. Changing model means starting a new session, which is cheap because
multi-session is already the design. Effort is validated once at creation
against the model's `ModelInfo.effort`, so later changes always pick from a
known-good ladder.

## Session state

```ts
{
  id: SessionId;                  // ours, uuid
  providerId: string;
  model: string;
  effort?: EffortLevel;
  title: string;                  // first user message, truncated; renameable
  cwd: string;
  status: 'idle' | 'running' | 'awaiting-approval' | 'error';
  permissionMode: PermissionMode;
  transcript: TranscriptItem[];   // append-only
  pending: Map<string, PermissionRequest>;
  resumeToken?: string;
  usage: { inputTokens: number; outputTokens: number };
  archived: boolean;
}
```

Transcript items are coarse — `user | assistant | tool | permission | error` —
not raw events. Text deltas coalesce into the trailing assistant item. The
webview never replays deltas on hydrate, only settled items plus the in-flight
tail.

## Persistence

Files under `context.storageUri`, not `workspaceState`. Mementos hold small
values and rewrite the whole blob per write; transcripts are unbounded and
append-heavy.

```
<storageUri>/
  index.json                 session metadata + pane layout
  sessions/<id>.jsonl        one settled transcript item per line
```

JSONL matches an append-only transcript: one `appendFile` per settled item, no
rewrite. Writes are buffered and flushed on turn-end, on permission-settled, and
on `deactivate()`. In-flight streaming text is not written per delta — only the
coalesced item once it settles. A crash loses at most the current turn's tail;
the alternative is write amplification on every token.

`index.json` is small and rewritten whole on metadata change.

**Loading is lazy and paged.** Startup reads `index.json` only, so the roster
renders instantly regardless of history size. Making a session visible produces
a `session-snapshot` holding the last ~100 items; older items load on demand via
`load-more` / `session-prepend`.

**Where a snapshot comes from depends on whether the session is live.** A live
session holds its recent transcript in memory and serves the snapshot from
there. An archived or not-yet-opened session is read from its JSONL. Both paths
produce the same shape, so `PanelViewProvider` does not branch — `AgentSession`
answers `snapshot()` and decides internally. A live session keeps only a bounded
recent window in memory; anything older comes from disk through the same paging
path, so memory does not grow with a long-running session.

**Close is not delete.** Close stops the run, drops the session from the active
roster, and keeps the transcript — the session is archived. Delete removes the
`index.json` entry and the JSONL file, and is explicitly confirmed. Archived
sessions open read-only; sending a message reopens one live via `resumeToken`.

## Protocol

```ts
type WebviewToHost =
  | { t: 'ready' }
  | { t: 'create-session'; providerId: string; cwd: string;
      model?: string; effort?: EffortLevel }
  | { t: 'set-visible'; sessionIds: SessionId[] }
  | { t: 'set-layout';  layout: PaneLayout }
  | { t: 'close-session';  id: SessionId }
  | { t: 'delete-session'; id: SessionId }
  | { t: 'send';       id: SessionId; text: string }
  | { t: 'interrupt';  id: SessionId }
  | { t: 'set-effort'; id: SessionId; effort: EffortLevel }
  | { t: 'set-permission-mode'; id: SessionId; mode: PermissionMode }
  | { t: 'permission-decision'; id: SessionId; requestId: string; decision: ToolDecision }
  | { t: 'load-more'; id: SessionId; beforeItemId: string };

type HostToWebview =
  | { t: 'hydrate'; sessions: SessionSummary[]; layout: PaneLayout;
      snapshots: SessionSnapshot[]; catalog: ProviderInfo[] }
  | { t: 'session-snapshot'; session: SessionSnapshot }
  | { t: 'session-patch';    id: SessionId; patch: TranscriptPatch }
  | { t: 'session-prepend';  id: SessionId; items: TranscriptItem[]; hasMore: boolean }
  | { t: 'session-status';   id: SessionId; status: SessionStatus }
  | { t: 'sessions-changed'; sessions: SessionSummary[] };
```

Supporting shapes referenced above:

```ts
type SessionId  = string;                 // uuid, ours
type SessionSummary  = Omit<SessionState, 'transcript' | 'pending'>;
type SessionSnapshot = SessionSummary & {
  items: TranscriptItem[];                // recent window, oldest-first
  hasMore: boolean;                       // more history on disk
  pending: PermissionRequest[];
};
type ProviderInfo = { id: string; displayName: string; models: ModelInfo[] };

type TranscriptPatch =
  | { op: 'append';  item: TranscriptItem }
  | { op: 'delta';   itemId: string; field: 'text' | 'thinking'; delta: string }
  | { op: 'replace'; item: TranscriptItem };   // tool-end, permission settled
```

`delta` is the streaming case and targets an item already appended, which is why
`append` always precedes it for a given `itemId`. `replace` settles an item in
place — a tool card gaining its result, a permission card gaining its decision —
so the webview never reconciles by index.

Rules that keep this from rotting:

- **Host is the source of truth.** The webview may optimistically echo the
  user's own message because it feels instant; it invents nothing else.
- **Patches stream for visible sessions only.** Background sessions keep running
  and appending host-side but push status only. Keeps `postMessage` traffic flat
  as session count grows.
- **Every message carries a `SessionId`.** No implicit current session on the
  wire. The webview's idea of what is active and the host's can diverge across a
  reload, and an unaddressed `send` would land in the wrong conversation. This
  rule is also what makes multi-pane fan-out require no wire change.

## UI

**Split panes.** Flat pane list in one group, not a nested tree. Nesting is a
large jump in state and drag-target complexity; making the group recursive later
is additive.

```ts
type PaneLayout = {
  orientation: 'vertical' | 'horizontal';
  panes: { sessionId: SessionId; size: number }[];   // percent
};
```

Built on shadcn `Resizable` (wraps `react-resizable-panels` v4). `minSize` keeps
a pane readable; `collapsible` folds a pane without closing its session.
Orientation is a user choice, with one responsive guard: below ~500px total
width the group forces `vertical` regardless of the stored value and restores
the stored orientation when widened, measured with a `ResizeObserver` on the
webview root. Prevents the three-120px-columns state.

Layout persists via `onLayoutChange` → debounced `set-layout` → host →
`index.json`. Not `autoSaveId`/localStorage: webview storage is sandboxed and
does not survive reliably, and the host is the source of truth.

**Transcript** uses shadcn `MessageScroller`, which exists for exactly this
problem — scroll behaviour under streaming.

```tsx
<MessageScrollerProvider autoScroll defaultScrollPosition="last-anchor">
  <MessageScroller>
    <MessageScrollerViewport>
      <MessageScrollerContent>
        {items.map(i => (
          <MessageScrollerItem key={i.id} messageId={i.id} scrollAnchor={i.role === 'user'}>
            {renderItem(i)}
          </MessageScrollerItem>
        ))}
      </MessageScrollerContent>
    </MessageScrollerViewport>
    <MessageScrollerButton />
  </MessageScroller>
</MessageScrollerProvider>
```

- `autoScroll` follows the live edge without yanking the view when the user has
  scrolled up to read — the exact problem the patch stream creates.
- `defaultScrollPosition="last-anchor"` with `scrollAnchor` on user messages
  means opening a session lands at the start of the last turn, not mid-output
  with no visible question. `scrollPreviousItemPeek` (~64px) keeps the previous
  turn's tail visible.
- `useMessageScrollerVisibility()` gives `currentAnchorId`, so the roster's
  unread indicator clears on scrolled-to rather than merely selected.
- `preserveScrollOnPrepend` covers `load-more` history paging.

One `MessageScrollerProvider` per pane — provider-scoped, so instances are
independent by construction. Each pane has its own composer, effort control, and
scroll position.

**Per-pane chrome:** session title, provider/model badge, status dot, session
picker, close. **Composer:** textarea; send, replaced by interrupt while
running; inline effort selector when the model has one; permission-mode
selector. **Roster:** switcher dropdown with title, status dot, unread
indicator, plus a History view for archived sessions.

Tool calls render collapsed (name + one-line input summary), expanding on click.
Permission requests render as a blocking card at the point they occurred: tool
name, input, Allow/Deny, and a read-only diff preview for `Edit`/`Write`. A
session awaiting approval is visually distinct in the roster — it is blocked on
the user and would otherwise read as a hang.

## Build and webview constraints

Two esbuild configs sharing the existing watch/production flags:

- Extension host — node, CJS, `dist/extension.js` (exists).
- Webview — `platform: 'browser'`, `format: 'iife'`, entry
  `src/webview/main.tsx`, output `dist/webview.js` + `dist/webview.css`.

**CSP.** `panel-view-provider.ts` emits HTML with a per-load nonce,
`default-src 'none'`, script and style limited to `webview.cspSource` plus the
nonce, `localResourceRoots` pinned to `dist/`. Assets go through
`asWebviewUri()`. No remote fetches — this is what rules out any library that
loads fonts or icons at runtime. shadcn suits this: `shadcn add` vendors source
into the repo rather than adding a runtime dependency.

**Theming.** shadcn components read shadcn's token layer (`--background`,
`--foreground`, `--muted`, …). One CSS layer redefines those tokens in terms of
VS Code's `--vscode-*` variables, and a Tailwind v4 `@theme inline` block
registers them under the `--color-*` namespace so `bg-background` and
`border-border` exist as ordinary utilities. Light, dark, and high-contrast
follow the user's theme for free.

shadcn's current registry is **Base UI**-backed (`@base-ui/react`), not Radix.
All interactive controls — selects, dropdowns, buttons, text areas — come from
vendored shadcn components rather than raw HTML elements, for keyboard and
screen-reader behaviour we would otherwise have to reimplement.

**`retainContextWhenHidden` stays off.** Hydrate-on-`ready` makes that
affordable, and durable state is host-side.

## Error handling

Four failure classes, none of which may kill a session. Failures are state, not
exceptions — nothing throws across the `postMessage` boundary.

- **Provider crash or process exit.** `AgentRun.events` ends abnormally; session
  goes `error`, an error item is appended, `resumeToken` is retained so the user
  can retry into the same conversation.
- **Missing auth.** The Claude Agent SDK fails at the first turn, not at
  construction. Surface as an actionable transcript item ("run `claude` once to
  log in"), not a raw stack trace.
- **Unanswered permission request.** A session sits `awaiting-approval`
  indefinitely by design; the roster must make that visible. On close, pending
  resolvers settle as denied so the provider can unwind.
- **Webview reload mid-stream.** The host keeps appending; `ready` triggers a
  hydrate that replays settled items plus the in-flight tail. Nothing is lost
  because the webview never owned it.

## Testing

The seams were chosen to make this cheap.

- `AgentSession` and `SessionManager` — unit tests against a `FakeProvider`
  emitting scripted `AgentEvent` sequences. Covers delta coalescence, permission
  park and resolve, interrupt, error transitions. No VS Code, no network.
- `map-events.ts` — table-driven: recorded SDK messages in, `AgentEvent` out.
  This is where Claude-specific breakage surfaces first.
- `TranscriptStore` — append N items, reload, verify tail read plus paged
  prepend reconstructs the same sequence. `storageUri` points at a temp dir.
- Protocol — type-level. Both bundles importing one definition makes a mismatch
  a compile error.
- `@vscode/test-cli` integration (already scaffolded): extension activates, view
  registers, webview HTML carries a nonce and no remote sources.

`FakeProvider` doubles as the walking-skeleton harness, so the UI is buildable
before `claude-provider.ts` exists.

## Risks

**Claude Agent SDK API details are unverified.** The exact `query` options
shape, `canUseTool` signature, interrupt mechanics, and whether effort can
change on a live run have not been checked against the installed package. First
implementation step is reading its documentation. Blast radius is
`providers/claude/`; if a detail differs it is absorbed there and the protocol
and provider interface are unaffected. If effort turns out to need per-turn
threading rather than a live setter, `AgentRun.setEffort` becomes a stored value
applied at the next turn — no change above the seam.

**Secondary sidebar placement is manual.** The user must drag the container
across on first run. Rough first impression and the most likely part of this
design to be revisited.

## Open questions

**Transcript storage growth.** v1 stores plain, uncompressed JSONL and applies
no retention — transcripts accumulate on disk until explicitly deleted.
Unbounded storage is a real if slow-moving problem. Two v1.1 levers, deferred
together because neither is worth designing without evidence of actual volume:

- **Compress on archive.** Live sessions stay plain JSONL so appends stay one
  `appendFile` and tail reads stay a byte-offset seek; gzip the file once when a
  session is archived, and decompress on reopen. `index.json` records which form
  each session is in. Archived sessions are the bulk of stored bytes and are
  read rarely, so this captures most of the saving with no cost on the path that
  runs per token. Compressing on write instead would mean a member-offset index
  just to support tail reads and backward paging.
- **Retention policy.** A size cap or prune-by-age.

Compression is a constant factor, not a substitute for retention — it buys
roughly an order of magnitude, then the same question returns.
