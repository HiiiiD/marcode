import { afterEach, expect, test } from 'bun:test';
import { Transcript } from '../../tui/ui/transcript/transcript';
import type { RelocationKeys } from '../../tui/ui/transcript/relocation-card';
import { relocation, snapshot, summary } from '../fixtures/protocol';
import { hydrateMsg, mount, type Mounted } from './harness';
import type { TranscriptItem } from '../../protocol/messages';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });

const show = async (items: TranscriptItem[], keys: RelocationKeys = 'live') => {
  m = await mount(<Transcript sessionId="s1" focused relocationKeys={keys} />);
  await m.fromHost(hydrateMsg({ sessions: [summary('s1')], snapshots: [snapshot('s1', { items })] }));
};

test('a pending offer names the folder, says history stays, and shows the live keys', async () => {
  await show([relocation({ path: '/repo/trees/feat-x' })]);
  const f = m!.frame();
  expect(f).toContain('feat-x');
  expect(f).toContain('Move this session there?');
  expect(f).toContain('^Y move');
  expect(f).toContain('^L stay');
});

test('an unfocused pane tells the reader where to answer instead of showing keys', async () => {
  await show([relocation()], 'idle');
  expect(m!.frame()).toContain('focus this pane to answer');
  expect(m!.frame().includes('^Y')).toBe(false);
});

test('a foreign session shows the offer with no hint at all', async () => {
  await show([relocation()], 'none');
  expect(m!.frame()).toContain('Move this session there?');
  expect(m!.frame().includes('^Y')).toBe(false);
  expect(m!.frame().includes('focus this pane')).toBe(false);
});

test('a queued move says it is waiting and offers the cancel key', async () => {
  await show([relocation({ state: 'queued', path: '/repo/trees/feat-x' })]);
  expect(m!.frame()).toContain('Interrupting the turn to move to feat-x');
  expect(m!.frame()).toContain('^L cancel');
  expect(m!.frame().includes('^Y')).toBe(false);
});

test('settled offers are one muted line with no keys', async () => {
  await show([relocation({ id: 'a', state: 'moved', path: '/repo/trees/feat-x' }), relocation({ id: 'b', state: 'stayed' })]);
  const f = m!.frame();
  expect(f).toContain('Moved to feat-x');
  expect(f).toContain('Stayed');
  expect(f.includes('^Y')).toBe(false);
  expect(f.includes('^L')).toBe(false);
});

test('an older unsettled offer is shown without keys while the newest carries them', async () => {
  await show([relocation({ id: 'old', path: '/repo/trees/old-one' }), relocation({ id: 'new', path: '/repo/trees/new-one' })]);
  const f = m!.frame();
  expect(f).toContain('old-one');
  expect(f).toContain('new-one');
  expect(f.split('^Y move').length - 1).toBe(1);
  expect(f).toContain('superseded');
});

test('a very long folder name stays inside the pane', async () => {
  await show([relocation({ path: `/repo/trees/${'x'.repeat(200)}` })]);
  expect(m!.frame().split('\n').every((r) => r.length <= 100)).toBe(true);
});
