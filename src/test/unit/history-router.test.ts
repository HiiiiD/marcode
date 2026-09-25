import * as assert from 'assert';
import { MessageRouter, type EditorContextHost } from '../../host/message-router';
import type { HostToWebview } from '../../protocol/messages';

function routerWith(estimate = { sessions: 2, approxInputTokens: 6000 }) {
  const calls: string[] = [];
  const manager = {
    setPinned: (id: string, pinned: boolean) => { calls.push(`setPinned:${id}:${pinned}`); },
    ensureSummaries: async () => { calls.push('ensureSummaries'); },
    memoryStatus: () => ({ enabled: true, llm: false }),
    memoryEstimate: async () => estimate,
    memoryReindex: async (scope: string) => { calls.push(`reindex:${scope}`); },
    memoryResummarize: async (id: string) => { calls.push(`resummarize:${id}`); },
    memoryCancel: () => { calls.push('cancel'); },
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
  return { router, calls, emitted };
}

suite('history routing', () => {
  test('set-pinned reaches the manager', async () => {
    const { router, calls } = routerWith();
    await router.handle({ t: 'set-pinned', id: 's1', pinned: true });
    assert.deepStrictEqual(calls, ['setPinned:s1:true']);
  });

  test('request-history-summaries reaches the manager', async () => {
    const { router, calls } = routerWith();
    await router.handle({ t: 'request-history-summaries' });
    assert.deepStrictEqual(calls, ['ensureSummaries']);
  });

  test('open-history is a silent no-op in the router', async () => {
    const { router, calls } = routerWith();
    await router.handle({ t: 'open-history' });
    assert.strictEqual(calls.length, 0);
  });

  test('request-history-summaries answers with memory-status', async () => {
    const { router, emitted } = routerWith();
    await router.handle({ t: 'request-history-summaries' });
    assert.deepStrictEqual(emitted.find((m) => m.t === 'memory-status'), {
      t: 'memory-status', enabled: true, llm: false,
    });
  });

  test('memory-status goes out before the summaries sweep finishes', async () => {
    const gate: { release?: () => void } = {};
    const manager = {
      ensureSummaries: () => new Promise<void>((resolve) => { gate.release = resolve; }),
      memoryStatus: () => ({ enabled: true, llm: false }),
    } as unknown as ConstructorParameters<typeof MessageRouter>[0];
    const emitted: HostToWebview[] = [];
    const router = new MessageRouter(manager, (m) => emitted.push(m), '/tmp');
    const pending = router.handle({ t: 'request-history-summaries' });
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(emitted.some((m) => m.t === 'memory-status'), true);
    gate.release?.();
    await pending;
  });

  test('memory-estimate replies with the manager estimate', async () => {
    const { router, emitted } = routerWith();
    await router.handle({ t: 'memory-estimate', scope: 'missing-llm' });
    assert.deepStrictEqual(emitted.find((m) => m.t === 'memory-estimate'), {
      t: 'memory-estimate', scope: 'missing-llm', sessions: 2, approxInputTokens: 6000,
    });
  });

  test('memory-estimate with nothing to summarize starts the reindex instead of asking', async () => {
    const { router, calls, emitted } = routerWith({ sessions: 0, approxInputTokens: 0 });
    await router.handle({ t: 'memory-estimate', scope: 'missing-llm' });
    assert.deepStrictEqual(calls, ['reindex:missing-llm']);
    assert.strictEqual(emitted.some((m) => m.t === 'memory-estimate'), false);
  });

  test('memory-reindex, memory-resummarize and memory-cancel reach the manager', async () => {
    const { router, calls } = routerWith();
    await router.handle({ t: 'memory-reindex', scope: 'all' });
    await router.handle({ t: 'memory-resummarize', id: 's1' });
    await router.handle({ t: 'memory-cancel' });
    assert.deepStrictEqual(calls, ['reindex:all', 'resummarize:s1', 'cancel']);
  });
});
