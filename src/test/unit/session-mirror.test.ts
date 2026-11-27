import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { suite, test } from 'mocha';
import { readRemoteRoster } from '../../host/sync/remote-roster';
import { mirrorStoreDir, SessionMirror } from '../../host/sync/session-mirror';
import { TranscriptStore } from '../../host/transcript-store';
import type { SessionState, TranscriptItem } from '../../protocol/messages';
import { publishedState, type SessionPayload } from '../../sync/session-records';

const item = (id: string, text = id): TranscriptItem => ({ id, ts: 0, role: 'assistant', text });
const state: SessionState = {
  id: 's1', providerId: 'claude', model: 'm', title: 'T', name: 'n', cwd: '/w/repo', status: 'running', permissionMode: 'default',
  includeEditorContext: false, resumeTokens: {}, createdAt: 1, updatedAt: 2, projectId: 'github.com/a/b',
};
const meta: SessionPayload = { type: 'session-meta', v: 1, sessionId: 's1', projectId: 'github.com/a/b', relCwd: '.', branch: 'main', state: publishedState(state) };
const ops = (rev: number, ...list: Array<['append' | 'replace', TranscriptItem]>): SessionPayload =>
  ({ type: 'session-ops', v: 1, sessionId: 's1', rev, ops: list.map(([op, it]) => ({ op, item: it })) });

async function rig() {
  const root = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'marcode-mirror-')), 'mirror');
  const mirror = new SessionMirror(root);
  const items = async () => (await new TranscriptStore(mirrorStoreDir(root, 'devA')).tail('s1', 1000)).items;
  return { root, mirror, items };
}

suite('SessionMirror', () => {
  test('meta and ops become a roster row and a transcript a plain store can read', async () => {
    const r = await rig();
    await r.mirror.apply('devA', meta);
    await r.mirror.apply('devA', ops(1, ['append', item('a')]));
    await r.mirror.apply('devA', ops(2, ['append', item('b')]));
    await r.mirror.flush();
    const roster = await readRemoteRoster(r.root);
    assert.deepStrictEqual(roster.rows.map((x) => [x.deviceId, x.state.id, x.branch, x.rev]), [['devA', 's1', 'main', 2]]);
    assert.deepStrictEqual((await r.items()).map((i) => i.id), ['a', 'b']);
  });

  test('a replayed record leaves each item once, in order', async () => {
    const r = await rig();
    await r.mirror.apply('devA', meta);
    await r.mirror.apply('devA', ops(1, ['append', item('a')], ['append', item('b')]));
    await r.mirror.flush();
    await r.mirror.apply('devA', ops(1, ['append', item('a')], ['append', item('b')]));
    await r.mirror.flush();
    const fresh = new SessionMirror(r.root);
    await fresh.apply('devA', ops(1, ['append', item('a')], ['append', item('b')]));
    await fresh.flush();
    assert.deepStrictEqual((await r.items()).map((i) => i.id), ['a', 'b']);
    assert.strictEqual((await readRemoteRoster(r.root)).rows[0].gap, undefined);
  });

  test('a replace updates the item in place', async () => {
    const r = await rig();
    await r.mirror.apply('devA', meta);
    await r.mirror.apply('devA', ops(1, ['append', item('a', 'draft')], ['append', item('b')]));
    await r.mirror.flush();
    await r.mirror.apply('devA', ops(2, ['replace', item('a', 'final')]));
    await r.mirror.flush();
    const items = await r.items();
    assert.deepStrictEqual(items.map((i) => [i.id, 'text' in i ? i.text : '']), [['a', 'final'], ['b', 'b']]);
  });

  test('a replace of an item never seen is kept as an append', async () => {
    const r = await rig();
    await r.mirror.apply('devA', meta);
    await r.mirror.apply('devA', ops(1, ['replace', item('x')]));
    await r.mirror.flush();
    assert.deepStrictEqual((await r.items()).map((i) => i.id), ['x']);
  });

  test('a newer-format flag does not wipe presence written by an earlier holder', async () => {
    const r = await rig();
    await r.mirror.setDevices([{ deviceId: 'devA', name: 'PC-desk', online: true, lastSeenAt: 5 }]);
    await r.mirror.flush();
    const next = new SessionMirror(r.root);
    next.markNewerFormat('devA');
    await next.flush();
    assert.deepStrictEqual((await readRemoteRoster(r.root)).devices.map((d) => [d.name, d.newerFormat]), [['PC-desk', true]]);
  });

  test('a jump in rev marks a gap', async () => {
    const r = await rig();
    await r.mirror.apply('devA', meta);
    await r.mirror.apply('devA', ops(1, ['append', item('a')]));
    await r.mirror.apply('devA', ops(3, ['append', item('c')]));
    await r.mirror.flush();
    assert.strictEqual((await readRemoteRoster(r.root)).rows[0].gap, true);
  });

  test('ops that arrive before the meta are kept, and the row appears with the meta', async () => {
    const r = await rig();
    await r.mirror.apply('devA', ops(1, ['append', item('a')]));
    await r.mirror.flush();
    assert.strictEqual((await readRemoteRoster(r.root)).rows.length, 0);
    await r.mirror.apply('devA', meta);
    await r.mirror.flush();
    assert.strictEqual((await readRemoteRoster(r.root)).rows[0].rev, 1);
    assert.deepStrictEqual((await r.items()).map((i) => i.id), ['a']);
  });

  test('a delete drops the row and the transcript', async () => {
    const r = await rig();
    await r.mirror.apply('devA', meta);
    await r.mirror.apply('devA', ops(1, ['append', item('a')]));
    await r.mirror.flush();
    await r.mirror.apply('devA', { type: 'session-delete', v: 1, sessionId: 's1' });
    await r.mirror.flush();
    assert.strictEqual((await readRemoteRoster(r.root)).rows.length, 0);
    assert.strictEqual(await fs.stat(path.join(mirrorStoreDir(r.root, 'devA'), 'sessions', 's1.jsonl')).then(() => true, () => false), false);
  });

  test('device presence and a newer-format flag round-trip', async () => {
    const r = await rig();
    await r.mirror.setDevices([{ deviceId: 'devA', name: 'PC-desk', online: false, lastSeenAt: 5 }]);
    r.mirror.markNewerFormat('devA');
    await r.mirror.flush();
    assert.deepStrictEqual((await readRemoteRoster(r.root)).devices, [{ deviceId: 'devA', name: 'PC-desk', online: false, lastSeenAt: 5, newerFormat: true }]);
    await r.mirror.setDevices([{ deviceId: 'devA', name: 'PC-desk', online: true, lastSeenAt: 9 }]);
    await r.mirror.flush();
    assert.strictEqual((await readRemoteRoster(r.root)).devices[0].newerFormat, true);
  });

  test('a torn sessions file reads as no rows', async () => {
    const r = await rig();
    await fs.mkdir(mirrorStoreDir(r.root, 'devA'), { recursive: true });
    await fs.writeFile(path.join(mirrorStoreDir(r.root, 'devA'), 'sessions.json'), '{"rows": {');
    assert.deepStrictEqual((await readRemoteRoster(r.root)).rows, []);
    assert.deepStrictEqual((await readRemoteRoster(path.join(r.root, 'missing'))).rows, []);
  });
});
