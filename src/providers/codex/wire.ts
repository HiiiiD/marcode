/**
 * Hand-written subset of the Codex app-server protocol.
 *
 * Regenerate the full set with `yarn codex:bindings` and diff against it when
 * bumping the pinned CLI version — `InitializeResponse` carries no protocol
 * version, so a shape change is otherwise invisible until it fails at
 * runtime. `src/test/unit/codex-smoke.test.ts` automates the method-name half
 * of that check.
 *
 * Verified against codex-cli 0.147.0.
 */

export type AskForApproval = 'untrusted' | 'on-request' | 'never';
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type ApprovalsReviewer = 'user' | 'auto_review' | 'guardian_subagent';

export type SandboxPolicy =
  | { type: 'dangerFullAccess' }
  | { type: 'readOnly'; networkAccess: boolean }
  | {
      type: 'workspaceWrite'; writableRoots: string[]; networkAccess: boolean;
      excludeTmpdirEnvVar: boolean; excludeSlashTmp: boolean;
    };

/** Open string in the protocol; we narrow it at the boundary. */
export type ReasoningEffort = string;

export interface CodexModel {
  id: string;
  displayName: string;
  hidden: boolean;
  supportedReasoningEfforts: { reasoningEffort: ReasoningEffort; description: string }[];
  defaultReasoningEffort: ReasoningEffort;
}

export interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  /** UNIT IS NOT DOCUMENTED — measured in map-usage, never assumed. */
  resetsAt: number | null;
}

export interface RateLimitSnapshot {
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
}

export interface TokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface ThreadTokenUsage {
  total: TokenUsageBreakdown;
  last: TokenUsageBreakdown;
  modelContextWindow: number | null;
}

/**
 * One touched file inside a `fileChange` item — verified against codex-cli
 * 0.147.0. `diff` is a FULL unified diff, `---`/`+++` file headers and `@@`
 * hunk headers included, not just the changed body lines.
 */
export interface FileUpdateChange {
  path: string;
  /** 'add' | 'delete' | 'update' in practice; kept open, the renderer does not branch on it. */
  kind: string;
  diff: string;
}

export type ThreadItem =
  | { type: 'agentMessage'; id: string; text: string }
  | { type: 'reasoning'; id: string; summary: string[]; content: string[] }
  | { type: 'commandExecution'; id: string; command: string; cwd: string;
      status?: string; aggregatedOutput?: string; exitCode?: number | null }
  | { type: 'fileChange'; id: string; status?: string; changes?: FileUpdateChange[] }
  | { type: 'mcpToolCall'; id: string; server: string; toolName: string;
      status?: string; result?: unknown }
  | { type: 'webSearch'; id: string; query?: string }
  | { type: 'dynamicToolCall'; id: string; toolName?: string; status?: string }
  | { type: 'plan'; id: string; text: string }
  // Every other kind is deliberately unmodelled: parsing is tolerant, and an
  // unknown item is ignored rather than thrown.
  | { type: string; id: string };

export type ReviewDecision =
  | 'approved'
  | 'approved_for_session'
  | 'abort'
  | { denied: { rejection: string } };

/** `InitializeResponse` — verified against codex-cli 0.147.0. Carries no protocol version. */
export interface InitializeResponse {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

/**
 * `account/read`'s response — verified against the codex-cli 0.147.0
 * generated bindings (`GetAccountResponse`). There is no `authMethod` field.
 *
 * `requiresOpenaiAuth` does NOT mean "not signed in" — it describes whether
 * this provider requires OpenAI auth at all, and stays `true` for a
 * genuinely signed-in account. Measured against a live, signed-in ChatGPT
 * Plus account on codex-cli 0.147.0:
 * `{ account: { type: 'chatgpt', email, planType: 'plus' }, requiresOpenaiAuth: true }`.
 * The signed-out signal is `account` itself: null/absent is "not signed in";
 * a populated `account` is signed in regardless of `requiresOpenaiAuth`. See
 * codex-provider.ts's `fetchModels` and `src/test/unit/codex-smoke.test.ts`'s
 * `probeAuth()`, which the check here mirrors.
 */
export interface AccountReadResponse {
  account: { type: string; email?: string; planType?: string } | null;
  requiresOpenaiAuth: boolean;
}

export interface ModelListResponse {
  data: CodexModel[];
  nextCursor: string | null;
}

export interface RateLimitsReadResponse {
  rateLimits: RateLimitSnapshot;
}

/**
 * `skills/list`'s response — verified against the codex-cli 0.147.0
 * generated bindings. The request is keyed by `cwds` (plural, an array —
 * `SkillsListParams`), and the response nests skills one level under each
 * cwd rather than returning a flat list: `data` is one `SkillsListEntry` per
 * requested cwd, each carrying that cwd's own `skills` (and any `errors`
 * encountered loading them, which this client does not surface separately).
 */
export interface SkillMetadata {
  name: string;
  description?: string;
  /** Preferred over `description` for display when present — see map in codex-provider.ts. */
  shortDescription?: string;
  path: string;
  scope: string;
  enabled: boolean;
}

export interface SkillsListEntry {
  cwd: string;
  skills: SkillMetadata[];
  errors: unknown[];
}

export interface SkillsListResponse {
  data: SkillsListEntry[];
}
