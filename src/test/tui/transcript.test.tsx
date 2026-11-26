import { act } from 'react';
import { afterEach, expect, test } from 'bun:test';
import { Transcript } from '../../tui/ui/transcript/transcript';
import { hydrateMsg, mount, type Mounted } from './harness';
import { permission, snapshot, summary, tool } from '../fixtures/protocol';
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
// <markdown> lays out asynchronously (slower once tree-sitter loads); poll frames until the text paints.
const paint = async (text: string) => {
  for (let i = 0; i < 60; i++) {
    await tick();
    await m!.fromHost();
    if (m!.frame().includes(text)) { return; }
  }
};

test('user and assistant text render, assistant as markdown', async () => {
  m = await mount(<Transcript sessionId="s1" focused />);
  await m.fromHost(withItems([
    { id: 'u1', ts: 1, role: 'user', text: 'fix the tests' },
    { id: 'a1', ts: 2, role: 'assistant', text: 'Done. **All green.**' },
  ]));
  await paint('All green');
  expect(m.frame()).toContain('fix the tests');
  expect(m.frame()).toContain('All green');
  expect(/\b(user|assistant|You)\b/.test(m.frame())).toBe(false);
});

test('agent prose and the user\'s own turn carry their time underneath', async () => {
  const at = new Date(2026, 0, 1, 9, 41).getTime();
  const time = new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  m = await mount(<Transcript sessionId="s1" focused />);
  await m.fromHost(withItems([{ id: 'u1', ts: at, role: 'user', text: 'go' }, { id: 'a1', ts: at, role: 'assistant', text: 'Done here.' }]));
  await paint('Done here');
  const rows = m.frame().split(/\r?\n/);
  const under = (needle: string) => rows[rows.findIndex((r) => r.includes(needle)) + 1] ?? '';
  expect(under('go')).toContain(time);
  expect(under('Done here')).toContain(time);
});

test('a message from another session names its sender', async () => {
  m = await mount(<Transcript sessionId="s1" focused />);
  await m.fromHost(withItems([{ id: 'u1', ts: 1, role: 'user', text: 'status?', from: { sessionId: 's2', name: 'scout' } }]));
  expect(m.frame()).toContain('Message from scout');
});

test('a finished tool row starts no interval timers', async () => {
  const real = globalThis.setInterval;
  let started = 0;
  globalThis.setInterval = ((...a: Parameters<typeof setInterval>) => { started++; return real(...a); }) as typeof setInterval;
  try {
    m = await mount(<Transcript sessionId="s1" focused />);
    const before = started;
    await m.fromHost(withItems([tool({ id: 't1', state: 'ok' })]));
    expect(started - before).toBe(0);
  } finally { globalThis.setInterval = real; }
});

const barRows = () => m!.frame().split(/\r?\n/).filter((r) => r.includes('┃'));

test('only the selected row draws the gutter bar, and selecting shifts no text', async () => {
  m = await mount(<Transcript sessionId="s1" focused />);
  await m.fromHost(withItems([tool({ id: 't1' }), tool({ id: 't2', tool: { kind: 'command', label: 'Grep', command: 'rg x' } })]));
  const col = (needle: string) => m!.frame().split(/\r?\n/).find((r) => r.includes(needle))?.indexOf(needle) ?? -1;
  const before = [col('Bash'), col('Grep')];
  expect(barRows().length).toBe(0);
  await m.press('j');
  expect(barRows().length).toBe(1);
  expect(barRows()[0]?.includes('Bash')).toBe(true);
  expect([col('Bash'), col('Grep')]).toEqual(before);
});

const spansOf = () => m!.setup.captureSpans().lines.flatMap((l) => l.spans);
const fgOf = (text: string) => {
  const span = spansOf().find((s) => s.text.includes(text));
  return span === undefined ? '' : span.fg.toString();
};

test('user text is capped to a readable width on a wide terminal', async () => {
  m = await mount(<Transcript sessionId="s1" focused />, { width: 200, height: 20 });
  await m.fromHost(withItems([{ id: 'u1', ts: 1, role: 'user', text: 'word '.repeat(80) }]));
  const longest = Math.max(...m.frame().split(/\r?\n/).map((r) => r.trimEnd().length));
  expect(longest <= 104).toBe(true);
  expect(longest > 40).toBe(true);
});

test('the user\'s turn sits on the right of the measure, sized to its text', async () => {
  m = await mount(<Transcript sessionId="s1" focused />, { width: 80, height: 20 });
  await m.fromHost(withItems([{ id: 'u1', ts: 1, role: 'user', text: 'fix the tests' }]));
  const row = m.frame().split(/\r?\n/).find((r) => r.includes('fix the tests')) ?? '';
  expect(row.indexOf('fix the tests') > 40).toBe(true);
});

test('the selected bar stops at the last line of the message, not the spacer row', async () => {
  m = await mount(<Transcript sessionId="s1" focused />);
  await m.fromHost(withItems([{ id: 'u2', ts: 2, role: 'user', text: 'and lint' }, { id: 'u1', ts: 1, role: 'user', text: 'fix the tests' }]));
  await m.press('j');
  const rows = m.frame().split(/\r?\n/);
  const at = rows.findIndex((r) => r.includes('and lint'));
  const time = rows[at + 1] ?? '';
  expect(rows[at]?.includes('┃') && time.includes('┃')).toBe(true);
  expect(barRows().length).toBe(2);
  expect((rows[at + 2] ?? '').includes('┃')).toBe(false);
});

test('only the status mark of a failed tool row is red, not its name', async () => {
  m = await mount(<Transcript sessionId="s1" focused />);
  await m.fromHost(withItems([tool({ id: 't1', state: 'error' })]));
  expect(fgOf('✗') === '').toBe(false);
  expect(fgOf('Bash') === fgOf('✗')).toBe(false);
});

test('only the mark of a permission row is coloured', async () => {
  m = await mount(<Transcript sessionId="s1" focused />);
  await m.fromHost(withItems([permission({ id: 'p1', state: 'allowed' })]));
  expect(fgOf('✓') === '').toBe(false);
  expect(fgOf('allowed') === fgOf('✓')).toBe(false);
});

test('a finished tool card shows no status mark', async () => {
  m = await mount(<Transcript sessionId="s1" focused />);
  await m.fromHost(withItems([tool({ id: 't1', state: 'ok' })]));
  expect(m.frame()).toContain('Bash');
  expect(m.frame().includes('✓') || m.frame().includes('✗')).toBe(false);
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
  await paint('xxxx');
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
  await paint('Hello there');
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

const prepend = (items: TranscriptItem[], hasMore = true) =>
  ({ t: 'session-prepend', id: 's1', items, hasMore }) as const;

test('a prepend does not cascade another load-more and keeps the reader in place', async () => {
  m = await mount(<Transcript sessionId="s1" focused />, { width: 60, height: 10 });
  await m.fromHost(withItems(many(40), 'idle', true));
  await tick();
  for (let i = 0; i < 20; i++) { await m.press('pageup'); await tick(); }
  expect(m.frame()).toContain('m message 0');
  expect(loadMores().length).toBe(1);
  await m.fromHost(prepend(many(30, 'old')));
  await tick();
  await m.fromHost();
  await tick();
  await m.fromHost();
  expect(loadMores().length).toBe(1);
  expect(m.frame()).toContain('m message 0');
  await m.press('k');
  for (let i = 0; i < 80; i++) { await m.press('pageup'); await tick(); }
  expect(loadMores().length).toBe(2);
  expect(loadMores()[1]).toEqual({ t: 'load-more', id: 's1', beforeItemId: 'old0' });
});

test('the cursor stays on the same row after a prepend', async () => {
  m = await mount(<Transcript sessionId="s1" focused />, { width: 60, height: 12 });
  await m.fromHost(withItems([
    { id: 'u1', ts: 1, role: 'user', text: 'first' },
    tool({ id: 't1', tool: { kind: 'command', label: 'Bash', command: 'yarn x' }, output: { kind: 'text', text: 'BODYTEXT' } }),
  ], 'idle', true));
  await m.press('j');
  await m.press('j');
  await m.fromHost(prepend([{ id: 'o1', ts: 0, role: 'user', text: 'older' }]));
  await m.press('return');
  expect(m.frame()).toContain('BODYTEXT');
});

test('an unfocused transcript ignores j/k/Enter', async () => {
  m = await mount(<Transcript sessionId="s1" focused={false} />);
  await m.fromHost(withItems([tool({ id: 't1', output: { kind: 'text', text: 'BODYTEXT' } })]));
  await m.press('j');
  await m.press('return');
  expect(m.frame()).not.toContain('BODYTEXT');
});

test('two quick j presses both register', async () => {
  m = await mount(<Transcript sessionId="s1" focused />);
  await m.fromHost(withItems([
    { id: 'u1', ts: 1, role: 'user', text: 'first' },
    tool({ id: 't1', output: { kind: 'text', text: 'BODYTEXT' } }),
  ]));
  await act(async () => { m!.setup.mockInput.pressKey('j'); m!.setup.mockInput.pressKey('j'); });
  await m.fromHost();
  await m.press('return');
  expect(m.frame()).toContain('BODYTEXT');
});

test('Enter toggles a subagent and a user collapse sticks while it is still blocked', async () => {
  const blocked = () => withItems([tool({
    id: 'sa', ts: 1, state: 'running',
    tool: { kind: 'subagent', label: 'Task', action: 'spawn', agent: 'Explore' },
    children: [tool({ id: 'k1', toolId: 'tk1', ts: 2, tool: { kind: 'command', label: 'Bash', command: 'CHILDCMD' } }), permission({ id: 'pp', state: 'pending' })],
  })], 'running');
  m = await mount(<Transcript sessionId="s1" focused />);
  await m.fromHost(blocked());
  expect(m.frame()).toContain('CHILDCMD');
  await m.press('j');
  await m.press('return');
  expect(m.frame().includes('CHILDCMD')).toBe(false);
  await m.fromHost(blocked());
  expect(m.frame().includes('CHILDCMD')).toBe(false);
  await m.press('return');
  expect(m.frame()).toContain('CHILDCMD');
});
