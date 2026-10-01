import type { SessionId } from '../../protocol/messages';
import { useTuiStore } from './store';

const PICKER_HINT = '^P model · ^E effort · ⇧Tab mode';

export function StatusLine({ sessionId, width }: { sessionId: SessionId | null; width: number }) {
  const { state } = useTuiStore();
  const summarizing = Object.entries(state.handoffPhase).find(([, phase]) => phase === 'summarizing')?.[0];
  if (summarizing) {
    const src = state.sessions.find((x) => x.id === summarizing);
    return <text fg="gray">{`Summarizing ${src ? src.name || src.title : summarizing}…`}</text>;
  }
  const s = sessionId ? state.byId[sessionId]?.summary ?? state.sessions.find((x) => x.id === sessionId) : undefined;
  if (!s) { return <text fg="gray">no session — Ctrl+N new</text>; }
  const provider = state.catalog.find((p) => p.id === s.providerId)?.displayName ?? s.providerId;
  const line = [provider, s.model, s.effort, s.permissionMode].filter((p): p is string => Boolean(p)).join(' · ');
  const withHint = s.owner ? line : `${line}   ${PICKER_HINT}`;
  const shown = withHint.length <= width ? withHint : line;
  return <text fg="gray">{shown.length > width ? `${shown.slice(0, Math.max(0, width - 1))}…` : shown}</text>;
}
