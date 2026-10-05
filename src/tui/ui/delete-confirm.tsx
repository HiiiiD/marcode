import { useKeyboard } from '@opentui/react';
import { useState } from 'react';
import { useTheme } from './termcn/hooks/use-theme';
import type { SessionId } from '../../protocol/messages';
import { useTuiStore } from './store';

// The vendored termcn Confirm matches on key.name alone, so Ctrl+Y or Alt+N would answer it.
export function DeleteConfirm({ id, title, onDone }: { id: SessionId; title: string; onDone(): void }) {
  const { post } = useTuiStore();
  const theme = useTheme();
  const [selected, setSelected] = useState(false);
  const confirm = () => { post({ t: 'delete-session', id }); onDone(); };
  useKeyboard((key) => {
    if (key.ctrl && key.name === 'c') { onDone(); return; }
    if (key.ctrl || key.meta) { return; }
    if (key.name === 'escape' || key.name === 'n') { onDone(); }
    else if (key.name === 'y') { confirm(); }
    else if (key.name === 'left' || key.name === 'right') { setSelected((s) => !s); }
    else if (key.name === 'return') { if (selected) { confirm(); } else { onDone(); } }
  });
  return (
    <box flexShrink={0} flexDirection="column">
      <box flexDirection="row">
        <text fg={theme.colors.primary}>{'? '}</text>
        <text>{`Delete "${title}"?`}</text>
      </box>
      <box flexDirection="row" gap={2} paddingLeft={2}>
        <text fg={selected ? theme.colors.error : theme.colors.mutedForeground}>{selected ? <b>{'› Delete'}</b> : '  Delete'}</text>
        <text fg={selected ? theme.colors.mutedForeground : undefined}>{selected ? '  Cancel' : <b>{'› Cancel'}</b>}</text>
      </box>
    </box>
  );
}
