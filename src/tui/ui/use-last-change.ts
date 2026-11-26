import { useRef } from 'react';
import { LastChangeClock } from '../../client-core/worker-status';

export function useLastChanges(entries: ReadonlyArray<{ id: string; signature: string }>): ReadonlyMap<string, number> {
  const clock = useRef<LastChangeClock | null>(null);
  clock.current ??= new LastChangeClock();
  return clock.current.observe(entries, Date.now());
}

export function useLastChange(signature: string): number {
  return useLastChanges([{ id: 'only', signature }]).get('only') ?? Date.now();
}
