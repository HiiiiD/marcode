import type {
  ContextBreakdown, PaneLayout, ProviderInfo, SessionSnapshot, SessionSummary, TranscriptItem,
  UsageWindow,
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
  return { ...summary(id), items: [], hasMore: false, pending: [], ...over };
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

export function breakdown(over: Partial<ContextBreakdown> = {}): ContextBreakdown {
  return {
    systemPercent: 12,
    memoryPercent: 4,
    conversationPercent: 27,
    freePercent: 57,
    memoryFiles: [{ path: '/repo/CLAUDE.md', percent: 3 }],
    ...over,
  };
}

export function windows(): UsageWindow[] {
  return [
    { id: 'five-hour', label: 'Session (5h)', usedPercent: 62, resetsAt: 3_600_000 },
    { id: 'seven-day', label: 'Week', usedPercent: 18 },
  ];
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
