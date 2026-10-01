import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { Roster } from '../../tui/ui/roster';
import { hydrateMsg, mount, type Mounted } from './harness';
import { snapshot, summary } from '../fixtures/protocol';

let m: Mounted | undefined;
// A lone Esc is held back until the key parser's timeout, so the wait itself runs inside act.
const settleEscape = async () => {
  await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
  await m!.setup.renderOnce();
};
afterEach(() => { m?.destroy(); m = undefined; });

const sessions = [
  summary('a', { name: 'api-fix', status: 'running' }),
  summary('b', { name: 'docs', status: 'awaiting-approval' }),
  summary('c', { name: 'shared', owner: { host: 'vscode', pid: 4812 } }),
];

test('rows show glyph, name and the foreign owner label', async () => {
  m = await mount(<Roster focused onFocusSession={() => {}} onAskDelete={() => {}} />);
  await m.fromHost(hydrateMsg({ sessions, snapshots: [snapshot('a', { name: 'api-fix' })] }));
  const f = m.frame();
  expect(f).toContain('● api-fix');
  expect(f).toContain('! docs');
  expect(f).toContain('shared');
  expect(f).toContain('vscode·4812');
});

test('j then Enter focuses the second session', async () => {
  const chosen: string[] = [];
  m = await mount(<Roster focused onFocusSession={(id) => chosen.push(id)} onAskDelete={() => {}} />);
  await m.fromHost(hydrateMsg({ sessions, snapshots: [snapshot('a')] }));
  await m.press('j');
  await m.press('return');
  expect(chosen).toEqual(['b']);
});

test('x on a row posts close-session for it', async () => {
  m = await mount(<Roster focused onFocusSession={() => {}} onAskDelete={() => {}} />);
  await m.fromHost(hydrateMsg({ sessions, snapshots: [snapshot('a')] }));
  await m.press('x');
  expect(m.posted).toContainEqual({ t: 'close-session', id: 'a' });
});

test('k clamps at the first row', async () => {
  const chosen: string[] = [];
  m = await mount(<Roster focused onFocusSession={(id) => chosen.push(id)} onAskDelete={() => {}} />);
  await m.fromHost(hydrateMsg({ sessions, snapshots: [snapshot('a')] }));
  await m.press('k');
  await m.press('return');
  expect(chosen).toEqual(['a']);
});

test('keys are ignored while the roster is not focused', async () => {
  const chosen: string[] = [];
  m = await mount(<Roster focused={false} onFocusSession={(id) => chosen.push(id)} onAskDelete={() => {}} />);
  await m.fromHost(hydrateMsg({ sessions, snapshots: [snapshot('a')] }));
  await m.press('return');
  await m.press('x');
  expect(chosen).toEqual([]);
  expect(m.posted.some((p) => p.t === 'close-session')).toBe(false);
});

test('an empty roster says so', async () => {
  m = await mount(<Roster focused onFocusSession={() => {}} onAskDelete={() => {}} />);
  await m.fromHost(hydrateMsg({ sessions: [], snapshots: [] }));
  expect(m.frame()).toContain('no sessions yet');
});

test('p posts set-pinned for the row under the cursor, toggling an already pinned one off', async () => {
  m = await mount(<Roster focused onFocusSession={() => {}} onAskDelete={() => {}} />);
  await m.fromHost(hydrateMsg({
    sessions: [summary('a', { name: 'api-fix' }), summary('b', { name: 'docs', pinned: true })],
    snapshots: [snapshot('a')],
  }));
  await m.press('p');
  expect(m.posted).toContainEqual({ t: 'set-pinned', id: 'b', pinned: false });
  await m.press('j');
  await m.press('p');
  expect(m.posted).toContainEqual({ t: 'set-pinned', id: 'a', pinned: true });
});

test('pinned rows show a star', async () => {
  m = await mount(<Roster focused onFocusSession={() => {}} onAskDelete={() => {}} />);
  await m.fromHost(hydrateMsg({ sessions: [summary('a', { name: 'api-fix', pinned: true })], snapshots: [snapshot('a')] }));
  expect(m.frame()).toContain('★ api-fix');
});

test('/ filters by title; the cursor then addresses the filtered rows; Esc clears', async () => {
  const chosen: string[] = [];
  m = await mount(<Roster focused onFocusSession={(id) => chosen.push(id)} onAskDelete={() => {}} />);
  await m.fromHost(hydrateMsg({ sessions, snapshots: [snapshot('a')] }));
  await m.press('/');
  await m.type('docs');
  expect(m.frame()).toContain('/docs');
  expect(m.frame().includes('api-fix')).toBe(false);
  await m.press('return');
  await m.press('return');
  expect(chosen).toEqual(['b']);
  await m.press('/');
  await m.press('escape');
  await settleEscape();
  expect(m.frame()).toContain('api-fix');
});

test('filter mode swallows x and p so typing never closes or pins a session', async () => {
  m = await mount(<Roster focused onFocusSession={() => {}} onAskDelete={() => {}} />);
  await m.fromHost(hydrateMsg({ sessions, snapshots: [snapshot('a')] }));
  await m.press('/');
  await m.type('xp');
  expect(m.posted.some((p) => p.t === 'close-session' || p.t === 'set-pinned')).toBe(false);
});

test('shift+d asks to delete the row under the cursor', async () => {
  const asked: { id: string; title: string }[] = [];
  m = await mount(<Roster focused onFocusSession={() => {}} onAskDelete={(r) => asked.push(r)} />);
  await m.fromHost(hydrateMsg({ sessions, snapshots: [snapshot('a')] }));
  await m.press('j');
  await m.press('d', { shift: true });
  expect(asked).toEqual([{ id: 'b', title: 'docs' }]);
});

test('the cursor follows the pinned row when pinning reorders the list', async () => {
  m = await mount(<Roster focused onFocusSession={() => {}} onAskDelete={() => {}} />);
  const four = ['a', 'b', 'c', 'd'].map((id) => summary(id, { name: id }));
  await m.fromHost(hydrateMsg({ sessions: four, snapshots: [snapshot('a')] }));
  await m.press('j');
  await m.press('j');
  await m.press('j');
  await m.press('p');
  expect(m.posted).toContainEqual({ t: 'set-pinned', id: 'd', pinned: true });
  await m.fromHost({ t: 'sessions-changed', sessions: [four[0], four[1], four[2], { ...four[3], pinned: true }] });
  await m.press('p');
  expect(m.posted).toContainEqual({ t: 'set-pinned', id: 'd', pinned: false });
});

test('a very long title and a foreign row stay inside the 26-column roster', async () => {
  m = await mount(<Roster focused onFocusSession={() => {}} onAskDelete={() => {}} />, { width: 60, height: 20 });
  await m.fromHost(hydrateMsg({
    sessions: [
      summary('a', { name: 'x'.repeat(80) }),
      summary('c', { name: 'shared', owner: { host: 'vscode', pid: 4812 } }),
    ],
    snapshots: [snapshot('a')],
  }));
  const borderRows = m.frame().split('\n').filter((l) => l.includes('│'));
  expect(borderRows.every((l) => l.trimEnd().length <= 26)).toBe(true);
  expect(m.frame()).toContain('sessions');
  expect(m.frame()).toContain('vscode·4812');
});

test('a long roster keeps the cursor row visible while moving down', async () => {
  const many = Array.from({ length: 40 }, (_, i) => summary(`n${i}`, { name: `session-${String(i).padStart(2, '0')}` }));
  // App gives the roster a bounded row; mount it the same way so the box has a height to scroll within.
  m = await mount(
    <box flexDirection="row" width="100%" height="100%" minHeight={0}>
      <Roster focused onFocusSession={() => {}} onAskDelete={() => {}} />
    </box>,
    { width: 60, height: 15 },
  );
  await m.fromHost(hydrateMsg({ sessions: many, snapshots: [snapshot('n0')] }));
  expect(m.frame()).toContain('session-00');
  for (let i = 0; i < 35; i++) { await m.press('j'); }
  expect(m.frame()).toContain('session-35');
});
