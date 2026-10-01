import { afterEach, expect, test } from 'bun:test';
import type { PermissionRequest } from '../../protocol/messages';
import { BottomSlotView } from '../../tui/ui/bottom-slot';
import { snapshot, summary } from '../fixtures/protocol';
import { hydrateMsg, mount, type Mounted } from './harness';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });

const perm: PermissionRequest = { requestId: 'r1', tool: { kind: 'command', label: 'Bash', command: 'rm -rf x' } };
const perm2: PermissionRequest = { requestId: 'r2', tool: { kind: 'command', label: 'Bash', command: 'ls' } };
const decisions = () => m!.posted.filter((p) => p.t === 'permission-decision');

test('a pending permission replaces the composer and the draft survives the round trip', async () => {
  m = await mount(<BottomSlotView sessionId="s1" focused />);
  await m.fromHost(hydrateMsg());
  await m.type('half a thought');
  expect(m.frame()).toContain('half a thought');
  await m.fromHost({ t: 'session-snapshot', session: snapshot('s1', { status: 'awaiting-approval', pending: [perm] }) });
  expect(m.frame()).toContain('[y] allow');
  expect(m.frame()).not.toContain('half a thought');
  await m.press('y');
  await m.fromHost({ t: 'session-snapshot', session: snapshot('s1', { pending: [] }) });
  expect(m.frame()).toContain('half a thought');
});

test('a second request gets a fresh prompt that can answer again', async () => {
  m = await mount(<BottomSlotView sessionId="s1" focused />);
  await m.fromHost(hydrateMsg());
  await m.fromHost({ t: 'session-snapshot', session: snapshot('s1', { pending: [perm] }) });
  await m.press('y');
  await m.fromHost({ t: 'session-snapshot', session: snapshot('s1', { pending: [perm2] }) });
  expect(m.frame()).toContain('ls');
  await m.press('y');
  expect(decisions().map((d) => (d as { requestId: string }).requestId)).toEqual(['r1', 'r2']);
});

test('a foreign session shows the banner and no composer', async () => {
  const foreign = summary('s1', { owner: { host: 'vscode', pid: 4812 } });
  m = await mount(<BottomSlotView sessionId="s1" focused />);
  await m.fromHost(hydrateMsg({ sessions: [foreign], snapshots: [snapshot('s1', { owner: foreign.owner })] }));
  expect(m.frame()).toContain('Running in vscode (pid 4812). Read-only here.');
  await m.type('hello');
  await m.press('return');
  expect(m.posted.some((p) => p.t === 'send')).toBe(false);
  expect(m.frame()).not.toContain('hello');
});

test('a foreign session with a pending permission shows no prompt and posts nothing', async () => {
  const foreign = summary('s1', { owner: { host: 'vscode', pid: 4812 } });
  m = await mount(<BottomSlotView sessionId="s1" focused />);
  await m.fromHost(hydrateMsg({ sessions: [foreign], snapshots: [snapshot('s1', { owner: foreign.owner, pending: [perm] })] }));
  expect(m.frame()).not.toContain('[y] allow');
  await m.press('y');
  expect(decisions().length).toBe(0);
});

test('when the owner lets go the banner turns back into a composer', async () => {
  const foreign = summary('s1', { owner: { host: 'vscode', pid: 4812 } });
  m = await mount(<BottomSlotView sessionId="s1" focused />);
  await m.fromHost(hydrateMsg({ sessions: [foreign], snapshots: [snapshot('s1', { owner: foreign.owner })] }));
  await m.fromHost({ t: 'sessions-changed', sessions: [summary('s1')] });
  expect(m.frame()).not.toContain('Read-only here');
  await m.type('now mine');
  await m.press('return');
  expect(m.posted.some((p) => p.t === 'send')).toBe(true);
});
