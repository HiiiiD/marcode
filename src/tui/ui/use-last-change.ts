import { useRef } from 'react';
import { LastChangeClock } from '../../client-core/worker-status';

export function useLastChange(signature: string): number {
  const clock = useRef<LastChangeClock | null>(null);
  clock.current ??= new LastChangeClock();
  return clock.current.observe([{ id: 'only', signature }], Date.now()).get('only') ?? Date.now();
}
