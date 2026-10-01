import { afterEach, expect, setSystemTime, test } from 'bun:test';
import type { LayoutNode } from '../../client-core/layout-tree';
import { App } from '../../tui/ui/app';
import { snapshot, summary } from '../fixtures/protocol';
import { hydrateMsg, mount, type Mounted } from './harness';
import { hydrateTwo, lastOf, twoUp } from './pane-fixtures';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });
const props = { launchCwd: '/repo', forceNew: false, loginCommands: {}, onQuit: () => {} };

test('launch restores a two-pane layout and posts both leaves as the visible set', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateTwo());
  expect(lastOf(m.posted, 'set-visible')?.sessionIds.join(',')).toBe('s1,s2');
});

test('a session arriving by snapshot with no leaf (a spawn) is placed in a pane and not focused', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateMsg());
  await m.fromHost(
    { t: 'sessions-changed', sessions: [summary('s1'), summary('sp1', { name: 'spawned' })] },
    { t: 'session-snapshot', session: snapshot('sp1') },
  );
  expect(JSON.stringify(lastOf(m.posted, 'set-layout')?.layout.root).includes('"sp1"')).toBe(true);
  expect(lastOf(m.posted, 'set-visible')?.sessionIds.includes('sp1')).toBe(true);
  expect(m.posted.filter((p) => p.t === 'focus-pane' && p.sessionId === 'sp1').length).toBe(0);
});

test('roster Enter on an unshown session places it', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateMsg({ sessions: [summary('s1', { name: 'one' }), summary('s2', { name: 'two' })] }));
  await m.press('tab');
  await m.press('tab');
  await m.press('j');
  await m.press('return');
  expect(JSON.stringify(lastOf(m.posted, 'set-layout')?.layout.root).includes('"s2"')).toBe(true);
  expect(lastOf(m.posted, 'set-visible')?.sessionIds.join(',')).toBe('s1,s2');
});

test('when the focused session is deleted, focus falls to a remaining leaf', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateTwo());
  await m.fromHost({ t: 'sessions-changed', sessions: [summary('s2', { name: 'two' })] });
  expect(lastOf(m.posted, 'focus-pane')?.sessionId).toBe('s2');
});

test('a session whose snapshot arrives again after it was hidden is not re-placed', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateMsg({ sessions: [summary('s1'), summary('s2')] }));
  await m.fromHost({ t: 'session-snapshot', session: snapshot('s2') });
  const afterFirst = m.posted.filter((p) => p.t === 'set-layout').length;
  await m.fromHost({ t: 'layout-changed', layout: { root: { kind: 'leaf', sessionId: 's1', size: 100 }, presets: [] } });
  await m.fromHost({ t: 'session-snapshot', session: snapshot('s2') });
  expect(m.posted.filter((p) => p.t === 'set-layout').length).toBe(afterFirst);
});

test('two panes each render their own transcript', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateMsg({
    sessions: [summary('s1', { name: 'one' }), summary('s2', { name: 'two' })],
    layout: { root: twoUp(), presets: [], focusedSessionId: 's1' },
    snapshots: [
      snapshot('s1', { items: [{ id: 'u1', ts: 1, role: 'user', text: 'alpha message' }] }),
      snapshot('s2', { items: [{ id: 'u2', ts: 1, role: 'user', text: 'beta message' }] }),
    ],
  }));
  await new Promise((r) => setTimeout(r, 30));
  await m.fromHost();
  const f = m.frame();
  expect(f).toContain('alpha message');
  expect(f).toContain('beta message');
});

test('only the focused pane takes composer input', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateTwo());
  await m.type('hi');
  await m.press('return');
  const sends = m.posted.filter((p) => p.t === 'send');
  expect(sends.length).toBe(1);
  expect(sends[0]?.t === 'send' && sends[0].id).toBe('s1');
});

test('a pending approval in an unfocused pane is shown but does not answer', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateMsg({
    sessions: [summary('s1'), summary('s2', { status: 'awaiting-approval' })],
    layout: { root: twoUp(), presets: [], focusedSessionId: 's1' },
    snapshots: [snapshot('s1'), snapshot('s2', { pending: [{ requestId: 'r1', tool: { kind: 'command', label: 'Bash', command: 'rm x' } }] })],
  }));
  await m.press('y');
  expect(m.posted.filter((p) => p.t === 'permission-decision').length).toBe(0);
  expect(m.frame()).toContain('[y] allow');
});

test('a terminal too narrow for the tree maximizes the focused pane and keeps it usable', async () => {
  m = await mount(<App {...props} />, { width: 70, height: 30 });
  await m.fromHost(hydrateTwo());
  expect(m.frame().split('\n').every((line) => line.length <= 70)).toBe(true);
  await m.type('hi');
  await m.press('return');
  expect(m.posted.filter((p) => p.t === 'send').length).toBe(1);
});

test('a foreign session in a pane is read-only', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateMsg({
    sessions: [summary('s1', { owner: { host: 'vscode', pid: 42 } }), summary('s2')],
    layout: { root: twoUp(), presets: [], focusedSessionId: 's1' },
    snapshots: [snapshot('s1', { owner: { host: 'vscode', pid: 42 } }), snapshot('s2')],
  }));
  expect(m.frame()).toContain('vscode·42');
  await m.type('hi');
  await m.press('return');
  expect(m.posted.filter((p) => p.t === 'send').length).toBe(0);
});

test('Ctrl+W l moves focus to the pane on the right and posts focus-pane', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateTwo());
  await m.press('w', { ctrl: true });
  await m.press('l');
  expect(lastOf(m.posted, 'focus-pane')?.sessionId).toBe('s2');
});

test('a swallowed chord key never reaches the composer', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateTwo());
  await m.press('w', { ctrl: true });
  await m.press('q');
  await m.type('z');
  await m.press('return');
  const sends = m.posted.filter((p) => p.t === 'send');
  expect(sends.length).toBe(1);
  expect(sends[0]?.t === 'send' && sends[0].text).toBe('z');
});

test('Ctrl+W x hides the focused pane: one leaf left, set-visible shrinks', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateTwo());
  await m.press('w', { ctrl: true });
  await m.press('x');
  expect(lastOf(m.posted, 'set-visible')?.sessionIds.join(',')).toBe('s2');
});

test('Ctrl+W | opens the new-session dialog and the created session splits beside the focused pane', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateMsg());
  await m.press('w', { ctrl: true });
  await m.press('|');
  expect(m.frame()).toContain('New session');
  await m.press('return');
  await m.press('return');
  expect(m.posted.filter((p) => p.t === 'create-session').length).toBe(1);
  await m.fromHost(
    { t: 'sessions-changed', sessions: [summary('s1'), summary('n1')] },
    { t: 'session-snapshot', session: snapshot('n1') },
  );
  const root = lastOf(m.posted, 'set-layout')?.layout.root;
  expect(root?.kind === 'split' && root.orientation === 'horizontal' && root.children.length === 2).toBe(true);
});

test('Ctrl+W then Esc cancels, and a plain key afterwards behaves normally', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateTwo());
  await m.press('w', { ctrl: true });
  await m.press('escape');
  await new Promise((r) => setTimeout(r, 100));
  await m.type('q');
  await m.press('return');
  const send = m.posted.find((p) => p.t === 'send');
  expect(send?.t === 'send' && send.text).toBe('q');
});

test('Ctrl+W L widens the focused pane by posting one set-layout', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateTwo());
  const before = m.posted.filter((p) => p.t === 'set-layout').length;
  await m.press('w', { ctrl: true });
  await m.press('l', { shift: true });
  const layouts = m.posted.filter((p) => p.t === 'set-layout');
  expect(layouts.length).toBe(before + 1);
  const root = lastOf(m.posted, 'set-layout')?.layout.root;
  expect(root?.kind === 'split' && Math.round(root.children[0].size)).toBe(55);
});

test('Ctrl+W m maximizes the focused pane without posting a layout', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateTwo());
  const before = m.posted.filter((p) => p.t === 'set-layout').length;
  await m.press('w', { ctrl: true });
  await m.press('m');
  expect(m.posted.filter((p) => p.t === 'set-layout').length).toBe(before);
});

const fourUp = (): LayoutNode => ({
  kind: 'split', orientation: 'horizontal', size: 100,
  children: ['s1', 's2', 's3', 's4'].map((id) => ({ kind: 'leaf' as const, sessionId: id, size: 25 })),
});
const hydrateFour = () => hydrateMsg({
  sessions: ['s1', 's2', 's3', 's4'].map((id, i) => summary(id, { name: ['one', 'two', 'three', 'four'][i] })),
  layout: { root: fourUp(), presets: [], focusedSessionId: 's1' },
  snapshots: ['s1', 's2', 's3', 's4'].map((id) => snapshot(id)),
});

test('the focused pane keeps its composer even when four panes cannot fit', async () => {
  m = await mount(<App {...props} />, { width: 100, height: 30 });
  await m.fromHost(hydrateFour());
  await m.type('hi');
  await m.press('return');
  const sends = m.posted.filter((p) => p.t === 'send');
  expect(sends.length).toBe(1);
  expect(sends[0]?.t === 'send' && sends[0].id).toBe('s1');
});

test('a session with a pane but no room is marked + in the roster', async () => {
  m = await mount(<App {...props} />, { width: 110, height: 30 });
  await m.fromHost(hydrateFour());
  const row = m.frame().split('\n').find((l) => l.includes('two')) ?? '';
  expect(row.includes('+○ two')).toBe(true);
});

test('Ctrl+W x from the roster hides the pane and does not also hide the roster row', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateTwo());
  await m.press('tab');
  await m.press('tab');
  await m.press('w', { ctrl: true });
  await m.press('x');
  expect(m.posted.filter((p) => p.t === 'close-session').length).toBe(0);
  expect(lastOf(m.posted, 'set-visible')?.sessionIds.join(',')).toBe('s2');
});

test('a fork the host never answers does not leave the next spawn splitting and stealing focus', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateMsg({ snapshots: [snapshot('s1', { items: [{ id: 'u1', ts: 1, role: 'user', text: 'first' }] })] }));
  await m.press('tab');
  await m.press('k');
  await m.press('f');
  setSystemTime(new Date(Date.now() + 60_000));
  try {
    await m.fromHost(
      { t: 'sessions-changed', sessions: [summary('s1'), summary('sp1')] },
      { t: 'session-snapshot', session: snapshot('sp1') },
    );
  } finally { setSystemTime(); }
  const root = lastOf(m.posted, 'set-layout')?.layout.root;
  expect(root?.kind === 'split' && root.orientation === 'vertical').toBe(true);
  expect(m.posted.filter((p) => p.t === 'focus-pane' && p.sessionId === 'sp1').length).toBe(0);
});

test('a spawn arriving while the split dialog is open does not take the split slot', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateMsg());
  await m.press('w', { ctrl: true });
  await m.press('|');
  await m.fromHost(
    { t: 'sessions-changed', sessions: [summary('s1'), summary('sp1')] },
    { t: 'session-snapshot', session: snapshot('sp1') },
  );
  const root = lastOf(m.posted, 'set-layout')?.layout.root;
  expect(root?.kind === 'split' && root.orientation === 'vertical').toBe(true);
});
