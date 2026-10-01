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
