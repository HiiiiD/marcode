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

export type ThreadItem =
  | { type: 'agentMessage'; id: string; text: string }
  | { type: 'reasoning'; id: string; summary: string[]; content: string[] }
  | { type: 'commandExecution'; id: string; command: string; cwd: string;
      status?: string; aggregatedOutput?: string; exitCode?: number | null }
  | { type: 'fileChange'; id: string; status?: string; changes?: unknown }
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
 * `account/read`'s response. `authMethod` is absent from the summary this
 * subset was drawn from but present on the wire (see codex-provider.ts's
 * unauthenticated-account test, which sends it): null/absent alongside
 * `requiresOpenaiAuth: true` is what actually means "not signed in" — an
 * account mid-refresh can carry `requiresOpenaiAuth: true` with a method
 * already on file, and that case must not be reported as logged out.
 */
export interface AccountReadResponse {
  account: { type: string; email?: string; planType?: string } | null;
  requiresOpenaiAuth: boolean;
  authMethod?: string | null;
}

export interface ModelListResponse {
  data: CodexModel[];
  nextCursor: string | null;
}

export interface RateLimitsReadResponse {
  rateLimits: RateLimitSnapshot;
}

/**
 * `skills/list`'s response shape is unverified — no fixture or captured
 * frame for it exists anywhere in this codebase yet, unlike every other type
 * in this file. Modelled on the same `{ data: [...] }` envelope `model/list`
 * uses, since that is this protocol's established list shape, but treat this
 * one as a guess until it is checked against a real `codex app-server`.
 */
export interface SkillInfo {
  name: string;
  description?: string;
}

export interface SkillsListResponse {
  data: SkillInfo[];
}
