import type {
  HostToWebview, McpServerStatus, PaneLayout, PermissionRequest, ProviderInfo, SessionId,
  SessionSummary, TranscriptItem,
} from '../protocol/messages';

export interface PaneState {
  summary: SessionSummary;
  items: TranscriptItem[];
  hasMore: boolean;
  pending: PermissionRequest[];
  mcpServers: McpServerStatus[];
}

export interface ClientState {
  ready: boolean;
  sessions: SessionSummary[];
  layout: PaneLayout;
  catalog: ProviderInfo[];
  byId: Record<SessionId, PaneState>;
}

export const initialState: ClientState = {
  ready: false,
  sessions: [],
  layout: { orientation: 'vertical', panes: [] },
  catalog: [],
  byId: {},
};

/**
 * `HostToWebview` plus one client-local action. The host persists
 * `set-layout` but never echoes it back — `hydrate` is the only
 * `HostToWebview` message carrying `layout`, and it only arrives on
 * `ready`. `local-layout` lets `StoreProvider.post` apply a posted layout
 * change optimistically so a newly opened or closed pane renders
 * immediately instead of waiting for the next reload; the host ends up
 * persisting exactly the value computed here, so there's nothing to
 * reconcile against later.
 */
export type ClientAction = HostToWebview | { t: 'local-layout'; layout: PaneLayout };

export function reduce(state: ClientState, msg: ClientAction): ClientState {
  switch (msg.t) {
    case 'local-layout':
      return { ...state, layout: msg.layout };

    case 'hydrate': {
      const byId: Record<SessionId, PaneState> = {};
      for (const s of msg.snapshots) {
        byId[s.id] = {
          summary: s, items: s.items, hasMore: s.hasMore, pending: s.pending,
          mcpServers: s.mcpServers ?? [],
        };
      }
      return {
        ready: true, sessions: msg.sessions, layout: msg.layout,
        catalog: msg.catalog, byId,
      };
    }

    case 'sessions-changed': {
      // `sessions-changed` is the only HostToWebview message carrying a
      // session's full summary — effort and permissionMode changes
      // (AgentSession.setEffort/setPermissionMode notify via
      // sink.changed() -> sessions-changed) reach the wire only through it,
      // not through session-status or session-patch. Mirror each incoming
      // summary into the matching byId entry so panes reflect it without
      // waiting for a session-snapshot (which only arrives on hydrate or
      // set-visible) — the same reason session-status below mirrors
      // `status` specifically, generalized to every summary field.
      const byId = { ...state.byId };
      for (const s of msg.sessions) {
        const pane = byId[s.id];
        if (!pane) { continue; } // no existing pane: nothing to mirror onto, and not created here.
        byId[s.id] = { ...pane, summary: s };
      }
      return { ...state, sessions: msg.sessions, byId };
    }

    case 'session-snapshot': {
      const s = msg.session;
      return {
        ...state,
        byId: {
          ...state.byId,
          [s.id]: {
            summary: s, items: s.items, hasMore: s.hasMore, pending: s.pending,
            mcpServers: s.mcpServers ?? [],
          },
        },
      };
    }

    case 'session-status': {
      const sessions = state.sessions.map((s) =>
        s.id === msg.id ? { ...s, status: msg.status } : s);
      const pane = state.byId[msg.id];
      if (!pane) { return { ...state, sessions }; }
      return {
        ...state,
        sessions,
        byId: {
          ...state.byId,
          [msg.id]: { ...pane, summary: { ...pane.summary, status: msg.status } },
        },
      };
    }

    case 'session-prepend': {
      const pane = state.byId[msg.id];
      if (!pane) { return state; }
      return {
        ...state,
        byId: {
          ...state.byId,
          [msg.id]: { ...pane, items: [...msg.items, ...pane.items], hasMore: msg.hasMore },
        },
      };
    }

    case 'session-patch': {
      const pane = state.byId[msg.id];
      if (!pane) { return state; }
      return {
        ...state,
        byId: { ...state.byId, [msg.id]: applyPatch(pane, msg.patch) },
      };
    }

    case 'session-mcp': {
      const pane = state.byId[msg.id];
      if (!pane) { return state; }
      return {
        ...state,
        byId: { ...state.byId, [msg.id]: { ...pane, mcpServers: msg.servers } },
      };
    }

    default:
      // The HostToWebview type is closed, but nothing guarantees a runtime value
      // matches it (a host that shipped a new variant before this bundle updated,
      // or a stray/malformed message). Treat an unrecognized message as a no-op
      // rather than falling off the switch and returning undefined.
      return state;
  }
}

type Patch = Extract<HostToWebview, { t: 'session-patch' }>['patch'];

function applyPatch(pane: PaneState, patch: Patch): PaneState {
  switch (patch.op) {
    case 'append': {
      const pending = patch.item.role === 'permission' && patch.item.state === 'pending'
        ? [...pane.pending, {
            requestId: patch.item.requestId,
            name: patch.item.name,
            input: patch.item.input,
          }]
        : pane.pending;

      // A nested append targets a parent already in the loaded window: the
      // parent's tool-start is appended before its subagent can emit
      // anything, so no orphan buffer is needed. If the parent genuinely is
      // not here, promote the child to top-level rather than dropping it —
      // losing nesting degrades rendering; dropping hides real work.
      if (patch.parentItemId) {
        const nested = withChild(pane.items, patch.parentItemId, patch.item);
        if (nested) { return { ...pane, items: nested, pending }; }
      }

      return { ...pane, items: [...pane.items, patch.item], pending };
    }

    case 'replace': {
      const replaced = patch.item;
      const pending = replaced.role === 'permission' && replaced.state !== 'pending'
        ? pane.pending.filter((p) => p.requestId !== replaced.requestId)
        : pane.pending;

      if (patch.parentItemId) {
        const nested = withChild(pane.items, patch.parentItemId, replaced);
        if (nested) { return { ...pane, items: nested, pending }; }
      }

      const items = pane.items.map((i) => (i.id === replaced.id ? replaced : i));
      return { ...pane, items, pending };
    }

    case 'delta': {
      const items = pane.items.map((i) => {
        if (i.id !== patch.itemId || i.role !== 'assistant') { return i; }
        return { ...i, [patch.field]: (i[patch.field] ?? '') + patch.delta };
      });
      return { ...pane, items };
    }
  }
}

/**
 * Inserts or replaces `child` inside `parentItemId`'s children, immutably.
 * Returns undefined when the parent is not in the loaded window, which is
 * the caller's signal to fall back to a top-level append.
 */
function withChild(
  items: TranscriptItem[],
  parentItemId: string,
  child: TranscriptItem,
): TranscriptItem[] | undefined {
  let found = false;
  const next = items.map((item) => {
    if (item.id !== parentItemId || item.role !== 'tool') { return item; }
    found = true;
    const children = item.children ?? [];
    const at = children.findIndex((c) => c.id === child.id);
    const updated = at >= 0
      ? children.map((c, i) => (i === at ? child : c))
      : [...children, child];
    return { ...item, children: updated };
  });
  return found ? next : undefined;
}
