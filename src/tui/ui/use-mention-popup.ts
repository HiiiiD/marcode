import { useEffect, useRef, useState } from 'react';
import { fileMentions, type FileMentionPayload } from '../../client-core/mentions/file-mentions';
import {
  mentionQuery, pruneMentions, spliceMention, tokenFor, type MentionOption, type PendingMention,
} from '../../client-core/mentions/mention-menu';
import type { SessionId } from '../../protocol/messages';
import { useTuiStore } from './store';

const SEARCH_DEBOUNCE_MS = 150;

// Held outside the hook so a Composer remount (a permission or question slot swap) keeps picked mentions.
const pendingByStore = new WeakMap<object, Map<SessionId, PendingMention<FileMentionPayload>[]>>();

export interface MentionPopup {
  open: boolean;
  rows: MentionOption<FileMentionPayload>[];
  index: number;
  move(delta: number): void;
  dismiss(): void;
  pick(): { text: string; caret: number } | undefined;
  refs(): FileMentionPayload['ref'][];
  prune(text: string): void;
  /** Closes the popup for an `@` token already at the end of `text`, which the user did not just type. */
  suppress(text: string): void;
  reset(): void;
}

export function useMentionPopup(opts: { sessionId: SessionId; text: string; caret: number }): MentionPopup {
  const { state, post, drafts } = useTuiStore();
  const hit = mentionQuery(opts.text, opts.caret);
  const [index, setIndex] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  let perSession = pendingByStore.get(drafts);
  if (!perSession) { perSession = new Map(); pendingByStore.set(drafts, perSession); }
  const held = perSession;
  const pending = {
    get current() { return held.get(opts.sessionId) ?? []; },
    set current(next: PendingMention<FileMentionPayload>[]) { held.set(opts.sessionId, next); },
  };
  const liveAnswered = useRef<string | null>(null);

  const dismissed = hit !== undefined && dismissedAt === hit.start;
  const query = dismissed ? undefined : hit?.query;
  useEffect(() => {
    if (query === undefined) { return; }
    const timer = setTimeout(() => { post({ t: 'file-search', id: opts.sessionId, query }); }, SEARCH_DEBOUNCE_MS);
    return () => { clearTimeout(timer); };
  }, [query, opts.sessionId]);
  useEffect(() => { setIndex(0); }, [query]);
  useEffect(() => { setDismissedAt(null); }, [opts.sessionId]);
  // Esc dismisses one `@` token; typing a fresh `@` later must open the popup again.
  useEffect(() => { if (!hit) { setDismissedAt(null); } }, [hit === undefined]);

  const answer = state.fileSearchBySession[opts.sessionId];
  // Results can land out of order; an older answer replacing the live one would close the popup until the next keystroke.
  useEffect(() => {
    if (!hit || !answer) { return; }
    if (answer.query === hit.query) { liveAnswered.current = hit.query; return; }
    if (liveAnswered.current === hit.query) {
      liveAnswered.current = null;
      post({ t: 'file-search', id: opts.sessionId, query: hit.query });
    }
  }, [answer]);
  const rows = hit && answer && answer.query === hit.query ? fileMentions(answer.files) : [];
  const open = hit !== undefined && dismissedAt !== hit.start && rows.length > 0;
  const clamped = Math.min(index, Math.max(0, rows.length - 1));

  return {
    open, rows, index: clamped,
    move: (delta) => { setIndex(Math.max(0, Math.min(rows.length - 1, clamped + delta))); },
    dismiss: () => { if (hit) { setDismissedAt(hit.start); } },
    pick: () => {
      const row = rows[clamped];
      if (!hit || !row) { return undefined; }
      const token = tokenFor(row, pending.current.map((p) => p.token));
      pending.current = [...pending.current, { token, payload: row.payload }];
      return spliceMention(opts.text, hit.start, opts.caret, `${token} `);
    },
    refs: () => pending.current.map((p) => p.payload.ref),
    prune: (text) => { pending.current = pruneMentions(text, pending.current); },
    suppress: (text) => {
      const at = mentionQuery(text, text.length);
      if (at) { setDismissedAt(at.start); }
    },
    reset: () => { pending.current = []; setDismissedAt(null); },
  };
}
