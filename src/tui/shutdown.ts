export interface ShutdownDeps {
  destroyRenderer(): void;
  disposeHost(): Promise<void>;
  exit(code: number): void;
  timeoutMs?: number;
}

export interface Shutdown {
  (code: number): Promise<void>;
  /** For a teardown that may be our own echo (the renderer's onDestroy): never escalates to a forced 130. */
  ifIdle(code: number): Promise<void>;
}

export function createShutdown(deps: ShutdownDeps): Shutdown {
  let phase: 'idle' | 'closing' | 'done' = 'idle';
  const shutdown = async (code: number) => {
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
  return Object.assign(shutdown, {
    ifIdle: (code: number) => (phase === 'idle' ? shutdown(code) : Promise.resolve()),
  });
}

export const EXIT_SIGNALS: ReadonlyArray<[NodeJS.Signals, number]> = [
  ['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129], ['SIGQUIT', 131], ['SIGBREAK', 149],
];

export function installExitSignals(
  on: (signal: NodeJS.Signals, handler: () => void) => void,
  shutdown: (code: number) => Promise<void>,
): void {
  for (const [signal, code] of EXIT_SIGNALS) {
    try { on(signal, () => { void shutdown(code); }); } catch { /* not a signal this platform can deliver */ }
  }
}
