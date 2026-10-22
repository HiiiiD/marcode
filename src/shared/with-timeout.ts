/** The timer is cleared either way: a pending one would keep the host's event loop alive past dispose. */
export function withTimeout<T>(work: Promise<T>, ms: number, reason: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(reason)), ms);
  });
  return Promise.race([work, bound]).finally(() => {
    if (timer) { clearTimeout(timer); }
  }) as Promise<T>;
}
