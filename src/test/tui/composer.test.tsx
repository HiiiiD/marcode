import { afterEach, expect, test } from 'bun:test';
import { Composer } from '../../tui/ui/composer';
import { hydrateMsg, mount, type Mounted } from './harness';
import { snapshot, summary } from '../fixtures/protocol';
import type { TranscriptItem } from '../../protocol/messages';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });

const sends = () => m!.posted.filter((p) => p.t === 'send');
const drafts = () => m!.posted.filter((p) => p.t === 'set-draft');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const withPrompts = (...texts: string[]) => {
  const items: TranscriptItem[] = texts.map((text, i) => ({ id: `u${i}`, ts: i, role: 'user', text }));
  return hydrateMsg({ sessions: [summary('s1')], snapshots: [snapshot('s1', { items })] });
};

test('Enter posts send with the typed text and clears the box', async () => {
  m = await mount(<Composer sessionId="s1" focused />);
  await m.fromHost(hydrateMsg());
  await m.type('fix the tests');
  await m.press('return');
  expect(sends()).toEqual([{ t: 'send', id: 's1', text: 'fix the tests' }]);
  expect(m.frame()).not.toContain('fix the tests');
  expect(drafts().at(-1)).toEqual({ t: 'set-draft', id: 's1', text: '' });
});

test('a blank Enter sends nothing', async () => {
  m = await mount(<Composer sessionId="s1" focused />);
  await m.fromHost(hydrateMsg());
  await m.type('   ');
  await m.press('return');
  expect(sends().length).toBe(0);
});

test('Ctrl+J (linefeed) inserts a newline instead of sending', async () => {
  m = await mount(<Composer sessionId="s1" focused />);
  await m.fromHost(hydrateMsg());
  await m.type('line one');
  await m.press('linefeed');
  await m.type('line two');
  const lines = m.frame().split('\n');
  expect(lines.some((l) => l.includes('line one') && !l.includes('line two'))).toBe(true);
  expect(lines.some((l) => l.includes('line two') && !l.includes('line one'))).toBe(true);
  expect(sends().length).toBe(0);
});

test('Alt+Enter inserts a newline instead of sending', async () => {
  m = await mount(<Composer sessionId="s1" focused />);
  await m.fromHost(hydrateMsg());
  await m.type('line one');
  await m.press('return', { meta: true });
  await m.type('line two');
  const lines = m.frame().split('\n');
  expect(lines.some((l) => l.includes('line one') && !l.includes('line two'))).toBe(true);
  expect(lines.some((l) => l.includes('line two') && !l.includes('line one'))).toBe(true);
  expect(sends().length).toBe(0);
});

test('a multi-line message is sent whole', async () => {
  m = await mount(<Composer sessionId="s1" focused />);
  await m.fromHost(hydrateMsg());
  await m.type('a');
  await m.press('linefeed');
  await m.type('b');
  await m.press('return');
  expect(sends()).toEqual([{ t: 'send', id: 's1', text: 'a\nb' }]);
});

test('Up recalls the previous prompt when the box is empty, repeated Up walks back', async () => {
  m = await mount(<Composer sessionId="s1" focused />);
  await m.fromHost(withPrompts('first prompt', 'second prompt'));
  await m.press('up');
  expect(m.frame()).toContain('second prompt');
  await m.press('up');
  expect(m.frame()).toContain('first prompt');
  expect(m.frame()).not.toContain('second prompt');
  await m.press('up');
  expect(m.frame()).toContain('first prompt');
});

test('Up does nothing while the cursor is past the start of typed text', async () => {
  m = await mount(<Composer sessionId="s1" focused />);
  await m.fromHost(withPrompts('earlier prompt'));
  await m.type('draft');
  await m.press('up');
  expect(m.frame()).toContain('draft');
  expect(m.frame()).not.toContain('earlier prompt');
});

test('a typed character resets the walk', async () => {
  m = await mount(<Composer sessionId="s1" focused />);
  await m.fromHost(withPrompts('first prompt', 'second prompt'));
  await m.press('up');
  await m.press('up');
  expect(m.frame()).toContain('first prompt');
  await m.type('!');
  await m.press('home');
  await m.press('up');
  expect(m.frame()).toContain('second prompt');
});

test('queued messages render dim above the box and the placeholder shows Working', async () => {
  m = await mount(<Composer sessionId="s1" focused />);
  await m.fromHost(hydrateMsg({
    sessions: [summary('s1', { status: 'running', queued: [{ id: 'q1', text: 'then run lint' }] })],
    snapshots: [snapshot('s1', { status: 'running', queued: [{ id: 'q1', text: 'then run lint' }] })],
  }));
  expect(m.frame()).toContain('queued: then run lint');
  expect(m.frame()).toContain('Working… Esc to interrupt');
});

test('the idle placeholder explains the chords', async () => {
  m = await mount(<Composer sessionId="s1" focused />);
  await m.fromHost(hydrateMsg());
  expect(m.frame()).toContain('Message — Enter send, Ctrl+J newline');
});

test('a draft from the host seeds the box', async () => {
  m = await mount(<Composer sessionId="s1" focused />);
  await m.fromHost(hydrateMsg({ sessions: [summary('s1', { draft: 'half written' })], snapshots: [snapshot('s1')] }));
  expect(m.frame()).toContain('half written');
});

test('typing posts one debounced set-draft with the latest text', async () => {
  m = await mount(<Composer sessionId="s1" focused />);
  await m.fromHost(hydrateMsg());
  await m.type('abc');
  expect(drafts().length).toBe(0);
  await wait(350);
  expect(drafts()).toEqual([{ t: 'set-draft', id: 's1', text: 'abc' }]);
});

test('unmounting flushes a pending draft and leaves no timer behind', async () => {
  m = await mount(<Composer sessionId="s1" focused />);
  await m.fromHost(hydrateMsg());
  await m.type('abc');
  m.destroy();
  const posted = m.posted;
  expect(posted.filter((p) => p.t === 'set-draft')).toEqual([{ t: 'set-draft', id: 's1', text: 'abc' }]);
  await wait(350);
  expect(posted.filter((p) => p.t === 'set-draft').length).toBe(1);
  m = undefined;
});

test('an unfocused composer ignores keys', async () => {
  m = await mount(<Composer sessionId="s1" focused={false} />);
  await m.fromHost(withPrompts('earlier prompt'));
  await m.type('nope');
  await m.press('up');
  await m.press('return');
  expect(m.frame()).not.toContain('nope');
  expect(m.frame()).not.toContain('earlier prompt');
  expect(sends().length).toBe(0);
});
