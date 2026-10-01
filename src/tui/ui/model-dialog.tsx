import { useKeyboard } from '@opentui/react';
import { useRef } from 'react';
import type { SessionId } from '../../protocol/messages';
import { modelOptions, windowAround } from '../view/pickers';
import { useTuiStore } from './store';
import { Dialog } from './termcn/components/ui/dialog';
import { useSyncState } from './use-sync-state';

const VISIBLE_ROWS = 8;

export function ModelDialog({ sessionId, onClose }: { sessionId: SessionId; onClose(): void }) {
  const { state, post } = useTuiStore();
  const summary = state.byId[sessionId]?.summary ?? state.sessions.find((s) => s.id === sessionId);
  const rowsFor = (filter: string) => (summary ? modelOptions(state.catalog, summary, state.favoriteModels, filter) : []);
  const st = useSyncState<{ filter: string; index?: number }>({ filter: '' });
  const startIndex = Math.max(0, rowsFor('').findIndex((o) => o.current));
  const sent = useRef(false);

  useKeyboard((key) => {
    if (key.name === 'escape') { onClose(); return; }
    if (sent.current || !summary) { return; }
    const cur = { filter: st.get().filter, index: st.get().index ?? startIndex };
    const rows = rowsFor(cur.filter);
    if (key.name === 'down') { st.set({ index: Math.min(rows.length - 1, cur.index + 1) }); }
    else if (key.name === 'up') { st.set({ index: Math.max(0, cur.index - 1) }); }
    else if (key.name === 'return') {
      const picked = rows[cur.index];
      if (!picked) { return; }
      sent.current = true;
      if (!picked.current) { post({ t: 'set-model', id: summary.id, model: picked.id }); }
      onClose();
    } else if (key.name === 'backspace') { st.set({ filter: cur.filter.slice(0, -1), index: 0 }); }
    else if (!key.ctrl && !key.meta && key.sequence.length === 1 && key.sequence >= ' ') {
      st.set({ filter: cur.filter + key.sequence, index: 0 });
    }
  });

  const { filter } = st.view;
  const index = st.view.index ?? startIndex;
  const rows = rowsFor(filter);
  const { start, end } = windowAround(rows.length, index, VISIBLE_ROWS);
  return (
    <box flexDirection="column" flexShrink={0}>
      <Dialog isOpen interactive={false} title="Model">
        <text fg="gray">{`Search: ${filter}▏`}</text>
        {rows.length === 0 ? <text fg="gray">No model matches.</text> : null}
        {rows.slice(start, end).map((o, i) => (
          <text key={o.id} attributes={start + i === index ? 1 : 0}>
            {`${start + i === index ? '›' : ' '} ${o.current ? '✓' : ' '} ${o.favorite ? '★ ' : ''}${o.label}`}
          </text>
        ))}
        <text fg="gray">Type to search — Enter select, Esc cancel</text>
      </Dialog>
    </box>
  );
}
