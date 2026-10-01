import { afterEach, expect, test } from 'bun:test';
import { Transcript } from '../../tui/ui/transcript/transcript';
import { hydrateMsg, mount, type Mounted } from './harness';
import { snapshot, summary, tool } from '../fixtures/protocol';
import type { TranscriptItem } from '../../protocol/messages';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });

const withItems = (items: TranscriptItem[], status: 'idle' | 'running' = 'idle', hasMore = false) =>
  hydrateMsg({
    sessions: [summary('s1', { status })],
    snapshots: [snapshot('s1', { status, items, hasMore })],
  });

const many = (n: number, prefix = 'm'): TranscriptItem[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, ts: i, role: 'user', text: `${prefix} message ${i}` }));

const loadMores = () => m!.posted.filter((p) => p.t === 'load-more');
const tick = () => new Promise((r) => setTimeout(r, 10));
// <markdown> lays out asynchronously; a wall-clock gap plus one more frame lets it paint.
const paint = async () => { await tick(); await m!.fromHost(); };

test('user and assistant text render, assistant as markdown', async () => {
  m = await mount(<Transcript sessionId="s1" focused />);
  await m.fromHost(withItems([
    { id: 'u1', ts: 1, role: 'user', text: 'fix the tests' },
    { id: 'a1', ts: 2, role: 'assistant', text: 'Done. **All green.**' },
  ]));
  await paint();
  expect(m.frame()).toContain('> fix the tests');
  expect(m.frame()).toContain('All green');
});

test('a tool call is one header line until expanded', async () => {
  m = await mount(<Transcript sessionId="s1" focused />);
  await m.fromHost(withItems([tool({ id: 't1', tool: { kind: 'command', label: 'Bash', command: 'yarn test:unit' }, output: { kind: 'text', text: 'line one\nline two' } })]));
  expect(m.frame()).toContain('Bash');
  expect(m.frame()).not.toContain('line two');
  await m.press('j');
  await m.press('return');
  expect(m.frame()).toContain('line two');
  await m.press('return');
  expect(m.frame()).not.toContain('line two');
});

test('a very long output is clamped with a hidden-lines divider', async () => {
  m = await mount(<Transcript sessionId="s1" focused />, { width: 100, height: 60 });
  const long = Array.from({ length: 80 }, (_, i) => `row ${i}`).join('\n');
  await m.fromHost(withItems([tool({ id: 't1', output: { kind: 'text', text: long } })]));
  await m.press('j');
  await m.press('return');
  expect(m.frame()).toContain('lines hidden');
  expect(m.frame()).not.toContain('row 40');
});

test('a single enormous line wraps instead of overflowing', async () => {
  m = await mount(<Transcript sessionId="s1" focused />, { width: 40, height: 20 });
  await m.fromHost(withItems([{ id: 'a1', ts: 1, role: 'assistant', text: 'x'.repeat(200) }]));
  await paint();
  const widest = Math.max(...m.frame().split('\n').map((l) => l.length));
  expect(widest).toBeLessThanOrEqual(40);
  expect(m.frame()).toContain('xxxx');
});

test('hasMore shows the older-messages row', async () => {
  m = await mount(<Transcript sessionId="s1" focused />);
  await m.fromHost(withItems([{ id: 'u1', ts: 1, role: 'user', text: 'hi' }], 'idle', true));
  expect(m.frame()).toContain('older messages');
});

test('a streaming delta appends to the visible assistant text', async () => {
  m = await mount(<Transcript sessionId="s1" focused />);
  await m.fromHost(withItems([{ id: 'a1', ts: 1, role: 'assistant', text: 'Hel' }], 'running'));
  await m.fromHost({ t: 'session-patch', id: 's1', patch: { op: 'delta', itemId: 'a1', field: 'text', delta: 'lo there' } });
  await paint();
  expect(m.frame()).toContain('Hello there');
});

test('follows the tail while sticky, stops when scrolled up, End re-pins', async () => {
  m = await mount(<Transcript sessionId="s1" focused />, { width: 60, height: 10 });
  await m.fromHost(withItems(many(40)));
  await tick();
  await m.fromHost();
  expect(m.frame()).toContain('m message 39');
  expect(m.frame()).not.toContain('m message 0\n');
  await m.press('pageup');
  expect(m.frame()).not.toContain('m message 39');
  await m.fromHost({ t: 'session-patch', id: 's1', patch: { op: 'append', item: { id: 'x', ts: 99, role: 'user', text: 'newest' } } });
  expect(m.frame()).not.toContain('newest');
  await m.press('end');
  await m.fromHost();
  expect(m.frame()).toContain('newest');
});

test('load-more posts once per first item id when scrolled to the top', async () => {
  m = await mount(<Transcript sessionId="s1" focused />, { width: 60, height: 10 });
  await m.fromHost(withItems(many(40), 'idle', true));
  await tick();
  await m.fromHost();
  expect(loadMores().length).toBe(0);
  for (let i = 0; i < 20; i++) { await m.press('pageup'); await tick(); }
  await m.fromHost();
  expect(loadMores().length).toBe(1);
  expect(loadMores()[0]).toEqual({ t: 'load-more', id: 's1', beforeItemId: 'm0' });
  for (let i = 0; i < 5; i++) { await m.press('pageup'); await tick(); }
  expect(loadMores().length).toBe(1);
  await m.fromHost(withItems([...many(3, 'older'), ...many(40)], 'idle', true));
  await tick();
  await m.fromHost();
  for (let i = 0; i < 30; i++) { await m.press('pageup'); await tick(); }
  await m.fromHost();
  expect(loadMores().length).toBe(2);
  expect(loadMores()[1]).toEqual({ t: 'load-more', id: 's1', beforeItemId: 'older0' });
});

test('no load-more without hasMore', async () => {
  m = await mount(<Transcript sessionId="s1" focused />, { width: 60, height: 10 });
  await m.fromHost(withItems(many(40)));
  for (let i = 0; i < 20; i++) { await m.press('pageup'); await tick(); }
  expect(loadMores().length).toBe(0);
});
