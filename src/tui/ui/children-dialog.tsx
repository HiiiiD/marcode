import { useKeyboard } from '@opentui/react';
import type { SessionId } from '../../protocol/messages';
import { childTargets } from '../view/children-targets';
import { windowAround } from '../view/pickers';
import { useTuiStore } from './store';
import { Dialog } from './termcn/components/ui/dialog';
import { useSyncState } from './use-sync-state';

const VISIBLE_ROWS = 8;

export function ChildrenDialog({ sessionId, onClose }: { sessionId: SessionId; onClose(): void }) {
  const { state, post } = useTuiStore();
  const summary = state.byId[sessionId]?.summary ?? state.sessions.find((s) => s.id === sessionId);
  const targets = summary ? childTargets(summary, state.sessions) : [];
  const st = useSyncState<{ index: number }>({ index: 0 });

  useKeyboard((key) => {
    if (key.name === 'escape') { onClose(); return; }
    const index = st.get().index;
    if (key.name === 'down') { st.set({ index: Math.min(targets.length - 1, index + 1) }); }
    else if (key.name === 'up') { st.set({ index: Math.max(0, index - 1) }); }
    else if (key.name === 'return') {
      const picked = targets[index];
      if (!picked?.id) { return; }
      post({ t: 'focus-session', id: picked.id });
      onClose();
    }
  });

  const index = st.view.index;
  const { start, end } = windowAround(targets.length, index, VISIBLE_ROWS);
  return (
    <box flexDirection="column" flexShrink={0}>
      <Dialog isOpen interactive={false} title="Forks and side chats">
        {targets.length === 0 ? <text fg="gray">Nothing branched from this chat yet.</text> : null}
        {targets.slice(start, end).map((t, i) => (
          <text key={`${start + i}`} attributes={start + i === index ? 1 : 0}>
            {`${start + i === index ? '›' : ' '} ${t.label}`}
          </text>
        ))}
        <text fg="gray">Enter open, Esc cancel</text>
      </Dialog>
    </box>
  );
}
