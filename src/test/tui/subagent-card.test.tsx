import { afterEach, expect, test } from 'bun:test';
import { SubagentCard } from '../../tui/ui/transcript/subagent-card';
import { permission, tool } from '../fixtures/protocol';
import { mount, type Mounted } from './harness';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });

const spawn = { kind: 'subagent', label: 'Task', action: 'spawn', agent: 'Explore' } as const;
const kids = (n: number) => Array.from({ length: n }, (_, i) => tool({ id: `k${i}`, toolId: `tk${i}`, ts: 10 + i }));
const agent = (over: Parameters<typeof tool>[0] = {}) =>
  tool({ id: 'sa', ts: 1, state: 'ok', tool: spawn, children: kids(3), ...over });
const card = (item: ReturnType<typeof agent>, o: { open?: boolean; userClosed?: boolean } = {}) =>
  <SubagentCard item={item} open={o.open ?? false} userClosed={o.userClosed ?? false} selected={false} />;

test('the collapsed header shows the label, the tool count and the elapsed time', async () => {
  m = await mount(card(agent()));
  expect(m.frame()).toContain('Explore');
  expect(m.frame()).toContain('3 tools');
  expect(/\d+s/.test(m.frame())).toBe(true);
});

test('a background dispatch says it runs in the background', async () => {
  m = await mount(card(agent({ tool: { ...spawn, background: true }, children: [] })));
  expect(m.frame()).toContain('Running in background');
  expect(m.frame().includes('0 tools')).toBe(false);
});

test('zero children shows 0 tools without crashing when opened', async () => {
  m = await mount(card(agent({ children: [] }), { open: true }));
  expect(m.frame()).toContain('0 tools');
});

test('open shows child cards, header only, and windows to the last 10 with a note', async () => {
  m = await mount(card(agent({ children: kids(14) }), { open: true }), { width: 100, height: 60 });
  expect(m.frame()).toContain('showing last 10 of 14');
  expect(m.frame().split('\n').filter((r) => r.includes('Bash')).length).toBe(10);
});

test('a blocked subagent forces itself open until the user closed it', async () => {
  const blocked = agent({ state: 'running', children: [...kids(1), permission({ id: 'pp', state: 'pending' })] });
  m = await mount(card(blocked));
  expect(m.frame()).toContain('Needs you');
  expect(m.frame().includes('Bash')).toBe(true);
  m.destroy();
  m = await mount(card(blocked, { userClosed: true }));
  expect(m.frame()).toContain('Needs you');
  expect(m.frame().split('\n').filter((r) => r.includes('Bash')).length).toBe(0);
});

test('a settled closed subagent starts no interval', async () => {
  const real = globalThis.setInterval;
  let started = 0;
  globalThis.setInterval = ((...a: Parameters<typeof setInterval>) => { started++; return real(...a); }) as typeof setInterval;
  try { m = await mount(card(agent())); } finally { globalThis.setInterval = real; }
  expect(started).toBe(0);
});

test('a very long agent label keeps the Needs you pill visible at 50 columns', async () => {
  const blocked = agent({
    state: 'running',
    tool: { ...spawn, agent: 'a-very-long-custom-agent-name-for-review' },
    children: [permission({ id: 'pp', state: 'pending' })],
  });
  m = await mount(card(blocked, { userClosed: true }), { width: 50, height: 10 });
  const rows = m.frame().split(/\r?\n/);
  expect(rows.some((r) => r.includes('Needs you'))).toBe(true);
  expect(rows.every((r) => r.trimEnd().length <= 50)).toBe(true);
});
