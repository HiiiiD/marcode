import { useCallback, useSyncExternalStore } from 'react';
import type { SessionId } from '../../protocol/messages';
import { useDraftStore } from '../store';

/**
 * A session's composer text, read from the `DraftStore` rather than
 * `ClientState` — see `lib/draft-store.ts`. `useSyncExternalStore` subscribes
 * only this component to only this session's slot, so typing in one pane's
 * composer re-renders that composer alone, not every `useStore()` consumer
 * the way a reducer-backed draft did.
 */
export function useDraft(id: SessionId): [string, (text: string) => void] {
  const store = useDraftStore();
  const subscribe = useCallback((onStoreChange: () => void) => store.subscribe(id, onStoreChange), [store, id]);
  const getSnapshot = useCallback(() => store.get(id), [store, id]);
  const text = useSyncExternalStore(subscribe, getSnapshot);
  const setText = useCallback((next: string) => store.set(id, next), [store, id]);
  return [text, setText];
}
