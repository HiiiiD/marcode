import { useKeyboard } from '@opentui/react';
import { useEffect, useState } from 'react';
import type { SessionId } from '../../protocol/messages';
import { actionFor } from '../keymap';
import { rosterRows } from '../view/roster-rows';
import { useTuiStore } from './store';

export function Roster({ focused, onFocusSession }: { focused: boolean; onFocusSession(id: SessionId): void }) {
  const { state, focusedId, post } = useTuiStore();
  const rows = rosterRows(state.sessions, focusedId);
  const [cursor, setCursor] = useState(0);
  useEffect(() => { setCursor((c) => Math.min(c, Math.max(0, rows.length - 1))); }, [rows.length]);

  useKeyboard((key) => {
    if (!focused) { return; }
    const action = actionFor('roster', key, { running: false });
    if (!action) { return; }
    const row = rows[cursor];
    if (action.do === 'roster-next') { setCursor((c) => Math.min(c + 1, rows.length - 1)); }
    else if (action.do === 'roster-prev') { setCursor((c) => Math.max(c - 1, 0)); }
    else if (action.do === 'roster-focus' && row) { onFocusSession(row.id); }
    else if (action.do === 'roster-hide' && row) { post({ t: 'close-session', id: row.id }); }
  });

  return (
    <box flexDirection="column" width={26} border borderStyle="single" title="sessions">
      {rows.map((row, i) => (
        <text key={row.id} fg={row.dim ? 'gray' : undefined} attributes={focused && i === cursor ? 1 : 0}>
          {`${row.focused ? '▸' : ' '}${row.glyph} ${row.title}${row.suffix ? ` ${row.suffix}` : ''}`}
        </text>
      ))}
      {rows.length === 0 ? <text fg="gray">no sessions yet</text> : null}
    </box>
  );
}
