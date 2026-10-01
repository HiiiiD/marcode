import { useKeyboard } from '@opentui/react';
import type { SessionId } from '../../protocol/messages';
import { useTuiStore } from './store';

export function DeleteConfirm({ id, title, onDone }: { id: SessionId; title: string; onDone(): void }) {
  const { post } = useTuiStore();
  useKeyboard((key) => {
    if (key.name === 'y') { post({ t: 'delete-session', id }); onDone(); }
    else if (key.name === 'n' || key.name === 'escape') { onDone(); }
  });
  return <text fg="yellow">{`Delete "${title}"? y/n`}</text>;
}
