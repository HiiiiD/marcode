import { afterEach, expect, test } from 'bun:test';
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

test('a finished command renders its command, output and exit code', async () => {
  m = await mount(<Transcript sessionId="s1" focused />);
  await m.fromHost(withShell(shell()));
  expect(m.frame()).toContain('$ ls -la');
  expect(m.frame()).toContain('file-b');
  expect(m.frame()).toContain('exit 0');
});

test('a running command says so', async () => {
  m = await mount(<Transcript sessionId="s1" focused />);
  await m.fromHost(withShell(shell({ state: 'running', exitCode: undefined })));
  expect(m.frame()).toContain('running…');
});

test('a failed command shows its exit code', async () => {
  m = await mount(<Transcript sessionId="s1" focused />);
  await m.fromHost(withShell(shell({ exitCode: 2 })));
  expect(m.frame()).toContain('exit 2');
});
