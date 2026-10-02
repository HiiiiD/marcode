import type { SessionId } from '../../protocol/messages';
import { hitsContext, statusLayout } from '../view/status-line';
import { useTuiStore } from './store';

export function StatusLine({ sessionId, width, onOpenContext }: { sessionId: SessionId | null; width: number; onOpenContext?(): void }) {
  const { state } = useTuiStore();
  const summarizing = Object.entries(state.handoffPhase).find(([, phase]) => phase === 'summarizing')?.[0];
  if (summarizing) {
    const src = state.sessions.find((x) => x.id === summarizing);
    return <text fg="gray">{`Summarizing ${src ? src.name || src.title : summarizing}…`}</text>;
  }
  const s = sessionId ? state.byId[sessionId]?.summary ?? state.sessions.find((x) => x.id === sessionId) : undefined;
  if (!s) { return <text fg="gray">no session — Ctrl+N new</text>; }
  const provider = state.catalog.find((p) => p.id === s.providerId)?.displayName ?? s.providerId;
  const layout = statusLayout({
    provider, model: s.model, effort: s.effort, permissionMode: s.permissionMode,
    contextPercent: s.contextPercent, owned: !s.owner, width,
  });
  const { ctx, text } = layout;
  const onMouseDown = onOpenContext
    ? (e: { x: number }) => { if (hitsContext(layout, e.x)) { onOpenContext(); } }
    : undefined;
  if (!ctx) { return <text fg="gray" onMouseDown={onMouseDown}>{text}</text>; }
  return (
    <text fg="gray" onMouseDown={onMouseDown}>
      {text.slice(0, ctx.start)}
      <span fg={ctx.danger ? 'red' : 'gray'}>{text.slice(ctx.start, ctx.end)}</span>
      {text.slice(ctx.end)}
    </text>
  );
}
