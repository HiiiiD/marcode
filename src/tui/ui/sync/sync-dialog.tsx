import { useKeyboard } from '@opentui/react';
import { useEffect, useRef, useState } from 'react';
import { codeGroups, countdown, hostOf, lastSeen, middleTruncate } from '../../../client-core/sync/sync-format';
import type { SyncPanel } from '../../../protocol/messages';
import { syncKey, type SyncConfirm, type SyncRow } from '../../view/sync-keys';
import { useTuiStore } from '../store';
import { Dialog } from '../termcn/components/ui/dialog';
import { useSyncState } from '../use-sync-state';
import { SyncConnectForm } from './sync-connect-form';

type Paired = Extract<SyncPanel, { state: 'paired' }>;

const keyOf = (key: { name: string; sequence: string }): string =>
  (key.sequence.length === 1 && /[a-zA-Z]/.test(key.sequence) ? key.sequence : key.name);

const CHOICE = { shared: 'Shared', own: 'Keep separate', linked: 'Linked', none: 'no remote · not shared' } as const;

function rowsOf(panel: Paired): SyncRow[] {
  return [
    ...panel.devices.filter((d) => !d.revoked || d.unfinishedRevoke)
      .map((d): SyncRow => ({ kind: 'device', deviceId: d.deviceId, self: d.self, revoked: d.revoked, unfinishedRevoke: d.unfinishedRevoke })),
    ...panel.projects.map((p): SyncRow => ({ kind: 'project', path: p.path, choice: p.choice })),
  ];
}

function PairedView({ panel, onClose }: { panel: Paired; onClose(): void }) {
  const { post } = useTuiStore();
  const st = useSyncState<{ index: number; confirming?: SyncConfirm }>({ index: 0 });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!panel.pairing) { return; }
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [panel.pairing]);
  const rows = rowsOf(panel);

  useKeyboard((key) => {
    const cur = st.get();
    if (panel.connection === 'revoked') {
      if (key.name === 'escape') { onClose(); } else if (keyOf(key) === 'x') { post({ t: 'sync-forget' }); }
      return;
    }
    const action = syncKey(keyOf(key), { rows, index: Math.min(cur.index, Math.max(0, rows.length - 1)), busy: panel.busy !== undefined, confirming: cur.confirming });
    if (!action) { return; }
    switch (action.t) {
      case 'close': onClose(); return;
      case 'move': st.set({ index: action.index }); return;
      case 'cancel': st.set({ confirming: undefined }); return;
      case 'confirm': st.set({ confirming: action.what }); return;
      case 'revoke': st.set({ confirming: undefined }); post({ t: 'sync-revoke', deviceId: action.deviceId }); return;
      case 'leave': st.set({ confirming: undefined }); post({ t: 'sync-leave' }); return;
      case 'pair': post({ t: 'sync-pair' }); return;
      case 'refresh': post({ t: 'sync-refresh' }); return;
      case 'project': post({ t: 'sync-project', path: action.path, choice: action.choice }); return;
    }
  });

  if (panel.connection === 'revoked') {
    return (
      <box flexDirection="column" flexShrink={0}>
        <Dialog isOpen interactive={false} title="Sync">
          <text>This device was removed from sync on another device.</text>
          <text fg="gray">x remove this device&apos;s sync data · Esc close</text>
        </Dialog>
      </box>
    );
  }
  const { index, confirming } = st.view;
  const host = hostOf(panel.server);
  const deviceName = (id: string) => panel.devices.find((d) => d.deviceId === id)?.name ?? id;
  const left = panel.pairing ? countdown(panel.pairing.expiresAt, now) : '';
  return (
    <box flexDirection="column" flexShrink={0}>
      <Dialog isOpen interactive={false} title="Sync">
        {panel.connection === 'unreachable'
          ? <text fg="yellow">{`Can't reach ${host} · g retry`}</text>
          : <text fg="gray">{`${host} · ${panel.deviceName} · ${panel.connection === 'checking' ? 'Checking…' : 'Connected'}`}</text>}
        {panel.error ? <text fg="red">{panel.error.message}</text> : null}
        <text fg="gray">Devices</text>
        {rows.map((row, i) => {
          const marker = i === index ? '› ' : '  ';
          if (row.kind === 'device') {
            const d = panel.devices.find((x) => x.deviceId === row.deviceId)!;
            return (
              <text key={row.deviceId} attributes={i === index ? 1 : 0}>
                <span>{marker}</span>
                <span>{middleTruncate(d.name, 30)}</span>
                {d.self ? <span fg="gray">  this device</span> : null}
                {d.unfinishedRevoke ? <span fg="yellow">  revoke not finished (r)</span> : null}
                <span fg="gray">{`  ${lastSeen(d.lastSeenAt, now)}`}</span>
              </text>
            );
          }
          const p = panel.projects.find((x) => x.path === row.path)!;
          return (
            <box key={row.path} flexDirection="column">
              {i === rows.findIndex((r) => r.kind === 'project') ? <text fg="gray">Project memory</text> : null}
              <text attributes={i === index ? 1 : 0}>
                <span>{marker}</span>
                <span>{p.name}</span>
                <span fg="gray">{`  ${CHOICE[p.choice]}${p.projectId ? ` · ${middleTruncate(p.projectId, 40)}` : ''}`}</span>
              </text>
            </box>
          );
        })}
        {panel.pairing && left !== '' ? (
          <box flexDirection="column">
            <text>{`Pairing code  ${codeGroups(panel.pairing.code).join(' ')}`}</text>
            <text fg="gray">{`Works once · expires in ${left}`}</text>
            <text fg="gray">{panel.pairing.joinCommand}</text>
          </box>
        ) : panel.pairing ? <text fg="gray">Pairing code expired · p make a new one</text> : null}
        {confirming?.t === 'revoke' ? (
          <text fg="yellow">{`Revoke ${deviceName(confirming.deviceId)}? It keeps what it already downloaded; anything synced from now on uses a key it never had. (y/n)`}</text>
        ) : null}
        {confirming?.t === 'leave' ? <text fg="yellow">Leave sync? This device stops syncing and forgets its keys. (y/n)</text> : null}
        <text fg="gray">{panel.busy ? 'Working…' : '↑↓ move · p add a device · r revoke · s/k share or keep separate · l leave · Esc close'}</text>
      </Dialog>
    </box>
  );
}

/** Panel-level `/sync`: renders the host's `sync-panel`, the same state the sidebar dialog uses. */
export function SyncDialog({ onClose }: { onClose(): void }) {
  const { state, post } = useTuiStore();
  const postRef = useRef(post);
  postRef.current = post;
  useEffect(() => { postRef.current({ t: 'sync-open' }); }, []);
  const panel = state.syncPanel;
  if (!panel) {
    return (
      <box flexDirection="column" flexShrink={0}>
        <Dialog isOpen interactive={false} title="Sync"><text fg="gray">Checking…</text></Dialog>
      </box>
    );
  }
  return panel.state === 'unpaired'
    ? <SyncConnectForm panel={panel} post={post} onClose={onClose} />
    : <PairedView panel={panel} onClose={onClose} />;
}
