import type {
  AgentEvent, AgentProvider, AgentRun,
  Attachment,
  ContextBreakdown,
  EditorContext,
  EffortLevel, Invocable, ModelInfo, PermissionMode, PermissionModeInfo, QuestionAnswers,
  StartOptions, ThreadScope, ToolDecision,
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

/** An `AgentRun` a test can push arbitrary events into. */
export type FakeRun = AgentRun & { emit(event: AgentEvent): void };
export interface FakeReports {
  context?: ContextBreakdown;
  windows?: UsageWindow[];
  /**
   * Scripts the "this account has no plan limits at all" answer — the API
   * key / Bedrock / Vertex case — which is `undefined`, not `[]`. The two
   * are different instructions to the host: `undefined` clears persisted
   * windows, `[]` does not.
   */
  usageUnavailable?: boolean;
}

export class FakeProvider implements AgentProvider {
  readonly id = 'fake';
  readonly displayName = 'Fake';
  readonly threadScope: ThreadScope = 'cwd';
  /** Records every decision passed to respondToTool, for assertions. */
  readonly decisions = new Map<string, ToolDecision>();
  /** Records every (requestId, answers) pair passed to respondToQuestion, in order. */
  readonly answered: [string, QuestionAnswers][] = [];
  /** Records every mode passed to setPermissionMode, for assertions. */
  readonly permissionModes: PermissionMode[] = [];
  /** Records every model passed to setModel, for assertions. */
  readonly models: string[] = [];
  /** Records every level passed to setEffort, for assertions. */
  readonly efforts: EffortLevel[] = [];
  /**
   * Every run started by this provider, newest last. A real provider emits
   * events without the user having sent anything; tests need a handle to
   * do the same.
   */
  readonly runs: FakeRun[] = [];
  /** Every cwd listInvocables() was called with, in order. */
  readonly listInvocablesCalls: string[] = [];
  /** Scripted probe answer: a catalog to resolve with, or an Error to reject with. */
  invocables: Invocable[] | Error | undefined;
  /**
   * Records every (text, context, attachments) triple passed to send, for
   * assertions. `runIndex` is this send's position in `starts`/`runs` — the
   * one way a test can tell a message went to the run started for a moved
   * cwd rather than the one being torn down.
   */
  readonly sent: {
    text: string; context?: EditorContext; attachments?: Attachment[]; runIndex: number;
  }[] = [];
  /** Every cwd fetchUsage() was called with, in order. */
  readonly fetchUsageCalls: string[] = [];
  /** Every options object start() was called with, in order. */
  readonly starts: StartOptions[] = [];
  /** Every run whose interrupt() was called, in order — a run can appear more than once. */
  readonly interrupted: FakeRun[] = [];
  private sessionCounter = 0;

  /** The options the most recent run was started with, for assertions. */
  get lastStart(): StartOptions | undefined { return this.starts[this.starts.length - 1]; }

  constructor(
    private readonly script: (text: string) => AgentEvent[] = () => [],
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

  /** Every mode, so existing tests keep exercising the full picker. */
  listPermissionModes(): PermissionModeInfo[] {
    return [
      { id: 'default' }, { id: 'acceptEdits' }, { id: 'auto' },
      { id: 'plan' }, { id: 'dontAsk' }, { id: 'bypass' },
    ];
  }

  start(opts: StartOptions): AgentRun {
    const runIndex = this.starts.length;
    this.starts.push(opts);
    const channel = new EventChannel();
    const resumeToken = `fake-session-${++this.sessionCounter}`;
    let started = false;

    const run: FakeRun = {
      events: channel,
      send: (text: string, context?: EditorContext, attachments?: Attachment[]) => {
        this.sent.push({ text, context, attachments, runIndex });
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
      respondToQuestion: (id: string, answers: QuestionAnswers) => {
        this.answered.push([id, answers]);
        // Same reason as respondToTool above: a real provider resumes and
        // finishes the turn once the answer lands, and without a follow-up
        // event AgentSession leaves the status at 'running' forever.
        channel.push({ kind: 'turn-end', reason: 'done' });
      },
      setEffort: (effort: EffortLevel) => { this.efforts.push(effort); },
      setPermissionMode: (mode: PermissionMode) => { this.permissionModes.push(mode); },
      setModel: (model: string) => { this.models.push(model); },
      interrupt: async () => {
        this.interrupted.push(run);
        channel.push({ kind: 'turn-end', reason: 'interrupted' });
      },
      dispose: async () => { channel.close(); },
      emit: (event: AgentEvent) => { channel.push(event); },
      usageWindows: async (): Promise<UsageWindow[] | undefined> =>
        (this.reports.usageUnavailable ? undefined : (this.reports.windows ?? [])),
    };
    this.runs.push(run);
    const { context } = this.reports;
    if (context) { run.contextBreakdown = async () => context; }
    return run;
  }

  async listInvocables(cwd: string): Promise<Invocable[]> {
    this.listInvocablesCalls.push(cwd);
    if (this.invocables instanceof Error) { throw this.invocables; }
    return this.invocables ?? [];
  }

  async fetchUsage(cwd: string): Promise<UsageWindow[] | undefined> {
    this.fetchUsageCalls.push(cwd);
    return this.reports.usageUnavailable ? undefined : (this.reports.windows ?? []);
  }
}
