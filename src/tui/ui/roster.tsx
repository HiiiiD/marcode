import { useKeyboard } from '@opentui/react';
import { useEffect, useState } from 'react';
import type { SessionId } from '../../protocol/messages';
import { actionFor } from '../keymap';
import { rosterRows } from '../view/roster-rows';
import { useTuiStore } from './store';

interface RosterProps {
  focused: boolean;
  onFocusSession(id: SessionId): void;
  onAskDelete(row: { id: SessionId; title: string }): void;
}

export function Roster({ focused, onFocusSession, onAskDelete }: RosterProps) {
  const { state, focusedId, post, setNotice } = useTuiStore();
  const [filter, setFilter] = useState('');
  const [filtering, setFiltering] = useState(false);
  const rows = rosterRows(state.sessions, focusedId, filter);
  const [cursor, setCursor] = useState(0);
  useEffect(() => { setCursor((c) => Math.min(c, Math.max(0, rows.length - 1))); }, [rows.length]);

  useKeyboard((key) => {
    if (!focused) { return; }
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
    if (action.do === 'roster-next') { setCursor((c) => Math.min(c + 1, rows.length - 1)); }
    else if (action.do === 'roster-prev') { setCursor((c) => Math.max(c - 1, 0)); }
    else if (action.do === 'roster-focus' && row) { onFocusSession(row.id); }
    else if (action.do === 'roster-hide' && row) { post({ t: 'close-session', id: row.id }); }
    else if (action.do === 'roster-pin' && row) { post({ t: 'set-pinned', id: row.id, pinned: !row.pinned }); }
    else if (action.do === 'roster-filter') { setFiltering(true); setCursor(0); }
    else if (action.do === 'roster-delete' && row) {
      if (row.foreign) {
        const owner = row.suffix?.split('·')[0] ?? 'another host';
        setNotice(`Cannot delete "${row.title}": owned by ${owner}`);
      } else { onAskDelete({ id: row.id, title: row.title }); }
    }
  });

  return (
    <box flexDirection="column" width={26} border borderStyle="single" title="sessions">
      {filtering || filter !== '' ? <text fg="gray">{`/${filter}`}</text> : null}
      {rows.map((row, i) => (
        <text key={row.id} fg={row.dim ? 'gray' : undefined} attributes={focused && i === cursor ? 1 : 0}>
          {`${row.focused ? '▸' : ' '}${row.glyph} ${row.pinned ? '★ ' : ''}${row.title}${row.suffix ? ` ${row.suffix}` : ''}`}
        </text>
      ))}
      {rows.length === 0 ? <text fg="gray">{filter !== '' ? 'no match' : 'no sessions yet'}</text> : null}
    </box>
  );
}
