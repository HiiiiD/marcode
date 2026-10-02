import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { App } from '../../tui/ui/app';
import { Roster } from '../../tui/ui/roster';
import { useTuiStore } from '../../tui/ui/store';
import { UsageStrip } from '../../tui/ui/usage-strip';
import { snapshot, summary, windows } from '../fixtures/protocol';
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

const strip = () => <UsageStrip width={24} maxLines={8} />;
const usage = (over: Record<string, ReturnType<typeof windows>> = { claude: windows() }) => hydrateMsg({ usage: over });

test('hidden entirely while nothing reports', async () => {
  m = await mount(strip());
  await m.fromHost(usage({}));
  expect(m.frame().trim()).toBe('');
});

test('a reporting provider shows its name, windows as percentages and a countdown', async () => {
  m = await mount(strip());
  await m.fromHost(usage());
  const f = m.frame();
  expect(f).toContain('5h');
  expect(f).toContain('62%');
  expect(f).toContain('7d');
  expect(f).toContain('18%');
  expect(f).toMatch(/\d+m|\dh\d\dm/);
  expect(f.includes('tokens')).toBe(false);
});

test('a provider whose windows all expired shows nothing', async () => {
  m = await mount(strip());
  await m.fromHost(usage({ claude: [{ id: 'five-hour', label: 'Session (5h)', usedPercent: 62, resetsAt: Date.now() - 1000 }] }));
  expect(m.frame().trim()).toBe('');
});

test('the display name from the host wins over the catalog name', async () => {
  m = await mount(strip());
  await m.fromHost(hydrateMsg({ usage: { claude: windows() }, usageDisplayNames: { claude: 'Claude Max' } }));
  expect(m.frame()).toContain('Claude Max');
});

test('a usage-windows push updates a row in place', async () => {
  m = await mount(strip());
  await m.fromHost(usage());
  await m.fromHost({ t: 'usage-windows', providerId: 'claude', windows: [{ id: 'five-hour', label: 'x', usedPercent: 91 }] });
  expect(m.frame()).toContain('91%');
  expect(m.frame().includes('62%')).toBe(false);
});

test('clicking the strip pulls once and shows the marker until the round is done', async () => {
  m = await mount(strip());
  await m.fromHost(usage());
  await act(async () => { await m!.setup.mockMouse.click(2, 1); });
  await m.fromHost();
  expect(pulls()).toBe(1);
  expect(m.frame()).toContain('refreshing');
  await act(async () => { await m!.setup.mockMouse.click(2, 1); });
  await m.fromHost();
  expect(pulls()).toBe(1);
  await m.fromHost({ t: 'usage-refresh-done' });
  expect(m.frame().includes('refreshing')).toBe(false);
});

test('maxLines keeps the strip from eating the list: a tiny budget cuts windows, never wraps', async () => {
  m = await mount(<UsageStrip width={24} maxLines={2} />);
  await m.fromHost(usage());
  expect(m.frame()).toContain('5h');
  expect(m.frame().includes('7d')).toBe(false);
});

test('inside the roster the strip sits under the sessions and fits 26 columns', async () => {
  m = await mount(
    <box flexDirection="row" width="100%" height="100%">
      <Roster focused onFocusSession={() => {}} onAskDelete={() => {}} onHandoff={() => {}} />
    </box>,
    { width: 26, height: 20 },
  );
  await m.fromHost(hydrateMsg({ usage: { claude: windows() }, usageDisplayNames: { claude: 'An extremely long provider display name' } }));
  const rows = m.frame().split('\n');
  expect(rows.every((r) => r.length <= 26)).toBe(true);
  expect(rows.some((r) => r.includes('62%'))).toBe(true);
  expect(m.frame()).toContain('sessions');
});

test('Ctrl+G pulls once whatever zone is focused, and not again while refreshing', async () => {
  const s = summary('s1');
  m = await mount(<App launchCwd="/repo" forceNew={false} loginCommands={{}} onQuit={() => {}} />, { width: 140, height: 30 });
  await m.fromHost(hydrateMsg({ sessions: [s], snapshots: [snapshot('s1', s)], usage: { claude: windows() } }));
  await m.press('g', { ctrl: true });
  await m.press('g', { ctrl: true });
  expect(pulls()).toBe(1);
});
