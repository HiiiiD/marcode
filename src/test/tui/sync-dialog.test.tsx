import { afterEach, expect, test } from 'bun:test';
import type { SyncPanel } from '../../protocol/messages';
import { SyncDialog } from '../../tui/ui/sync/sync-dialog';
import { hydrateMsg, mount, type Mounted } from './harness';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });

const NOW = Date.now();
const PAIRED: SyncPanel = {
  state: 'paired', server: 'https://sync.example.com', deviceName: 'desk', connection: 'connected',
  devices: [
    { deviceId: 'd-desk', name: 'desk', lastSeenAt: NOW, self: true, revoked: false },
    { deviceId: 'd-laptop', name: 'laptop', lastSeenAt: NOW - 7_200_000, self: false, revoked: false },
  ],
  projects: [{ path: '/w/marcode', name: 'marcode', projectId: 'github.com/HiiiiD/marcode', choice: 'shared' }],
};

const open = async (panel?: SyncPanel) => {
  m = await mount(<SyncDialog onClose={() => {}} />, { width: 90, height: 34 });
  await m.fromHost(hydrateMsg({}));
  if (panel) { await m.fromHost({ t: 'sync-panel', panel }); }
};

test('asks the host for the sync panel on open', async () => {
  await open();
  expect(m!.posted.filter((p) => p.t === 'sync-open').length).toBe(1);
});

test('unpaired shows the join form; typing and Enter posts sync-join', async () => {
  await open({ state: 'unpaired', defaultName: 'desk' });
  const f = m!.frame();
  expect(f).toContain('Server address');
  expect(f).toContain('Pairing code');
  expect(f).toContain('Device name');
  await m!.press('down');
  await m!.type('https://s.example.com');
  await m!.press('tab');
  await m!.type('MRC-ABC');
  await m!.press('return');
  expect(m!.posted.at(-1)).toEqual({ t: 'sync-join', server: 'https://s.example.com', code: 'MRC-ABC', name: 'desk' });
});

test('paired lists devices with this device marked; p pairs', async () => {
  await open(PAIRED);
  const f = m!.frame();
  expect(f).toContain('sync.example.com · desk · Connected');
  expect(f).toContain('laptop');
  expect(f).toContain('this device');
  expect(f).toContain('marcode');
  await m!.press('p');
  expect(m!.posted.at(-1)).toEqual({ t: 'sync-pair' });
});

test('a pairing shows the code and the join command', async () => {
  const code = 'MRC-ABCDEF-GHIJKL';
  await open({ ...PAIRED, pairing: { code, expiresAt: Date.now() + 600_000, joinCommand: `marcode sync join https://sync.example.com ${code}` } });
  const f = m!.frame();
  expect(f).toContain('ABCDEF GHIJKL');
  expect(f).toContain('marcode sync join');
});

test('r then y revokes the selected device', async () => {
  await open(PAIRED);
  await m!.press('down');
  await m!.press('r');
  expect(m!.frame()).toContain('Revoke laptop?');
  await m!.press('y');
  expect(m!.posted.at(-1)).toEqual({ t: 'sync-revoke', deviceId: 'd-laptop' });
});

test('the status line appears only when sync is broken', async () => {
  const { SyncStatusLine } = await import('../../tui/ui/sync/sync-status-line');
  m = await mount(<SyncStatusLine />, { width: 60, height: 4 });
  await m.fromHost(hydrateMsg({}));
  expect(m.frame()).not.toContain('Sync');
  await m.fromHost({ t: 'sync-status', status: 'offline' });
  expect(m.frame()).toContain('Sync offline · /sync');
  await m.fromHost({ t: 'sync-status', status: 'revoked' });
  expect(m.frame()).toContain('Sync: device removed · /sync');
});

test('a re-hydrate while open asks for the panel again', async () => {
  await open(PAIRED);
  await m!.fromHost(hydrateMsg({}));
  expect(m!.posted.filter((p) => p.t === 'sync-open').length).toBe(2);
});
