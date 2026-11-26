import { useTuiStore } from '../store';

const LABEL = { offline: 'Sync offline · /sync', revoked: 'Sync: device removed · /sync' } as const;

/** Silent while sync is healthy or off; one line pointing at /sync when there is something to fix. */
export function SyncStatusLine() {
  const { state } = useTuiStore();
  if (state.syncStatus !== 'offline' && state.syncStatus !== 'revoked') { return null; }
  return <text fg="yellow">{LABEL[state.syncStatus]}</text>;
}
