import { useKeyboard } from '@opentui/react';
import type { SyncField, SyncPanel, WebviewToHost } from '../../../protocol/messages';
import { Dialog } from '../termcn/components/ui/dialog';
import { useSyncState } from '../use-sync-state';

type Unpaired = Extract<SyncPanel, { state: 'unpaired' }>;
type Form = { mode: 'join' | 'setup'; focus: number; server: string; code: string; name: string };
const FIELDS = ['mode', 'server', 'code', 'name'] as const;

/** Not paired yet: Mode (←→), then the three fields; Enter submits from anywhere. */
export function SyncConnectForm({ panel, post, onClose }: { panel: Unpaired; post: (msg: WebviewToHost) => void; onClose(): void }) {
  const st = useSyncState<Form>({ mode: 'join', focus: 0, server: '', code: '', name: panel.defaultName });

  useKeyboard((key) => {
    const f = st.get();
    const field = FIELDS[f.focus];
    if (key.name === 'escape') { onClose(); return; }
    if (key.name === 'return') {
      if (!panel.busy) { post({ t: f.mode === 'join' ? 'sync-join' : 'sync-setup', server: f.server.trim(), code: f.code.trim(), name: f.name.trim() }); }
      return;
    }
    if ((key.name === 'tab' && !key.shift) || key.name === 'down') { st.set({ focus: Math.min(FIELDS.length - 1, f.focus + 1) }); return; }
    if ((key.name === 'tab' && key.shift) || key.name === 'up') { st.set({ focus: Math.max(0, f.focus - 1) }); return; }
    if (field === 'mode') {
      if (key.name === 'left' || key.name === 'right') { st.set({ mode: f.mode === 'join' ? 'setup' : 'join' }); }
      return;
    }
    if (key.name === 'backspace') { st.set({ [field]: f[field].slice(0, -1) } as Partial<Form>); return; }
    if (!key.ctrl && !key.meta && key.sequence.length >= 1 && key.sequence >= ' ' && !key.sequence.includes('\u001b')) {
      st.set({ [field]: f[field] + key.sequence } as Partial<Form>);
    }
  });

  const f = st.view;
  const join = f.mode === 'join';
  const label: Record<(typeof FIELDS)[number], string> = {
    mode: 'Mode', server: 'Server address', code: join ? 'Pairing code' : 'Setup code', name: 'Device name',
  };
  const errorOn = (field: SyncField) => (panel.error?.field === field ? panel.error.message : undefined);
  const value = (field: (typeof FIELDS)[number]): string =>
    (field === 'mode' ? (join ? '[Join] Set up a new server' : 'Join [Set up a new server]') : f[field]);
  return (
    <box flexDirection="column" flexShrink={0}>
      <Dialog isOpen interactive={false} title="Sync">
        <text fg="gray">Sync memory and sessions between your machines through a server you run. It only ever stores encrypted data.</text>
        {FIELDS.map((field, i) => (
          <box key={field} flexDirection="column">
            <text attributes={i === f.focus ? 1 : 0}>
              <span>{i === f.focus ? '› ' : '  '}</span>
              <span fg="gray">{`${label[field]}: `}</span>
              <span>{`${value(field)}${i === f.focus && field !== 'mode' ? '▏' : ''}`}</span>
            </text>
            {field !== 'mode' && errorOn(field) ? <text fg="red">{`    ${errorOn(field)}`}</text> : null}
          </box>
        ))}
        {!join ? <text fg="gray">The setup code is the one your server printed when it started.</text> : null}
        {panel.error && !panel.error.field ? <text fg="red">{panel.error.message}</text> : null}
        <text fg="gray">{panel.busy ? 'Working…' : `Tab next · ←→ mode · Enter ${join ? 'join' : 'set up'} · Esc close`}</text>
      </Dialog>
    </box>
  );
}
