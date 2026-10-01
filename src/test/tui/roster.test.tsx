import { afterEach, expect, test } from 'bun:test';
import { Roster } from '../../tui/ui/roster';
import { hydrateMsg, mount, type Mounted } from './harness';
import { snapshot, summary } from '../fixtures/protocol';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });

const sessions = [
  summary('a', { name: 'api-fix', status: 'running' }),
  summary('b', { name: 'docs', status: 'awaiting-approval' }),
  summary('c', { name: 'shared', owner: { host: 'vscode', pid: 4812 } }),
];

test('rows show glyph, name and the foreign owner label', async () => {
  m = await mount(<Roster focused onFocusSession={() => {}} />);
  await m.fromHost(hydrateMsg({ sessions, snapshots: [snapshot('a', { name: 'api-fix' })] }));
  const f = m.frame();
  expect(f).toContain('● api-fix');
  expect(f).toContain('! docs');
  expect(f).toContain('shared');
  expect(f).toContain('vscode·4812');
});

test('j then Enter focuses the second session', async () => {
  const chosen: string[] = [];
  m = await mount(<Roster focused onFocusSession={(id) => chosen.push(id)} />);
  await m.fromHost(hydrateMsg({ sessions, snapshots: [snapshot('a')] }));
  await m.press('j');
  await m.press('return');
  expect(chosen).toEqual(['b']);
});

test('x on a row posts close-session for it', async () => {
  m = await mount(<Roster focused onFocusSession={() => {}} />);
  await m.fromHost(hydrateMsg({ sessions, snapshots: [snapshot('a')] }));
  await m.press('x');
  expect(m.posted).toContainEqual({ t: 'close-session', id: 'a' });
});

test('k clamps at the first row', async () => {
  const chosen: string[] = [];
  m = await mount(<Roster focused onFocusSession={(id) => chosen.push(id)} />);
  await m.fromHost(hydrateMsg({ sessions, snapshots: [snapshot('a')] }));
  await m.press('k');
  await m.press('return');
  expect(chosen).toEqual(['a']);
});

test('keys are ignored while the roster is not focused', async () => {
  const chosen: string[] = [];
  m = await mount(<Roster focused={false} onFocusSession={(id) => chosen.push(id)} />);
  await m.fromHost(hydrateMsg({ sessions, snapshots: [snapshot('a')] }));
  await m.press('return');
  await m.press('x');
  expect(chosen).toEqual([]);
  expect(m.posted.some((p) => p.t === 'close-session')).toBe(false);
});

test('an empty roster says so', async () => {
  m = await mount(<Roster focused onFocusSession={() => {}} />);
  await m.fromHost(hydrateMsg({ sessions: [], snapshots: [] }));
  expect(m.frame()).toContain('no sessions yet');
});
