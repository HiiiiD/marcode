import type { SessionId } from '../../protocol/messages';
import { useTuiStore } from './store';

export function StatusLine({ sessionId, width }: { sessionId: SessionId | null; width: number }) {
  const { state } = useTuiStore();
  const s = sessionId ? state.byId[sessionId]?.summary ?? state.sessions.find((x) => x.id === sessionId) : undefined;
  if (!s) { return <text fg="gray">no session — Ctrl+N new</text>; }
  const provider = state.catalog.find((p) => p.id === s.providerId)?.displayName ?? s.providerId;
  const line = [provider, s.model, s.effort, s.permissionMode].filter((p): p is string => Boolean(p)).join(' · ');
  return <text fg="gray">{line.length > width ? `${line.slice(0, Math.max(0, width - 1))}…` : line}</text>;
}
