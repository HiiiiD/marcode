import type { SessionStatus } from '../protocol/messages';

export interface StatusView {
  label: string;
  tone: 'idle' | 'busy' | 'attention' | 'failed';
  /** The agent is blocked on a human decision. Distinct from `failed`. */
  needsUser: boolean;
}

const VIEW: Record<SessionStatus, StatusView> = {
  idle: { label: 'Idle', tone: 'idle', needsUser: false },
  running: { label: 'Working', tone: 'busy', needsUser: false },
  'awaiting-approval': { label: 'Needs you', tone: 'attention', needsUser: true },
  error: { label: 'Failed', tone: 'failed', needsUser: false },
};

export function statusView(status: SessionStatus): StatusView {
  return VIEW[status];
}
