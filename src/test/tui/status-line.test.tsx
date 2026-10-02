import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { StatusLine } from '../../tui/ui/status-line';
import { snapshot, summary } from '../fixtures/protocol';
import { hydrateMsg, mount, type Mounted } from './harness';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });

const withEffort = summary('s1', { effort: 'high', permissionMode: 'plan' });

test('shows display name, model, effort and permission mode', async () => {
  m = await mount(<StatusLine sessionId="s1" width={80} />);
  await m.fromHost(hydrateMsg({ sessions: [withEffort], snapshots: [snapshot('s1', withEffort)] }));
  expect(m.frame()).toContain('Fake · fake-large · high · plan');
});

test('truncates with an ellipsis to the width', async () => {
  m = await mount(<StatusLine sessionId="s1" width={12} />);
  await m.fromHost(hydrateMsg({ sessions: [withEffort], snapshots: [snapshot('s1', withEffort)] }));
  expect(m.frame()).toContain('Fake · fake…');
  expect(m.frame()).not.toContain('fake-large');
});

test('with no session it offers a new one', async () => {
  m = await mount(<StatusLine sessionId={null} width={80} />);
  await m.fromHost(hydrateMsg({ sessions: [], snapshots: [] }));
  expect(m.frame()).toContain('no session — Ctrl+N new');
});

test('hints the picker keys when the session is ours and there is room', async () => {
  m = await mount(<StatusLine sessionId="s1" width={100} />);
  await m.fromHost(hydrateMsg({ sessions: [withEffort], snapshots: [snapshot('s1', withEffort)] }));
  expect(m.frame()).toContain('^P model · ^E effort · ⇧Tab mode');
});

test('drops the hint before it would truncate the session line', async () => {
  m = await mount(<StatusLine sessionId="s1" width={40} />);
  await m.fromHost(hydrateMsg({ sessions: [withEffort], snapshots: [snapshot('s1', withEffort)] }));
  expect(m.frame()).toContain('Fake · fake-large · high · plan');
  expect(m.frame().includes('^P')).toBe(false);
});

test('a session owned by another host gets no hint', async () => {
  const foreign = summary('s1', { owner: { host: 'vscode', pid: 1 } });
  m = await mount(<StatusLine sessionId="s1" width={100} />);
  await m.fromHost(hydrateMsg({ sessions: [foreign], snapshots: [snapshot('s1', foreign)] }));
  expect(m.frame().includes('^P')).toBe(false);
});

test('shows the context share when the session reports one', async () => {
  const s = summary('s1', { contextPercent: 42 });
  m = await mount(<StatusLine sessionId="s1" width={120} />);
  await m.fromHost(hydrateMsg({ sessions: [s], snapshots: [snapshot('s1', s)] }));
  expect(m.frame()).toContain('ctx 42%');
});

test('shows no ctx segment without a reading', async () => {
  m = await mount(<StatusLine sessionId="s1" width={120} />);
  await m.fromHost(hydrateMsg({ sessions: [withEffort], snapshots: [snapshot('s1', withEffort)] }));
  expect(m.frame().includes('ctx')).toBe(false);
});

test('a click on the share opens the context dialog, a click elsewhere does not', async () => {
  let opened = 0;
  const s = summary('s1', { contextPercent: 42 });
  m = await mount(<StatusLine sessionId="s1" width={120} onOpenContext={() => { opened++; }} />);
  await m.fromHost(hydrateMsg({ sessions: [s], snapshots: [snapshot('s1', s)] }));
  const rows = m.frame().split('\n');
  const y = rows.findIndex((r) => r.includes('ctx 42%'));
  const x = rows[y]!.indexOf('ctx 42%');
  await act(async () => { await m!.setup.mockMouse.click(0, y); });
  expect(opened).toBe(0);
  await act(async () => { await m!.setup.mockMouse.click(x + 1, y); });
  expect(opened).toBe(1);
});
