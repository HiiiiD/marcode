import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { makeTmp, mountBooted } from './e2e-harness';

const tmps: string[] = [];
afterEach(async () => { for (const t of tmps.splice(0)) { await fs.rm(t, { recursive: true, force: true }); } });
const entries = [{ name: 'review', description: 'Review code' }, { name: 'simplify', description: 'Simplify' }];

test('a restored "/" draft does not open the skill popup, so Tab still moves focus', async () => {
  const tmp = await makeTmp();
  tmps.push(tmp);
  const opts = { home: `${tmp}/home`, cwd: tmp };
  const first = await mountBooted({ ...opts, prompt: 'hello' });
  await first.waitFrame((f) => f.includes('hello'));
  await first.type('/');
  await first.settle(700);
  await first.destroy();

  const again = await mountBooted(opts);
  try {
    await again.settle(600);
    const id = again.booted.host.manager.visibleIds()[0];
    again.booted.loopback.deliver({ t: 'session-invocables', id, entries });
    await again.settle(400);
    expect(again.frame().includes('Review code')).toBe(false);
    await again.press('tab');
    await again.type('j');
    await again.settle(300);
    expect(again.frame().includes('/review')).toBe(false);
  } finally {
    await again.destroy();
  }
});

test('typing "/" afresh still opens the popup', async () => {
  const m = await mountBooted({ prompt: 'hello' });
  try {
    await m.waitFrame((f) => f.includes('hello'));
    const id = m.booted.host.manager.visibleIds()[0];
    m.booted.loopback.deliver({ t: 'session-invocables', id, entries });
    await m.settle(300);
    await m.type('/');
    await m.settle(300);
    expect(m.frame().includes('Review code')).toBe(true);
  } finally {
    await m.destroy();
  }
});
