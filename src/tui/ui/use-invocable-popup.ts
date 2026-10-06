import { useEffect, useState } from 'react';
import { insertionFor, menuQuery, menuView, nextIndex } from '../../client-core/invocables/invocable-menu';
import type { Invocable, SessionId } from '../../protocol/messages';
import { useTuiStore } from './store';

export interface InvocablePopup {
  open: boolean;
  rows: Invocable[];
  overflow: number;
  index: number;
  move(delta: number): void;
  dismiss(): void;
  /** Restored text is not something the user is typing, so its menu stays closed until the query changes. */
  suppress(text: string): void;
  pick(): { text: string; caret: number } | undefined;
}

export function useInvocablePopup(opts: { sessionId: SessionId; text: string }): InvocablePopup {
  const { state } = useTuiStore();
  const query = menuQuery(opts.text);
  const [index, setIndex] = useState(0);
  const [dismissedQuery, setDismissedQuery] = useState<string | null>(null);
  useEffect(() => { setIndex(0); }, [query]);
  // Kept while the query still equals the dismissed one, so suppress() survives the render its own text change causes.
  useEffect(() => { setDismissedQuery((d) => (d === query ? d : null)); }, [query]);
  useEffect(() => { setDismissedQuery(null); }, [opts.sessionId]);

  const entries = state.byId[opts.sessionId]?.invocables ?? [];
  const { rows, overflow } = query === undefined ? { rows: [], overflow: 0 } : menuView(entries, query);
  const open = query !== undefined && dismissedQuery !== query && rows.length > 0;
  const clamped = Math.min(index, Math.max(0, rows.length - 1));

  return {
    open, rows, overflow, index: clamped,
    move: (delta) => { setIndex(nextIndex(clamped, delta, rows.length)); },
    dismiss: () => { if (query !== undefined) { setDismissedQuery(query); } },
    suppress: (text) => {
      const q = menuQuery(text);
      if (q !== undefined) { setDismissedQuery(q); }
    },
    pick: () => {
      const row = rows[clamped];
      if (!row) { return undefined; }
      const { text } = insertionFor(row);
      return { text, caret: text.length };
    },
  };
}
