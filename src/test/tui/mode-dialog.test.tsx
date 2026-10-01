import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import type { HostToWebview, TranscriptItem } from '../../protocol/messages';
import { ModeDialog } from '../../tui/ui/mode-dialog';
import { snapshot, summary } from '../fixtures/protocol';
import { hydrateMsg, mount, type Mounted } from './harness';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });
const settleEscape = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 100)); }); await m!.setup.renderOnce(); };

const posts = (t: 'set-permission-mode' | 'set-effort') => (m?.posted ?? []).filter((p) => p.t === t);
const open = async (focus: 'modes' | 'effort', msg: HostToWebview = hydrateMsg(), onClose = () => {}) => {
  m = await mount(<ModeDialog sessionId="s1" focus={focus} onClose={onClose} />);
  await m.fromHost(msg);
};
const started: TranscriptItem[] = [{ id: 'u1', ts: 1, role: 'user', text: 'hello' }];
const withSession = (sum: Parameters<typeof summary>[1], items: TranscriptItem[] = []) =>
  hydrateMsg({ sessions: [summary('s1', sum)], snapshots: [snapshot('s1', { ...sum, items })] });

test('lists the modes with their descriptions and the current effort level', async () => {
  await open('modes');
  const frame = m!.frame();
  expect(frame).toContain('Permission mode');
  expect(frame).toContain('✓ Ask');
  expect(frame).toContain('Approve every tool call before it runs.');
  expect(frame).toContain('Effort');
  expect(frame).toContain('medium');
});

test('Enter on another mode posts set-permission-mode for it and closes', async () => {
  let closed = 0;
  await open('modes', undefined, () => { closed++; });
  await m!.pressMany(['down', 'down', 'down', 'return']);
  const msg = posts('set-permission-mode')[0];
  expect(msg?.t === 'set-permission-mode' && msg.mode).toBe('plan');
  expect(closed).toBe(1);
});

test('Down past the last mode lands on the effort row; Right raises the level without closing', async () => {
  let closed = 0;
  await open('modes', undefined, () => { closed++; });
  for (let i = 0; i < 6; i++) { await m!.press('down'); }
  await m!.press('right');
  const msg = posts('set-effort')[0];
  expect(msg?.t === 'set-effort' && msg.effort).toBe('high');
  expect(closed).toBe(0);
});

test('opening on the effort row: Right and Left step through the levels and stop at the ends', async () => {
  await open('effort');
  await m!.press('right');
  await m!.press('right');
  await m!.press('left');
  await m!.press('left');
  await m!.press('left');
  const levels = posts('set-effort').map((p) => (p.t === 'set-effort' ? p.effort : ''));
  expect(levels).toEqual(['high', 'medium', 'low']);
});

test('Enter on the effort row closes without posting', async () => {
  let closed = 0;
  await open('effort', undefined, () => { closed++; });
  await m!.press('return');
  expect(closed).toBe(1);
  expect(posts('set-effort').length).toBe(0);
});

test('a model without effort levels shows no effort row', async () => {
  await open('modes', withSession({ model: 'fake-small' }));
  expect(m!.frame().includes('Effort')).toBe(false);
});

test('opening on effort for a model without levels says so and still lets Esc close', async () => {
  let closed = 0;
  await open('effort', withSession({ model: 'fake-small' }), () => { closed++; });
  expect(m!.frame()).toContain('no effort levels');
  await m!.press('escape');
  await settleEscape();
  expect(closed).toBe(1);
});

test('bypass is greyed with its reason once the session has started and cannot be chosen', async () => {
  await open('modes', withSession({}, started));
  expect(m!.frame()).toContain('only be chosen before the first message');
  for (let i = 0; i < 5; i++) { await m!.press('down'); }
  await m!.press('return');
  expect(posts('set-permission-mode').length).toBe(0);
});

test('bypass can be chosen before the first message', async () => {
  await open('modes');
  for (let i = 0; i < 5; i++) { await m!.press('down'); }
  await m!.press('return');
  const msg = posts('set-permission-mode')[0];
  expect(msg?.t === 'set-permission-mode' && msg.mode).toBe('bypass');
});

test('Esc closes without posting', async () => {
  let closed = 0;
  await open('modes', undefined, () => { closed++; });
  await m!.press('escape');
  await settleEscape();
  expect(closed).toBe(1);
  expect(posts('set-permission-mode').length).toBe(0);
});
