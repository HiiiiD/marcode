import type { SessionId } from '../../protocol/messages';

/**
 * Per-session composer text, outside `ClientState`. A draft lives here
 * instead of in the main reducer so a keystroke notifies only that one
 * session's subscriber — the reducer's `useReducer` sits behind a single
 * context value, so a dispatch on every keystroke re-rendered every consumer
 * of `useStore()` (every pane, transcript item, roster row), not just the
 * composer being typed in.
 */
export interface DraftStore {
  get(id: SessionId): string;
  set(id: SessionId, text: string): void;
  /** Replaces the whole map, as `hydrate` does — see `ClientState.draftBySession`'s old doc comment. */
  hydrate(entries: [SessionId, string][]): void;
  subscribe(id: SessionId, listener: () => void): () => void;
}

export function createDraftStore(): DraftStore {
  const drafts = new Map<SessionId, string>();
  const listeners = new Map<SessionId, Set<() => void>>();

  function notify(id: SessionId): void {
    for (const listener of listeners.get(id) ?? []) { listener(); }
  }

  return {
    get(id) {
      return drafts.get(id) ?? '';
    },
    set(id, text) {
      drafts.set(id, text);
      notify(id);
    },
    hydrate(entries) {
      // Every id that held a value before or holds one after must be
      // notified — one that only drops out (host says nothing survived)
      // still changed, from its old text to empty.
      const touched = new Set(drafts.keys());
      drafts.clear();
      for (const [id, text] of entries) {
        drafts.set(id, text);
        touched.add(id);
      }
      for (const id of touched) { notify(id); }
    },
    subscribe(id, listener) {
      let set = listeners.get(id);
      if (!set) {
        set = new Set();
        listeners.set(id, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) { listeners.delete(id); }
      };
    },
  };
}
