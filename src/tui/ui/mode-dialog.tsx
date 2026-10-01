import { useKeyboard } from '@opentui/react';
import { useRef } from 'react';
import type { SessionId } from '../../protocol/messages';
import type { EffortLevel } from '../../providers/types';
import { effortRow, modeOptions } from '../view/pickers';
import { useTuiStore } from './store';
import { Dialog } from './termcn/components/ui/dialog';
import { useSyncState } from './use-sync-state';

export function ModeDialog({ sessionId, focus, onClose }: { sessionId: SessionId; focus: 'modes' | 'effort'; onClose(): void }) {
  const { state, post } = useTuiStore();
  const pane = state.byId[sessionId];
  const summary = pane?.summary ?? state.sessions.find((s) => s.id === sessionId);
  const modes = summary ? modeOptions(state.catalog, summary, (pane?.items.length ?? 0) > 0) : [];
  const effort = summary ? effortRow(state.catalog, summary) : undefined;
  const effortIndex = modes.length;
  const startIndex = focus === 'effort' ? effortIndex : Math.max(0, modes.findIndex((o) => o.current));
  const st = useSyncState<{ index?: number; level?: EffortLevel }>({});
  const indexNow = () => st.get().index ?? startIndex;
  const levelNow = () => st.get().level ?? effort?.level;
  const sent = useRef(false);

  useKeyboard((key) => {
    if (key.name === 'escape') { onClose(); return; }
    if (sent.current || !summary) { return; }
    const cur = { index: indexNow(), level: levelNow() };
    const last = effort ? effortIndex : effortIndex - 1;
    if (key.name === 'down') { st.set({ index: Math.min(last, cur.index + 1) }); }
    else if (key.name === 'up') { st.set({ index: Math.max(0, cur.index - 1) }); }
    else if ((key.name === 'left' || key.name === 'right') && effort && cur.index === effortIndex && cur.level) {
      const next = effort.levels[effort.levels.indexOf(cur.level) + (key.name === 'right' ? 1 : -1)];
      if (next) { st.set({ level: next }); post({ t: 'set-effort', id: summary.id, effort: next }); }
    } else if (key.name === 'return') {
      const picked = modes[cur.index];
      if (picked?.disabled) { return; }
      sent.current = true;
      if (picked && !picked.current) { post({ t: 'set-permission-mode', id: summary.id, mode: picked.id }); }
      onClose();
    }
  });

  const index = st.view.index ?? startIndex;
  const level = st.view.level ?? effort?.level;
  const locked = modes.find((o) => o.disabled)?.disabled;
  return (
    <box flexDirection="column" flexShrink={0}>
      <Dialog isOpen interactive={false} title="Permission mode">
        {modes.map((o, i) => (
          <box key={o.id} flexDirection="column">
            <text attributes={i === index ? 1 : 0} fg={o.disabled ? 'gray' : undefined}>
              {`${i === index ? '›' : ' '} ${o.current ? '✓' : ' '} ${o.label}`}
            </text>
            <text fg="gray">{`      ${o.description}`}</text>
          </box>
        ))}
        {locked ? <text fg="gray">{locked}</text> : null}
        {effort && level ? (
          <text attributes={index === effortIndex ? 1 : 0}>
            {`${index === effortIndex ? '›' : ' '} Effort  ${effort.levels.map((l) => (l === level ? `[${l}]` : l)).join('  ')}`}
          </text>
        ) : focus === 'effort' ? <text fg="gray">This model has no effort levels.</text> : null}
        <text fg="gray">Up/Down move — Left/Right effort — Enter select, Esc close</text>
      </Dialog>
    </box>
  );
}
