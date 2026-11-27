import { useKeyboard } from '@opentui/react';
import { useEffect } from 'react';
import { choiceFromKey, initialChoice, moveDialogView, moveMessage, type MoveChoice } from '../../client-core/sync/move-dialog';
import type { SessionId } from '../../protocol/messages';
import { windowAround } from '../view/pickers';
import { useTuiStore } from './store';
import { Dialog } from './termcn/components/ui/dialog';
import { useSyncState } from './use-sync-state';

const VISIBLE_ROWS = 6;

export function MoveDialog({ sessionId, onClose, onDone }: { sessionId: SessionId; onClose(): void; onDone(id: SessionId): void }) {
  const { state, post } = useTuiStore();
  const slice = state.move?.id === sessionId ? state.move : undefined;
  const session = state.sessions.find((s) => s.id === sessionId);
  const st = useSyncState<{ choice: MoveChoice; picked: boolean }>({ choice: { cancelTurn: false }, picked: false });
  useEffect(() => { post({ t: 'request-move-panel', id: sessionId }); }, [sessionId]);
  const panel = slice?.panel;
  useEffect(() => { if (panel) { st.set({ choice: initialChoice(panel), picked: true }); } }, [panel]);
  const status = slice?.status;
  useEffect(() => { if (status?.state === 'done') { onDone(status.sessionId); } }, [status]);

  const view = (choice: MoveChoice) => (panel ? moveDialogView({
    panel, status, choice, name: session?.name ?? '', running: session?.status === 'running' || session?.status === 'awaiting-approval',
  }) : undefined);

  useKeyboard((key) => {
    if (key.name === 'escape') { onClose(); return; }
    const { choice } = st.get();
    const v = view(choice);
    if (!v || !panel || v.action.disabled) { return; }
    const at = v.options.findIndex((o) => o.key === v.selected);
    if (key.name === 'down' || key.name === 'up') {
      const next = v.options[Math.max(0, Math.min(v.options.length - 1, at + (key.name === 'down' ? 1 : -1)))];
      if (next) { st.set({ choice: choiceFromKey(next.key, choice.cancelTurn), picked: true }); }
    } else if (key.name === 'space' && v.checkbox) {
      st.set({ choice: { ...choice, cancelTurn: !choice.cancelTurn }, picked: true });
    } else if (key.name === 'return') {
      if (v.action.kind === 'close') { onClose(); return; }
      const msg = moveMessage(panel, choice);
      if (msg) { post(msg); }
    }
  });

  const v = view(st.view.choice);
  const at = v ? Math.max(0, v.options.findIndex((o) => o.key === v.selected)) : 0;
  const { start, end } = windowAround(v?.options.length ?? 0, at, VISIBLE_ROWS);
  return (
    <box flexDirection="column" flexShrink={0}>
      <Dialog isOpen interactive={false} title={v?.title ?? `Move "${session?.name ?? ''}" here`}>
        {!v ? <text fg="gray">Checking where it can go…</text> : null}
        {v?.options.slice(start, end).map((o, i) => (
          <text key={o.key} attributes={start + i === at ? 1 : 0}>{`${start + i === at ? '›' : ' '} ${o.label}`}</text>
        ))}
        {v?.lines.map((line) => <text key={line} fg="gray">{line}</text>)}
        {v?.checkbox ? <text>{`[${st.view.choice.cancelTurn ? 'x' : ' '}] ${v.checkbox} (space)`}</text> : null}
        {v?.progress ? <text fg="gray">{v.progress}</text> : null}
        {v?.error ? <text fg="red">{v.error}</text> : null}
        {v ? <text fg="gray">{v.action.disabled ? v.action.label : `enter ${v.action.label} · esc close`}</text> : null}
      </Dialog>
    </box>
  );
}
