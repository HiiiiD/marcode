import { useReducer, useRef } from 'react';

export interface SyncState<T> {
  /** Snapshot for rendering. */
  view: T;
  /** Live value, current even mid-batch. Handlers must read this, never `view`. */
  get(): T;
  set(patch: Partial<T>): void;
}

/** State mutated synchronously so several keys in one input chunk each see the previous key's effect. */
export function useSyncState<T extends object>(initial: T): SyncState<T> {
  const ref = useRef<T>(initial);
  const [, render] = useReducer((n: number) => n + 1, 0);
  return {
    view: ref.current,
    get: () => ref.current,
    set: (patch) => { ref.current = { ...ref.current, ...patch }; render(); },
  };
}
