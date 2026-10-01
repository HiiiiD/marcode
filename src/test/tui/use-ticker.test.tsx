import { afterEach, expect, test } from 'bun:test';
import type { ReactNode } from 'react';
import { mount, type Mounted } from './harness';
import { useTick, SPINNER } from '../../tui/ui/use-ticker';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });

function Probe({ active }: { active: boolean }) {
  const n = useTick(active);
  return <text>{`tick:${n % SPINNER.length}`}</text>;
}

const countIntervals = async (ui: () => ReactNode) => {
  const real = globalThis.setInterval;
  let started = 0;
  globalThis.setInterval = ((...a: Parameters<typeof setInterval>) => { started++; return real(...a); }) as typeof setInterval;
  try { m = await mount(ui()); } finally { globalThis.setInterval = real; }
  return started;
};

test('inactive probes start no interval', async () => {
  expect(await countIntervals(() => <box><Probe active={false} /><Probe active={false} /></box>)).toBe(0);
});

test('many active probes share one interval', async () => {
  expect(await countIntervals(() => <box><Probe active /><Probe active /><Probe active /></box>)).toBe(1);
});

test('the tick advances while active', async () => {
  m = await mount(<Probe active />);
  const first = m.frame();
  await new Promise((r) => setTimeout(r, 600));
  await m.fromHost();
  expect(m.frame() === first).toBe(false);
});
