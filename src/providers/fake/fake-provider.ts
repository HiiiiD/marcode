import type {
  AgentEvent, AgentProvider, AgentRun,
  ContextBreakdown,
  EditorContext, EffortLevel, ModelInfo, PermissionMode,
  StartOptions, ToolDecision,
  UsageWindow
} from '../types';

class EventChannel implements AsyncIterable<AgentEvent> {
  private queue: AgentEvent[] = [];
  private waiting: ((v: IteratorResult<AgentEvent>) => void) | undefined;
  private closed = false;

  push(event: AgentEvent): void {
    if (this.closed) { return; }
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ value: event, done: false });
    } else {
      this.queue.push(event);
    }
  }

  close(): void {
    this.closed = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return {
      next: (): Promise<IteratorResult<AgentEvent>> => {
        const next = this.queue.shift();
        if (next) { return Promise.resolve({ value: next, done: false }); }
        if (this.closed) { return Promise.resolve({ value: undefined, done: true }); }
        return new Promise((resolve) => { this.waiting = resolve; });
      },
    };
  }
}

export interface FakeReports {
  context?: ContextBreakdown;
  windows?: UsageWindow[];
}

export class FakeProvider implements AgentProvider {
  readonly id = 'fake';
  readonly displayName = 'Fake';
  /** Records every decision passed to respondToTool, for assertions. */
  readonly decisions = new Map<string, ToolDecision>();
  /** Records every mode passed to setPermissionMode, for assertions. */
  readonly permissionModes: PermissionMode[] = [];
  /** Records every model passed to setModel, for assertions. */
  readonly models: string[] = [];
  /** Records every (text, context) pair passed to send, for assertions. */
  readonly sent: { text: string; context?: EditorContext }[] = [];
  private sessionCounter = 0;

  constructor(
    private readonly script: (text: string) => AgentEvent[],
    private readonly reports: FakeReports = {},
  ) {}

  listModels(): ModelInfo[] {
    return [
      {
        id: 'fake-large',
        displayName: 'Fake Large',
        effort: { levels: ['low', 'medium', 'high'], default: 'medium' },
      },
      { id: 'fake-small', displayName: 'Fake Small' },
    ];
  }

  start(_opts: StartOptions): AgentRun {
    const channel = new EventChannel();
    const resumeToken = `fake-session-${++this.sessionCounter}`;
    let started = false;

    const run: AgentRun = {
      events: channel,
      send: (text: string, context?: EditorContext) => {
        this.sent.push({ text, context });
        if (!started) {
          started = true;
          channel.push({ kind: 'session', resumeToken });
        }
        for (const ev of this.script(text)) { channel.push(ev); }
      },
      respondToTool: (id, decision) => {
        this.decisions.set(id, decision);
        // A real provider resolves the tool and completes the turn once the
        // decision lands. Without a follow-up event here, AgentSession sets
        // status to 'running' when pending.size reaches 0 (see
        // respondToPermission) and nothing ever arrives after that for the
        // fake provider — the status dot is stuck at 'running' forever.
        channel.push({ kind: 'turn-end', reason: 'done' });
      },
      setEffort: (_effort: EffortLevel) => { /* recorded by tests via lastEffort if needed */ },
      setPermissionMode: (mode: PermissionMode) => { this.permissionModes.push(mode); },
      setModel: (model: string) => { this.models.push(model); },
      interrupt: async () => { channel.push({ kind: 'turn-end', reason: 'interrupted' }); },
      dispose: async () => { channel.close(); },
    };
    const { context, windows } = this.reports;
    if (context) { run.contextBreakdown = async () => context; }
    if (windows) { run.usageWindows = async () => windows; }
    return run;
  }
}
