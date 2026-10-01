import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { ModelDialog } from '../../tui/ui/model-dialog';
import { hydrateMsg, mount, type Mounted } from './harness';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });
const settleEscape = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 100)); }); await m!.setup.renderOnce(); };

const setModels = () => (m?.posted ?? []).filter((p) => p.t === 'set-model');
const open = async (over: Parameters<typeof hydrateMsg>[0] = {}, onClose = () => {}) => {
  m = await mount(<ModelDialog sessionId="s1" onClose={onClose} />);
  await m.fromHost(hydrateMsg(over));
};

test('lists the provider models and marks the current one', async () => {
  await open();
  const frame = m!.frame();
  expect(frame).toContain('Model');
  expect(frame).toContain('Fake Small');
  expect(frame).toContain('Fake Medium');
  expect(frame).toContain('✓ Fake Large');
});

test('Enter on a moved row posts set-model for it and closes', async () => {
  let closed = 0;
  await open({}, () => { closed++; });
  await m!.press('down');
  await m!.press('return');
  const msg = setModels()[0];
  expect(msg?.t === 'set-model' && msg.id).toBe('s1');
  expect(msg?.t === 'set-model' && msg.model).toBe('fake-small');
  expect(closed).toBe(1);
});

test('batched down and Enter pick the moved row', async () => {
  await open();
  await m!.pressMany(['down', 'return']);
  const msg = setModels()[0];
  expect(msg?.t === 'set-model' && msg.model).toBe('fake-small');
});

test('typing filters the list and Enter picks the first match', async () => {
  await open();
  await m!.type('med');
  expect(m!.frame().includes('Fake Small')).toBe(false);
  await m!.press('return');
  const msg = setModels()[0];
  expect(msg?.t === 'set-model' && msg.model).toBe('fake-medium');
});

test('Backspace widens the filter again', async () => {
  await open();
  await m!.type('sm');
  await m!.press('backspace');
  await m!.press('backspace');
  expect(m!.frame()).toContain('Fake Medium');
});

test('favorites are listed first with a star', async () => {
  await open({ favoriteModels: ['fake fake-medium'] });
  const frame = m!.frame();
  expect(frame).toContain('★ Fake Medium');
  expect(frame.indexOf('Fake Medium') < frame.indexOf('Fake Large')).toBe(true);
});

test('Esc closes without posting', async () => {
  let closed = 0;
  await open({}, () => { closed++; });
  await m!.press('escape');
  await settleEscape();
  expect(closed).toBe(1);
  expect(setModels().length).toBe(0);
});

test('Enter with no match posts nothing', async () => {
  await open();
  await m!.type('zzz');
  await m!.press('return');
  expect(setModels().length).toBe(0);
});

test('the dialog is drawn with the termcn rounded frame', async () => {
  await open();
  expect(m!.frame()).toContain('╭');
});
