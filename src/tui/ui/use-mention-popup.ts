import { useEffect, useRef, useState } from 'react';
import { fileMentions, type FileMentionPayload } from '../../client-core/mentions/file-mentions';
import {
  mentionQuery, pruneMentions, spliceMention, tokenFor, type MentionOption, type PendingMention,
} from '../../client-core/mentions/mention-menu';
import type { SessionId } from '../../protocol/messages';
import { useTuiStore } from './store';

const SEARCH_DEBOUNCE_MS = 150;

export interface MentionPopup {
  open: boolean;
  rows: MentionOption<FileMentionPayload>[];
  index: number;
  move(delta: number): void;
  dismiss(): void;
  pick(): { text: string; caret: number } | undefined;
  refs(): FileMentionPayload['ref'][];
  prune(text: string): void;
  reset(): void;
}

export function useMentionPopup(opts: { sessionId: SessionId; text: string; caret: number }): MentionPopup {
  const { state, post } = useTuiStore();
  const hit = mentionQuery(opts.text, opts.caret);
  const [index, setIndex] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const pending = useRef<PendingMention<FileMentionPayload>[]>([]);

  const query = hit?.query;
  useEffect(() => {
    if (query === undefined) { return; }
    const timer = setTimeout(() => { post({ t: 'file-search', id: opts.sessionId, query }); }, SEARCH_DEBOUNCE_MS);
    return () => { clearTimeout(timer); };
  }, [query, opts.sessionId]);
  useEffect(() => { setIndex(0); }, [query]);
  useEffect(() => {
    pending.current = [];
    setDismissedAt(null);
  }, [opts.sessionId]);

  const answer = state.fileSearchBySession[opts.sessionId];
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
    reset: () => { pending.current = []; setDismissedAt(null); },
  };
}
