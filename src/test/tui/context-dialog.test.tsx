import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { ContextDialog } from '../../tui/ui/context-dialog';
import { breakdown, snapshot, summary } from '../fixtures/protocol';
import { hydrateMsg, mount, type Mounted } from './harness';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });
const settleEscape = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 100)); }); await m!.setup.renderOnce(); };

const requests = () => (m?.posted ?? []).filter((p) => p.t === 'request-context');
const open = async (percent: number | null = 42, onClose = () => {}) => {
  const s = summary('s1', percent === null ? {} : { contextPercent: percent });
  m = await mount(<ContextDialog sessionId="s1" onClose={onClose} />);
  await m.fromHost(hydrateMsg({ sessions: [s], snapshots: [snapshot('s1', s)] }));
};
const answer = (result: { ok: true; breakdown: ReturnType<typeof breakdown> } | { ok: false; reason: string }) =>
  m!.fromHost({ t: 'context-breakdown', id: 's1', result });

test('asks the host for the breakdown of its session once on open', async () => {
  await open();
  expect(requests().length).toBe(1);
  const r = requests()[0];
  expect(r?.t === 'request-context' && r.id).toBe('s1');
});

test('shows a loading line until the answer arrives', async () => {
  await open();
  expect(m!.frame()).toContain('Loading');
});

test('renders the header, slices and memory files from the breakdown', async () => {
  await open(42);
  await answer({ ok: true, breakdown: breakdown() });
  const f = m!.frame();
  expect(f).toContain('Context');
  expect(f).toContain('42% used');
  expect(f).toContain('System prompt');
  expect(f).toContain('12%');
  expect(f).toContain('Free');
  expect(f).toContain('57%');
  expect(f).toContain('/repo/CLAUDE.md');
  expect(f).toContain('3%');
});

test('quotes the window once when the provider reported both fields', async () => {
  await open();
  await answer({ ok: true, breakdown: breakdown({ usedTokens: 43000, windowTokens: 258000 }) });
  expect(m!.frame()).toContain('43K of 258K tokens');
});

test('no window line when the provider reported neither', async () => {
  await open();
  await answer({ ok: true, breakdown: breakdown() });
  expect(m!.frame().includes('tokens')).toBe(false);
});

test('says when no memory file was loaded', async () => {
  await open();
  await answer({ ok: true, breakdown: breakdown({ memoryFiles: [] }) });
  expect(m!.frame()).toContain('No memory files loaded');
});

test('an unavailable reading says so in the header', async () => {
  await open(null);
  await answer({ ok: true, breakdown: breakdown() });
  expect(m!.frame()).toContain('unavailable');
});

test('an error shows its reason and r asks again', async () => {
  await open();
  await answer({ ok: false, reason: 'provider offline' });
  expect(m!.frame()).toContain('provider offline');
  await m!.press('r');
  expect(requests().length).toBe(2);
});

test('r does nothing while a good breakdown is shown', async () => {
  await open();
  await answer({ ok: true, breakdown: breakdown() });
  await m!.press('r');
  expect(requests().length).toBe(1);
});

test('odd percentages are clamped without breaking the layout', async () => {
  await open();
  await answer({ ok: true, breakdown: breakdown({ systemPercent: 140, memoryPercent: -2, conversationPercent: 0, freePercent: 0 }) });
  expect(m!.frame()).toContain('100%');
  expect(m!.frame().includes('-2%')).toBe(false);
});

test('Esc closes', async () => {
  let closed = 0;
  await open(42, () => { closed++; });
  await m!.press('escape');
  await settleEscape();
  expect(closed).toBe(1);
});

test('a session that is gone closes the dialog instead of spinning', async () => {
  let closed = 0;
  await open(42, () => { closed++; });
  await m!.fromHost({ t: 'sessions-changed', sessions: [] });
  expect(closed > 0).toBe(true);
  expect(m!.frame().includes('Loading')).toBe(false);
});
