import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { App } from '../../tui/ui/app';
import { catalog, snapshot, summary } from '../fixtures/protocol';
import { hydrateMsg, mount, type Mounted } from './harness';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });

const props = { launchCwd: '/repo', forceNew: false, loginCommands: {}, onQuit: () => {} };
const sends = () => m!.posted.filter((p) => p.t === 'send');
// A lone Esc and the quit-arm expiry both land on timers, so the wait itself runs inside act.
const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const settleEscape = async () => { await wait(100); await m!.setup.renderOnce(); };

test('Ctrl+C while idle needs a second press to quit', async () => {
  let quit = 0;
  m = await mount(<App {...props} onQuit={() => { quit++; }} />);
  await m.fromHost(hydrateMsg());
  await m.press('c', { ctrl: true });
  expect(quit).toBe(0);
  expect(m.frame()).toContain('Press Ctrl+C again');
  await m.press('c', { ctrl: true });
  expect(quit).toBe(1);
});

test('the quit arm expires: the notice clears and the next Ctrl+C arms again', async () => {
  let quit = 0;
  m = await mount(<App {...props} quitWindowMs={40} onQuit={() => { quit++; }} />);
  await m.fromHost(hydrateMsg());
  await m.press('c', { ctrl: true });
  await wait(80);
  await m.fromHost();
  expect(m.frame()).not.toContain('Press Ctrl+C again');
  await m.press('c', { ctrl: true });
  expect(quit).toBe(0);
  expect(m.frame()).toContain('Press Ctrl+C again');
});

test('Ctrl+C during a running turn interrupts instead of quitting', async () => {
  let quit = 0;
  m = await mount(<App {...props} onQuit={() => { quit++; }} />);
  await m.fromHost(hydrateMsg({ sessions: [summary('s1', { status: 'running' })], snapshots: [snapshot('s1', { status: 'running' })] }));
  await m.press('c', { ctrl: true });
  expect(quit).toBe(0);
  expect(m.posted.some((p) => p.t === 'interrupt' && p.id === 's1')).toBe(true);
});

test('Esc during a running turn interrupts', async () => {
  m = await mount(<App {...props} />);
  await m.fromHost(hydrateMsg({ sessions: [summary('s1', { status: 'running' })], snapshots: [snapshot('s1', { status: 'running' })] }));
  await m.press('escape');
  await settleEscape();
  expect(m.posted.filter((p) => p.t === 'interrupt').length).toBe(1);
});

test('Enter with text in the composer posts exactly one send', async () => {
  m = await mount(<App {...props} />);
  await m.fromHost(hydrateMsg());
  await m.type('ship it');
  await m.press('return');
  expect(sends().length).toBe(1);
});

test('the new-session dialog makes every other key consumer inert until it closes', async () => {
  m = await mount(<App {...props} />);
  await m.fromHost(hydrateMsg());
  await m.type('draft');
  await m.press('n', { ctrl: true });
  expect(m.frame()).toContain('New session');
  await m.type('xyz');
  await m.press('tab');
  await m.press('c', { ctrl: true });
  expect(m.frame()).not.toContain('draftxyz');
  expect(m.frame()).not.toContain('Press Ctrl+C again');
  await m.press('escape');
  await settleEscape();
  expect(m.frame()).not.toContain('New session');
  expect(sends().length).toBe(0);
  await m.type(' done');
  await m.press('return');
  expect(sends().length).toBe(1);
  const sent = sends()[0];
  expect(sent?.t === 'send' && sent.text).toBe('draft done');
});

test('Enter in the dialog creates a session and sends nothing from the composer', async () => {
  m = await mount(<App {...props} />);
  await m.fromHost(hydrateMsg({ catalog: [{ id: 'fake', displayName: 'Fake', models: [{ id: 'fake-large', displayName: 'Fake Large' }], permissionModes: [] }] }));
  await m.type('draft');
  await m.press('n', { ctrl: true });
  await m.press('return');
  expect(m.posted.filter((p) => p.t === 'create-session').length).toBe(1);
  expect(sends().length).toBe(0);
  await m.fromHost({ t: 'sessions-changed', sessions: [summary('s1'), summary('s9')] });
  expect(m.posted.some((p) => p.t === 'set-visible' && p.sessionIds[0] === 's9')).toBe(true);
});

const owner = { host: 'vscode' as const, pid: 4812 };
const modes = catalog().map((p) => ({ ...p, permissionModes: [{ id: 'default' as const }, { id: 'plan' as const }] }));
const foreignRunning = () => hydrateMsg({
  catalog: modes,
  sessions: [summary('s1', { status: 'running', owner })],
  snapshots: [snapshot('s1', { status: 'running', owner })],
});
const forS1 = () => m!.posted.filter((p) => 'id' in p && p.id === 's1');

test('a running foreign session: Ctrl+C twice quits and nothing is posted for it', async () => {
  let quit = 0;
  m = await mount(<App {...props} onQuit={() => { quit++; }} />);
  await m.fromHost(foreignRunning());
  await m.press('c', { ctrl: true });
  await m.press('c', { ctrl: true });
  expect(quit).toBe(1);
  expect(forS1().length).toBe(0);
});

test('a foreign session: Esc and the cyclers post nothing for it', async () => {
  m = await mount(<App {...props} />);
  await m.fromHost(foreignRunning());
  await m.press('escape');
  await settleEscape();
  await m.press('p', { ctrl: true });
  await m.press('e', { ctrl: true });
  await m.press('tab', { shift: true });
  expect(forS1().length).toBe(0);
});

test('an owned running session: the first Ctrl+C interrupts, a second within the window quits', async () => {
  let quit = 0;
  m = await mount(<App {...props} onQuit={() => { quit++; }} />);
  await m.fromHost(hydrateMsg({ sessions: [summary('s1', { status: 'running' })], snapshots: [snapshot('s1', { status: 'running' })] }));
  await m.press('c', { ctrl: true });
  expect(m.posted.filter((p) => p.t === 'interrupt').length).toBe(1);
  expect(quit).toBe(0);
  await m.press('c', { ctrl: true });
  expect(quit).toBe(1);
});
