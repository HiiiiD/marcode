import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { Composer } from '../../tui/ui/composer';
import { snapshot, summary } from '../fixtures/protocol';
import { hydrateMsg, mount, type Mounted } from './harness';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });

const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const settleEscape = async () => { await wait(100); await m!.setup.renderOnce(); };
const searches = () => m!.posted.filter((p) => p.t === 'file-search');
const sends = () => m!.posted.filter((p) => p.t === 'send');
const files = [
  { path: 'src/app.ts', name: 'app.ts' },
  { path: 'docs/app.md', name: 'app.md' },
];

async function open() {
  m = await mount(<Composer sessionId="s1" focused />);
  await m.fromHost(hydrateMsg({ snapshots: [snapshot('s1')] }));
}

test('typing @ap debounces one file-search for the live query', async () => {
  await open();
  await m!.type('look at @ap');
  await wait(250);
  expect(searches().length).toBe(1);
  expect(searches()[0]).toEqual({ t: 'file-search', id: 's1', query: 'ap' });
});

test('results for the live query render and Enter inserts the token instead of sending', async () => {
  await open();
  await m!.type('look at @ap');
  await wait(250);
  await m!.fromHost({ t: 'file-search-result', id: 's1', query: 'ap', files });
  expect(m!.frame()).toContain('src/app.ts');
  await m!.press('return');
  expect(sends().length).toBe(0);
  expect(m!.frame()).toContain('@src/app.ts');
  await m!.press('return');
  expect(sends().length).toBe(1);
  const msg = sends()[0];
  expect(msg.t === 'send' && msg.fileRefs).toEqual([{ path: 'src/app.ts', name: 'app.ts' }]);
});

test('Down then Tab picks the second row', async () => {
  await open();
  await m!.type('@ap');
  await wait(250);
  await m!.fromHost({ t: 'file-search-result', id: 's1', query: 'ap', files });
  await m!.press('down');
  await m!.press('tab');
  expect(m!.frame()).toContain('@docs/app.md');
});

test('a result for an older query is ignored', async () => {
  await open();
  await m!.type('@ap');
  await wait(250);
  await m!.type('p');
  await m!.fromHost({ t: 'file-search-result', id: 's1', query: 'ap', files });
  expect(m!.frame().includes('src/app.ts')).toBe(false);
});

test('Esc dismisses the popup and Enter then sends', async () => {
  await open();
  await m!.type('@ap');
  await wait(250);
  await m!.fromHost({ t: 'file-search-result', id: 's1', query: 'ap', files });
  await m!.press('escape');
  await settleEscape();
  expect(m!.frame().includes('src/app.ts')).toBe(false);
  await m!.press('return');
  expect(sends().length).toBe(1);
});

test('@ inside an email address or mid-word never opens the popup', async () => {
  await open();
  await m!.type('mail me@host.com and a@b');
  await wait(250);
  expect(searches().length).toBe(0);
});

test('a mention whose token was deleted before sending carries no fileRef', async () => {
  await open();
  await m!.type('@ap');
  await wait(250);
  await m!.fromHost({ t: 'file-search-result', id: 's1', query: 'ap', files });
  await m!.press('return');
  for (let i = 0; i < '@src/app.ts '.length; i++) { await m!.press('backspace'); }
  await m!.type('hello');
  await m!.press('return');
  const msg = sends()[0];
  expect(msg.t === 'send' && 'fileRefs' in msg).toBe(false);
});

test('a mention sent once is not remembered: picking the same file again keeps the plain token', async () => {
  await open();
  await m!.type('fix @ap');
  await wait(250);
  await m!.fromHost({ t: 'file-search-result', id: 's1', query: 'ap', files });
  await m!.press('return');
  await m!.press('return');
  expect(sends().length).toBe(1);
  await m!.type('@ap');
  await wait(250);
  await m!.fromHost({ t: 'file-search-result', id: 's1', query: 'ap', files });
  await m!.press('return');
  expect(m!.frame()).toContain('@src/app.ts');
  expect(m!.frame().includes('app.ts-2')).toBe(false);
});

const pickedFrame = async (text: string) => {
  await m!.type(text);
  await wait(250);
  await m!.fromHost({ t: 'file-search-result', id: 's1', query: 'ap', files });
};

test('an older result landing after the live one triggers a fresh search for the live query', async () => {
  await open();
  await m!.type('@ap');
  await wait(250);
  await m!.type('p');
  await wait(250);
  await m!.fromHost({ t: 'file-search-result', id: 's1', query: 'app', files });
  expect(m!.frame()).toContain('src/app.ts');
  await m!.fromHost({ t: 'file-search-result', id: 's1', query: 'ap', files });
  await wait(250);
  expect(searches().filter((s) => s.t === 'file-search' && s.query === 'app').length).toBe(2);
});

test('a draft that ends in an @ token does not open the popup', async () => {
  m = await mount(<Composer sessionId="s1" focused />);
  await m.fromHost(hydrateMsg({ sessions: [{ ...summary('s1'), draft: 'see @ap' }] }));
  await wait(250);
  expect(searches().length).toBe(0);
});

test('picking a mention mid-text leaves the caret after the token', async () => {
  await open();
  await m!.type('a @ap b');
  for (let i = 0; i < 2; i++) { await m!.press('left'); }
  await wait(250);
  await m!.fromHost({ t: 'file-search-result', id: 's1', query: 'ap', files });
  await m!.press('return');
  await m!.type('X');
  expect(m!.frame()).toContain('a @src/app.ts X b');
});

test('moving the caret back into an @ token with the arrow keys reopens the popup', async () => {
  await open();
  await pickedFrame('@ap');
  await m!.type(' x');
  expect(m!.frame().includes('docs/app.md')).toBe(false);
  await m!.press('left');
  await m!.press('left');
  expect(m!.frame()).toContain('docs/app.md');
});

test('after Esc, a fresh @ opens the popup again and nothing searches while dismissed', async () => {
  await open();
  await pickedFrame('@ap');
  await m!.press('escape');
  await settleEscape();
  const before = searches().length;
  await m!.type('p');
  await wait(250);
  expect(searches().length).toBe(before);
  for (let i = 0; i < 4; i++) { await m!.press('backspace'); }
  await m!.type('@ap');
  await wait(250);
  expect(searches().length).toBeGreaterThan(before);
});

test('typing dismisses attachment rejections', async () => {
  await open();
  await m!.fromHost({ t: 'attachments-rejected', id: 's1', reasons: ['too big: huge.bin'] });
  expect(m!.frame()).toContain('too big: huge.bin');
  await m!.type('h');
  expect(m!.frame().includes('too big: huge.bin')).toBe(false);
});

test('Ctrl+A selects the whole composer, so the next key replaces it', async () => {
  await open();
  await m!.type('first line');
  await m!.press('linefeed');
  await m!.type('second line');
  await m!.press('a', { ctrl: true });
  await m!.type('X');
  expect(m!.frame()).toContain('X');
  expect(m!.frame().includes('first line') || m!.frame().includes('second line')).toBe(false);
});
