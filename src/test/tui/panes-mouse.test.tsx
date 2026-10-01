import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { App } from '../../tui/ui/app';
import { snapshot, summary, tool } from '../fixtures/protocol';
import { hydrateMsg, mount, type Mounted } from './harness';
import { hydrateTwo, lastOf } from './pane-fixtures';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });
const props = { launchCwd: '/repo', forceNew: false, loginCommands: {}, onQuit: () => {} };
const mouse = async (fn: (mm: Mounted['setup']['mockMouse']) => Promise<void>) => {
  await act(async () => { await fn(m!.setup.mockMouse); });
  await m!.fromHost();
};

test('clicking an unfocused pane focuses it', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateTwo());
  await mouse((mm) => mm.click(110, 5));
  expect(lastOf(m.posted, 'focus-pane')?.sessionId).toBe('s2');
});

test('dragging a divider posts exactly one set-layout with the new sizes', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateTwo());
  const before = m.posted.filter((p) => p.t === 'set-layout').length;
  await mouse((mm) => mm.drag(82, 10, 60, 10));
  expect(m.posted.filter((p) => p.t === 'set-layout').length).toBe(before + 1);
  const root = lastOf(m.posted, 'set-layout')?.layout.root;
  expect(root?.kind === 'split' && root.children[0].size < 50).toBe(true);
});

test('a drag past the pane clamps to the minimum share', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateTwo());
  await mouse((mm) => mm.drag(82, 10, 30, 10));
  const root = lastOf(m.posted, 'set-layout')?.layout.root;
  expect(root?.kind === 'split' && root.children[0].size >= 8).toBe(true);
});

test('a click on a divider without moving posts no layout', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateTwo());
  const before = m.posted.filter((p) => p.t === 'set-layout').length;
  await mouse((mm) => mm.click(82, 10));
  expect(m.posted.filter((p) => p.t === 'set-layout').length).toBe(before);
});

test('clicking the title ✕ hides that pane', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateTwo());
  const line = m.frame().split('\n')[1] ?? '';
  const x = line.indexOf('✕');
  expect(x).toBeGreaterThan(0);
  await mouse((mm) => mm.click(x, 1));
  expect(lastOf(m.posted, 'set-visible')?.sessionIds.length).toBe(1);
});

test('clicking a roster row places or focuses that session', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateMsg({ sessions: [summary('s1', { name: 'one' }), summary('s2', { name: 'two' })] }));
  const y = m.frame().split('\n').findIndex((l) => l.includes('two'));
  await mouse((mm) => mm.click(5, y));
  expect(lastOf(m.posted, 'set-visible')?.sessionIds.includes('s2')).toBe(true);
});

test('clicking a tool card expands it', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateMsg({
    snapshots: [snapshot('s1', { items: [tool({ output: { kind: 'text', text: 'the full output text' } })] })],
  }));
  await new Promise((r) => setTimeout(r, 20));
  await m.fromHost();
  expect(m.frame()).not.toContain('the full output text');
  const y = m.frame().split('\n').findIndex((l) => l.includes('Bash'));
  expect(y).toBeGreaterThan(-1);
  await mouse((mm) => mm.click(40, y));
  expect(m.frame()).toContain('the full output text');
});

test('a click elsewhere after an abandoned drag does not commit it', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateTwo());
  const before = m.posted.filter((p) => p.t === 'set-layout').length;
  await mouse(async (mm) => { await mm.pressDown(82, 10); await mm.moveTo(70, 10); });
  await mouse((mm) => mm.click(100, 5));
  expect(m.posted.filter((p) => p.t === 'set-layout').length).toBe(before);
});
