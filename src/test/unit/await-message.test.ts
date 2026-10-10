import * as assert from 'node:assert';
import { awaitMessage } from '../../host/await-message';
import type { HostToWebview } from '../../protocol/messages';

function transport() {
  const ls = new Set<(m: HostToWebview) => void>();
  return {
    t: { post: () => {}, onMessage: (l: (m: HostToWebview) => void) => { ls.add(l); return () => { ls.delete(l); }; } },
    emit: (m: HostToWebview) => { for (const l of [...ls]) { l(m); } },
    count: () => ls.size,
  };
}

suite('await message', () => {
  test('resolves with the first matching message and unsubscribes', async () => {
    const x = transport();
    const p = awaitMessage(x.t, (m) => m.t === 'memory-status', 1000);
    x.emit({ t: 'sessions-changed' } as never);
    x.emit({ t: 'memory-status', enabled: true, llm: false });
    assert.strictEqual((await p)?.t, 'memory-status');
    assert.strictEqual(x.count(), 0);
  });

  test('resolves undefined on timeout and unsubscribes', async () => {
    const x = transport();
    assert.strictEqual(await awaitMessage(x.t, () => false, 20), undefined);
    assert.strictEqual(x.count(), 0);
  });
});
