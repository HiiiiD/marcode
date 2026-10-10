import * as assert from 'node:assert';
import { runMemoryReindex, type ReindexIo } from '../../host/memory-reindex-flow';

function io(over: Partial<ReindexIo> & { llm?: boolean; enabled?: boolean } = {}) {
  const log = { info: [] as string[], details: [] as string[], reindexed: 0, estimated: 0 };
  const impl: ReindexIo = {
    status: async () => ({ enabled: over.enabled ?? true, llm: over.llm ?? true }),
    estimate: async () => { log.estimated++; return { sessions: 3, approxInputTokens: 12000 }; },
    confirm: async (detail) => { log.details.push(detail); return true; },
    reindex: async () => { log.reindexed++; },
    info: (m) => { log.info.push(m); },
    ...over,
  };
  return { impl, log };
}

suite('memory reindex flow', () => {
  test('memory off: says so and does nothing', async () => {
    const { impl, log } = io({ enabled: false });
    await runMemoryReindex(impl);
    assert.deepStrictEqual(log.info, ['Marcode memory is off (marcode.memory.enabled).']);
    assert.strictEqual(log.reindexed, 0);
  });

  test('with a summarizer the confirmation quotes sessions and tokens, then reindexes', async () => {
    const { impl, log } = io();
    await runMemoryReindex(impl);
    assert.strictEqual(log.details[0].includes('3 hidden sessions'), true);
    assert.strictEqual(log.details[0].includes('about 12k input tokens'), true);
    assert.strictEqual(log.reindexed, 1);
    assert.deepStrictEqual(log.info, ['Marcode memory reindex finished.']);
  });

  test('declining the confirmation reindexes nothing', async () => {
    const { impl, log } = io({ confirm: async () => false });
    await runMemoryReindex(impl);
    assert.strictEqual(log.reindexed, 0);
    assert.deepStrictEqual(log.info, []);
  });

  test('without a summarizer no estimate is asked for and the detail says no model is used', async () => {
    const { impl, log } = io({ llm: false });
    await runMemoryReindex(impl);
    assert.strictEqual(log.estimated, 0);
    assert.strictEqual(log.details[0].includes('No summarizer is configured'), true);
    assert.strictEqual(log.reindexed, 1);
  });

  test('no estimate means the router already reindexed: no confirmation, no second reindex', async () => {
    const { impl, log } = io({ estimate: async () => undefined });
    await runMemoryReindex(impl);
    assert.deepStrictEqual(log.details, []);
    assert.strictEqual(log.reindexed, 0);
    assert.deepStrictEqual(log.info, ['Marcode memory reindex finished.']);
  });
});
