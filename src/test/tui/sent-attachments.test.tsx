import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { makeTmp, mountBooted } from './e2e-harness';

const tmps: string[] = [];
afterEach(async () => { for (const t of tmps.splice(0)) { await fs.rm(t, { recursive: true, force: true }); } });

async function sendWithFiles(names: string[]) {
  const tmp = await makeTmp();
  tmps.push(tmp);
  const m = await mountBooted({ home: `${tmp}/home`, cwd: tmp, prompt: 'hello' });
  await m.waitFrame((f) => f.includes('hello'));
  const asked: { attachmentId: string; itemId: string | undefined }[] = [];
  const mgr = m.booted.host.manager as unknown as { attachmentPath: (id: string, attachmentId: string, itemId?: string) => Promise<string | undefined> };
  mgr.attachmentPath = async (_id, attachmentId, itemId) => { asked.push({ attachmentId, itemId }); return undefined; };
  for (const name of names) {
    await fs.writeFile(`${tmp}/${name}`, 'x');
    await m.type(`/attach ${tmp}/${name}`);
    await m.press('return');
    await m.settle(300);
  }
  await m.type('with files');
  await m.press('return');
  await m.waitFrame((f) => f.includes(names[0] ?? ''));
  await m.settle(500);
  await m.press('tab');
  await m.press('k');
  await m.press('k');
  return { m, asked };
}

test('Enter on a selected message opens its first attachment', async () => {
  const { m, asked } = await sendWithFiles(['a.txt', 'b.txt']);
  try {
    await m.press('return');
    await m.settle(300);
    expect(asked.length).toBe(1);
    expect(asked[0]?.itemId !== undefined).toBe(true);
  } finally { await m.destroy(); }
});

test('l walks to the next attachment and Enter opens that one', async () => {
  const { m, asked } = await sendWithFiles(['a.txt', 'b.txt']);
  try {
    await m.press('l');
    await m.press('l');
    await m.press('return');
    await m.settle(300);
    await m.press('h');
    await m.press('return');
    await m.settle(300);
    expect(asked.length).toBe(2);
    expect(asked[0]?.attachmentId === asked[1]?.attachmentId).toBe(false);
  } finally { await m.destroy(); }
});
