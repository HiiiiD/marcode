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

/**
 * What the user is looking at in the editor when they hit send. Carries the
 * file reference always, and the selected text only when there is a
 * selection — the model has file-reading tools, so inlining a whole file on
 * every message would spend tokens on what it can fetch on demand.
 */
export interface EditorContext {
  /** Workspace-relative when inside an open folder, absolute otherwise. POSIX separators. */
  path: string;
  languageId: string;
  /** Absent when nothing is selected. */
  selection?: {
    /**
     * 1-based inclusive line numbers, sorted, non-overlapping. An array from
     * day one: multi-cursor selections are ordinary, and transcript items
     * persist to disk, so widening a scalar pair later would need a tolerant
     * reader for already-written history.
     */
    ranges: { startLine: number; endLine: number; text: string }[];
    /** True when text was cut or whole ranges dropped to fit the budget. */
    truncated: boolean;
  };
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

/**
 * Status of one configured MCP server. Mirrors the SDK's own union
 * (sdk.d.ts:1083) including 'disabled' — a configured-but-off server is a
 * different thing from a broken one, and the user needs to tell them apart.
 */
export type McpServerStatus = {
  name: string;
  state: 'pending' | 'connected' | 'failed' | 'needs-auth' | 'disabled';
  toolCount?: number;
  error?: string;
};

export type AgentEvent =
  | { kind: 'session'; resumeToken: string }
  | { kind: 'text'; delta: string }
  | { kind: 'thinking'; delta: string }
  | { kind: 'tool-start'; id: string; name: string; input: unknown; parentId?: string }
  | { kind: 'tool-end'; id: string; ok: boolean; output: unknown; parentId?: string }
  | { kind: 'permission'; id: string; name: string; input: unknown; parentId?: string }
  | { kind: 'turn-end'; reason: 'done' | 'interrupted' | 'error'; error?: string }
  | { kind: 'usage'; inputTokens: number; outputTokens: number }
  | { kind: 'mcp-servers'; servers: McpServerStatus[] };

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
