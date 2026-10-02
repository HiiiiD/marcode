import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { App } from '../../tui/ui/app';
import { relocation, snapshot, summary } from '../fixtures/protocol';
import { hydrateMsg, mount, type Mounted } from './harness';
import { twoUp } from './pane-fixtures';
import type { TranscriptItem } from '../../protocol/messages';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });
const props = { launchCwd: '/repo', forceNew: false, loginCommands: {}, onQuit: () => {} };
const answers = () => (m?.posted ?? []).filter((p) => p.t === 'answer-relocation' || p.t === 'cancel-relocation');

const boot = async (items: TranscriptItem[], over: Parameters<typeof summary>[1] = {}) => {
  const s = summary('s1', over);
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateMsg({ sessions: [s], snapshots: [snapshot('s1', { ...s, items })] }));
};

test('Ctrl+Y answers move=true for the pending offer in the focused session', async () => {
  await boot([relocation({ id: 'r1' })]);
  await m!.press('y', { ctrl: true });
  expect(answers()).toEqual([{ t: 'answer-relocation', id: 's1', itemId: 'r1', move: true }]);
});

test('Ctrl+L answers move=false', async () => {
  await boot([relocation({ id: 'r1' })]);
  await m!.press('l', { ctrl: true });
  expect(answers()).toEqual([{ t: 'answer-relocation', id: 's1', itemId: 'r1', move: false }]);
});

test('a double press posts once', async () => {
  await boot([relocation({ id: 'r1' })]);
  await m!.press('y', { ctrl: true });
  await m!.press('y', { ctrl: true });
  expect(answers().length).toBe(1);
});

test('queued: Ctrl+L cancels, Ctrl+Y does nothing, and a return to pending re-arms the keys', async () => {
  await boot([relocation({ id: 'r1', state: 'queued' })]);
  await m!.press('y', { ctrl: true });
  expect(answers().length).toBe(0);
  await m!.press('l', { ctrl: true });
  expect(answers()).toEqual([{ t: 'cancel-relocation', id: 's1', itemId: 'r1' }]);
  await m!.fromHost({ t: 'session-patch', id: 's1', patch: { op: 'replace', item: relocation({ id: 'r1', state: 'pending' }) } });
  await m!.press('y', { ctrl: true });
  expect(answers().length).toBe(2);
  expect(answers()[1]).toEqual({ t: 'answer-relocation', id: 's1', itemId: 'r1', move: true });
});

test('no open offer, or a settled one, posts nothing', async () => {
  await boot([relocation({ id: 'r1', state: 'moved' })]);
  await m!.press('y', { ctrl: true });
  await m!.press('l', { ctrl: true });
  expect(answers().length).toBe(0);
});

test('a foreign session cannot be answered from here', async () => {
  await boot([relocation({ id: 'r1' })], { owner: { host: 'vscode', pid: 9 } });
  await m!.press('y', { ctrl: true });
  expect(answers().length).toBe(0);
});

test('with two visible panes only the focused one is addressed, and its card is the one with keys', async () => {
  const a = summary('s1');
  const b = summary('s2');
  m = await mount(<App {...props} />, { width: 140, height: 40 });
  await m.fromHost(hydrateMsg({
    sessions: [a, b],
    layout: { root: twoUp(), presets: [], focusedSessionId: 's1' },
    snapshots: [
      snapshot('s1', { ...a, items: [relocation({ id: 'ra', path: '/repo/trees/for-a' })] }),
      snapshot('s2', { ...b, items: [relocation({ id: 'rb', path: '/repo/trees/for-b' })] }),
    ],
  }));
  expect(m.frame().split('^Y move').length - 1).toBe(1);
  expect(m.frame()).toContain('focus this pane to answer');
  await m.press('y', { ctrl: true });
  expect(answers()).toEqual([{ t: 'answer-relocation', id: 's1', itemId: 'ra', move: true }]);
});

test('the keys are inert while a dialog owns the keyboard', async () => {
  await boot([relocation({ id: 'r1' })]);
  await m!.press('p', { ctrl: true });
  await m!.press('y', { ctrl: true });
  expect(answers().length).toBe(0);
});

test('a offer that comes back to pending after a hide and re-show can be answered again', async () => {
  await boot([relocation({ id: 'r1' })]);
  await m!.press('y', { ctrl: true });
  await m!.fromHost({ t: 'session-patch', id: 's1', patch: { op: 'replace', item: relocation({ id: 'r1', state: 'queued' }) } });
  await m!.fromHost({ t: 'session-patch', id: 's1', patch: { op: 'replace', item: relocation({ id: 'r1', state: 'pending' }) } });
  await m!.press('y', { ctrl: true });
  expect(answers().length).toBe(2);
});

test('the same offer id in another session is answered separately (a fork copies it)', async () => {
  const a = summary('s1', { name: 'one' });
  const b = summary('s2', { name: 'two' });
  m = await mount(<App {...props} />, { width: 140, height: 40 });
  await m.fromHost(hydrateMsg({
    sessions: [a, b],
    layout: { root: twoUp(), presets: [], focusedSessionId: 's1' },
    snapshots: [
      snapshot('s1', { ...a, items: [relocation({ id: 'r1' })] }),
      snapshot('s2', { ...b, items: [relocation({ id: 'r1' })] }),
    ],
  }));
  await m.press('y', { ctrl: true });
  await act(async () => { await m!.setup.mockMouse.click(110, 5); });
  await m.fromHost();
  await m.press('y', { ctrl: true });
  expect(answers().map((p) => (p.t === 'answer-relocation' ? p.id : ''))).toEqual(['s1', 's2']);
});
