import type { SessionSummary } from '../protocol/messages';
import { displayStatus } from '../client-core/display-status';

export type SortKey = 'updatedAt' | 'createdAt';
export type SortDir = 'asc' | 'desc';
export interface HistoryQuery { sort: SortKey; dir: SortDir; text: string; needsAttention?: boolean }
export interface HistoryGroups { pinned: SessionSummary[]; rest: SessionSummary[] }

export const DEFAULT_QUERY: HistoryQuery = { sort: 'updatedAt', dir: 'desc', text: '' };

export const needsAttention = (s: SessionSummary): boolean => {
  const shown = displayStatus(s);
  return shown === 'awaiting-approval' || shown === 'error';
};

const matches = (s: SessionSummary, needle: string): boolean =>
  [s.title, s.name, s.model, s.providerId, s.summary?.text ?? '']
    .some((field) => field.toLowerCase().includes(needle));

export function queryHistory(sessions: SessionSummary[], q: HistoryQuery): HistoryGroups {
  const needle = q.text.trim().toLowerCase();
  const kept = sessions.filter((s) =>
    (!q.needsAttention || needsAttention(s))
    && (needle === '' || matches(s, needle)));
  const sign = q.dir === 'asc' ? 1 : -1;
  const order = (a: SessionSummary, b: SessionSummary): number =>
    sign * (a[q.sort] - b[q.sort]) || a.id.localeCompare(b.id);
  return {
    pinned: kept.filter((s) => s.pinned === true).sort(order),
    rest: kept.filter((s) => s.pinned !== true).sort(order),
  };
}
