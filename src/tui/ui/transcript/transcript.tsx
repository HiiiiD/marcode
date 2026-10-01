import type { ScrollBoxRenderable } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionId } from '../../../protocol/messages';
import { actionFor } from '../../keymap';
import { transcriptRows } from '../../view/transcript-rows';
import { useTuiStore } from '../store';
import { RowView } from './row';
import { ToolBody } from './tool-row';

export function Transcript({ sessionId, focused }: { sessionId: SessionId; focused: boolean }) {
  const { state, post } = useTuiStore();
  const pane = state.byId[sessionId];
  const running = pane?.summary.status === 'running';
  const rows = useMemo(() => transcriptRows(pane?.items ?? [], running), [pane?.items, running]);
  const [cursor, setCursor] = useState(-1);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const asked = useRef<string | undefined>(undefined);
  const scroll = useRef<ScrollBoxRenderable | null>(null);

  const itemById = useMemo(
    () => new Map((pane?.items ?? []).flatMap((i) => [[i.id, i] as const, ...((i.role === 'tool' ? i.children ?? [] : []).map((c) => [c.id, c] as const))])),
    [pane?.items],
  );

  const first = pane?.items[0]?.id;
  const hasMore = pane?.hasMore === true;
  const askOlder = () => {
    if (!hasMore || !first || asked.current === first || (scroll.current?.scrollTop ?? 1) > 0) { return; }
    asked.current = first;
    post({ t: 'load-more', id: sessionId, beforeItemId: first });
  };
  // Content that fits the viewport sits at scrollTop 0 too, which is right: nothing older is on screen.
  useEffect(() => {
    const t = setTimeout(askOlder, 0);
    return () => clearTimeout(t);
  });

  useKeyboard((key) => {
    if (!focused) { return; }
    const action = actionFor('transcript', key, { running });
    if (!action) { return; }
    const box = scroll.current;
    const select = (next: number) => {
      setCursor(next);
      const id = rows[next]?.id;
      if (id) { box?.scrollChildIntoView(id); }
    };
    if (action.do === 'item-next') { select(Math.min(cursor + 1, rows.length - 1)); }
    else if (action.do === 'item-prev') { select(cursor < 0 ? rows.length - 1 : Math.max(cursor - 1, 0)); }
    else if (action.do === 'page-up') { box?.scrollBy(-0.5, 'viewport'); }
    else if (action.do === 'page-down') { box?.scrollBy(0.5, 'viewport'); }
    else if (action.do === 'toggle-item') {
      const row = rows[cursor];
      if (row?.kind !== 'tool') { return; }
      setOpen((s) => { const n = new Set(s); if (n.has(row.id)) { n.delete(row.id); } else { n.add(row.id); } return n; });
    } else if (action.do === 'repin') { setCursor(-1); box?.scrollTo(Number.MAX_SAFE_INTEGER); }
    if (action.do === 'page-up' || action.do === 'item-prev') { setTimeout(askOlder, 0); }
  });

  return (
    <scrollbox ref={scroll} flexGrow={1} stickyScroll stickyStart="bottom" viewportCulling focused={focused}>
      {hasMore ? <text fg="gray">↑ older messages</text> : null}
      {rows.map((row, i) => {
        const item = itemById.get(row.id);
        const expanded = open.has(row.id);
        return (
          <box key={row.id} id={row.id} flexDirection="column">
            <RowView row={row} selected={focused && i === cursor} expanded={expanded} />
            {row.kind === 'tool' && expanded && item?.role === 'tool'
              ? <ToolBody tool={item.tool} output={item.output} state={item.state} /> : null}
          </box>
        );
      })}
    </scrollbox>
  );
}
