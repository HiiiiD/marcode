import { afterEach, expect, test } from 'bun:test';
import { App } from '../../tui/ui/app';
import { snapshot, summary } from '../fixtures/protocol';
import { hydrateMsg, mount, type Mounted } from './harness';
import { hydrateTwo, lastOf } from './pane-fixtures';

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
