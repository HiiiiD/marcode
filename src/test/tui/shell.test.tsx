import { afterEach, expect, test } from 'bun:test';
import { BottomSlotView } from '../../tui/ui/bottom-slot';
import { Composer } from '../../tui/ui/composer';
import { Transcript } from '../../tui/ui/transcript/transcript';
import { hydrateMsg, mount, type Mounted } from './harness';
import { snapshot, summary } from '../fixtures/protocol';
import type { ShellItem } from '../../protocol/messages';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });
const posts = (t: string) => m!.posted.filter((p) => p.t === t);

const shell = (over: Partial<ShellItem> = {}): ShellItem => ({
  id: 'sh1', ts: 1, role: 'shell', command: 'ls -la', state: 'done', output: 'file-a\nfile-b\n', exitCode: 0, ...over,
});
const withShell = (item: ShellItem) =>
  hydrateMsg({ sessions: [summary('s1')], snapshots: [snapshot('s1', { items: [item] })] });

test('a bang line posts run-shell, never send, and clears the box', async () => {
  m = await mount(<Composer sessionId="s1" focused />);
  await m.fromHost(hydrateMsg());
  await m.type('!git status');
  await m.press('return');
  expect(posts('run-shell')).toEqual([{ t: 'run-shell', id: 's1', command: 'git status' }]);
  expect(posts('send').length).toBe(0);
  expect(m.frame()).not.toContain('git status');
});

test('a lone bang is an ordinary prompt', async () => {
  m = await mount(<Composer sessionId="s1" focused />);
  await m.fromHost(hydrateMsg());
  await m.type('!');
  await m.press('return');
  expect(posts('send')).toEqual([{ t: 'send', id: 's1', text: '!' }]);
});

test('a bang line works while a turn is running', async () => {
  m = await mount(<Composer sessionId="s1" focused />);
  await m.fromHost(hydrateMsg({ sessions: [summary('s1', { status: 'running' })], snapshots: [snapshot('s1', { status: 'running' })] }));
  await m.type('!ls');
  await m.press('return');
  expect(posts('run-shell').length).toBe(1);
});

test('shell mode shows its own hint', async () => {
  m = await mount(<Composer sessionId="s1" focused />);
  await m.fromHost(hydrateMsg());
  await m.type('!l');
  expect(m.frame()).toContain('shell');
});

test('a bang the parser rejects shows no shell hint', async () => {
  m = await mount(<Composer sessionId="s1" focused />);
  await m.fromHost(hydrateMsg());
  await m.type('! ls');
  expect(m.frame()).not.toContain('shell command');
});

test('a finished command is a You ran card with its output open', async () => {
  m = await mount(<Transcript sessionId="s1" focused />);
  await m.fromHost(withShell(shell()));
  expect(m.frame()).toContain('You ran');
  expect(m.frame()).toContain('ls -la');
  expect(m.frame()).toContain('file-b');
});

test('a running command streams its output inside the card', async () => {
  m = await mount(<Transcript sessionId="s1" focused />);
  await m.fromHost(withShell(shell({ state: 'running', exitCode: undefined, output: 'tick-1' })));
  expect(m.frame()).toContain('You ran');
  expect(m.frame()).toContain('tick-1');
});

test('a failed command is marked failed and shows its exit code', async () => {
  m = await mount(<Transcript sessionId="s1" focused />);
  await m.fromHost(withShell(shell({ exitCode: 2 })));
  expect(m.frame()).toContain('failed');
  expect(m.frame()).toContain('[exit 2]');
});

test('a very long output is clamped with the hidden-lines divider', async () => {
  m = await mount(<Transcript sessionId="s1" focused />, { width: 100, height: 60 });
  const long = Array.from({ length: 80 }, (_, i) => `row-a${i}`).join('\n');
  await m.fromHost(withShell(shell({ output: long })));
  expect(m.frame()).toContain('lines hidden');
  expect(m.frame()).not.toContain('row-a40');
});

test('Enter collapses the card and Enter again reopens it', async () => {
  m = await mount(<Transcript sessionId="s1" focused />);
  await m.fromHost(withShell(shell()));
  await m.press('j');
  await m.press('return');
  expect(m.frame()).not.toContain('file-b');
  await m.press('return');
  expect(m.frame()).toContain('file-b');
});

test('a running command is pinned above the composer with its cancel hint', async () => {
  m = await mount(<BottomSlotView sessionId="s1" focused />);
  await m.fromHost(withShell(shell({ state: 'running', exitCode: undefined })));
  expect(m.frame()).toContain('$ ls -la');
  expect(m.frame()).toContain('Esc');
});

test('nothing is pinned once the command has finished', async () => {
  m = await mount(<BottomSlotView sessionId="s1" focused />);
  await m.fromHost(withShell(shell()));
  expect(m.frame()).not.toContain('$ ls -la');
});
