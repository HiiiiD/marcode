import { useKeyboard } from '@opentui/react';
import { useEffect, useRef } from 'react';
import { mcpRows, mcpSummary } from '../../../client-core/mcp/mcp-rows';
import type { McpPanel, McpRemovableOrigin, SessionId } from '../../../protocol/messages';
import { mcpListKey } from '../../view/mcp-keys';
import { useTuiStore } from '../store';
import { Dialog } from '../termcn/components/ui/dialog';
import { useSyncState } from '../use-sync-state';
import { McpAddForm } from './mcp-add-form';

const DOT: Record<string, string> = { connected: 'green', failed: 'red', 'needs-auth': 'yellow', pending: 'cyan', disabled: 'gray' };

function fileFor(panel: McpPanel | undefined, origin: McpRemovableOrigin | undefined): string {
  const t = panel?.targets && origin ? (origin === 'repo' ? panel.targets.repo : panel.targets.global) : undefined;
  if (!t || !('path' in t)) { return 'its config file'; }
  return origin === 'repo-private' ? `${t.path} (this repo)` : t.path;
}

const keyOf = (key: { name: string; sequence: string }): string =>
  (key.sequence.length === 1 && /[a-zA-Z]/.test(key.sequence) ? key.sequence : key.name);

export function McpDialog({ sessionId, onClose }: { sessionId: SessionId; onClose(): void }) {
  const { state, post } = useTuiStore();
  const pane = state.byId[sessionId];
  const panel = pane?.mcpPanel;
  const rows = mcpRows(pane?.mcpServers ?? [], panel);
  const st = useSyncState<{ index: number; confirming?: string; view: 'list' | 'add' }>({ index: 0, view: 'list' });
  const postRef = useRef(post);
  postRef.current = post;

  useEffect(() => { postRef.current({ t: 'mcp-open', id: sessionId }); }, [sessionId]);

  useKeyboard((key) => {
    const cur = st.get();
    if (cur.view !== 'list') { return; }
    const action = mcpListKey(keyOf(key), {
      rows, index: Math.min(cur.index, Math.max(0, rows.length - 1)), confirming: cur.confirming,
      pending: (panel?.pending.length ?? 0) > 0 && !panel?.restarting, canAdd: Boolean(panel?.capabilities),
    });
    if (!action) { return; }
    switch (action.t) {
      case 'close': onClose(); return;
      case 'move': st.set({ index: action.index }); return;
      case 'cancel': st.set({ confirming: undefined }); return;
      case 'confirm-remove': st.set({ confirming: action.name }); return;
      case 'remove':
        st.set({ confirming: undefined });
        post({ t: 'mcp-remove', id: sessionId, name: action.name, origin: action.origin });
        return;
      case 'reconnect': post({ t: 'mcp-reconnect', id: sessionId, name: action.name }); return;
      case 'sign-in': post({ t: 'mcp-sign-in', id: sessionId, name: action.name }); return;
      case 'restart': post({ t: 'restart-session', id: sessionId }); return;
      case 'add': st.set({ view: 'add' }); return;
    }
  });

  if (!pane) { return null; }
  const { index, confirming, view } = st.view;
  if (view === 'add' && panel?.capabilities) {
    return (
      <McpAddForm
        capabilities={panel.capabilities}
        targets={panel.targets}
        error={panel.error}
        onBack={() => { st.set({ view: 'list' }); }}
        onSubmit={(scope, server) => { post({ t: 'mcp-add', id: sessionId, scope, server }); st.set({ view: 'list' }); }}
      />
    );
  }
  const confirmRow = rows.find((r) => r.name === confirming);
  const hasPending = (panel?.pending.length ?? 0) > 0;
  return (
    <box flexDirection="column" flexShrink={0}>
      <Dialog isOpen interactive={false} title="MCP servers">
        {hasPending ? (
          <text fg="yellow">{panel?.restarting ? 'Restarting…' : 'Config changed. Restart the session to load it (R).'}</text>
        ) : null}
        {panel?.error ? <text fg="red">{panel.error}</text> : null}
        {panel && !panel.capabilities ? <text fg="gray">{panel.readOnly ?? "This provider can't manage MCP servers from Marcode."}</text> : null}
        {rows.length === 0 ? <text fg="gray">No MCP servers yet.</text> : null}
        {rows.map((r, i) => (
          <box key={r.name} flexDirection="column">
            <text attributes={i === index ? 1 : 0}>
              <span>{i === index ? '› ' : '  '}</span>
              <span fg={DOT[r.state]}>●</span>
              <span>{` ${r.name}`}</span>
              {r.badge ? <span fg="gray">{`  [${r.badge}]`}</span> : null}
            </text>
            {r.detail ? <text fg={r.state === 'failed' ? 'red' : 'gray'}>{`    ${r.detail}`}</text> : null}
          </box>
        ))}
        {confirmRow ? (
          <text fg="yellow">{`Delete ${confirmRow.name} from ${fileFor(panel, confirmRow.removeOrigin)}? (y/n)`}</text>
        ) : null}
        <text fg="gray">{mcpSummary(rows)}</text>
        <text fg="gray">↑↓ move · r reconnect · s sign in · d delete · a add · Esc close</text>
      </Dialog>
    </box>
  );
}
