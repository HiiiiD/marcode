import type { ChildRef, SessionId, SessionStatus } from '../protocol/messages';

export interface ChildRow {
  id: SessionId;
  title: string;
  badge: 'Fork' | 'Side chat' | 'Promoted';
  status: SessionStatus;
}

/** What each branch of a session is called: a side chat is "Promoted" once it has joined the roster. */
export function childrenRows(children: ChildRef[] | undefined): ChildRow[] {
  return (children ?? []).map((c) => ({
    id: c.id,
    title: c.title,
    status: c.status,
    badge: c.origin === 'fork' ? 'Fork' : c.hidden ? 'Side chat' : 'Promoted',
  }));
}
