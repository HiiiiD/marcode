import type {
  EffortLevel, McpServerStatus, ModelInfo, PermissionMode, ToolDecision,
} from '../providers/types';

export type { EffortLevel, McpServerStatus, ModelInfo, PermissionMode, ToolDecision };

export type SessionId = string;
export type SessionStatus = 'idle' | 'running' | 'awaiting-approval' | 'error';

interface ItemBase { id: string; ts: number }

export type TranscriptItem =
  | (ItemBase & { role: 'user'; text: string })
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
    })
  | (ItemBase & {
      role: 'permission'; requestId: string; name: string; input: unknown;
      state: 'pending' | 'allowed' | 'denied'; reason?: string;
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
  resumeToken?: string;
  usage: { inputTokens: number; outputTokens: number };
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
}

export interface PaneLayout {
  orientation: 'vertical' | 'horizontal';
  panes: { sessionId: SessionId; size: number }[];
}

export type WebviewToHost =
  | { t: 'ready' }
  | { t: 'create-session'; providerId: string; cwd: string; model?: string; effort?: EffortLevel }
  | { t: 'set-visible'; sessionIds: SessionId[] }
  | { t: 'set-layout'; layout: PaneLayout }
  | { t: 'close-session'; id: SessionId }
  | { t: 'delete-session'; id: SessionId }
  | { t: 'send'; id: SessionId; text: string }
  | { t: 'interrupt'; id: SessionId }
  | { t: 'set-effort'; id: SessionId; effort: EffortLevel }
  | { t: 'set-permission-mode'; id: SessionId; mode: PermissionMode }
  | { t: 'set-model'; id: SessionId; model: string }
  | { t: 'permission-decision'; id: SessionId; requestId: string; decision: ToolDecision }
  | { t: 'load-more'; id: SessionId; beforeItemId: string };

export type HostToWebview =
  | { t: 'hydrate'; sessions: SessionSummary[]; layout: PaneLayout;
      snapshots: SessionSnapshot[]; catalog: ProviderInfo[] }
  | { t: 'session-snapshot'; session: SessionSnapshot }
  | { t: 'session-patch'; id: SessionId; patch: TranscriptPatch }
  | { t: 'session-prepend'; id: SessionId; items: TranscriptItem[]; hasMore: boolean }
  | { t: 'session-status'; id: SessionId; status: SessionStatus }
  | { t: 'session-mcp'; id: SessionId; servers: McpServerStatus[] }
  | { t: 'sessions-changed'; sessions: SessionSummary[] };
