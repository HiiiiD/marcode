# Editor Context Design

Attach the user's current IDE selection to messages sent from the agent panel, with a per-session toggle to suppress it.

## Problem

A message typed in the panel carries no signal about what the user is looking at. Asking "why does this break?" while a function is selected forces the model to rediscover the subject by searching the workspace, or forces the user to paste the code by hand.

## Goals

- A message sent from the panel carries the active file, and the selected ranges when there is a selection.
- The user can turn the attachment off and on without leaving the composer.
- The user can see, before sending and after sending, exactly what was attached.
- No path adds unbounded text to a prompt.

## Non-goals

- Pinning several files or selections at once. That needs an attachment manager — add/remove affordances, ordering, a budget shared across items — and it contradicts a single toggle. If it lands later it is an additive protocol field, and it will want its own chip UX.
- `@file` mentions typed into the input.
- Diff editors, notebooks, images, terminal output.

## Capture policy

Attach the file reference, never the file body. When the user has selected text, attach the selected text; when they have not, attach only the reference. The model has file-reading tools; inlining a whole file on every message spends tokens on what it can fetch on demand.

Rules:

- Only editors whose document URI scheme is `file`. Webview, output, untitled, and virtual editors produce no context.
- All non-empty ranges of `editor.selections` are captured, sorted by start line, with overlapping or adjacent ranges merged. Empty ranges (bare cursors) are dropped.
- If every selection is empty, `selection` is absent and the context is a file reference alone.
- Line numbers are 1-based and inclusive, matching what the editor gutter shows.
- `path` is workspace-relative when the file sits inside an open workspace folder, absolute otherwise.
- Total selected text is capped at 8000 characters. Ranges are filled in document order until the budget is exhausted; remaining ranges are dropped and `truncated` is set. A single range that exceeds the budget on its own is cut at the budget boundary and also sets `truncated`.

## Data model

In `src/providers/types.ts`:

```ts
export interface EditorContext {
  /** Workspace-relative when inside an open folder, absolute otherwise. */
  path: string;
  languageId: string;
  /** Absent when nothing is selected. */
  selection?: {
    /** 1-based inclusive, sorted by startLine, non-overlapping. */
    ranges: { startLine: number; endLine: number; text: string }[];
    /** True when ranges were cut or dropped to fit the budget. */
    truncated: boolean;
  };
}
```

The ranges array is the shape from day one even though the common case holds exactly one. Transcript items persist to disk through `TranscriptStore`; widening a scalar `startLine`/`endLine` pair into an array later would require a tolerant reader for already-written history.

## Protocol changes

In `src/protocol/messages.ts`:

- The `user` variant of `TranscriptItem` gains `context?: EditorContext`.
- `SessionState` gains `includeEditorContext: boolean`, defaulting to `true`.
- New webview-to-host message: `{ t: 'set-include-context'; id: SessionId; on: boolean }`.
- New webview-to-host message: `{ t: 'reveal-file'; path: string; startLine?: number }`, for clicking a chip in the transcript.
- New host-to-webview message: `{ t: 'editor-context'; ctx: EditorContext | null }`. Broadcast, not addressed to a session: the active editor is global IDE state, and every composer shows the same chip.
- `send` keeps its shape, `{ t: 'send'; id; text }`. The toggle is sticky, so the host reads `session.state.includeEditorContext` at send time. Suppressing one message means flipping the toggle, sending, and flipping back.

## Ownership

The host is the single source of truth. It tracks the context; the webview receives it only to render the chip and never echoes it back.

The alternative — the webview returning the object it was shown — guarantees that chip and payload agree, but it puts prompt content under the control of webview state and widens the send message. The host-authoritative version cannot diverge in practice because both the chip and the payload read the same tracker field, and the only window between them is a keystroke.

## EditorContextTracker

New file `src/host/editor-context-tracker.ts`, holding `current: EditorContext | null` and an `onChange` event.

The critical behavior: **`vscode.window.activeTextEditor` becomes `undefined` while the panel webview holds focus.** Since the user must focus the composer to type, a naive live read at send time returns nothing exactly when it matters. The tracker therefore treats `undefined` and non-`file` editors as "no news" and keeps its last valid value. `current` is replaced only when a valid file editor becomes active or its selection changes.

`current` is cleared to `null` only when the last valid editor's document is closed.

The tracker subscribes to `onDidChangeActiveTextEditor` and `onDidChangeTextEditorSelection`. It takes those subscriptions and the workspace-folder lookup through a narrow injected interface rather than importing `vscode`, so it runs under the existing mocha unit suite like the rest of `src/host`.

## Send flow

- `AgentRun.send` gains an optional second parameter: `send(text: string, context?: EditorContext): void`.
- `AgentSession.send(text, context?)` stores `context` on the user `TranscriptItem` and forwards it to `run.send`.
- The message router (Task 7 of the agent-manager plan) resolves the context on `send`: it passes `tracker.current` when `session.state.includeEditorContext` is true, and nothing otherwise. It handles `set-include-context` by writing the flag onto session state and persisting it, and it forwards tracker changes to the webview as `editor-context`.

Providers own formatting. A shared `formatEditorContext(ctx: EditorContext): string` lives beside the provider types so every provider emits the same block:

```
<editor-context path="src/host/agent-session.ts" language="typescript">
<range lines="60-73">
send(text: string): void { … }
</range>
<range lines="88-90">
…
</range>
</editor-context>
```

With no selection the element is self-closing and carries no body. When text was cut, the opening tag carries `truncated="true"` so the model knows it is reading a partial view.

## Webview

The composer toolbar carries a toggle whose label is the live chip:

```
┌──────────────────────────────────────┐
│ fix the send path…                   │
│ [◉ agent-session.ts:60-73 +2] [Send] │
└──────────────────────────────────────┘
```

- The label doubles as a preview of what will be attached. `+N` counts ranges beyond the first.
- Off state renders `○` and dims the label.
- `ctx: null` renders a disabled `○ no editor`. The toggle's stored value is untouched, so it returns as soon as an editor is active again.
- Clicking flips local state optimistically and sends `set-include-context`. The host value wins on reload.
- Reducer state: `editorContext` sits in global webview state; `includeEditorContext` is per session and arrives inside `SessionState`.

A user transcript item with `context` renders the same chip above its text, built from the stored item rather than the live tracker, so history stays accurate. Clicking it sends `reveal-file` for the path and first range.

## Testing

Unit tests under `src/test/unit`, driving fakes rather than the VS Code runtime, matching the existing suite.

- `editor-context-tracker.test.ts`: active editor going `undefined` keeps the last context; a non-`file` scheme editor is ignored; closing the tracked document clears to `null`; multi-cursor selections merge and sort; bare cursors are dropped; exceeding the budget drops the tail and sets `truncated`; path is workspace-relative inside a folder and absolute outside one.
- `format-editor-context.test.ts`: the no-selection, single-range, and multi-range-truncated shapes.
- `agent-session.test.ts`: `send(text, ctx)` stores `context` on the user item and forwards it to the run; `send(text)` produces an item with no `context` field, keeping already-persisted transcripts valid.
- `protocol.test.ts`: the new message variants are covered exhaustively.
- Router test: `includeEditorContext: false` sends no context even when the tracker holds one; `set-include-context` persists across a session reload.

## Risks

- The focus-theft behavior of `activeTextEditor` is the defect most likely to ship unnoticed, because it reproduces only through the real panel. The tracker test covers it directly, and manual verification should confirm the chip survives clicking into the composer.
- The 8000-character cap is a guess. It is a single constant, adjustable once real usage exists.
