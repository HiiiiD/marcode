import { afterEach, expect, test } from 'bun:test';
import { App } from '../../tui/ui/app';
import { snapshot, summary } from '../fixtures/protocol';
import { hydrateMsg, mount, type Mounted } from './harness';
import { lastOf } from './pane-fixtures';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });
const props = { launchCwd: '/repo', forceNew: false, loginCommands: {}, onQuit: () => {} };
const items = [{ id: 'u1', ts: 1, role: 'user' as const, text: 'first' }, { id: 'a1', ts: 2, role: 'assistant' as const, text: 'second' }];

test('f on a selected message forks it and the fork lands beside the source, focused', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateMsg({ snapshots: [snapshot('s1', { items })] }));
  await m.press('tab');
  await m.press('k');
  await m.press('f');
  const forks = m.posted.filter((p) => p.t === 'fork-session');
  expect(forks.length).toBe(1);
  expect(forks[0]?.t === 'fork-session' && forks[0].id).toBe('s1');
  expect(forks[0]?.t === 'fork-session' && forks[0].itemId).toBe('a1');
  await m.fromHost(
    { t: 'sessions-changed', sessions: [summary('s1'), summary('f1')] },
    { t: 'session-snapshot', session: snapshot('f1') },
  );
  expect(lastOf(m.posted, 'focus-pane')?.sessionId).toBe('f1');
  expect(lastOf(m.posted, 'set-layout')?.layout.root.kind).toBe('split');
});

test('forking a foreign session is refused with a notice and posts nothing', async () => {
  const owner = { host: 'vscode' as const, pid: 7 };
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateMsg({
    sessions: [summary('s1', { owner })],
    snapshots: [snapshot('s1', { owner, items })],
  }));
  await m.press('tab');
  await m.press('k');
  await m.press('f');
  expect(m.posted.filter((p) => p.t === 'fork-session').length).toBe(0);
  expect(m.frame()).toContain('owned by vscode');
});

test('f with no selected row does nothing', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateMsg({ snapshots: [snapshot('s1', { items })] }));
  await m.press('tab');
  await m.press('f');
  expect(m.posted.filter((p) => p.t === 'fork-session').length).toBe(0);
});

test('H on a roster row opens the dialog with the handoff on, and the seed line posts a handoff create-session', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateMsg({ sessions: [summary('s1', { name: 'one' })] }));
  await m.press('tab');
  await m.press('tab');
  await m.press('h', { shift: true });
  expect(m.frame()).toContain('[x] Hand off from one');
  await m.press('return');
  await m.press('return');
  await m.type('continue the work');
  await m.press('return');
  const creates = m.posted.filter((p) => p.t === 'create-session');
  expect(creates.length).toBe(1);
  const c = creates[0];
  expect(c?.t === 'create-session' && c.seed?.handoffFrom).toBe('s1');
  expect(c?.t === 'create-session' && c.seed?.text).toBe('continue the work');
});

test('Ctrl+N has the handoff off by default, so no seed is sent', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateMsg({ sessions: [summary('s1', { name: 'one' })] }));
  await m.press('n', { ctrl: true });
  expect(m.frame()).toContain('[ ] Hand off from one');
  await m.press('return');
  await m.press('return');
  const c = m.posted.find((p) => p.t === 'create-session');
  expect(c?.t === 'create-session' && c.seed === undefined).toBe(true);
});

test('Ctrl+N then h turns the handoff on for the focused session', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateMsg({ sessions: [summary('s1', { name: 'one' })] }));
  await m.press('n', { ctrl: true });
  await m.press('h');
  expect(m.frame()).toContain('[x] Hand off from one');
});

test('with no focused session the handoff toggle is unavailable', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateMsg({ sessions: [], snapshots: [], layout: { root: { kind: 'leaf', sessionId: null, size: 100 }, presets: [] } }));
  await m.press('n', { ctrl: true });
  await m.press('h');
  expect(m.frame()).not.toContain('Hand off from');
});

test('Esc in the seed line cancels without creating', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateMsg({ sessions: [summary('s1', { name: 'one' })] }));
  await m.press('n', { ctrl: true });
  await m.press('h');
  await m.press('return');
  await m.press('return');
  await m.type('abc');
  await m.press('escape');
  await new Promise((r) => setTimeout(r, 100));
  await m.setup.renderOnce();
  expect(m.posted.filter((p) => p.t === 'create-session').length).toBe(0);
  expect(m.frame().includes('New session')).toBe(false);
});

test('the status line says a source is being summarized until the phase is done', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateMsg({ sessions: [summary('s1', { name: 'one' })] }));
  await m.fromHost({ t: 'handoff-progress', sessionId: 's1', phase: 'summarizing' });
  expect(m.frame()).toContain('Summarizing one');
  await m.fromHost({ t: 'handoff-progress', sessionId: 's1', phase: 'done' });
  expect(m.frame().includes('Summarizing')).toBe(false);
});
