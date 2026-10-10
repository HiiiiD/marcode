import type { HostHandle } from '../host/create-host';

const errorText = (err: unknown) => (err instanceof Error ? err.stack ?? err.message : String(err));

/** A provider child that never exits must not keep a stopping daemon, its daemon.json and its clients waiting forever. */
export async function disposeWithin(host: HostHandle, ms: number, log: (line: string) => void): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), ms); });
  const disposed = host.dispose().then(
    () => false,
    (err: unknown) => { log(`host dispose failed: ${errorText(err)}`); return false; },
  );
  try {
    if (await Promise.race([disposed, timedOut])) { log(`host dispose timed out after ${ms}ms; exiting anyway`); }
  } finally {
    clearTimeout(timer);
  }
}
