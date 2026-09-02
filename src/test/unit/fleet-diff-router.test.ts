// The two fleet-diff arms. The router imports no `vscode`, which is what
// lets this run outside the extension host at all.

import * as assert from 'assert';
import { MessageRouter, type EditorContextHost } from '../../host/message-router';
import type { DiffBase, HostToWebview } from '../../protocol/messages';

function routerWith() {
  const calls: string[] = [];
  const opened: { root: string; path: string }[] = [];
  const manager = {
    requestFleetDiff: async () => { calls.push('requestFleetDiff'); },
  } as unknown as ConstructorParameters<typeof MessageRouter>[0];
  const editor: EditorContextHost = {
    current: () => null,
    reveal: () => {},
    openDiff: (root, path) => { opened.push({ root, path }); },
    openSettings: () => {},
    openExternal: () => {},
    exportCsv: () => {},
    exportImage: () => {},
    login: () => {},
  };
  const emitted: HostToWebview[] = [];
  const router = new MessageRouter(manager, (m) => emitted.push(m), '/tmp', editor);
  return { router, calls, opened, emitted };
}

const BASE: DiffBase = { kind: 'merge-base', ref: 'origin/main', sha: 'abc123' };

suite('fleet-diff routing', () => {
  test('request-fleet-diff reaches the manager', async () => {
    const { router, calls } = routerWith();
    await router.handle({ t: 'request-fleet-diff' });
    assert.deepStrictEqual(calls, ['requestFleetDiff']);
  });

  test('open-file-diff reaches the editor host', async () => {
    const { router, opened } = routerWith();
    await router.handle({ t: 'open-file-diff', root: '/repo', path: 'src/a.ts', base: BASE });
    assert.deepStrictEqual(opened, [{ root: '/repo', path: 'src/a.ts' }]);
  });

  test('an unknown tag is still dropped as malformed', async () => {
    const { router, calls, opened } = routerWith();
    await router.handle({ t: 'not-a-real-message' } as never);
    assert.strictEqual(calls.length + opened.length, 0);
  });
});
