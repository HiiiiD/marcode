import * as assert from 'assert';
import type { SessionState } from '../../protocol/messages';
import { mergeRoster } from '../../host/roster-sync';

const s = (id: string, over: Partial<SessionState> = {}): SessionState => ({
  id, providerId: 'fake', model: 'm', title: id, name: id, cwd: '/w', status: 'idle',
  permissionMode: 'default', includeEditorContext: true, resumeTokens: {}, createdAt: 1, updatedAt: 1, ...over,
} as SessionState);

const owner = { host: 'vscode' as const, pid: 7 };

suite('mergeRoster', () => {
  test('a session only on disk is adopted', () => {
    const r = mergeRoster({ ours: new Map(), disk: [s('a')], owners: new Map(), knownOnDisk: new Set() });
    assert.deepStrictEqual(r.adopt.map((x) => x.id), ['a']);
    assert.deepStrictEqual(r.sessions.map((x) => x.id), ['a']);
    assert.strictEqual(r.changed, true);
  });

  test('a session owned by another host takes the disk copy and carries the owner', () => {
    const ours = new Map([['a', s('a', { title: 'stale', status: 'idle' })]]);
    const r = mergeRoster({
      ours, disk: [s('a', { title: 'fresh', status: 'running' })], owners: new Map([['a', owner]]), knownOnDisk: new Set(['a']),
    });
    assert.deepStrictEqual(r.update.map((x) => x.title), ['fresh']);
    assert.deepStrictEqual(r.update[0].owner, owner);
  });

  test('a session we hold and nobody else owns keeps our copy', () => {
    const ours = new Map([['a', s('a', { title: 'mine' })]]);
    const r = mergeRoster({ ours, disk: [s('a', { title: 'theirs' })], owners: new Map(), knownOnDisk: new Set(['a']) });
    assert.deepStrictEqual(r.update, []);
    assert.deepStrictEqual(r.sessions.map((x) => x.title), ['mine']);
  });

  test('a session we saw on disk that is now gone was deleted elsewhere', () => {
    const r = mergeRoster({ ours: new Map([['a', s('a')]]), disk: [], owners: new Map(), knownOnDisk: new Set(['a']) });
    assert.deepStrictEqual(r.drop, ['a']);
    assert.deepStrictEqual(r.sessions, []);
  });

  test('a fresh session we created and never wrote is kept', () => {
    const r = mergeRoster({ ours: new Map([['n', s('n')]]), disk: [], owners: new Map(), knownOnDisk: new Set() });
    assert.deepStrictEqual(r.drop, []);
    assert.deepStrictEqual(r.sessions.map((x) => x.id), ['n']);
  });

  test('persisted sessions never carry owner', () => {
    const r = mergeRoster({ ours: new Map(), disk: [s('a')], owners: new Map([['a', owner]]), knownOnDisk: new Set() });
    assert.strictEqual(r.sessions.every((x) => x.owner === undefined), true);
  });

  test('an unchanged roster reports changed: false and does not ping-pong', () => {
    const disk = [s('a')];
    const first = mergeRoster({ ours: new Map(), disk, owners: new Map(), knownOnDisk: new Set() });
    const ours = new Map(first.adopt.map((x) => [x.id, x]));
    const second = mergeRoster({ ours, disk, owners: new Map(), knownOnDisk: first.knownOnDisk });
    assert.strictEqual(second.changed, false);
  });

  test('a foreign update settles: after applying it a second merge reports no change', () => {
    const local = { ...s('a', { title: 'stale' }), queued: undefined } as SessionState;
    const disk = [s('a', { title: 'fresh' })];
    const owners = new Map([['a', owner]]);
    const first = mergeRoster({ ours: new Map([['a', local]]), disk, owners, knownOnDisk: new Set(['a']) });
    assert.strictEqual(first.update.length, 1);
    Object.assign(local, first.update[0]);
    const second = mergeRoster({ ours: new Map([['a', local]]), disk, owners, knownOnDisk: first.knownOnDisk });
    assert.strictEqual(second.changed, false);
  });
});
