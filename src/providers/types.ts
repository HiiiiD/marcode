export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
/**
 * 'default'     — prompt on anything that falls through to a prompt
 * 'acceptEdits' — auto-accept file edits, still prompt for everything else
 * 'plan'        — read-only planning
 * 'dontAsk'     — deny anything not already permitted
 * 'bypass'      — allow everything
 */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'dontAsk' | 'bypass';

export interface ModelInfo {
  id: string;
  displayName: string;
  /** Absent when the model has no effort control. */
  effort?: { levels: EffortLevel[]; default: EffortLevel };
}

export interface StartOptions {
  cwd: string;
  model?: string;
  effort?: EffortLevel;
  permissionMode: PermissionMode;
  /** Provider-opaque. Never parsed by callers. */
  resumeToken?: string;
}

export type ToolDecision =
  | { allow: true; updatedInput?: unknown }
  | { allow: false; reason?: string };

/** One account/plan usage window, as a percentage. Never a token count. */
export interface UsageWindow {
  /** Provider-defined: 'five-hour' | 'seven-day' | … */
  id: string;
  /** Human label, e.g. 'Session (5h)'. */
  label: string;
  /** 0..100. */
  usedPercent: number;
  /** Epoch ms, when the provider knows it. */
  resetsAt?: number;
}

/**
 * How the model's context window is occupied, as percentages of that window.
 * The four `*Percent` fields sum to 100; `memoryFiles` percentages sum to
 * `memoryPercent` subject to rounding, so consumers must never re-derive a
 * total from the rows. A listed file rounding to 0 means "under 1%", never
 * "absent" — the UI renders that case as `<1%`.
 */
export interface ContextBreakdown {
  /** System prompt and tool definitions, as one slice. */
  systemPercent: number;
  memoryPercent: number;
  conversationPercent: number;
  freePercent: number;
  /** Absolute paths, with each file's share of the window. */
  memoryFiles: { path: string; percent: number }[];
}

export type AgentEvent =
  | { kind: 'session'; resumeToken: string }
  | { kind: 'text'; delta: string }
  | { kind: 'thinking'; delta: string }
  | { kind: 'tool-start'; id: string; name: string; input: unknown }
  | { kind: 'tool-end'; id: string; ok: boolean; output: unknown }
  | { kind: 'permission'; id: string; name: string; input: unknown }
  | { kind: 'turn-end'; reason: 'done' | 'interrupted' | 'error'; error?: string }
  | { kind: 'usage'; inputTokens: number; outputTokens: number };

export interface AgentRun {
  send(text: string): void;
  readonly events: AsyncIterable<AgentEvent>;
  respondToTool(id: string, decision: ToolDecision): void;
  setEffort(effort: EffortLevel): void;
  /**
   * Changes the model. The SDK fixes the model at query construction, so
   * this only ever takes effect when called before the first `send()` —
   * there is no live seam to migrate a running query onto a new model.
   * Fire-and-forget by design, same as the other setters: callers must
   * never see this reject.
   */
  setModel(model: string): void;
  /**
   * Changes the permission mode of the *running* session, not just recorded
   * state — a live agent process should actually start enforcing the new
   * mode. Fire-and-forget by design (`void`, not `Promise<void>`): callers
   * must never see this reject. A failure is state, not an exception.
   */
  setPermissionMode(mode: PermissionMode): void;
  interrupt(): Promise<void>;
  /**
   * Startup context inventory for this conversation. Optional: a provider
   * that cannot report it omits the method entirely rather than resolving
   * to a fabricated breakdown.
   */
  contextBreakdown?(): Promise<ContextBreakdown>;
  /**
   * Account/plan usage windows visible from this run. Lives on the run
   * rather than the provider because the Claude Agent SDK exposes plan
   * limits only from a live `Query`; the host treats any one live run of a
   * provider as speaking for that provider's account.
   */
  usageWindows?(): Promise<UsageWindow[]>;
  dispose(): Promise<void>;
}

export interface AgentProvider {
  readonly id: string;
  readonly displayName: string;
  listModels(): ModelInfo[];
  start(opts: StartOptions): AgentRun;
}
