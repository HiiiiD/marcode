import * as assert from 'assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SessionState, TranscriptItem } from '../../protocol/messages';
import { TranscriptStore } from '../../host/transcript-store';

const item = (id: string, text: string): TranscriptItem =>
  ({ id, ts: 1, role: 'assistant', text } as TranscriptItem);

function state(id: string): SessionState {
  return {
    id, providerId: 'fake', model: 'm', title: 't', name: id, cwd: '/w', status: 'idle',
    permissionMode: 'default', includeEditorContext: true, resumeTokens: {}, createdAt: 1, updatedAt: 1,
  } as SessionState;
}

suite('TranscriptStore (shared directory)', () => {
  let dir: string;
  setup(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-store-')); });
  teardown(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  const file = (id: string) => path.join(dir, 'sessions', `${id}.jsonl`);

  test('interleaved index writes from two stores leave one whole file and no temp files', async () => {
    const a = new TranscriptStore(dir);
    const b = new TranscriptStore(dir, 'tui');
    for (let i = 0; i < 6; i++) {
      await a.writeIndex({ version: 2, sessions: [state(`a${i}`)], layout: (await a.readIndex()).layout });
      await b.writeIndex({ version: 2, sessions: [state(`b${i}`)], layout: (await b.readIndex()).layout });
    }
    JSON.parse(await fs.readFile(path.join(dir, 'index.json'), 'utf8'));
    assert.deepStrictEqual((await fs.readdir(dir)).filter((n) => n.endsWith('.tmp')), []);
  });

  test('a tui host keeps its layout in its own file and leaves the vscode layout alone', async () => {
    const vs = new TranscriptStore(dir);
    const layout = { root: { kind: 'leaf' as const, sessionId: 'x', size: 100 }, presets: [] };
    await vs.writeIndex({ version: 2, sessions: [], layout });
    const tui = new TranscriptStore(dir, 'tui');
    await tui.writeIndex({ version: 2, sessions: [state('s')], layout: { root: { kind: 'leaf', sessionId: 'y', size: 100 }, presets: [] } });
    const vsRoot = (await new TranscriptStore(dir).readIndex()).layout.root;
    assert.strictEqual(vsRoot.kind === 'leaf' && vsRoot.sessionId === 'x', true);
    const tuiRoot = (await new TranscriptStore(dir, 'tui').readIndex()).layout.root;
    assert.strictEqual(tuiRoot.kind === 'leaf' && tuiRoot.sessionId === 'y', true);
  });

  test('a daemon host with no layout file of its own starts from the vscode layout', async () => {
    const layout = {
      root: {
        kind: 'split' as const, orientation: 'horizontal' as const, size: 100,
        children: [
          { kind: 'leaf' as const, sessionId: 'a', size: 50 },
          { kind: 'leaf' as const, sessionId: 'b', size: 50 },
        ],
      },
      presets: [],
    };
    await new TranscriptStore(dir).writeIndex({ version: 2, sessions: [state('a'), state('b')], layout });
    const seeded = (await new TranscriptStore(dir, 'daemon').readIndex()).layout;
    assert.deepStrictEqual(seeded, layout);
  });

  test('once a daemon host has its own layout file, the vscode layout no longer seeds it', async () => {
    const vs = new TranscriptStore(dir);
    await vs.writeIndex({ version: 2, sessions: [state('a')], layout: { root: { kind: 'leaf', sessionId: 'a', size: 100 }, presets: [] } });
    const daemon = new TranscriptStore(dir, 'daemon');
    await daemon.writeIndex({ version: 2, sessions: [state('a')], layout: { root: { kind: 'leaf', sessionId: null, size: 100 }, presets: [] } });
    const root = (await new TranscriptStore(dir, 'daemon').readIndex()).layout.root;
    assert.strictEqual(root.kind === 'leaf' && root.sessionId === null, true);
  });

  test('a foreign session is never written: append, replace, flush and remove are no-ops', async () => {
    const owner = new TranscriptStore(dir);
    owner.append('s1', item('i1', 'one'));
    await owner.flush('s1');
    const before = await fs.readFile(file('s1'), 'utf8');

    const guest = new TranscriptStore(dir, 'tui');
    guest.markForeign('s1');
    guest.append('s1', item('i2', 'two'));
    guest.replace('s1', item('i1', 'CHANGED'));
    await guest.flush();
    await guest.flush('s1');
    await guest.remove('s1');
    assert.strictEqual(await fs.readFile(file('s1'), 'utf8'), before);
  });

  test('clearForeign makes the store writable again and drops the stale cache', async () => {
    const owner = new TranscriptStore(dir);
    owner.append('s1', item('i1', 'one'));
    await owner.flush('s1');
    const guest = new TranscriptStore(dir, 'tui');
    guest.markForeign('s1');
    await guest.tail('s1');
    owner.append('s1', item('i2', 'two'));
    await owner.flush('s1');
    guest.clearForeign('s1');
    assert.strictEqual((await guest.tail('s1')).items.length, 2);
    guest.append('s1', item('i3', 'three'));
    await guest.flush('s1');
    assert.strictEqual((await fs.readFile(file('s1'), 'utf8')).trim().split('\n').length, 3);
  });

  test('reloadFromDisk reports appended and replaced items', async () => {
    const owner = new TranscriptStore(dir);
    owner.append('s1', item('i1', 'one'));
    await owner.flush('s1');
    const guest = new TranscriptStore(dir, 'tui');
    guest.markForeign('s1');
    await guest.tail('s1');

    owner.append('s1', item('i2', 'two'));
    owner.replace('s1', item('i1', 'ONE'));
    await owner.flush('s1');

    const delta = await guest.reloadFromDisk('s1');
    assert.deepStrictEqual(delta.appended.map((i) => i.id), ['i2']);
    assert.deepStrictEqual(delta.replaced.map((i) => i.id), ['i1']);
    assert.deepStrictEqual(await guest.reloadFromDisk('s1'), { appended: [], replaced: [] });
  });

  test('a torn trailing line while the owner is mid-append is not reported as corruption', async () => {
    const guest = new TranscriptStore(dir, 'tui');
    guest.markForeign('s1');
    await fs.mkdir(path.join(dir, 'sessions'), { recursive: true });
    await fs.writeFile(file('s1'), `${JSON.stringify(item('i1', 'one'))}\n{"id":"i2","ts":1,"ro`);
    const delta = await guest.reloadFromDisk('s1');
    assert.deepStrictEqual(delta.appended.map((i) => i.id), ['i1']);
    await fs.writeFile(file('s1'), `${JSON.stringify(item('i1', 'one'))}\n${JSON.stringify(item('i2', 'two'))}\n`);
    assert.deepStrictEqual((await guest.reloadFromDisk('s1')).appended.map((i) => i.id), ['i2']);
  });
});
