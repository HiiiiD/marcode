import { afterEach, expect, test } from 'bun:test';
import { McpDialog } from '../../tui/ui/mcp/mcp-dialog';
import type { McpPanel } from '../../protocol/messages';
import { snapshot, summary } from '../fixtures/protocol';
import { hydrateMsg, mount, type Mounted } from './harness';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });

const PANEL: McpPanel = {
  capabilities: { reconnect: 'per-server', signIn: false, sse: true, workingDirectory: false },
  targets: { repo: { path: '/repo/.mcp.json' }, global: { path: '/home/.claude.json' } },
  pending: [],
  restarting: false,
};

const open = async (panel: McpPanel = PANEL) => {
  const s = summary('s1');
  m = await mount(<McpDialog sessionId="s1" onClose={() => {}} />, { width: 100, height: 30 });
  await m.fromHost(hydrateMsg({ sessions: [s], snapshots: [snapshot('s1', s)] }));
  await m.fromHost(
    { t: 'session-mcp', id: 's1', servers: [
      { name: 'shadcn', state: 'connected', toolCount: 3, origin: 'repo' },
      { name: 'figma', state: 'failed', error: 'boom', origin: 'global' },
    ] },
    { t: 'mcp-panel', id: 's1', panel },
  );
};

test('asks the host for its session panel on open', async () => {
  await open();
  expect(m!.posted.filter((p) => p.t === 'mcp-open').length).toBe(1);
});

test('lists problems first with badges and a summary', async () => {
  await open();
  const f = m!.frame();
  expect(f).toContain('MCP servers');
  expect(f.indexOf('figma') < f.indexOf('shadcn')).toBe(true);
  expect(f).toContain('2 servers · 1 failing');
  expect(f).toContain('global');
});

test('d then y removes the selected server from its origin', async () => {
  await open();
  await m!.press('down');
  await m!.press('d');
  expect(m!.frame()).toContain('/repo/.mcp.json');
  await m!.press('y');
  const last = m!.posted.at(-1);
  expect(last?.t === 'mcp-remove' && `${last.name}:${last.origin}`).toBe('shadcn:repo');
});

test('R restarts when the banner shows', async () => {
  await open({ ...PANEL, pending: [{ name: 'x', origin: 'repo', change: 'added' }] });
  expect(m!.frame()).toContain('Restart');
  await m!.press('R');
  expect(m!.posted.at(-1)?.t).toBe('restart-session');
});

test('a then the form adds a stdio server to the repo', async () => {
  await open();
  await m!.press('a');
  expect(m!.frame()).toContain('Add MCP server');
  await m!.press('tab');
  await m!.type('blender');
  await m!.press('tab');
  await m!.type('uv run blender-mcp');
  await m!.press('return');
  const last = m!.posted.at(-1);
  expect(last?.t === 'mcp-add' && JSON.stringify([last.scope, last.server])).toBe(
    JSON.stringify(['repo', { name: 'blender', transport: 'stdio', command: 'uv', args: ['run', 'blender-mcp'], env: {} }]),
  );
});
