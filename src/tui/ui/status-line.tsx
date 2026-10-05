import type { SessionId } from '../../protocol/messages';
import { hitsContext, LAYOUT_HINT, statusLayout } from '../view/status-line';
import { useTuiStore } from './store';
import { useTheme } from './termcn/hooks/use-theme';
import { useTokens } from './tokens/tokens-provider';

export function StatusLine({ sessionId, width, onOpenContext }: { sessionId: SessionId | null; width: number; onOpenContext?(): void }) {
  const { state } = useTuiStore();
  const muted = useTokens()?.textMuted ?? 'gray';
  const danger = useTheme().colors.error;
  const summarizing = Object.entries(state.handoffPhase).find(([, phase]) => phase === 'summarizing')?.[0];
  if (summarizing) {
    const src = state.sessions.find((x) => x.id === summarizing);
    return <text fg={muted}>{`Summarizing ${src ? src.name || src.title : summarizing}…`}</text>;
  }
  const s = sessionId ? state.byId[sessionId]?.summary ?? state.sessions.find((x) => x.id === sessionId) : undefined;
  if (!s) { return <text fg={muted}>no session — Ctrl+N new</text>; }
  const provider = state.catalog.find((p) => p.id === s.providerId)?.displayName ?? s.providerId;
  const layout = statusLayout({
    provider, model: s.model, effort: s.effort, permissionMode: s.permissionMode,
    contextPercent: s.contextPercent, owned: !s.owner, width,
  });
  const { ctx, text } = layout;
  const onMouseDown = onOpenContext
    ? (e: { x: number }) => { if (hitsContext(layout, e.x)) { onOpenContext(); } }
    : undefined;
  const line = ctx ? (
    <text fg={muted} onMouseDown={onMouseDown}>
      {text.slice(0, ctx.start)}
      <span fg={ctx.danger ? danger : muted}>{text.slice(ctx.start, ctx.end)}</span>
      {text.slice(ctx.end)}
    </text>
  ) : <text fg={muted} onMouseDown={onMouseDown}>{text}</text>;
  return (
    <box flexDirection="column">
      {line}
      {LAYOUT_HINT.length <= width ? <text fg={muted}>{LAYOUT_HINT}</text> : null}
    </box>
  );
}
