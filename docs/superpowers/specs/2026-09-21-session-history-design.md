# Session history and pinning

## Goal

Old sessions are hard to find: the sidebar picker lists live rows then archived rows, unsorted,
with no dates, model or summary. Add a history browser and a pin flag so a session can be closed
(reclaiming roster space) yet remembered.

## Data (host)

- `SessionState.pinned?: boolean` — absent means false, so existing `index.json` loads unchanged.
- `SessionState.summary?: { text: string; forUpdatedAt: number }` — a cache, never a source of
  truth. Stale when `forUpdatedAt !== updatedAt`.
- `archived`, `createdAt`, `updatedAt`, provider and model already exist.
- Summaries come from `ExtractiveSummarizer` over the session JSONL, generated lazily in the
  background and throttled by `SessionManager`. Until one lands, the row shows the title.
- Pin is independent of open/closed/archived. Closing never unpins.

## Protocol (`src/protocol/messages.ts`, types only)

- `set-pinned { sessionId, pinned }` (webview → host).
- `request-history` (tab → host); `history` reply carries rows: id, title, summary, createdAt,
  updatedAt, archived, pinned, providerId, model, status. Every row addresses a `SessionId`.
- `sessions-changed` fan-out reaches the history tab through its own bus allow-list.

## History tab (`src/history/`, bundle `dist/history.js`/`.css`)

- Host `HistoryPanel` mirrors `ReviewPanel`: own `MessageRouter`, `WebviewPanelSerializer`,
  command `marcode.history.open`.
- Own narrow reducer. Table with sort by created or updated (asc/desc, default updated desc).
- Pinned sessions group first; sort applies within pinned and within the rest.
- Filter: all / active / archived, plus text filter over title and summary.
- Row actions: pin/unpin, open in panes (existing `set-layout` + `set-visible` path; archived
  sessions open read-only as today).
- Sort and filter are ephemeral, not persisted.
- Grouping and sorting is a pure function in `history-groups.ts`.

## Sidebar

- Picker gets a **Pinned** section listing pinned sessions not currently open, for one-click reopen.
- Pin toggle on `SessionRow`; "History…" menu item opens the tab.

## Testing

- Unit: `index.json` without `pinned`; summary invalidation on `updatedAt` change; sort/group.
- DOM: through real `StoreProvider`; never pass DOM nodes to assertions.
- impeccable detector over changed `src/webview/components/` files.

## Out of scope

LLM summaries (swap later behind `Summarizer`), persisted sort/filter, bulk actions.
