import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { suite, test } from 'mocha';
import { gitBranch } from '../../host/project/git-branch';
import { SessionPublisher } from '../../host/sync/session-publisher';
import { TranscriptStore } from '../../host/transcript-store';
import type { SessionState, TranscriptItem } from '../../protocol/messages';
import type { SessionPayload } from '../../sync/session-records';
import { SyncState } from '../../sync/sync-state';

const item = (id: string, text = id): TranscriptItem => ({ id, ts: 0, role: 'user', text });
const session = (over: Partial<SessionState> = {}): SessionState => ({
  id: 's1', providerId: 'claude', model: 'm', title: 'T', name: 'n', cwd: '/w/repo/src', status: 'idle', permissionMode: 'default',
  includeEditorContext: false, resumeTokens: {}, createdAt: 1, updatedAt: 2, projectId: 'github.com/a/b', ...over,
});

async function rig(publishable: (id: string) => SessionState | undefined) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'marcode-spub-'));
  const state = new SyncState(path.join(dir, 'state.sqlite'));
  const store = new TranscriptStore(path.join(dir, 'ws'));
  const pub = new SessionPublisher({
    store, state, excluded: ['github.com/secret/repo'], publishable,
    relCwd: async () => 'src', branch: async () => 'main',
  });
  pub.start();
  const settle = () => new Promise((r) => setTimeout(r, 30));
  const payloads = () => state.peek(1000).map((r) => r.payload as SessionPayload);
  return { dir, state, store, pub, settle, payloads };
}

suite('SessionPublisher', () => {
  test('a first write publishes meta then the whole transcript; later writes get the next rev', async () => {
    const s = session();
    const r = await rig((id) => (id === 's1' ? s : undefined));
    r.store.append('s1', item('a'));
    await r.store.flush('s1');
    await r.settle();
    const first = r.payloads();
    assert.deepStrictEqual(first.map((p) => p.type), ['session-meta', 'session-ops']);
    assert.strictEqual(first[0].type === 'session-meta' && first[0].relCwd, 'src');
    assert.strictEqual(first[0].type === 'session-meta' && first[0].branch, 'main');
    assert.strictEqual(first[1].type === 'session-ops' && first[1].rev, 1);
    r.store.append('s1', item('b'));
    await r.store.flush('s1');
    await r.settle();
    const last = r.payloads().at(-1)!;
    assert.strictEqual(last.type === 'session-ops' && last.rev, 2);
    assert.deepStrictEqual(last.type === 'session-ops' && last.ops.map((o) => o.item.id), ['b']);
  });

  test('a local project, an excluded one, a side chat or an id not owned here publish nothing', async () => {
    const byId: Record<string, SessionState> = {
      l: session({ id: 'l', projectId: 'local:/x' }),
      e: session({ id: 'e', projectId: 'github.com/secret/repo' }),
      n: session({ id: 'n', projectId: undefined }),
    };
    const r = await rig((id) => byId[id]);
    for (const id of ['l', 'e', 'n', 'foreign']) { r.store.append(id, item(`${id}1`)); await r.store.flush(id); }
    await r.settle();
    assert.strictEqual(r.state.outboxSize(), 0);
  });

  test('publishMeta enqueues only when what other devices see changed', async () => {
    let s = session();
    const r = await rig(() => s);
    await r.pub.publishMeta([s]);
    await r.pub.publishMeta([s]);
    assert.strictEqual(r.state.outboxSize(), 1);
    s = session({ title: 'Renamed' });
    await r.pub.publishMeta([s]);
    assert.strictEqual(r.state.outboxSize(), 2);
    s = session({ title: 'Renamed', draft: 'typing…', pinned: true });
    await r.pub.publishMeta([s]);
    assert.strictEqual(r.state.outboxSize(), 2);
  });

  test('backfill publishes an existing session once', async () => {
    const s = session();
    const r = await rig(() => s);
    const writer = new TranscriptStore(r.store.root);
    for (const id of ['a', 'b', 'c']) { writer.append('s1', item(id)); }
    await writer.flush('s1');
    assert.strictEqual(await r.pub.backfill([s]), 1);
    assert.strictEqual(await r.pub.backfill([s]), 0);
    const p = r.payloads();
    assert.deepStrictEqual(p.map((x) => x.type), ['session-meta', 'session-ops']);
    assert.deepStrictEqual(p[1].type === 'session-ops' && p[1].ops.map((o) => o.item.id), ['a', 'b', 'c']);
  });

  test('removing a published session sends a tombstone; an unpublished one sends nothing', async () => {
    const r = await rig((id) => session({ id }));
    r.store.append('s1', item('a'));
    await r.store.flush('s1');
    await r.settle();
    await r.store.remove('s1');
    await r.store.remove('never');
    await r.settle();
    assert.deepStrictEqual(r.payloads().filter((p) => p.type === 'session-delete').map((p) => p.sessionId), ['s1']);
  });

  test('a broken sync state never breaks the transcript write', async () => {
    const r = await rig(() => session());
    r.state.close();
    r.store.append('s1', item('a'));
    await r.store.flush('s1');
    await r.settle();
    assert.strictEqual((await new TranscriptStore(r.store.root).tail('s1')).items.length, 1);
  });

  test('gitBranch reads the branch and is undefined outside a repo', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'marcode-branch-'));
    assert.strictEqual(await gitBranch(dir), undefined);
    execFileSync('git', ['init', '-q', '-b', 'feat/x', dir]);
    execFileSync('git', ['-C', dir, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'i']);
    assert.strictEqual(await gitBranch(dir), 'feat/x');
  });
});
