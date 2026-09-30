import type { AgentEvent, AgentProvider, AgentRun } from '../providers/types';

class DormantRun implements AgentRun {
  private release: () => void = () => {};
  private readonly closed = new Promise<void>((resolve) => { this.release = resolve; });
  readonly events: AsyncIterable<AgentEvent> = this.iterate();

  private async *iterate(): AsyncGenerator<AgentEvent> { await this.closed; }

  send(): void {}
  respondToTool(): void {}
  respondToQuestion(): void {}
  setEffort(): void {}
  setModel(): void {}
  setPermissionMode(): void {}
  async interrupt(): Promise<void> { this.release(); }
  async dispose(): Promise<void> { this.release(); }
}

export function dormantProvider(provider: AgentProvider): AgentProvider {
  return Object.create(provider, { start: { value: (): AgentRun => new DormantRun() } }) as AgentProvider;
}
