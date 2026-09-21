import * as assert from 'assert';
import { MessageRouter, type EditorContextHost } from '../../host/message-router';
import type { HostToWebview } from '../../protocol/messages';

function routerWith() {
  const calls: string[] = [];
  const manager = {
    setPinned: (id: string, pinned: boolean) => { calls.push(`setPinned:${id}:${pinned}`); },
  } as unknown as ConstructorParameters<typeof MessageRouter>[0];
  const editor: EditorContextHost = {
    current: () => null,
    reveal: () => {},
    openDiff: () => {},
    openSettings: () => {},
    openExternal: () => {},
    exportCsv: () => {},
    exportImage: () => {},
    login: () => {},
  };
  const emitted: HostToWebview[] = [];
  const router = new MessageRouter(manager, (m) => emitted.push(m), '/tmp', editor);
  return { router, calls };
}

suite('history routing', () => {
  test('set-pinned reaches the manager', async () => {
    const { router, calls } = routerWith();
    await router.handle({ t: 'set-pinned', id: 's1', pinned: true });
    assert.deepStrictEqual(calls, ['setPinned:s1:true']);
  });

  test('open-history is a silent no-op in the router', async () => {
    const { router, calls } = routerWith();
    await router.handle({ t: 'open-history' });
    assert.strictEqual(calls.length, 0);
  });
});
