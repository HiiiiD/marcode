export function isBusy(summaries: readonly { status: string }[]): boolean {
  return summaries.some((s) => s.status !== 'idle' && s.status !== 'error');
}

export interface IdleMonitorDeps {
  busy(): boolean;
  clients(): number;
  idleMs: number;
  onIdle(): void;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

export class IdleMonitor {
  private handle: unknown;
  private armed = false;
  private readonly setTimer: NonNullable<IdleMonitorDeps['setTimer']>;
  private readonly clearTimer: NonNullable<IdleMonitorDeps['clearTimer']>;

  constructor(private readonly deps: IdleMonitorDeps) {
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  private quiet(): boolean {
    return this.deps.clients() === 0 && !this.deps.busy();
  }

  check(): void {
    if (!this.quiet()) {
      this.disarm();
      return;
    }
    if (this.armed) {
      return;
    }
    this.armed = true;
    this.handle = this.setTimer(() => {
      this.armed = false;
      if (this.quiet()) {
        this.deps.onIdle();
      }
    }, this.deps.idleMs);
  }

  dispose(): void {
    this.disarm();
  }

  private disarm(): void {
    if (!this.armed) {
      return;
    }
    this.clearTimer(this.handle);
    this.armed = false;
  }
}
