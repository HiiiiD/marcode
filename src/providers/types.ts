export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
/**
 * 'default'     — prompt on anything that falls through to a prompt
 * 'acceptEdits' — auto-accept file edits, still prompt for everything else
 * 'auto'        — a model classifier decides which calls are safe; the rest prompt
 * 'plan'        — read-only planning
 * 'dontAsk'     — deny anything not already permitted
 * 'bypass'      — allow everything
 */
export type PermissionMode = 'default' | 'acceptEdits' | 'auto' | 'plan' | 'dontAsk' | 'bypass';

export interface ModelInfo {
  id: string;
  displayName: string;
  /**
   * The canonical wire id this row resolves to, when the row is an alias
   * (`opus` -> `claude-opus-5`). Absent when `id` is already canonical. This
   * is what lets a session persisted under a wire id find the alias row that
   * covers it — see `findModel` in src/shared/model-catalog.ts.
   */
  resolvedModel?: string;
  /** Absent when the model has no effort control. */
  effort?: { levels: EffortLevel[]; default: EffortLevel };
}

/**
 * One thing the user can invoke by typing `/name`: a skill or a slash
 * command. Providers report these as one undifferentiated list — the SDK has
 * no discriminator — so there is deliberately no `kind` field.
 */
export interface Invocable {
  /** Verbatim from the provider. This is what gets inserted into the composer. */
  name: string;
  /** One line, rendered as the row's second line. */
  description?: string;
  /** Plugin/namespace prefix derived from a `prefix:leaf` name. Display only. */
  origin?: string;
  /** e.g. '[interval] [prompt]'. Rendered as ghost text after insertion. */
  argHint?: string;
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
  /** Full replacement list, not a delta. Emitted whenever the provider notices a change. */
  | { kind: 'invocables'; entries: Invocable[] }
  /** Full replacement list, not a delta — same snapshot semantics as `invocables`. */
  | { kind: 'mcp-servers'; servers: McpServerStatus[] };

export interface AgentRun {
  send(text: string, context?: EditorContext): void;
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
  /**
   * What is known about this provider's models *right now* — a cache, not a
   * source of truth. Synchronous because session creation and the roster read
   * it inline; providers that can discover their real catalog implement
   * `fetchModels` and let this return whatever the last fetch produced.
   */
  listModels(): ModelInfo[];
  /**
   * Asks the backend for its real model catalog and updates what
   * `listModels()` returns. Optional: a provider whose models are genuinely
   * fixed (the fake one) omits it. Rejections propagate — the caller decides
   * whether a failed probe is worth retrying.
   */
  fetchModels?(cwd: string): Promise<ModelInfo[]>;
  start(opts: StartOptions): AgentRun;
  /**
   * The catalog for a working directory, with NO session required.
   *
   * Optional because a provider may not be able to answer without one. It
   * exists because the Claude provider constructs its query lazily on the
   * first send() (only construction can set `bypass`), so the session's own
   * query cannot answer for a composer that has not been used yet — which is
   * exactly when the menu is wanted.
   */
  listInvocables?(cwd: string): Promise<Invocable[]>;
}
