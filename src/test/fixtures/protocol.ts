import type {
  PaneLayout, ProviderInfo, SessionSnapshot, SessionSummary, TranscriptItem,
} from '../../protocol/messages';

export type PermissionItem = Extract<TranscriptItem, { role: 'permission' }>;

export function summary(id: string, over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    providerId: 'fake',
    model: 'fake-large',
    title: `Session ${id}`,
    cwd: '/tmp',
    status: 'idle',
    permissionMode: 'default',
    usage: { inputTokens: 0, outputTokens: 0 },
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

export function snapshot(id: string, over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return { ...summary(id), items: [], hasMore: false, pending: [], mcpServers: [], ...over };
}

export function layoutOf(...ids: string[]): PaneLayout {
  return {
    orientation: 'vertical',
    panes: ids.map((sessionId) => ({ sessionId, size: 100 / ids.length })),
  };
}

export function catalog(): ProviderInfo[] {
  return [{
    id: 'fake',
    displayName: 'Fake',
    models: [
      {
        id: 'fake-large',
        displayName: 'Fake Large',
        effort: { levels: ['low', 'medium', 'high'], default: 'medium' },
      },
      { id: 'fake-small', displayName: 'Fake Small' },
      {
        id: 'fake-medium',
        displayName: 'Fake Medium',
        effort: { levels: ['low', 'medium'], default: 'low' },
      },
    ],
  }];
}

export function permission(over: Partial<PermissionItem> = {}): PermissionItem {
  return {
    id: 'i1',
    ts: 1,
    role: 'permission',
    requestId: 'r1',
    name: 'Write',
    input: { file_path: '/tmp/a.txt', content: 'hi' },
    state: 'pending',
    ...over,
  };
}
