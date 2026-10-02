import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { useTuiStore } from '../../tui/ui/store';
import { hydrateMsg, mount, type Mounted } from './harness';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });

function Probe() {
  const { state, refreshUsage } = useTuiStore();
  return <text onMouseDown={refreshUsage}>{state.usageRefreshing ? 'refreshing' : 'idle'}</text>;
}
const pulls = () => (m?.posted ?? []).filter((p) => p.t === 'refresh-usage').length;
const click = async () => { await act(async () => { await m!.setup.mockMouse.click(1, 0); }); await m!.fromHost(); };

test('refreshUsage posts once, marks refreshing, and ignores a second call until the round is done', async () => {
  m = await mount(<Probe />);
  await m.fromHost(hydrateMsg());
  await click();
  await click();
  expect(pulls()).toBe(1);
  expect(m.frame()).toContain('refreshing');
  await m.fromHost({ t: 'usage-refresh-done' });
  expect(m.frame()).toContain('idle');
  await click();
  expect(pulls()).toBe(2);
});

test('a hydrate clears a stuck refreshing marker', async () => {
  m = await mount(<Probe />);
  await m.fromHost(hydrateMsg());
  await click();
  await m.fromHost(hydrateMsg());
  expect(m.frame()).toContain('idle');
});
