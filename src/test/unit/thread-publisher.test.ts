import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { suite, test } from 'mocha';
import { SessionManager } from '../../host/session-manager';
import { ThreadPublisher } from '../../host/sync/thread-publisher';
import { TranscriptStore } from '../../host/transcript-store';
import type { SessionState } from '../../protocol/messages';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { AgentProvider } from '../../providers/types';
import type { AttachmentChunkPayload, ThreadChunkPayload } from '../../sync/move-records';
import { SyncState } from '../../sync/sync-state';

const session = (over: Partial<SessionState> = {}): SessionState => ({
  id: 's1', providerId: 'threads', model: 'm', title: 'T', name: 'n', cwd: '/w/repo', status: 'idle', permissionMode: 'default',
  includeEditorContext: false, resumeTokens: { 'threads:/w/repo': 'tok' }, createdAt: 1, updatedAt: 2, projectId: 'github.com/a/b', ...over,
});

async function rig(state = session()) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-threads-'));
  const file = path.join(dir, 'tok.jsonl');
  const sync = new SyncState(path.join(dir, 'state.sqlite'));
  const threads = Object.assign(new FakeProvider(), {
    id: 'threads', threadScope: 'cwd' as const,
    threadFiles: async () => (await fs.stat(file).then(() => true, () => false) ? [file] : []),
  }) as unknown as AgentProvider;
  const pub = new ThreadPublisher({
    state: sync, providers: new Map<string, AgentProvider>([['threads', threads], ['fake', new FakeProvider()]]),
    publishable: (id) => (id === state.id ? state : undefined), excluded: [],
  });
  const chunks = () => sync.peek(1000).map((r) => r.payload as ThreadChunkPayload | AttachmentChunkPayload);
  return { dir, file, sync, pub, chunks };
}

suite('ThreadPublisher', () => {
  test('a turn end uploads the thread from the start, then only what was appended', async () => {
    const r = await rig();
    await fs.writeFile(r.file, 'a'.repeat(1000));
    assert.deepStrictEqual(await r.pub.turnEnded('s1'), { generation: 1, bytes: 1000 });
    await fs.appendFile(r.file, 'b'.repeat(10 * 1024));
    await r.pub.turnEnded('s1');
    const all = r.chunks();
    assert.deepStrictEqual(all.map((c) => [c.type, c.offset, c.generation]), [['thread-chunk', 0, 1], ['thread-chunk', 1000, 1]]);
    assert.strictEqual(await r.pub.turnEnded('s1').then(() => r.chunks().length), 2);
  });

  test('a thread file that shrank starts a new generation from the first byte', async () => {
    const r = await rig();
    await fs.writeFile(r.file, 'a'.repeat(1000));
    await r.pub.turnEnded('s1');
    await fs.writeFile(r.file, 'c'.repeat(10));
    assert.deepStrictEqual(await r.pub.turnEnded('s1'), { generation: 2, bytes: 10 });
    assert.deepStrictEqual(r.chunks().at(-1) && [r.chunks().at(-1)!.offset, r.chunks().at(-1)!.generation], [0, 2]);
  });

  test('no thread hook, no token or a local project uploads nothing', async () => {
    const r = await rig(session({ projectId: 'local:/w' }));
    await fs.writeFile(r.file, 'a');
    assert.strictEqual(await r.pub.turnEnded('s1'), undefined);
    assert.strictEqual(await r.pub.turnEnded('other'), undefined);
    assert.strictEqual(r.sync.outboxSize(), 0);
  });

  test('a 600 KiB attachment goes up in three chunks', async () => {
    const r = await rig();
    const img = path.join(r.dir, 'shot.png');
    await fs.writeFile(img, Buffer.alloc(600 * 1024, 1));
    await r.pub.attachments('s1', [{ attachmentId: 'a1', name: 'shot.png', mime: 'image/png', path: img }]);
    assert.deepStrictEqual(r.chunks().map((c) => c.type), ['attachment', 'attachment', 'attachment']);
  });

  test('a closed sync state never throws out of a turn end', async () => {
    const r = await rig();
    await fs.writeFile(r.file, 'a');
    r.sync.close();
    assert.strictEqual(await r.pub.turnEnded('s1'), undefined);
  });

  test('the manager reports the end of a turn', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-turn-'));
    const manager = new SessionManager(new TranscriptStore(dir), new Map([['fake', new FakeProvider(() => [{ kind: 'text', delta: 'ok' }, { kind: 'turn-end', reason: 'done' }])]]), () => {});
    const ended: string[] = [];
    manager.setTurnListener((id) => { ended.push(id); });
    await manager.init();
    const s = await manager.create('fake', dir);
    s.send('hi');
    const deadline = Date.now() + 3000;
    while (!ended.includes(s.state.id) && Date.now() < deadline) { await new Promise((res) => setTimeout(res, 10)); }
    assert.strictEqual(ended.includes(s.state.id), true);
    await manager.dispose();
  });
});
