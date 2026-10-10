import * as assert from 'node:assert';
import { wantsFor } from '../../daemon/client-wants';
import { createRemoteHooks } from '../../daemon/remote-hooks';

suite('daemon remote hooks', () => {
  test('tui and sidebar want everything; review does not want session-patch', () => {
    const patch = { t: 'session-patch' } as never;
    assert.strictEqual(wantsFor('tui')(patch), true);
    assert.strictEqual(wantsFor('sidebar')(patch), true);
    assert.strictEqual(wantsFor('review')(patch), false);
    assert.strictEqual(wantsFor('history')({ t: 'sessions-changed' } as never), true);
  });

  test('current() serves the pushed context; fire-and-forget calls become act frames', () => {
    const acts: [string, unknown[]][] = [];
    const h = createRemoteHooks({ act: (op, args) => { acts.push([op, args]); }, ask: async () => undefined });
    assert.strictEqual(h.editor.current(), null);
    const ctx = { path: '/a.ts' } as never;
    h.setContext(ctx);
    assert.strictEqual(h.editor.current() === ctx, true);
    h.editor.reveal('/a.ts', 3);
    h.configHost.setFavoriteModels(['m']);
    assert.deepStrictEqual(acts, [['reveal', ['/a.ts', 3]], ['setFavoriteModels', [['m']]]]);
  });

  test('pick and search ask the client and tolerate a failed answer', async () => {
    const h = createRemoteHooks({
      act: () => {},
      ask: async (op) => { if (op === 'pick') { return ['/x']; } throw new Error('gone'); },
    });
    assert.deepStrictEqual(await h.picker.pick(), ['/x']);
    assert.deepStrictEqual(await h.fileSearch.search('q'), []);
  });
  test('updateNotify becomes a notify act', () => {
    const acts: [string, unknown[]][] = [];
    const h = createRemoteHooks({ act: (op, args) => { acts.push([op, args]); }, ask: async () => undefined });
    h.updateNotify.notify('Claude', '1.0', '1.1');
    assert.deepStrictEqual(acts, [['notify', ['info', 'Claude 1.0 → 1.1 available.']]]);
  });
});
