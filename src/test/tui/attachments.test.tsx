import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { act } from 'react';
import { App } from '../../tui/ui/app';
import { Composer } from '../../tui/ui/composer';
import { snapshot } from '../fixtures/protocol';
import { hydrateMsg, mount, type Mounted } from './harness';

let m: Mounted | undefined;
let dir = '';
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'marcode-attach-')); });
afterEach(() => { m?.destroy(); m = undefined; rmSync(dir, { recursive: true, force: true }); });

const drops = () => m!.posted.filter((p) => p.t === 'attach-drop');
const sends = () => m!.posted.filter((p) => p.t === 'send');
const paste = async (text: string) => {
  await act(async () => { await m!.setup.mockInput.pasteBracketedText(text); });
  await m!.setup.renderOnce();
};
const file = (name: string) => { const p = join(dir, name); writeFileSync(p, 'x'); return p; };
const attachment = { id: 'a1', path: '/x/shot.png', name: 'shot.png', kind: 'image' as const, bytes: 2048 };

async function open() {
  m = await mount(<Composer sessionId="s1" focused />);
  await m.fromHost(hydrateMsg({ snapshots: [snapshot('s1')] }));
}

test('pasting an existing file path attaches it and inserts no text', async () => {
  await open();
  const p = file('a b.txt');
  await paste(`"${p}"\n`);
  expect(drops()).toEqual([{ t: 'attach-drop', id: 's1', uris: [pathToFileURL(p).href] }]);
  await m!.press('return');
  expect(sends().length).toBe(0);
});

test('pasting prose, a missing path or a directory inserts as text and attaches nothing', async () => {
  await open();
  await paste(`see ${file('c.txt')} please`);
  expect(m!.frame()).toContain('please');
  await paste(join(dir, 'missing.txt'));
  await paste(dir);
  expect(drops().length).toBe(0);
});

test('/attach <path> attaches and clears the box; a bad path keeps the text and says why', async () => {
  m = await mount(<App launchCwd="/repo" forceNew={false} loginCommands={{}} onQuit={() => {}} />);
  await m.fromHost(hydrateMsg({ snapshots: [snapshot('s1')] }));
  const p = file('d.txt');
  await m.type(`/attach ${p}`);
  await m.press('return');
  expect(drops().length).toBe(1);
  expect(sends().length).toBe(0);
  await m.type('/attach nope.txt');
  await m.press('return');
  expect(drops().length).toBe(1);
  expect(m.frame()).toContain('attach: path not found');
  expect(m.frame()).toContain('/attach nope.txt');
});

test('chips list name and size; Ctrl+X removes the last one', async () => {
  await open();
  await m!.fromHost({
    t: 'session-attachments', id: 's1',
    attachments: [attachment, { ...attachment, id: 'a2', name: 'log.txt', kind: 'file', bytes: 10 }],
  });
  expect(m!.frame()).toContain('shot.png');
  expect(m!.frame()).toContain('log.txt');
  await m!.press('x', { ctrl: true });
  expect(m!.posted).toContainEqual({ t: 'attach-remove', id: 's1', attachmentId: 'a2' });
});

test('Ctrl+X with no chips posts nothing', async () => {
  await open();
  await m!.press('x', { ctrl: true });
  expect(m!.posted.some((p) => p.t === 'attach-remove')).toBe(false);
});

test('rejection reasons render under the chips and clear on the next attachments update', async () => {
  await open();
  await m!.fromHost({ t: 'attachments-rejected', id: 's1', reasons: ['A turn can carry up to 10 attachments.'] });
  expect(m!.frame()).toContain('up to 10 attachments');
  await m!.fromHost({ t: 'session-attachments', id: 's1', attachments: [] });
  expect(m!.frame().includes('up to 10 attachments')).toBe(false);
});
