import type {
  HostToWebview, PaneLayout, PermissionRequest, ProviderInfo, SessionId,
  SessionSummary, TranscriptItem,
} from '../protocol/messages';

export interface PaneState {
  summary: SessionSummary;
  items: TranscriptItem[];
  hasMore: boolean;
  pending: PermissionRequest[];
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

export function reduce(state: ClientState, msg: HostToWebview): ClientState {
  switch (msg.t) {
    case 'hydrate': {
      const byId: Record<SessionId, PaneState> = {};
      for (const s of msg.snapshots) {
        byId[s.id] = {
          summary: s, items: s.items, hasMore: s.hasMore, pending: s.pending,
        };
      }
      return {
        ready: true, sessions: msg.sessions, layout: msg.layout,
        catalog: msg.catalog, byId,
      };
    }

    case 'sessions-changed':
      return { ...state, sessions: msg.sessions };

    case 'session-snapshot': {
      const s = msg.session;
      return {
        ...state,
        byId: {
          ...state.byId,
          [s.id]: { summary: s, items: s.items, hasMore: s.hasMore, pending: s.pending },
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
  }
}

type Patch = Extract<HostToWebview, { t: 'session-patch' }>['patch'];

function applyPatch(pane: PaneState, patch: Patch): PaneState {
  switch (patch.op) {
    case 'append':
      return {
        ...pane,
        items: [...pane.items, patch.item],
        pending: patch.item.role === 'permission' && patch.item.state === 'pending'
          ? [...pane.pending, {
              requestId: patch.item.requestId,
              name: patch.item.name,
              input: patch.item.input,
            }]
          : pane.pending,
      };

    case 'replace': {
      const replaced = patch.item;
      const items = pane.items.map((i) => (i.id === replaced.id ? replaced : i));
      const pending = replaced.role === 'permission' && replaced.state !== 'pending'
        ? pane.pending.filter((p) => p.requestId !== replaced.requestId)
        : pane.pending;
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
