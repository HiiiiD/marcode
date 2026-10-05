import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { App } from '../../tui/ui/app';
import { layoutOf, snapshot, summary } from '../fixtures/protocol';
import { hydrateMsg, mount, type Mounted } from './harness';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });

const props = { launchCwd: '/repo', forceNew: false, loginCommands: {}, onQuit: () => {} };
const settleEscape = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 100)); }); await m!.setup.renderOnce(); };
const size = { width: 120, height: 50 };
const three = () => hydrateMsg({
  sessions: ['s1', 's2', 's3'].map((id) => summary(id)),
  snapshots: ['s1', 's2', 's3'].map((id) => snapshot(id)),
  layout: layoutOf(['s1', 's2', 's3']),
});
const setLayouts = () => m!.posted.filter((p) => p.t === 'set-layout');
const leafIds = (root: unknown): string[] => {
  const n = root as { kind: string; sessionId?: string | null; children?: unknown[] };
  return n.kind === 'leaf' ? (n.sessionId ? [n.sessionId] : []) : (n.children ?? []).flatMap(leafIds);
};
const openByChord = async () => {
  await m!.press('w', { ctrl: true });
  await m!.press('g');
};

test('Ctrl+W g opens the layout dialog', async () => {
  m = await mount(<App {...props} />, size);
  await m.fromHost(three());
  await openByChord();
  expect(m.frame()).toContain('Built-in');
});

test('/layout typed in the composer opens it and sends nothing', async () => {
  m = await mount(<App {...props} />, size);
  await m.fromHost(three());
  await m.type('/layout');
  await m.press('return');
  expect(m.frame()).toContain('Built-in');
  expect(m.posted.some((p) => p.t === 'send')).toBe(false);
});

test('the chord works with no sessions and no focused pane', async () => {
  m = await mount(<App {...props} />, size);
  await m.fromHost(hydrateMsg({ sessions: [], snapshots: [], layout: { root: { kind: 'leaf', sessionId: null, size: 100 }, presets: [] } }));
  await openByChord();
  expect(m.frame()).toContain('Built-in');
});

test('applying a built-in posts set-layout with the new shape and closes the dialog', async () => {
  m = await mount(<App {...props} />, size);
  await m.fromHost(three());
  await openByChord();
  await m.pressMany(['down', 'down', 'down', 'down', 'return']);
  const posted = setLayouts().at(-1);
  const shape = posted?.t === 'set-layout' ? posted.layout.root : undefined;
  expect(shape?.kind === 'split' ? shape.children.length : 0).toBe(3);
  expect(m.frame().includes('Built-in')).toBe(false);
});

test('overflow hides the extra session from the layout without re-placing it', async () => {
  m = await mount(<App {...props} />, size);
  await m.fromHost(three());
  await openByChord();
  await m.pressMany(['down', 'down', 'return']);
  expect(m.frame()).toContain('1 session will be hidden');
  await m.press('return');
  const posted = setLayouts().at(-1);
  const placed = posted?.t === 'set-layout' ? leafIds(posted.layout.root) : [];
  expect(placed).toEqual(['s1', 's2']);
  await m.fromHost();
  const after = setLayouts().at(-1);
  const stillPlaced = after?.t === 'set-layout' ? leafIds(after.layout.root) : [];
  expect(stillPlaced).toEqual(['s1', 's2']);
});

test('while open, other keys are inert: chords, Ctrl+B, Ctrl+N and Ctrl+C do nothing', async () => {
  m = await mount(<App {...props} onQuit={() => { throw new Error('quit'); }} />, size);
  await m.fromHost(three());
  await openByChord();
  const before = m.posted.length;
  await m.press('w', { ctrl: true });
  await m.press('x');
  await m.press('b', { ctrl: true });
  await m.press('n', { ctrl: true });
  await m.press('c', { ctrl: true });
  await m.press('c', { ctrl: true });
  expect(m.frame()).toContain('Built-in');
  expect(m.frame().includes('Press Ctrl+C again')).toBe(false);
  expect(m.frame().includes('New session')).toBe(false);
  expect(m.posted.length).toBe(before);
});

test('Esc closes the dialog without a layout write', async () => {
  m = await mount(<App {...props} />, size);
  await m.fromHost(three());
  await openByChord();
  const before = setLayouts().length;
  await m.press('escape');
  await settleEscape();
  expect(m.frame().includes('Built-in')).toBe(false);
  expect(setLayouts().length).toBe(before);
});

test('before hydrate the chord does nothing, so a layout write cannot overwrite the saved one', async () => {
  m = await mount(<App {...props} />, size);
  await openByChord();
  expect(m.frame().includes('Built-in')).toBe(false);
  await m.fromHost(three());
  expect(m.frame().includes('Built-in')).toBe(false);
  expect(setLayouts().length).toBe(0);
});
