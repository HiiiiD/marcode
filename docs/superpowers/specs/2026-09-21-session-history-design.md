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
- Summaries come from a new pure `digestSession()` over the session JSONL: first user message
  → last assistant reply · N files edited. (`ExtractiveSummarizer` is first message + count,
  which is what this feature improves on; it and memory indexing are untouched.) Generated on
  request by `SessionManager.ensureSummaries()`. Until one lands, the row shows the title.
- Pin is independent of open/closed/archived. Closing never unpins.

## Protocol (`src/protocol/messages.ts`, types only)

- `set-pinned { id, pinned }`, `request-history-summaries`, `open-history` (webview → host).
- No history reply: `SessionState` already carries every column, so the tab reads
  `hydrate.sessions` and `sessions-changed`, like the review tab. Its bus allow-list
  (`HISTORY_WANTS`) is `sessions-changed` only.

## History tab (`src/history/`, bundle `dist/history.js`/`.css`)

- Host `HistoryPanel` mirrors `ReviewPanel`: own `MessageRouter`, `WebviewPanelSerializer`,
  command `marcode.history.open`.
- Own narrow reducer. Table with sort by created or updated (asc/desc, default updated desc).
- Pinned sessions group first; sort applies within pinned and within the rest.
- Filter: all / active / archived, plus text filter over title and summary.
- Row actions: pin/unpin, open in panes (existing `focus-session` message, host logic shared with
  `FleetPanel`; archived sessions open read-only as today).
- Sort and filter are ephemeral, not persisted.
- Grouping and sorting is a pure function in `history-groups.ts`.

## Sidebar

- Picker gets a **Pinned** group listing all pinned sessions (open or not), removed from the
  Live/Archived groups so no row appears twice.
- Pin toggle on `SessionRow`; "History…" menu item opens the tab.

## Testing

- Unit: `index.json` without `pinned`; summary invalidation on `updatedAt` change; sort/group.
- DOM: through real `StoreProvider`; never pass DOM nodes to assertions.
- impeccable detector over changed `src/webview/components/` files.

## Out of scope

LLM summaries (swap later behind `Summarizer`), persisted sort/filter, bulk actions.
