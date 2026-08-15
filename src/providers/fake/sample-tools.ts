// One representative call per canonical kind, used by the DOM tests and by
// `fake-provider.test.ts`'s exhaustiveness check, so every arm of the
// renderer is exercised without a live backend.

import type { ToolCall } from '../canonical/tool-call';

export const SAMPLE_TOOL_CALLS: Record<ToolCall['kind'], ToolCall> = {
  'command': { kind: 'command', label: 'Bash', command: 'yarn test:unit', note: 'run the suite' },
  'file-edit': {
    kind: 'file-edit', label: 'Edit',
    files: [{
      path: 'src/webview/components/tool-render.ts', op: 'modify',
      edits: [{ before: 'const a = 1;', after: 'const a = 2;' }],
    }],
  },
  'file-read': {
    kind: 'file-read', label: 'Read',
    path: 'src/protocol/messages.ts', range: { offset: 1, limit: 40 },
  },
  'search': {
    kind: 'search', label: 'Grep', pattern: 'describeTool', mode: 'content',
    scope: 'src', filters: [{ label: 'glob', value: '*.ts' }],
  },
  'web': { kind: 'web', label: 'WebFetch', url: 'https://example.dev/docs', note: 'summarize' },
  'todos': {
    kind: 'todos', label: 'TodoWrite',
    items: [
      { status: 'completed', text: 'Write the mapper' },
      { status: 'in_progress', text: 'Rewrite the renderer' },
      { status: 'pending', text: 'Delete the old fields' },
    ],
  },
  'plan': { kind: 'plan', label: 'Plan', text: 'Map, render, then contract.' },
  'subagent': {
    kind: 'subagent', label: 'Agent', action: 'spawn',
    agent: 'Explore', model: 'sonnet', prompt: 'Find every call site.',
  },
  'mcp': { kind: 'mcp', label: 'create_issue', server: 'github', tool: 'create_issue' },
  'other': { kind: 'other', label: 'Bananas', raw: { peeled: true } },
};
