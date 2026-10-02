import type { ScrollBoxRenderable } from '@opentui/core';
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import { useEffect, useRef, useState } from 'react';
import { leafSessionIds } from '../../client-core/layout-tree';
import type { SessionId } from '../../protocol/messages';
import { actionFor } from '../keymap';
import { rosterRows } from '../view/roster-rows';
import { useTuiStore } from './store';
import { UsageStrip } from './usage-strip';
import { useTheme } from './termcn/hooks/use-theme';

export const ROSTER_W = 26;

interface RosterProps {
  focused: boolean;
  onFocusSession(id: SessionId): void;
  onAskDelete(row: { id: SessionId; title: string }): void;
  onHandoff(row: { id: SessionId; title: string }): void;
  squeezed?: ReadonlySet<SessionId>;
}

export function Roster({ focused, onFocusSession, onAskDelete, onHandoff, squeezed }: RosterProps) {
  const { state, focusedId, post, setNotice, setRosterFiltering, chordArmed } = useTuiStore();
  const [filter, setFilter] = useState('');
  const [filtering, setFiltering] = useState(false);
  const rows = rosterRows(state.sessions, focusedId, filter, new Set(leafSessionIds(state.layout.root)), squeezed);
  // Tracked by id so a reorder (pinning) keeps the highlight on the row it was on.
  const [cursorId, setCursorId] = useState<SessionId | null>(null);
  const cursor = Math.max(0, rows.findIndex((r) => r.id === cursorId));
  useEffect(() => {
    setRosterFiltering(focused && filtering);
    return () => { setRosterFiltering(false); };
  }, [focused, filtering]);
  useEffect(() => { if (!focused) { setFiltering(false); } }, [focused]);
  const theme = useTheme();
  const { height } = useTerminalDimensions();
  const scroll = useRef<ScrollBoxRenderable | null>(null);
  useEffect(() => {
    const id = rows[cursor]?.id;
    if (id !== undefined) { scroll.current?.scrollChildIntoView(id); }
  }, [cursor, rows.length]);

  useKeyboard((key) => {
    if (!focused || key.defaultPrevented || chordArmed.current) { return; }
    if (filtering) {
      if (key.name === 'escape') { setFilter(''); setFiltering(false); }
      else if (key.name === 'return') { setFiltering(false); }
      else if (key.name === 'backspace') { setFilter((f) => f.slice(0, -1)); }
      else if (key.name === 'space') { setFilter((f) => `${f} `); }
      else if (key.name.length === 1 && !key.ctrl && !key.meta) { setFilter((f) => f + key.name); }
      return;
    }
    const action = actionFor('roster', key, { running: false });
    if (!action) { return; }
    const row = rows[cursor];
    if (action.do === 'roster-next') { setCursorId(rows[Math.min(cursor + 1, rows.length - 1)]?.id ?? null); }
    else if (action.do === 'roster-prev') { setCursorId(rows[Math.max(cursor - 1, 0)]?.id ?? null); }
    else if (action.do === 'roster-focus' && row) { onFocusSession(row.id); }
    else if (action.do === 'roster-hide' && row) { post({ t: 'close-session', id: row.id }); }
    else if (action.do === 'roster-handoff' && row) { onHandoff({ id: row.id, title: row.title }); }
    else if (action.do === 'roster-pin' && row) { post({ t: 'set-pinned', id: row.id, pinned: !row.pinned }); }
    else if (action.do === 'roster-filter') { setFiltering(true); setCursorId(null); }
    else if (action.do === 'roster-delete' && row) {
      if (row.foreign) {
        const owner = row.suffix?.split('·')[0] ?? 'another host';
        setNotice(`Cannot delete "${row.title}": owned by ${owner}`);
      } else { onAskDelete({ id: row.id, title: row.title }); }
    }
  });

  return (
    <box flexDirection="column" width={ROSTER_W} border borderStyle="single" title="sessions">
      {filtering || filter !== '' ? <text fg={theme.colors.muted}>{`/${filter}`}</text> : null}
      <scrollbox ref={scroll} flexGrow={1}>
        {rows.map((row, i) => (
          <text
            key={row.id}
            id={row.id}
            fg={row.dim ? theme.colors.mutedForeground : undefined}
            attributes={focused && i === cursor ? 1 : 0}
            onMouseDown={() => { setCursorId(row.id); onFocusSession(row.id); }}
          >
            {`${row.focused ? '▸' : row.squeezed ? '+' : row.leaf ? '▪' : ' '}${row.glyph} ${row.pinned ? '★ ' : ''}${row.title}${row.suffix ? ` ${row.suffix}` : ''}`}
          </text>
        ))}
      </scrollbox>
      <UsageStrip width={ROSTER_W - 2} maxLines={Math.max(2, Math.floor(height / 3))} />
      {rows.length === 0 ? <text fg={theme.colors.muted}>{filter !== '' ? 'no match' : 'no sessions yet'}</text> : null}
    </box>
  );
}
