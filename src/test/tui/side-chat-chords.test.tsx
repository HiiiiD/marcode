import { afterEach, expect, test } from 'bun:test';
import { App } from '../../tui/ui/app';
import { snapshot, summary } from '../fixtures/protocol';
import { hydrateMsg, mount, type Mounted } from './harness';
import { leaf, lastOf } from './pane-fixtures';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });
const props = { launchCwd: '/repo', forceNew: false, loginCommands: {}, onQuit: () => {} };

const sideOver = { kind: 'side' as const, parentId: 's1', permissionMode: 'plan' as const, name: 'side' };

async function mountWithSide(parentStatus: 'idle' | 'running' = 'idle', sideOverrides = {}) {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateMsg({
    sessions: [summary('s1', { name: 'one', status: parentStatus })],
    layout: {
      root: { kind: 'split', orientation: 'horizontal', size: 100, children: [leaf('s1'), leaf('side1')] },
      presets: [], focusedSessionId: 'side1',
    },
    snapshots: [snapshot('s1', { status: parentStatus }), snapshot('side1', { ...sideOver, ...sideOverrides })],
  }));
  await chord('l');
}

async function chord(key: string) { await m!.press('w', { ctrl: true }); await m!.press(key); }
const sideMessages = () => m!.posted.filter((p) => ['merge-side-chat', 'promote-side-chat', 'close-side-chat', 'focus-session'].includes(p.t));

test('a side chat pane shows its label and what each chord does', async () => {
  await mountWithSide();
  const frame = m!.frame();
  expect(frame).toContain('Side chat');
  expect(frame).toContain('^W b bring back');
  expect(frame).not.toContain('Can edit files');
});

test('the warning appears once the side chat can edit', async () => {
  await mountWithSide('idle', { permissionMode: 'acceptEdits' });
  expect(m!.frame()).toContain('Can edit files');
});

test('Ctrl+W b brings the focused side chat back', async () => {
  await mountWithSide();
  await chord('b');
  expect(sideMessages()).toEqual([{ t: 'merge-side-chat', id: 'side1' }]);
});

test('Ctrl+W b is ignored while the main chat is working', async () => {
  await mountWithSide('running');
  await chord('b');
  expect(sideMessages()).toEqual([]);
});

test('Ctrl+W p promotes it and Ctrl+W x closes it instead of hiding the pane', async () => {
  await mountWithSide();
  await chord('p');
  await chord('x');
  expect(sideMessages()).toEqual([{ t: 'promote-side-chat', id: 'side1' }, { t: 'close-side-chat', id: 'side1' }]);
  expect(lastOf(m!.posted, 'set-layout')).toBeUndefined();
});

test('on an ordinary pane b and p do nothing and x still hides the pane', async () => {
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateMsg());
  await chord('b');
  await chord('p');
  expect(sideMessages()).toEqual([]);
});

test('forking from inside a side chat is refused with a hint until it is promoted', async () => {
  await mountWithSide('idle', { items: [{ id: 'u1', ts: 1, role: 'user', text: 'why?' }] });
  await m!.press('tab');
  await m!.press('f');
  expect(m!.posted.filter((p) => p.t === 'fork-session').length).toBe(0);
  expect(m!.frame()).toContain('Promote this side chat before forking it');
});
