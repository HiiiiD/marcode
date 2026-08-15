import type {
  ContextBreakdown, EditorContext, EffortLevel, Invocable, McpServerStatus, ModelInfo,
  PermissionMode, PermissionModeInfo, ToolCall, ToolDecision, ToolOutput, UsageWindow,
} from '../providers/types';

export type {
  ContextBreakdown, EditorContext, EffortLevel, Invocable, McpServerStatus, ModelInfo,
  PermissionMode, PermissionModeInfo, ToolCall, ToolDecision, ToolOutput, UsageWindow,
};

export type SessionId = string;
export type SessionStatus = 'idle' | 'running' | 'awaiting-approval' | 'error';

interface ItemBase { id: string; ts: number }

export type TranscriptItem =
  | (ItemBase & { role: 'user'; text: string; context?: EditorContext })
  | (ItemBase & { role: 'assistant'; text: string; thinking?: string })
  | (ItemBase & {
      role: 'tool'; toolId: string; name: string; input: unknown;
      state: 'running' | 'ok' | 'error'; output?: unknown;
      /**
       * A subagent's tool activity. Depth 1 only — a child never has
       * children of its own. Absent for the overwhelming majority of tool
       * calls, and absent on every item v1 wrote, which is why adding it
       * needs no migration.
       */
      children?: TranscriptItem[];
      /** Parsed from an `mcp__<server>__<tool>` name; `name` holds the bare tool. */
      mcpServer?: string;
      tool?: ToolCall; toolOutput?: ToolOutput;
    })
  | (ItemBase & {
      role: 'permission'; requestId: string; name: string; input: unknown;
      state: 'pending' | 'allowed' | 'denied'; reason?: string;
      /** Parsed from an `mcp__<server>__<tool>` name; `name` holds the bare tool. */
      mcpServer?: string;
      tool?: ToolCall;
    })
  | (ItemBase & { role: 'error'; message: string });

export type TranscriptPatch =
  | { op: 'append'; item: TranscriptItem; parentItemId?: string }
  | { op: 'delta'; itemId: string; field: 'text' | 'thinking'; delta: string }
  | { op: 'replace'; item: TranscriptItem; parentItemId?: string };

export interface PermissionRequest {
  requestId: string;
  name: string;
  input: unknown;
  tool?: ToolCall;
}

export interface SessionState {
  id: SessionId;
  providerId: string;
  model: string;
  effort?: EffortLevel;
  title: string;
  cwd: string;
  status: SessionStatus;
  permissionMode: PermissionMode;
  /** Whether sends from this session attach the editor context. Sticky. */
  includeEditorContext: boolean;
  resumeToken?: string;
  usage: { inputTokens: number; outputTokens: number };
  /**
   * Share of the model's context window in use, `100 - freePercent`.
   * Absent until the first turn ends, or forever for a provider that does
   * not report a breakdown.
   */
  contextPercent?: number;
  /**
   * The breakdown that `contextPercent` was computed from, kept whole so a
   * session restored after a reload can still answer `request-context`: the
   * Claude run is constructed lazily on the first `send()`, so a resumed
   * conversation has no live query to measure until it is used again, and
   * nothing about the context can change before that send. Host-side state:
   * it rides the wire because it lives on `SessionState`, but the webview
   * reads the breakdown only from the `context-breakdown` reply, which is
   * the one path that knows whether it came from a live query or the cache.
   */
  lastContext?: ContextBreakdown;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}

export type SessionSummary = SessionState;

export interface SessionSnapshot extends SessionState {
  /** Recent window, oldest-first. */
  items: TranscriptItem[];
  /** More history available before items[0]. */
  hasMore: boolean;
  pending: PermissionRequest[];
  /**
   * The cwd's catalog, when the host has one. In-memory host state: absent
   * before the probe resolves, and absent forever if it failed.
   */
  invocables?: Invocable[];
  /**
   * Live provider state, not persisted. Always [] for an archived session —
   * there is no run to ask, and a stale snapshot presented as current would
   * be a lie. Deliberately NOT on SessionState, which is what index.json
   * stores.
   */
  mcpServers: McpServerStatus[];
}

export interface ProviderInfo {
  id: string;
  displayName: string;
  models: ModelInfo[];
  /**
   * The modes this provider offers. Rides the existing `hydrate` and
   * `catalog` messages because it lives on `ProviderInfo` — a mode set that
   * arrived out of step with the catalog it belongs to would let the picker
   * offer one provider's modes for another's session.
   */
  permissionModes: PermissionModeInfo[];
}

/**
 * A configured provider the host cannot currently honor — its backend did not
 * answer, so nothing it could offer would be true.
 *
 * It is deliberately NOT a `ProviderInfo` with an empty `models`: the catalog
 * is the set of things that can be picked, and anything in it is selectable.
 * These travel alongside it instead, for the one thing they are good for —
 * telling the user why an expected provider is missing.
 */
export interface UnavailableProvider {
  id: string;
  displayName: string;
  /** One line, provider-authored and already redacted. Shown verbatim. */
  reason: string;
}

export type ContextResult =
  | { ok: true; breakdown: ContextBreakdown }
  | { ok: false; reason: string };

export interface PaneLayout {
  orientation: 'vertical' | 'horizontal';
  panes: { sessionId: SessionId; size: number }[];
}

export type WebviewToHost =
  | { t: 'ready' }
  /**
   * `mode` is the permission mode the session starts in. It is optional and
   * defaults to `'default'` on the host, because a caller that has no
   * opinion must not be able to start a session in `bypass` by omission —
   * and `bypass` can only ever be chosen *before* the first message, so
   * creation is the one point on the wire where it is settable at all.
   */
  | { t: 'create-session'; providerId: string; cwd: string; model?: string;
      effort?: EffortLevel; mode?: PermissionMode }
  | { t: 'set-visible'; sessionIds: SessionId[] }
  | { t: 'set-layout'; layout: PaneLayout }
  | { t: 'close-session'; id: SessionId }
  | { t: 'delete-session'; id: SessionId }
  | { t: 'send'; id: SessionId; text: string }
  | { t: 'interrupt'; id: SessionId }
  | { t: 'set-effort'; id: SessionId; effort: EffortLevel }
  | { t: 'set-permission-mode'; id: SessionId; mode: PermissionMode }
  | { t: 'set-include-context'; id: SessionId; on: boolean }
  /** Not session-addressed: opening a file is global IDE state, not session state. */
  | { t: 'reveal-file'; path: string; startLine?: number }
  | { t: 'set-model'; id: SessionId; model: string }
  | { t: 'permission-decision'; id: SessionId; requestId: string; decision: ToolDecision }
  | { t: 'load-more'; id: SessionId; beforeItemId: string }
  | { t: 'request-context'; id: SessionId }
  /**
   * Distinct from `reveal-file`, which opens an editor-context path the host
   * itself produced. `path` here originates in a *provider's* context report,
   * so it is carried back with the session that reported it: the host opens
   * it only if that session's most recent breakdown actually listed it.
   * Hence the `SessionId`, which also keeps this in line with the "every
   * session-addressed message carries an explicit id" rule.
   */
  | { t: 'open-file'; id: SessionId; path: string };

export type HostToWebview =
  | { t: 'hydrate'; sessions: SessionSummary[]; layout: PaneLayout;
      snapshots: SessionSnapshot[]; catalog: ProviderInfo[];
      /**
       * Providers that cannot be picked, and why. Empty at hydrate on a
       * healthy install *and* on a broken one — nothing has been probed yet,
       * so the honest answer is "no catalog, no reasons"; the first `catalog`
       * message fills both in.
       */
      unavailable: UnavailableProvider[];
      /** Per provider, the last window set the host knew. Empty on a fresh install. */
      usage: Record<string, UsageWindow[]> }
  | { t: 'session-snapshot'; session: SessionSnapshot }
  | { t: 'session-patch'; id: SessionId; patch: TranscriptPatch }
  | { t: 'session-prepend'; id: SessionId; items: TranscriptItem[]; hasMore: boolean }
  | { t: 'session-status'; id: SessionId; status: SessionStatus }
  | { t: 'sessions-changed'; sessions: SessionSummary[] }
  | { t: 'session-invocables'; id: SessionId; entries: Invocable[] }
  | { t: 'session-mcp'; id: SessionId; servers: McpServerStatus[] }
  /**
   * Broadcast, not session-addressed: the provider/model catalog is global.
   * Sent after `hydrate` whenever a provider reports a catalog that differs
   * from the one it could answer with synchronously — model lists come from
   * the backend, so `hydrate` can only carry a provisional list.
   *
   * Both arrays are full replacements, never deltas, and they partition the
   * configured providers: a provider is in exactly one of them.
   */
  | { t: 'catalog'; catalog: ProviderInfo[]; unavailable: UnavailableProvider[] }
  /** Broadcast, not session-addressed: every composer shows the same editor. */
  | { t: 'editor-context'; ctx: EditorContext | null }
  | { t: 'context-breakdown'; id: SessionId; result: ContextResult }
  /**
   * Broadcast, not session-addressed, and not a reply: account usage belongs
   * to the provider's account, and it is pushed whenever the provider reports
   * a change. The array is the complete current set for that provider — a
   * snapshot, never a delta — so the client replaces rather than merges.
   * There is no not-ok arm: under a push there is no request that can fail,
   * and "nothing has been reported" is a state, not an error.
   */
  | { t: 'usage-windows'; providerId: string; windows: UsageWindow[] };
