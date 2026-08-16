import type { ToolCall, ToolOutput } from './canonical/tool-call';

export type { FileEdit, TodoStatus, ToolCall, ToolOutput } from './canonical/tool-call';

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
/**
 * 'default'     — prompt on anything that falls through to a prompt
 * 'acceptEdits' — auto-accept file edits, still prompt for everything else
 * 'auto'        — a model classifier decides which calls are safe; the rest prompt
 * 'plan'        — read-only planning
 * 'dontAsk'     — deny anything not already permitted
 * 'bypass'      — allow everything
 */
export type PermissionMode = 'default' | 'acceptEdits' | 'auto' | 'plan' | 'dontAsk' | 'bypass';

/**
 * One permission mode a provider actually offers.
 *
 * `PermissionMode` stays a closed union — this is the `EffortLevel`
 * precedent, where the union is fixed and each model publishes the subset it
 * takes. A provider that cannot honor a mode must not offer it: Codex under
 * `workspace-write` never raises an approval for an in-workspace edit, so a
 * Codex `acceptEdits` would be a second name for `default`.
 */
export interface PermissionModeInfo {
  id: PermissionMode;
  /**
   * Provider-specific one-liner, overriding the shared description in the
   * picker. The same id enforces differently per provider, so the id alone is
   * not always enough for the user to choose safely.
   */
  description?: string;
}

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

export type AttachmentKind = 'image' | 'file';

/**
 * A file carried by a turn. Always a real path on disk: a pasted screenshot
 * is written to `context.storageUri` before it becomes one, so paste, the
 * file picker and drag-and-drop all converge on a single model before
 * anything downstream has to care which one it was.
 *
 * `kind` is what decides how a provider renders it — an image goes inline as
 * a native image input, anything else is named by path for the agent to read
 * with its own tools.
 */
export interface Attachment {
  /** Stable within a session. The chip's key and the handle `attach-remove` names. */
  id: string;
  /** Absolute. Deliberately not workspace-relative: a screenshot in ~/Downloads is the common case. */
  path: string;
  /** Basename. What the chip shows. */
  name: string;
  kind: AttachmentKind;
  /** Set for images; supplies the Claude block's `media_type`. */
  mediaType?: string;
  bytes: number;
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
  | { allow: true }
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
 * exactly `memoryPercent` — they are allocated within that slice, not
 * re-derived from token counts — so consumers must never re-derive a total
 * from the rows. A listed file rounding to 0 means "under 1%", never
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
  /**
   * The window's size in tokens, and how many of them are occupied.
   *
   * Every *share* on this interface is a percentage — that is what the slices
   * and the ring are for, and a percentage is what a supervisor reads at a
   * glance. These two exist because a percentage cannot answer "which window
   * am I on": 17% of 258k and 17% of 1M are the same reading of very
   * different sessions, and the model behind a session can change the
   * denominator without changing anything on screen. They are the
   * denominator and its numerator, quoted once, not a second unit for the
   * breakdown to be re-read in.
   *
   * Both optional and reported together: a provider that cannot name its
   * window omits both rather than pairing a real numerator with a guessed
   * denominator.
   */
  usedTokens?: number;
  windowTokens?: number;
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
  | { kind: 'tool-start'; id: string; tool: ToolCall; parentId?: string }
  /**
   * `tool`, when present, REPLACES what tool-start reported. A backend may
   * only learn a call's real arguments when it finishes — Codex's `webSearch`
   * carries `query: ''` while running and the actual search only on
   * completion — and a card that renders the start-time arguments forever
   * would show a search with no query. Omit it and the call stands.
   */
  | { kind: 'tool-end'; id: string; ok: boolean; output: ToolOutput;
      tool?: ToolCall; parentId?: string }
  | { kind: 'permission'; id: string; tool: ToolCall; parentId?: string }
  | { kind: 'turn-end'; reason: 'done' | 'interrupted' | 'error'; error?: string }
  | { kind: 'usage'; inputTokens: number; outputTokens: number }
  /**
   * The provider believes its plan usage has moved and a pull is due.
   *
   * Carries no data on purpose. `rate_limit_event`, which raises this, does
   * not populate a utilization percentage at steady state — reading values
   * off it is what made the strip permanently blank. The numbers come from
   * `AgentRun.usageWindows()`.
   */
  | { kind: 'usage-stale' }
  /** Full replacement list, not a delta. Emitted whenever the provider notices a change. */
  | { kind: 'invocables'; entries: Invocable[] }
  /** Full replacement list, not a delta — same snapshot semantics as `invocables`. */
  | { kind: 'mcp-servers'; servers: McpServerStatus[] };

export interface AgentRun {
  /**
   * `attachments` belong to the turn `text` was composed with — an attachment
   * added after this turn was sent belongs to the next one, not this one, so
   * a provider must never reach back to a session's live pending set. Absent
   * or empty means the turn carries none. Optional so a provider that does
   * not yet handle attachments simply ignores the parameter.
   */
  send(text: string, context?: EditorContext, attachments?: Attachment[]): void;
  readonly events: AsyncIterable<AgentEvent>;
  respondToTool(id: string, decision: ToolDecision): void;
  setEffort(effort: EffortLevel): void;
  /**
   * Changes the model of the *running* session, not just recorded state —
   * the same live-retarget contract as `setPermissionMode`. Called before the
   * first `send()` it shapes the query that gets built; called after, it
   * retargets the existing one, and a turn already in flight finishes on the
   * model it started with.
   *
   * Fire-and-forget by design, same as the other setters: callers must never
   * see this reject.
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
   * Same contract as `AgentProvider.fetchUsage`, answered on this run's live
   * query — so the two live triggers (a `usage-stale` event, and turn end)
   * cost one control request each and never a new subprocess.
   */
  usageWindows?(): Promise<UsageWindow[] | undefined>;
  dispose(): Promise<void>;
}

/**
 * Whether a resume token is valid only in the directory that produced it.
 *
 * 'cwd'    — history is stored per working directory (Claude:
 *            ~/.claude/projects/<slug>). Crossing directories needs a new
 *            thread, seeded by replay.
 * 'global' — a token resolves anywhere (Codex: threads keyed by threadId).
 *            Crossing directories is a native resume and costs nothing.
 *
 * Declaring 'cwd' when the truth is 'global' costs tokens. Declaring 'global'
 * when the truth is 'cwd' costs correctness: the resume silently finds
 * nothing and the agent comes up blank behind a full transcript. 'cwd' is the
 * safe default and 'global' must be measured before it is claimed.
 */
export type ThreadScope = 'cwd' | 'global';

export interface AgentProvider {
  readonly id: string;
  readonly displayName: string;
  readonly threadScope: ThreadScope;
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
  /**
   * The modes this provider can actually honor.
   *
   * Sync, like `listModels`: session creation and the roster read it inline.
   * MUST include 'default' — creation falls back to it in message-router,
   * and `resolvePermissionMode` resolves to it.
   */
  listPermissionModes(): PermissionModeInfo[];
  /**
   * Account/plan usage for a working directory, with NO session required.
   *
   * Optional: a provider whose backend has no plan limits (or cannot be
   * asked without a session) omits it entirely, and is then absent from the
   * usage strip rather than showing an empty row.
   *
   * `undefined` is a positive answer — this account has no plan limits at
   * all — and clears any persisted windows for the provider. `[]` means
   * limits apply but nothing is known yet, and clears nothing. Rejections
   * propagate; the caller decides retry policy.
   */
  fetchUsage?(cwd: string): Promise<UsageWindow[] | undefined>;
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
