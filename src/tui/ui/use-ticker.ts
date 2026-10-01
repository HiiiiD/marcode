import { useEffect, useState } from 'react';

export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

const FRAME_MS = 250;
const subscribers = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  if (timer === undefined) {
    timer = setInterval(() => { for (const s of subscribers) { s(); } }, FRAME_MS);
  }
  return () => {
    subscribers.delete(cb);
    if (subscribers.size === 0 && timer !== undefined) { clearInterval(timer); timer = undefined; }
  };
}

export function useTick(active: boolean): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!active) { return; }
    return subscribe(() => { setN((x) => x + 1); });
  }, [active]);
  return n;
}
