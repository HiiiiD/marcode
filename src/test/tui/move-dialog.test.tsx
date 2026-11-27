import { afterEach, expect, test } from 'bun:test';
import type { MovePanel } from '../../protocol/messages';
import { MoveDialog } from '../../tui/ui/move-dialog';
import { summary } from '../fixtures/protocol';
import { hydrateMsg, mount, type Mounted } from './harness';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });

const remote = { deviceId: 'd1', deviceName: 'PC-desk', online: true, lastSeenAt: 1, relCwd: '.' };
const panel: MovePanel = {
  id: 'r', mode: 'move', checkouts: [
    { root: '/w/repo', branch: 'main', main: true },
    { root: '/w/repo/.worktrees/feat-x', branch: 'feat/x', main: false },
  ], defaultRoot: '/w/repo', branch: 'main', thread: 'restored', ownerName: 'PC-desk', lastSeenAt: 1,
};

async function open(opts: { onClose?: () => void; onDone?: (id: string) => void } = {}) {
  m = await mount(<MoveDialog sessionId="r" onClose={opts.onClose ?? (() => {})} onDone={opts.onDone ?? (() => {})} />);
  await m.fromHost(hydrateMsg({ sessions: [summary('r', { name: 'fixer', remote })] }));
  await m.fromHost({ t: 'move-panel', panel });
}

test('asks for the panel and lists the checkouts with the thread line', async () => {
  await open();
  expect(m!.posted.filter((p) => p.t === 'request-move-panel')).toEqual([{ t: 'request-move-panel', id: 'r' }]);
  const frame = m!.frame();
  expect(frame).toContain('Move "fixer" here');
  expect(frame).toContain('repo · main');
  expect(frame).toContain('feat-x · feat/x');
  expect(frame).toContain('The agent thread comes along.');
});

test('down then enter moves into the second checkout', async () => {
  await open();
  await m!.pressMany(['down', 'return']);
  expect(m!.posted.filter((p) => p.t === 'move-session')).toEqual([{ t: 'move-session', id: 'r', target: { root: '/w/repo/.worktrees/feat-x' }, cancelTurn: false }]);
});

test('progress shows, and done hands the session back to focus', async () => {
  const done: string[] = [];
  await open({ onDone: (id) => { done.push(id); } });
  await m!.fromHost({ t: 'move-status', id: 'r', status: { state: 'waiting', step: 'claim' } });
  expect(m!.frame()).toContain('Claiming the session…');
  await m!.fromHost({ t: 'move-status', id: 'r', status: { state: 'done', sessionId: 'r', thread: 'restored' } });
  expect(done).toEqual(['r']);
});
