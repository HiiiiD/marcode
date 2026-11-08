import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import type { ChildRef } from '../../protocol/messages';
import { ChildrenDialog } from '../../tui/ui/children-dialog';
import { snapshot, summary } from '../fixtures/protocol';
import { hydrateMsg, mount, type Mounted } from './harness';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });
const settleEscape = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 100)); }); await m!.setup.renderOnce(); };

const CHILDREN: ChildRef[] = [
  { id: 'f1', title: 'Fork of plan', origin: 'fork', hidden: false, status: 'idle' },
  { id: 'sd1', title: 'Side: why?', origin: 'side', hidden: true, status: 'idle' },
];
const focuses = () => m!.posted.filter((p) => p.t === 'focus-session');

async function open(onClose = () => {}) {
  m = await mount(<ChildrenDialog sessionId="s1" onClose={onClose} />);
  await m.fromHost(hydrateMsg({
    sessions: [summary('s1', { children: CHILDREN, parentId: 'root' }), summary('root', { title: 'Root chat' })],
    snapshots: [snapshot('s1', { children: CHILDREN, parentId: 'root' })],
  }));
}

test('lists the parent and each branch', async () => {
  await open();
  const frame = m!.frame();
  expect(frame).toContain('Branched from Root chat');
  expect(frame).toContain('Fork · Fork of plan');
  expect(frame).toContain('Side chat · Side: why?');
});

test('Enter opens the highlighted branch and closes', async () => {
  let closed = 0;
  await open(() => { closed++; });
  await m!.pressMany(['down', 'return']);
  expect(focuses()).toEqual([{ t: 'focus-session', id: 'f1' }]);
  expect(closed).toBe(1);
});

test('Esc closes without opening anything', async () => {
  let closed = 0;
  await open(() => { closed++; });
  await m!.press('escape');
  await settleEscape();
  expect(focuses()).toEqual([]);
  expect(closed).toBe(1);
});
