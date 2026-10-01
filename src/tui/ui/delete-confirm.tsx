import { useKeyboard } from '@opentui/react';
import type { SessionId } from '../../protocol/messages';
import { useTuiStore } from './store';
import { Confirm } from './termcn/components/ui/confirm';

export function DeleteConfirm({ id, title, onDone }: { id: SessionId; title: string; onDone(): void }) {
  const { post } = useTuiStore();
  useKeyboard((key) => { if (key.name === 'escape') { onDone(); } });
  return (
    <box flexShrink={0}>
      <Confirm
        variant="danger"
        message={`Delete "${title}"?`}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        onConfirm={() => { post({ t: 'delete-session', id }); onDone(); }}
        onCancel={onDone}
      />
    </box>
  );
}
