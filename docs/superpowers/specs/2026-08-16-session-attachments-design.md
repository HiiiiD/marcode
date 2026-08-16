# Session attachments

**Date:** 2026-08-16
**Status:** Approved, ready for planning

## Problem

A turn can carry prose, editor context and session refs. It cannot carry a file, and it
cannot carry a screenshot at all.

Pasting a screenshot into a coding agent is one of the highest-value inputs there is — a
rendering bug, a stack trace in a terminal, a design comp — and it is the one input this
panel has no vocabulary for. Today the only way to get an image in front of the agent is to
save it somewhere, then type its path and hope the agent reads it.

The composer's own comments anticipate the gap. `session-mentions.ts:38` notes that "file
tagging arrives as one more source here and changes nothing else", and `composer.tsx:123`
repeats it. The machinery for pending, removable, token-bearing chips already exists for
`@`-refs; nothing feeds it files.

Both backends can accept images. Neither is asked to.

- Claude: `SDKUserMessage.message.content` is `Array<ContentBlockParam>`, which includes
  `ImageBlockParam` (`@anthropic-ai/sdk/resources/messages/messages.d.ts:610`).
  `claude-provider.ts:527` sends an array of exactly one text block.
- Codex: `turn/start`'s `input` is `Array<UserInput>`, a seven-variant union
  (`.codex-bindings/v2/UserInput.ts:7`) whose members include
  `{ type: 'localImage', path, detail? }` and `{ type: 'image', url, detail? }`.
  `codex-run.ts:353` sends an array of exactly one text item. The serde tags are present in
  the shipped `codex-cli 0.147.0` binary, so this is protocol, not aspiration.

## Scope

**In:**

- An attachment as a first-class part of a turn: added by button, by drag-and-drop, or by
  paste; shown as a removable chip; carried on the wire; replayed after a reload.
- Pasted image bytes persisted to disk by the host, under `context.storageUri`.
- Files from anywhere on disk, including outside the workspace.
- Claude and Codex each rendering attachments in their own native shape.
- `FakeProvider` recording attachments so tests can assert them.

**Out (see Deferred):** per-attachment line ranges; inlining a text file's contents rather
than referencing its path; attachments on anything but a user turn; editing or annotating an
image in the panel; remote URLs.

## Decisions

Each was taken deliberately; the rationale matters more than the choice.

1. **An attachment is a file on disk with an absolute path.** This is the load-bearing
   decision. Paste, the file button and drop all converge on it before anything else
   happens, so there is one attachment model rather than three. It is also the only model
   both providers can serve at full fidelity: Codex's `localImage` variant *is* a path, and
   Claude can be handed base64 read from that path. Bytes-in-memory would have forced a
   data-URL `{type:'image', url}` for Codex — a variant this repo has never exercised — and
   would have lost every attachment on reload.

2. **The host mints every `Attachment`; the webview never invents one.** A paste posts raw
   base64 and gets an `Attachment` back. A drop posts URIs and gets `Attachment`s back. The
   webview holds only what the host handed it. This keeps path normalisation, size limits,
   kind sniffing and existence checks in one place, and preserves the standing rule that the
   extension host owns all state.

3. **The pending set lives on `AgentSession`, not in the composer, and `send` does not
   carry it.** Attachments arrive from the host asynchronously, so composer-local state
   would mean the webview holding something the host does not — the one thing this
   architecture forbids. Instead the host owns the pending list, ships it on
   `SessionSnapshot`, replaces it wholesale on every change, and consumes and clears it when
   the turn goes out. Three consequences fall out for free: the wire carries a
   multi-megabyte payload exactly once (at paste), the `send` message is unchanged, and
   pending chips survive a webview reload — because host memory outlives it — which is
   more than a draft does today.

4. **Out-of-workspace paths are allowed, with no root check.** The `open-file` precedent
   validates against the session's memory files, but that guards a *host* action taken on a
   webview-supplied path. Here the path's only consumer is the agent, which has its own
   sandbox and its own permission gate. Adding a root check would block the common case —
   a screenshot in `~/Downloads`, a log outside the repo — to prevent nothing the agent's
   own permission card does not already prevent.

5. **Images go inline; non-image files go by reference.** An image becomes an
   `ImageBlockParam` (Claude) or a `localImage` input item (Codex) — the model sees it
   directly, and the agent's filesystem sandbox is never involved. A non-image file becomes
   a line in the prompt text naming its path, and the agent reads it with its own Read tool.
   For a file outside the workspace that read may raise a permission card; that is the
   existing mechanism working, not a new failure mode.

6. **`AgentProvider.send` widens rather than gaining a sibling method.** Attachments belong
   to the turn they were composed with, exactly as `EditorContext` does. A separate
   `sendAttachment` would let a turn's attachments and its text arrive independently, which
   no provider can represent.

7. **The composer's paperclip changes hands; the toggle stays put.**
   `editor-context-toggle.tsx:47` owns the `Paperclip` glyph today, but it names a file the
   user is *looking at*, not a file they attached. Attachments take the paperclip — the
   universal signifier, and this is the feature it signifies — and the editor-context
   toggle swaps to `FileCode2`. It does **not** move into `ModeMenu`: its value is the
   inline preview of which file and which lines would be attached, and a menu item shows
   none of that. The block-end row does gain one `icon-xs` button; that row's `flex-wrap`
   exists precisely so a control can land on a second line at 300px rather than shrink its
   neighbours.

## Architecture

```
composer.tsx
  ├─ onPaste ──── clipboardData.files ──▶ attach-paste { base64 }
  ├─ onDrop ───── text/uri-list ────────▶ attach-drop { uris }
  └─ paperclip ─────────────────────────▶ attach-pick
                                              │
                     ┌────────────────────────┘
                     ▼
        panel-view-provider.ts ── showOpenDialog, Uri → fsPath   (only vscode importer)
                     │
                     ▼
        message-router.ts ──▶ AttachmentStore
                                 ├─ write pasted bytes → <root>/attachments/<sessionId>/
                                 ├─ sniff kind, cap size and count
                                 └─ mint Attachment ──▶ attachments-added
                     │
                     ▼
        agent-session.send(text, context?, attachments?)
                     │
          ┌──────────┴───────────┐
          ▼                      ▼
   ClaudeProvider           CodexRun
   image → ImageBlockParam  image → { type:'localImage', path }
   file  → path line        file  → path line
```

`AttachmentStore` is a sibling of `TranscriptStore`: same `rootDir`, no `vscode` import,
unit-testable outside the extension host.

## Components

### Wire — `src/protocol/messages.ts` (types only)

```ts
export type AttachmentKind = 'image' | 'file'

export type Attachment = {
  id: string          // stable within a session; chip key and removal handle
  path: string        // absolute, normalised
  name: string        // basename, what the chip shows
  kind: AttachmentKind
  mediaType?: string  // set for images; drives the Claude block's media_type
  bytes: number       // shown on the chip for large files; also the cap's evidence
}
```

Additions:

- `SessionSnapshot` gains `pendingAttachments: Attachment[]` — live host state, beside
  `mcpServers`, not persisted to `index.json`
- The user `TranscriptItem` gains `attachments?: Attachment[]`, so the transcript records
  what a turn carried, exactly as `refs` and `context` do
- Webview→host: `attach-paste { id, name, mediaType, base64 }`, `attach-pick { id }`,
  `attach-drop { id, uris: string[] }`, `attach-remove { id, attachmentId }` — all four
  added to `KNOWN_MESSAGE_TAGS`
- Host→webview: `session-attachments { id, attachments }` — a full replacement, the same
  snapshot semantics as `session-invocables` and `session-mcp`; and
  `attachments-rejected { id, reason }`
- `send` is **unchanged**. The host already holds the pending set.

### `src/host/attachment-store.ts` (new)

Owns `<rootDir>/attachments/<sessionId>/`.

- `savePaste(sessionId, { name, mediaType, base64 })` → `Attachment`. Writes atomically,
  names the file by a monotonic counter plus the sniffed extension.
- `adopt(sessionId, paths)` → `Attachment[]`. For picked and dropped files: stats each path,
  sniffs kind, returns an `Attachment` referencing the file *in place*. Nothing is copied —
  a file the user already has on disk is already durable.
- Caps: 10 MB per attachment, 10 per turn. A violation yields `attachments-rejected` with a
  reason, never an exception.
- `remove(sessionId)` reaps the session's directory, called from the existing delete path.

Adopted paths are not copied, so an attachment can go stale if the user moves the file
between composing and sending. The send path stats each path and reports a missing file the
same way missing refs are reported today (`message-router.ts:167`) — an error transcript
item, turn not started.

### Host wiring

- `message-router.ts` gains the four attach handlers, each ending in a
  `session-attachments` emit. Still no `vscode` import: the file dialog arrives through an
  injected `AttachmentHost { pick(): Promise<string[]> }`, exactly as the editor arrives
  through `EditorContextHost` today.
- A `uris` payload is turned into paths by a pure `file-uri.ts` helper, not by
  `vscode.Uri` — so the drop path unit-tests like everything else in the router.
- `extension.ts` supplies the real `AttachmentHost`, wrapping
  `vscode.window.showOpenDialog`.
- `agent-session.ts` holds `pendingAttachments`, exposes add/remove, and `send` drains them
  onto the user `TranscriptItem` and into `run.send`.

### Providers

`src/providers/types.ts`: `send(text: string, context?: EditorContext, attachments?: Attachment[]): void`

**Claude** (`claude-provider.ts:527`) — text block first, then one `ImageBlockParam` per
image attachment with a base64 source read off the path at send time. Non-image attachments
append a line to the text block naming the path.

**Codex** (`codex-run.ts:353`) — the existing text item, then one
`{ type: 'localImage', path, detail: 'auto' }` per image. Non-image attachments append a
line to the text. Two supporting fixes:

- `wire.ts` gains a `UserInput` type mirroring `.codex-bindings/v2/UserInput.ts`. The skew
  test checks method names only, so a payload-shape assertion goes in `codex-run.test.ts`
  alongside it.
- `ThreadItem`'s `imageView` variant (`.codex-bindings/v2/ThreadItem.ts:117`) gets modelled,
  so an echoed image does not fall through `map-events.ts`'s tolerant catch-all.

**Fake** records attachments on its script log so DOM and unit tests can assert them.

### Webview

- `composer.tsx` reads `pane.attachments` from the store — it holds none of its own — and
  removes a chip by posting `attach-remove`.
- A chip strip as an `InputGroupAddon align="block-start"`, sibling of the two mention menus.
  Image chips show a thumbnail from the data URL the webview already holds from the paste,
  or from an `asWebviewUri` for picked files. CSP already permits `data:` in `img-src`
  (`panel-view-provider.ts:86`); `localResourceRoots` does **not** cover arbitrary disk
  paths, so a picked out-of-workspace image's chip shows a generic icon, not a preview.
  Only pasted images preview.
- `onPaste` on the textarea reads `clipboardData.files`; `onDragOver`/`onDrop` on
  `InputGroup` with a `data-dragging` ring.
- All controls from `@/components/ui/*`; classNames composed with `cn`.

## Data flow

**Paste.** `onPaste` → `File` → `FileReader` → base64 → `attach-paste` → store writes
`<root>/attachments/<sid>/3.png` → session's pending list grows → `session-attachments` →
chip. On the next `send`, the session drains the list; Claude re-reads the file for base64,
Codex passes the path.

**Pick / drop.** `attach-pick` (host opens the dialog) or `attach-drop` (URIs → paths) →
`store.adopt` → same pending list, same message, same chip.

**Reload.** `hydrate` carries each session's snapshot, which now carries
`pendingAttachments` — so composed-but-unsent chips come back. The transcript's own user
items carry the attachments each sent turn actually had.

## Error handling

Errors are state, never exceptions — the standing invariant.

| Case | Result |
|---|---|
| Over the size or count cap | `attachments-rejected` with a reason; toast in the composer; nothing written |
| Unreadable or missing at paste time | Same |
| Adopted file gone at send time | Error transcript item, turn not started — the missing-refs path |
| Unwritable storage dir | `attachments-rejected`; the session stays usable without attachments |
| Codex model without image modality | Attachment degrades to a path line. `Model.inputModalities` exists in the bindings and `wire.ts:39` discards it; the planning step decides whether to surface it now or defer |

## Testing

- **Unit:** `attachment-store` (write, atomic rename, caps, kind sniffing, reap);
  `message-router` composition with attachments and the missing-file path; Claude payload
  shape (text block then image blocks, correct `media_type`); Codex payload shape (text item
  then `localImage` items).
- **DOM** (`src/test/dom/composer.test.tsx` pattern, real `StoreProvider`, genuine
  `HostToWebview` messages): paste a `DataTransfer` carrying a PNG `File` → `attach-paste`
  posted → host replies → chip renders → Enter sends `attachments`; drop; pick; chip
  removal; a rejection renders its reason. Never pass a DOM node to an assertion.
- **Gate:** `detect.mjs` over every changed file under `src/webview/components/`, then
  `yarn lint && yarn check-types && yarn test:unit && yarn test:dom`.

## Deferred

- Per-attachment line ranges, the way `EditorContext` carries selection ranges.
- Inlining a small text file's contents instead of referencing its path.
- `localResourceRoots` widening so picked images preview like pasted ones.
- Surfacing `Model.inputModalities` in the model switcher, so a text-only model says so
  before the attachment silently degrades.
- Remote URLs via Codex's `{type:'image', url}` and Claude's `URLImageSource`.
