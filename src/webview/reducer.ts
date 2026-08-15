import type {
  BringBackPlan,
  ContextResult,
  EditorContext,
  HostToWebview, Invocable, McpServerStatus, PaneLayout, PermissionRequest, ProviderInfo,
  SessionId, SessionSummary, StaleTree, TranscriptItem, UnavailableProvider, UsageWindow,
} from '../protocol/messages';

export interface PaneState {
  summary: SessionSummary;
  items: TranscriptItem[];
  hasMore: boolean;
  pending: PermissionRequest[];
  /** The cwd's catalog. Absent until the host has one; see the spec's States. */
  invocables?: Invocable[];
  mcpServers: McpServerStatus[];
}

export interface ClientState {
  ready: boolean;
  sessions: SessionSummary[];
  layout: PaneLayout;
  catalog: ProviderInfo[];
  /**
   * The configured providers that cannot be picked, and why. Never overlaps
   * `catalog` — the host partitions them — so "is this provider available?"
   * is answered by `catalog` alone, and this list only ever supplies the
   * explanation.
   */
  unavailable: UnavailableProvider[];
  byId: Record<SessionId, PaneState>;
  /**
   * Client-wide, not per session: the active editor is global IDE state and
   * every composer shows the same file.
   */
  editorContext: EditorContext | null;
  /** Last reply per session; kept while a refetch is in flight. */
  contextBySession: Record<SessionId, ContextResult | undefined>;
  /**
   * The last bring-back plan the host answered with, per session. `undefined`
   * means nobody has asked yet — which is not the same as "no", and is why the
   * pane header shows no door until an answer arrives rather than showing one
   * and taking it away.
   */
  bringBackBySession: Record<SessionId, BringBackPlan | undefined>;
  /**
   * The window set each provider has reported. Pushed by the host, replaced
   * wholesale. `undefined` means the host has said nothing about that
   * provider yet; an empty array means it said "nothing to show". They render
   * identically — the distinction exists only so this reducer never has to
   * invent a value.
   */
  usageByProvider: Record<string, UsageWindow[] | undefined>;
  /**
   * Every working tree the host's last sweep found, in the order it sent
   * them. Panel-wide rather than per session, because the rows that matter
   * are the ones no session is in. Empty until something has asked — which is
   * not the same as "there are none", and is why the entry point is mounted
   * only once a non-empty answer has arrived.
   */
  staleTrees: StaleTree[];
  /**
   * The session whose pane last held focus — client-local, never sent to the
   * host and never persisted. It answers "which session is the user actually
   * working in", which is what a new session inherits its provider, model,
   * effort and permission mode from, and what the split renders its active
   * ring on. `null` until something in a pane has been focused, which is the
   * honest answer on a fresh load: nothing has been worked in yet.
   */
  focusedSessionId: SessionId | null;
}

export const initialState: ClientState = {
  ready: false,
  sessions: [],
  layout: { orientation: 'vertical', panes: [] },
  catalog: [],
  unavailable: [],
  byId: {},
  editorContext: null,
  contextBySession: {},
  bringBackBySession: {},
  usageByProvider: {},
  staleTrees: [],
  focusedSessionId: null,
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
export type ClientAction =
  | HostToWebview
  | { t: 'local-layout'; layout: PaneLayout }
  /** Focus landed somewhere inside `id`'s pane. Client-local; see `focusedSessionId`. */
  | { t: 'local-focus'; id: SessionId };

export function reduce(state: ClientState, msg: ClientAction): ClientState {
  switch (msg.t) {
    case 'local-layout':
      return { ...state, layout: msg.layout };

    case 'local-focus':
      return state.focusedSessionId === msg.id ? state : { ...state, focusedSessionId: msg.id };

    case 'hydrate': {
      const byId: Record<SessionId, PaneState> = {};
      for (const s of msg.snapshots) {
        byId[s.id] = {
          summary: s, items: s.items, hasMore: s.hasMore, pending: s.pending,
          invocables: s.invocables,
          mcpServers: s.mcpServers ?? [],
        };
      }
      return {
        ready: true, sessions: msg.sessions, layout: msg.layout,
        catalog: msg.catalog, unavailable: msg.unavailable, byId,
        // Explicit, not `...state`: `hydrate` is meant to be a total
        // rebuild of `ClientState`, not a merge. `editorContext` is
        // genuinely client-wide (global IDE state a reload doesn't change),
        // so it is deliberately carried forward here — but spelled out so a
        // future field added to `ClientState` doesn't silently survive a
        // reload by accident the way a bare spread would let it. `usage` is
        // the opposite case: it is host state (the account's last known
        // window set), not client state, so it is always taken fresh from
        // the message rather than carried forward like `editorContext`.
        editorContext: state.editorContext,
        // Both cleared, not carried: a plan is a statement about a directory's
        // git state at one instant, and a reload is exactly the event after
        // which nothing in the client may still claim to know that.
        contextBySession: {}, bringBackBySession: {}, usageByProvider: msg.usage,
        // Cleared for the same reason the plans are: a sweep describes the
        // disk at one instant, and a reload is exactly the event after which
        // nothing in the client may still claim to know it.
        staleTrees: [],
        // Not carried forward: focus is a fact about the rendered panes, and
        // hydrate rebuilds them. A stale id would let `+ New` inherit from a
        // session this hydrate may not even contain.
        focusedSessionId: null,
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
      // A deleted session's cached breakdown would otherwise outlive it for
      // the life of the webview — the roster is the only signal the client
      // gets that a session is gone.
      const alive = new Set(msg.sessions.map((s) => s.id));
      const contextBySession: Record<SessionId, ContextResult | undefined> = {};
      for (const [id, result] of Object.entries(state.contextBySession)) {
        if (alive.has(id)) { contextBySession[id] = result; }
      }
      // Pruned on the same signal and for the same reason: a plan naming a
      // worktree would otherwise outlive the session that was sitting in it.
      const bringBackBySession: Record<SessionId, BringBackPlan | undefined> = {};
      for (const [id, plan] of Object.entries(state.bringBackBySession)) {
        if (alive.has(id)) { bringBackBySession[id] = plan; }
      }
      return { ...state, sessions: msg.sessions, byId, contextBySession, bringBackBySession };
    }

    case 'bring-back-plan': {
      // Same guard as `context-breakdown`: the question and its answer are two
      // round trips apart, so a session deleted in between must not have a
      // plan cached *after* the `sessions-changed` that pruned it.
      if (!state.sessions.some((s) => s.id === msg.id)) { return state; }
      return {
        ...state,
        bringBackBySession: { ...state.bringBackBySession, [msg.id]: msg.plan },
      };
    }

    case 'context-breakdown': {
      // A reply for a session the roster does not name is ignored, not
      // stored: `request-context` and its answer are two round trips apart,
      // so a session deleted in between would otherwise get its breakdown
      // cached *after* the `sessions-changed` that was supposed to prune it,
      // and nothing would remove it until the next roster change.
      if (!state.sessions.some((s) => s.id === msg.id)) { return state; }
      return {
        ...state,
        contextBySession: { ...state.contextBySession, [msg.id]: msg.result },
      };
    }

    case 'stale-trees':
      // Wholesale, never merged: the sweep is the complete answer, and a
      // removal's outcome is a row that is no longer in it.
      return { ...state, staleTrees: msg.trees };

    case 'usage-windows':
      return {
        ...state,
        usageByProvider: { ...state.usageByProvider, [msg.providerId]: msg.windows },
      };

    case 'catalog':
      // Full replacement: the host sends the whole catalog, never a delta —
      // and both arrays move together, so an availability change lands as one
      // message rather than a window where the two could disagree.
      return { ...state, catalog: msg.catalog, unavailable: msg.unavailable };

    case 'editor-context':
      return { ...state, editorContext: msg.ctx };

    case 'session-snapshot': {
      const s = msg.session;
      return {
        ...state,
        byId: {
          ...state.byId,
          [s.id]: {
            summary: s, items: s.items, hasMore: s.hasMore, pending: s.pending,
            invocables: s.invocables,
            mcpServers: s.mcpServers ?? [],
          },
        },
      };
    }

    case 'session-invocables': {
      const pane = state.byId[msg.id];
      if (!pane) { return state; }
      // Full replacement, matching the seam: no merge, no ordering to keep.
      return {
        ...state,
        byId: { ...state.byId, [msg.id]: { ...pane, invocables: msg.entries } },
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
        ? [...pane.pending, { requestId: patch.item.requestId, tool: patch.item.tool }]
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
