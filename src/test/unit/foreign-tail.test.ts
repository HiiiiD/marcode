import * as assert from 'assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TranscriptItem, TranscriptPatch } from '../../protocol/messages';
import { ForeignTail } from '../../host/foreign-tail';
import { TranscriptStore } from '../../host/transcript-store';

const item = (id: string, text: string): TranscriptItem => ({ id, ts: 1, role: 'assistant', text } as TranscriptItem);
const until = async (ok: () => boolean) => { for (let i = 0; i < 100 && !ok(); i++) { await new Promise((r) => setTimeout(r, 10)); } };

suite('ForeignTail', () => {
  let dir: string;
  setup(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-tail-')); });
  teardown(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  test('it turns the owner\'s flushed writes into append and replace patches', async () => {
    const owner = new TranscriptStore(dir);
    owner.append('s1', item('i1', 'one'));
    await owner.flush('s1');
    const guest = new TranscriptStore(dir, 'tui');
    guest.markForeign('s1');
    await guest.tail('s1');
    const patches: TranscriptPatch[] = [];
    const tail = new ForeignTail({
      id: 's1', file: path.join(dir, 'sessions', 's1.jsonl'), store: guest, intervalMs: 10,
      stillForeign: async () => true, onPatch: (p) => patches.push(p), onFree: () => {},
    });
    tail.start();
    owner.append('s1', item('i2', 'two'));
    owner.replace('s1', item('i1', 'ONE'));
    await owner.flush('s1');
    await until(() => patches.length >= 2);
    tail.stop();
    assert.deepStrictEqual(patches.map((p) => p.op).sort(), ['append', 'replace']);
  });

  test('it stops and reports when the owner is gone', async () => {
    let free = 0;
    let foreign = true;
    const tail = new ForeignTail({
      id: 's1', file: path.join(dir, 'x.jsonl'), store: new TranscriptStore(dir, 'tui'), intervalMs: 10,
      stillForeign: async () => foreign, onPatch: () => {}, onFree: () => { free++; },
    });
    tail.start();
    foreign = false;
    await until(() => free > 0);
    await new Promise((r) => setTimeout(r, 40));
    assert.strictEqual(free, 1);
  });
});
