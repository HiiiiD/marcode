/**
 * Hand-written subset of the Codex app-server protocol.
 *
 * Regenerate the full set with `yarn codex:bindings` and diff against it when
 * bumping the pinned CLI version — `InitializeResponse` carries no protocol
 * version, so a shape change is otherwise invisible until it fails at
 * runtime. `src/test/unit/codex-smoke.test.ts` automates the method-name half
 * of that check.
 *
 * THAT SKEW CHECK COVERS METHOD **NAMES** ONLY. It asks the live binary
 * whether each method we send still exists; it never sends a real payload or
 * inspects a real response, so **payload-shape drift is invisible to it**.
 * Three shipped bugs came through that gap on 0.147.0 — `{ cwd }` sent to a
 * `params: undefined` request, a v1 `ReviewDecision` sent to a v2 approval,
 * and a response read one level too shallow — each of which the name check
 * passed cleanly. Shapes are held instead by the unit suites, which assert
 * the exact params we put on the wire and the exact responses we parse
 * (`codex-provider.test.ts`, `codex-run.test.ts`). Change a type here and a
 * test there must move with it.
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

/**
 * One command Codex parsed out of a shell invocation.
 *
 * Documented upstream as "a best-effort parsing of the command to understand
 * the action(s) it will perform … because a single shell command may be
 * composed of many commands piped together", and on the approval params as
 * "best-effort parsed command actions **for friendly display**". That last
 * phrase is the whole reason this type exists here: `ThreadItem.command` is
 * the escaped invocation Codex actually spawns, not something to show a user.
 */
export interface CommandAction {
  /** `'read' | 'listFiles' | 'search' | 'unknown'` upstream; kept open. */
  type?: string;
  command: string;
}

export type ThreadItem =
  | { type: 'agentMessage'; id: string; text: string }
  | { type: 'reasoning'; id: string; summary: string[]; content: string[] }
  // `command` is SHELL-ESCAPED, not display text — measured on codex-cli
  // 0.147.0, a `pwsh` call arrives as
  // `"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "…"` with every
  // backslash doubled. `commandActions` is the readable form. See
  // `CommandAction`.
  | { type: 'commandExecution'; id: string; command: string; cwd: string;
      commandActions?: CommandAction[];
      // Verified against the codex-cli 0.147.0 generated `v2/ThreadItem.ts`.
      // Both are null for the overwhelming majority of commands — an
      // ordinary shell invocation, or a model reading a plugin's own
      // SKILL.md through a generic `Get-Content`/`cat` call, resolves
      // neither (measured live: even a command whose only purpose was
      // reading `…\superpowers\…\SKILL.md` carried `pluginId: null,
      // scriptPath: null`). They populate only when the command IS a
      // trusted plugin script Codex recognizes and ran directly — a
      // narrower case than "a command that happens to touch a plugin's
      // files". `scriptPath` is plugin-relative, e.g.
      // `skills/using-superpowers/SKILL.md`.
      pluginId?: string | null; scriptPath?: string | null;
      status?: string; aggregatedOutput?: string; exitCode?: number | null }
  | { type: 'fileChange'; id: string; status?: string; changes?: FileUpdateChange[] }
  // `tool`, NOT `toolName` — verified against the codex-cli 0.147.0 generated
  // `v2/ThreadItem.ts`. Reading `toolName` here yields undefined and drops the
  // only identifying half of the header.
  | { type: 'mcpToolCall'; id: string; server: string; tool?: string;
      status?: string; result?: unknown }
  // `query` is `''` at `item/started` and only carries the real search on
  // `item/completed` — which is why the tool-end event revises the input.
  | { type: 'webSearch'; id: string; query?: string; results?: unknown[] }
  | { type: 'dynamicToolCall'; id: string; tool?: string; status?: string }
  | { type: 'plan'; id: string; text: string }
  // Every other kind is deliberately unmodelled: parsing is tolerant, and an
  // unknown item is ignored rather than thrown.
  | { type: string; id: string };

/**
 * The v2 approval decisions — verified against the codex-cli 0.147.0
 * generated bindings (`CommandExecutionApprovalDecision`,
 * `FileChangeApprovalDecision`).
 *
 * These replace the v1 `ReviewDecision` (`'approved'` / `{denied:{rejection}}`),
 * which belongs to the legacy `execCommandApproval`/`applyPatchApproval`
 * requests this client does not use. Sending a v1 value to an
 * `item/*\/requestApproval` request is not a no-op: measured live on 0.147.0,
 * `{decision:'approved'}` left the command unrun and the agent reported that
 * "the workspace blocked the shell write because its required approval
 * mechanism failed". `{decision:'accept'}` runs it.
 *
 * The amendment-carrying command variants
 * (`acceptWithExecpolicyAmendment`/`applyNetworkPolicyAmendment`) are
 * deliberately unmodelled: a `ToolDecision` is a yes/no and cannot express an
 * exec-policy or network-policy amendment.
 */
export type CommandExecutionApprovalDecision =
  | 'accept' | 'acceptForSession' | 'decline' | 'cancel';
export type FileChangeApprovalDecision =
  | 'accept' | 'acceptForSession' | 'decline' | 'cancel';

export interface CommandExecutionRequestApprovalResponse {
  decision: CommandExecutionApprovalDecision;
}
export interface FileChangeRequestApprovalResponse {
  decision: FileChangeApprovalDecision;
}

/**
 * `item/permissions/requestApproval`'s response — verified against the
 * codex-cli 0.147.0 generated bindings (`PermissionsRequestApprovalResponse`).
 *
 * Note what is NOT here: a `decision` field. This request does not ask
 * yes/no, it asks *which* additional permissions to grant and for how long,
 * so there is no "decline" member to send. Both fields of
 * `GrantedPermissionProfile` are optional, which makes an empty profile —
 * grant nothing — the one honest refusal the type can express; `'turn'` is
 * the narrower of the two scopes. See `CodexRun.respondToTool`.
 */
export interface GrantedPermissionProfile {
  network?: unknown;
  fileSystem?: unknown;
}
export type PermissionGrantScope = 'turn' | 'session';
export interface PermissionsRequestApprovalResponse {
  permissions: GrantedPermissionProfile;
  scope: PermissionGrantScope;
  strictAutoReview?: boolean;
}

/**
 * The two typed-input server requests this panel cannot render, and the
 * responses that decline them — verified against the codex-cli 0.147.0
 * generated bindings (`ToolRequestUserInputResponse`,
 * `McpServerElicitationRequestResponse`).
 *
 * Both have required fields, so `{}` fails deserialization server-side and
 * the blocking request goes unanswered — the exact hang the decline exists to
 * prevent. `answers` is a map, so an empty one is structurally valid and
 * means "answered nothing".
 */
export interface ToolRequestUserInputAnswer { answers: string[] }
export interface ToolRequestUserInputResponse {
  answers: Record<string, ToolRequestUserInputAnswer>;
}
export type McpServerElicitationAction = 'accept' | 'decline' | 'cancel';
export interface McpServerElicitationRequestResponse {
  action: McpServerElicitationAction;
  /** Nullable by design: decline/cancel responses carry no content. */
  content: unknown | null;
  _meta: unknown | null;
}

/**
 * `mcpServer/startupStatus/updated`'s params — verified against the
 * codex-cli 0.147.0 generated bindings (`McpServerStatusUpdatedNotification`).
 *
 * One server per notification, not a roster: the panel's `mcp-servers` event
 * is a full-replacement list, so `CodexRun` accumulates these by `name`.
 */
export type McpServerStartupState = 'starting' | 'ready' | 'failed' | 'cancelled';
export type McpServerStartupFailureReason = 'reauthenticationRequired';
export interface McpServerStatusUpdatedNotification {
  threadId: string | null;
  name: string;
  status: McpServerStartupState;
  error: string | null;
  failureReason: McpServerStartupFailureReason | null;
}

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

/**
 * `account/rateLimits/read`'s response — verified against the codex-cli
 * 0.147.0 generated bindings (`GetAccountRateLimitsResponse`).
 *
 * The snapshot is nested under `rateLimits`, not returned bare: typing this
 * request as a `RateLimitSnapshot` parses `.primary`/`.secondary` off the
 * envelope, finds nothing, and yields an empty window list. The request
 * itself declares `params: undefined` (a serde unit) — send `{}`, never
 * `{ cwd }`, which errors with `invalid type: map, expected unit`.
 *
 * `rateLimitsByLimitId`/`rateLimitResetCredits` are deliberately unmodelled:
 * the strip renders the single-bucket view only.
 */
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

/**
 * What `thread/start` and `thread/resume` both answer with — the whole
 * `Thread`, nested, with no bare `threadId` beside it. Only the id is read
 * here; the rest of the object (preview, path, status, timestamps) has no
 * consumer in this client yet.
 *
 * Measured on codex-cli 0.147.0. The distinction is load-bearing rather than
 * cosmetic: `thread/start` also emits a `thread/started` notification
 * carrying the same id, and `thread/resume` does not, so a client that reads
 * the id off the notification works until the first reload and then hangs
 * every restored session. See `startThread` in codex-run.ts.
 */
export interface ThreadResponse {
  thread?: { id?: string };
}
