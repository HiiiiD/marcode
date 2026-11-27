import type { SessionSummary } from '../protocol/messages';
import { displayStatus } from '../client-core/display-status';

export type SortKey = 'updatedAt' | 'createdAt';
export type SortDir = 'asc' | 'desc';
export interface HistoryQuery { sort: SortKey; dir: SortDir; text: string; needsAttention?: boolean }
export interface DeviceGroup {
  deviceId: string; deviceName: string; online: boolean; lastSeenAt: number; newerFormat: boolean; sessions: SessionSummary[];
}
/** `devices`: other devices' sessions, one group per device by name, after this device's own. */
export interface HistoryGroups { pinned: SessionSummary[]; rest: SessionSummary[]; devices: DeviceGroup[] }

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
  const local = kept.filter((s) => s.remote === undefined);
  const devices = new Map<string, DeviceGroup>();
  for (const s of kept) {
    if (!s.remote) { continue; }
    const { deviceId, deviceName, online, lastSeenAt, newerFormat } = s.remote;
    const group = devices.get(deviceId) ?? { deviceId, deviceName, online, lastSeenAt, newerFormat: newerFormat === true, sessions: [] };
    group.sessions.push(s);
    devices.set(deviceId, group);
  }
  return {
    pinned: local.filter((s) => s.pinned === true).sort(order),
    rest: local.filter((s) => s.pinned !== true).sort(order),
    devices: [...devices.values()]
      .map((g) => ({ ...g, sessions: g.sessions.sort(order) }))
      .sort((a, b) => a.deviceName.localeCompare(b.deviceName) || a.deviceId.localeCompare(b.deviceId)),
  };
}
