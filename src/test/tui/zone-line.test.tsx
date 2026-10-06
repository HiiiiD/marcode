import { afterEach, expect, test } from 'bun:test';
import { mountBooted } from './e2e-harness';

let m: Awaited<ReturnType<typeof mountBooted>> | undefined;
afterEach(async () => { await m?.destroy(); m = undefined; });

test('the bottom line names the zone and follows Tab through composer, transcript and roster', async () => {
  m = await mountBooted({ prompt: 'hello' });
  await m.waitFrame((f) => f.includes('hello'));
  await m.settle(200);
  expect(m.frame().includes('[composer]')).toBe(true);
  expect(m.frame().includes('^V image')).toBe(true);
  await m.press('tab');
  await m.settle(200);
  expect(m.frame().includes('[transcript]')).toBe(true);
  expect(m.frame().includes('j/k select')).toBe(true);
  await m.press('tab');
  await m.settle(200);
  expect(m.frame().includes('[roster]')).toBe(true);
  await m.press('tab');
  await m.settle(200);
  expect(m.frame().includes('[composer]')).toBe(true);
});

test('entering the transcript selects the newest message, so Enter-less actions have a target', async () => {
  m = await mountBooted({ prompt: 'hello' });
  await m.waitFrame((f) => f.includes('hello'));
  await m.settle(200);
  const rowColors = () => JSON.stringify(m!.spans().map((l) => l.spans.map((s) => s.fg.toString() + s.bg.toString())));
  const before = rowColors();
  await m.press('tab');
  await m.settle(200);
  expect(rowColors() === before).toBe(false);
});

test('the picker shortcuts stay on the line below', async () => {
  m = await mountBooted({ prompt: 'hello' });
  await m.waitFrame((f) => f.includes('hello'));
  await m.press('tab');
  await m.settle(200);
  expect(m.frame().includes('^P model')).toBe(true);
});
