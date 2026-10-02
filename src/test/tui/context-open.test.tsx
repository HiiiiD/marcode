import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { App } from '../../tui/ui/app';
import { snapshot, summary } from '../fixtures/protocol';
import { hydrateMsg, mount, type Mounted } from './harness';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });
const props = { launchCwd: '/repo', forceNew: false, loginCommands: {}, onQuit: () => {} };
const requests = () => (m?.posted ?? []).filter((p) => p.t === 'request-context');
const boot = async (over: Parameters<typeof summary>[1] = {}) => {
  const s = summary('s1', { contextPercent: 42, ...over });
  m = await mount(<App {...props} />, { width: 140, height: 30 });
  await m.fromHost(hydrateMsg({ sessions: [s], snapshots: [snapshot('s1', s)] }));
};
const clickShare = async () => {
  const rows = m!.frame().split('\n');
  const y = rows.findIndex((r) => r.includes('ctx 42%'));
  const x = rows[y]!.indexOf('ctx 42%');
  await act(async () => { await m!.setup.mockMouse.click(x + 1, y); });
  await m!.fromHost();
};

test('Ctrl+T opens the context dialog for the focused session', async () => {
  await boot();
  await m!.press('t', { ctrl: true });
  expect(m!.frame()).toContain('42% used');
  const r = requests()[0];
  expect(r?.t === 'request-context' && r.id).toBe('s1');
});

test('/context in the composer opens it', async () => {
  await boot();
  await m!.type('/context');
  await m!.press('return');
  expect(requests().length).toBe(1);
  expect(m!.posted.some((p) => p.t === 'send')).toBe(false);
});

test('clicking the share in the status line opens it', async () => {
  await boot();
  await clickShare();
  expect(requests().length).toBe(1);
});

test('a foreign session cannot open it by chord or click', async () => {
  await boot({ owner: { host: 'vscode', pid: 1 } });
  await m!.press('t', { ctrl: true });
  await clickShare();
  expect(requests().length).toBe(0);
});
