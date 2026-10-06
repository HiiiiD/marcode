import type { ScrollBoxRenderable } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionId } from '../../../protocol/messages';
import { summarizeSubagent } from '../../../client-core/subagent-window';
import { actionFor } from '../../keymap';
import { transcriptRows, type TranscriptRow } from '../../view/transcript-rows';
import { useTuiStore } from '../store';
import { useTheme } from '../termcn/hooks/use-theme';
import type { RelocationKeys } from './relocation-card';
import { RowView } from './row';

export function Transcript({ sessionId, focused, onFork, relocationKeys = 'none' }: {
  sessionId: SessionId; focused: boolean; onFork?(itemId: string): void; relocationKeys?: RelocationKeys;
}) {
  const { state, post, setNotice, chordArmed } = useTuiStore();
  const pane = state.byId[sessionId];
  const running = pane?.summary.status === 'running';
  const rows = useMemo(() => transcriptRows(pane?.items ?? [], running), [pane?.items, running]);
  const [cursorId, setCursorId] = useState<string | undefined>(undefined);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const asked = useRef<string | undefined>(undefined);
  const scroll = useRef<ScrollBoxRenderable | null>(null);
  const heightBefore = useRef<number | undefined>(undefined);

  const first = pane?.items[0]?.id;
  const hasMore = pane?.hasMore === true;
  // Only a user scroll asks: a render-driven ask would chain through every page, because a prepend leaves no scroll to anchor on.
  const askOlder = () => {
    const box = scroll.current;
    if (!hasMore || !first || asked.current === first || !box || box.scrollTop > 0) { return; }
    asked.current = first;
    heightBefore.current = box.scrollHeight;
    post({ t: 'load-more', id: sessionId, beforeItemId: first });
  };

  // Keep the reader on the row they were on once older items land above it.
  useEffect(() => {
    if (heightBefore.current === undefined) { return; }
    const before = heightBefore.current;
    const t = setTimeout(() => {
      const box = scroll.current;
      if (box && box.scrollHeight > before) { box.scrollBy(box.scrollHeight - before, 'absolute'); heightBefore.current = undefined; }
    }, 0);
    return () => clearTimeout(t);
  }, [first]);

  const cursor = cursorId === undefined ? -1 : rows.findIndex((r) => r.id === cursorId);
  useEffect(() => {
    if (cursorId !== undefined) { scroll.current?.scrollChildIntoView(cursorId); }
  }, [cursorId]);

  const toggleRow = (row: TranscriptRow | undefined) => {
    if (row?.kind === 'compaction') {
      if (row.summary === undefined) { return; }
      const id = row.id;
      setOpen((o) => { const n = new Set(o); if (n.has(id)) { n.delete(id); } else { n.add(id); } return n; });
      return;
    }
    if (row?.kind !== 'tool') { return; }
    const id = row.id;
    const blocked = row.item.tool.kind === 'subagent' && summarizeSubagent(row.item, 0).blocked;
    const effective = open.has(id) || (blocked && !closed.has(id));
    const flip = (s: ReadonlySet<string>, on: boolean) => { const n = new Set(s); if (on) { n.add(id); } else { n.delete(id); } return n; };
    setOpen((o) => flip(o, !effective));
    setClosed((c) => flip(c, effective && blocked));
  };

  useKeyboard((key) => {
    if (!focused || key.defaultPrevented || chordArmed.current) { return; }
    const action = actionFor('transcript', key, { running });
    if (!action) { return; }
    const box = scroll.current;
    const step = (delta: 1 | -1) => setCursorId((prev) => {
      const at = prev === undefined ? -1 : rows.findIndex((r) => r.id === prev);
      const next = delta === 1 ? Math.min(at + 1, rows.length - 1) : at < 0 ? rows.length - 1 : Math.max(at - 1, 0);
      return rows[next]?.id ?? prev;
    });
    if (action.do === 'item-next') { step(1); }
    else if (action.do === 'item-prev') { step(-1); }
    else if (action.do === 'page-up') { box?.scrollBy(-0.5, 'viewport'); }
    else if (action.do === 'page-down') { box?.scrollBy(0.5, 'viewport'); }
    else if (action.do === 'toggle-item') { toggleRow(rows[cursor]); }
    else if (action.do === 'fork-item') {
      const row = rows[cursor];
      const owner = pane?.summary.owner;
      if (!row) { return; }
      if (owner) { setNotice(`Cannot fork "${pane.summary.name || pane.summary.title}": owned by ${owner.host}`); return; }
      onFork?.(row.id);
    }
    else if (action.do === 'repin') { setCursorId(undefined); box?.scrollTo(Number.MAX_SAFE_INTEGER); }
    if (action.do === 'page-up' || action.do === 'item-prev') { setTimeout(askOlder, 0); }
  });

  const muted = useTheme().colors.mutedForeground;
  return (
    <scrollbox ref={scroll} flexGrow={1} stickyScroll stickyStart="bottom" viewportCulling focused={focused}>
      {hasMore ? <text fg={muted}>↑ older messages</text> : null}
      {rows.map((row, i) => {
        return (
          <box key={row.id} id={row.id} flexDirection="column" onMouseDown={() => { setCursorId(row.id); toggleRow(row); }}>
            <RowView row={row} selected={focused && i === cursor} expanded={open.has(row.id)} closed={closed.has(row.id)} relocationKeys={relocationKeys} />
          </box>
        );
      })}
    </scrollbox>
  );
}
