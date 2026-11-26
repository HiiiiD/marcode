import type { SessionStatus, SessionSummary } from '../protocol/messages';

/**
 * What a status surface shows for a session: its own status, lifted by the hosted nested
 * children still working under it. Display only. `status` itself drives send gating, queued
 * moves and the diff refresh, so the composer and the working row keep reading it.
 */
export function displayStatus(s: Pick<SessionSummary, 'status' | 'subagents'>): SessionStatus {
  if (s.status === 'error' || s.status === 'awaiting-approval' || !s.subagents) { return s.status; }
  if (s.subagents.awaitingApproval > 0) { return 'awaiting-approval'; }
  return s.subagents.running > 0 ? 'running' : s.status;
}
