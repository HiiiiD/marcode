export interface ShutdownDeps {
  destroyRenderer(): void;
  disposeHost(): Promise<void>;
  exit(code: number): void;
  timeoutMs?: number;
}

export function createShutdown(deps: ShutdownDeps): (code: number) => Promise<void> {
  let phase: 'idle' | 'closing' | 'done' = 'idle';
  return async (code) => {
    if (phase === 'done') { return; }
    if (phase === 'closing') { deps.exit(130); return; }
    phase = 'closing';
    // The terminal goes back to the user first, so a slow or broken host dispose never leaves it in raw mode.
    try { deps.destroyRenderer(); } catch { /* terminal already restored */ }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, deps.timeoutMs ?? 3000); });
    const disposed = (async () => { await deps.disposeHost(); })().catch(() => {});
    await Promise.race([disposed, timeout]);
    clearTimeout(timer);
    phase = 'done';
    deps.exit(code);
  };
}
