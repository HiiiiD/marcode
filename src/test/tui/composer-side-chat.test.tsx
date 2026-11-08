import { afterEach, expect, test } from 'bun:test';
import { Composer } from '../../tui/ui/composer';
import { hydrateMsg, mount, type Mounted } from './harness';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });

const sideChats = () => m!.posted.filter((p) => p.t === 'start-side-chat');
const sends = () => m!.posted.filter((p) => p.t === 'send');

test('/side posts start-side-chat with the question and sends nothing to the agent', async () => {
  m = await mount(<Composer sessionId="s1" focused />);
  await m.fromHost(hydrateMsg());
  await m.type('/side why a clamp?');
  await m.press('return');
  expect(sideChats()).toEqual([{ t: 'start-side-chat', id: 's1', text: 'why a clamp?' }]);
  expect(sends().length).toBe(0);
  expect(m.frame()).not.toContain('why a clamp?');
});

test('the bare /btw starts an empty side chat', async () => {
  m = await mount(<Composer sessionId="s1" focused />);
  await m.fromHost(hydrateMsg());
  await m.type('/btw');
  await m.press('return');
  expect(sideChats()).toEqual([{ t: 'start-side-chat', id: 's1' }]);
});

test('a message that merely mentions /side goes to the agent', async () => {
  m = await mount(<Composer sessionId="s1" focused />);
  await m.fromHost(hydrateMsg());
  await m.type('use /side later');
  await m.press('return');
  expect(sends()).toEqual([{ t: 'send', id: 's1', text: 'use /side later' }]);
  expect(sideChats().length).toBe(0);
});
