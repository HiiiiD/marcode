import type {
  Attachment,
  BringBackPlan,
  ContextResult,
  EditorContext,
  FileRef,
  HostToWebview, Invocable, McpServerStatus, PaneLayout, PermissionRequest, ProviderInfo,
  QuestionRequest,
  SessionId, SessionSummary, StaleTree, TranscriptItem, TreeDiff, UnavailableProvider, UsageWindow,
} from '../protocol/messages';

export interface PaneState {
  summary: SessionSummary;
  items: TranscriptItem[];
  hasMore: boolean;
  pending: PermissionRequest[];
  /** The cwd's catalog. Absent until the host has one; see the spec's States. */
  invocables?: Invocable[];
  mcpServers: McpServerStatus[];
  /** Composed but not sent. Host state mirrored for this pane. */
  attachments: Attachment[];
  pendingQuestions: QuestionRequest[];
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
  /**
   * Whether the host is still asking the backends. `true` until a message
   * says otherwise, because an empty catalog nobody has answered for yet is
   * not the same claim as an empty catalog that settled — and only the second
   * one may be shown as "nothing here can run an agent".
   */
  probing: boolean;
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
   * The host's last fleet answer. `undefined` means nobody has asked — which
   * is not the same as `[]`, "asked, and nothing has changed". The two render
   * differently, and collapsing them would make an idle fleet look like a
   * broken one.
   */
  fleetDiff: TreeDiff[] | undefined;
  /**
   * Why the host's last fleet read failed, if it did. Distinct from an empty
   * `fleetDiff`, which is an answer: this one says there is no answer, and
   * says what stopped it. `undefined` whenever the last read succeeded.
   */
  fleetDiffReason: string | undefined;
  /**
   * Bumped whenever something happened that could have changed a diff: a
   * settled `file-edit` tool call, or a session going idle.
   *
   * The counter, rather than a boolean, so the surface's debounce can key an
   * effect on it and coalesce a burst of edits into one request. Deliberately
   * client-side: `session-status` is ungated (it fans out for every session,
   * visible or not) and `session-patch` already carries settled tool items
   * for the visible ones, so the host needs no new plumbing to make this live.
   */
  fleetDiffDirty: number;
  /**
   * The session whose pane last held focus — client-local, never sent to the
   * host and never persisted. It answers "which session is the user actually
   * working in", which is what a new session inherits its provider, model,
   * effort and permission mode from, and what the split renders its active
   * ring on. `null` until something in a pane has been focused, which is the
   * honest answer on a fresh load: nothing has been worked in yet.
   */
  focusedSessionId: SessionId | null;
  /** Last transient attachment failure for each composer, one line per refused file. */
  rejectionBySession: Record<SessionId, string[] | undefined>;
  /**
   * The most recent `file-search-result` per composer, keyed alongside the
   * `query` it answers — the composer compares that against its own live
   * query and drops a result for a keystroke the user has since typed past,
   * rather than needing a separate staleness id on the wire.
   */
  fileSearchBySession: Record<SessionId, { query: string; files: FileRef[] } | undefined>;
}

export const initialState: ClientState = {
  ready: false,
  sessions: [],
  layout: { orientation: 'vertical', panes: [] },
  catalog: [],
  unavailable: [],
  probing: true,
  byId: {},
  editorContext: null,
  contextBySession: {},
  bringBackBySession: {},
  usageByProvider: {},
  staleTrees: [],
  fleetDiff: undefined,
  fleetDiffReason: undefined,
  fleetDiffDirty: 0,
  focusedSessionId: null,
  rejectionBySession: {},
  fileSearchBySession: {},
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
  | { t: 'local-focus'; id: SessionId }
  /**
   * The user closed the composer's rejection line. Client-local because the
   * host emits rejections and forgets them — `rejectionBySession` is the only
   * place they live, so there is nothing on the host to tell.
   */
  | { t: 'local-dismiss-rejection'; id: SessionId };

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
          attachments: s.pendingAttachments ?? [],
          pendingQuestions: s.pendingQuestions,
        };
      }
      return {
        ready: true, sessions: msg.sessions, layout: msg.layout,
        catalog: msg.catalog, unavailable: msg.unavailable,
        // Absent reads as "still probing", the conservative side: a host that
        // never mentions it has never said the answer settled, and the empty
        // state stays a wait rather than becoming a verdict.
        probing: msg.probing ?? true,
        byId,
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
        // Cleared with the sweep and for the same reason — and the counter
        // with it, so a reload does not immediately re-request off a count
        // that describes a webview that no longer exists.
        fleetDiff: undefined, fleetDiffReason: undefined, fleetDiffDirty: 0,
        // Not carried forward: focus is a fact about the rendered panes, and
        // hydrate rebuilds them. A stale id would let `+ New` inherit from a
        // session this hydrate may not even contain.
        focusedSessionId: null,
        rejectionBySession: {},
        // Cleared for the same reason: it answers "what did the box's last
        // keystroke ask for", and a reload has no box left holding one.
        fileSearchBySession: {},
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

    case 'fleet-diff':
      // Wholesale, never merged, for the same reason the sweep is: it
      // describes disk at an instant, and a merged delta would let a stale
      // row outlive the change it described.
      // The reason travels with the answer and is replaced by it: a later
      // successful read clears a failure, because a failure that outlived the
      // read that disproved it would be the stale row this case exists to
      // prevent.
      return { ...state, fleetDiff: msg.trees, fleetDiffReason: msg.reason };

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
      return {
        ...state, catalog: msg.catalog, unavailable: msg.unavailable,
        probing: msg.probing ?? true,
      };

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
            attachments: s.pendingAttachments ?? [],
            pendingQuestions: s.pendingQuestions,
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

    case 'session-attachments': {
      const pane = state.byId[msg.id];
      if (!pane) { return state; }
      return {
        ...state,
        byId: { ...state.byId, [msg.id]: { ...pane, attachments: msg.attachments } },
        rejectionBySession: { ...state.rejectionBySession, [msg.id]: undefined },
      };
    }

    case 'attachments-rejected':
      return {
        ...state,
        rejectionBySession: { ...state.rejectionBySession, [msg.id]: msg.reasons },
      };

    case 'file-search-result':
      return {
        ...state,
        fileSearchBySession: {
          ...state.fileSearchBySession,
          [msg.id]: { query: msg.query, files: msg.files },
        },
      };

    // Dismissed by the user rather than by a later success. The reasons are
    // read and spent; keeping them until something unrelated attaches leaves
    // a stale complaint sitting under the box with no way to close it.
    case 'local-dismiss-rejection':
      return {
        ...state,
        rejectionBySession: { ...state.rejectionBySession, [msg.id]: undefined },
      };

    case 'session-status': {
      const sessions = state.sessions.map((s) =>
        s.id === msg.id ? { ...s, status: msg.status } : s);
      // Idle is when a turn's writes have landed. Ungated, so this is the one
      // signal that reaches the client for a session with no pane on screen.
      const fleetDiffDirty = msg.status === 'idle'
        ? state.fleetDiffDirty + 1
        : state.fleetDiffDirty;
      const pane = state.byId[msg.id];
      if (!pane) { return { ...state, sessions, fleetDiffDirty }; }
      return {
        ...state,
        sessions,
        fleetDiffDirty,
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
      // Counted before the pane guard: a file edit changed the tree whether
      // or not this client is rendering that session's transcript.
      const edited = msg.patch.op === 'replace'
        && msg.patch.item.role === 'tool'
        && msg.patch.item.state !== 'running'
        && msg.patch.item.tool.kind === 'file-edit';
      const fleetDiffDirty = edited ? state.fleetDiffDirty + 1 : state.fleetDiffDirty;

      const pane = state.byId[msg.id];
      if (!pane) { return edited ? { ...state, fleetDiffDirty } : state; }
      return {
        ...state,
        fleetDiffDirty,
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
      const pendingQuestions = patch.item.role === 'question' && patch.item.state === 'pending'
        ? [...pane.pendingQuestions, {
            requestId: patch.item.requestId, questions: patch.item.questions, blocking: patch.item.blocking,
          }]
        : pane.pendingQuestions;

      // A nested append targets a parent already in the loaded window: the
      // parent's tool-start is appended before its subagent can emit
      // anything, so no orphan buffer is needed. If the parent genuinely is
      // not here, promote the child to top-level rather than dropping it —
      // losing nesting degrades rendering; dropping hides real work.
      if (patch.parentItemId) {
        const nested = withChild(pane.items, patch.parentItemId, patch.item);
        if (nested) { return { ...pane, items: nested, pending, pendingQuestions }; }
      }

      return { ...pane, items: [...pane.items, patch.item], pending, pendingQuestions };
    }

    case 'replace': {
      const replaced = patch.item;
      const pending = replaced.role === 'permission' && replaced.state !== 'pending'
        ? pane.pending.filter((p) => p.requestId !== replaced.requestId)
        : pane.pending;
      const pendingQuestions = replaced.role === 'question' && replaced.state !== 'pending'
        ? pane.pendingQuestions.filter((q) => q.requestId !== replaced.requestId)
        : pane.pendingQuestions;

      if (patch.parentItemId) {
        const nested = withChild(pane.items, patch.parentItemId, replaced);
        if (nested) { return { ...pane, items: nested, pending, pendingQuestions }; }
      }

      const items = pane.items.map((i) => (i.id === replaced.id ? replaced : i));
      return { ...pane, items, pending, pendingQuestions };
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
