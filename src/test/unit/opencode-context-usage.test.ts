import * as assert from 'node:assert/strict';
import { readOpenCodeContext } from '../../providers/opencode/context-usage';

type ContextSdk = Parameters<typeof readOpenCodeContext>[0];
const message = (created: number, input: number, read = 0, write = 0) => ({
  info: {
    role: 'assistant', providerID: 'openai', modelID: 'gpt-test', time: { created },
    tokens: { input, output: 9000, reasoning: 5000, cache: { read, write } },
  },
});

function sdkFor(messages: ReturnType<typeof message>[], limit = 200000): ContextSdk {
  return {
    session: { messages: async () => ({ data: messages }) },
    provider: { list: async () => ({ data: { all: [
      { id: 'other', models: { 'gpt-test': { limit: { context: 1000 } } } },
      { id: 'openai', models: { 'gpt-test': { limit: { context: limit } } } },
    ] } }) },
  };
}

suite('OpenCode direct context usage', () => {
  test('reads the last model call during an unfinished turn, including cached input', async () => {
    const sdk = sdkFor([message(1, 80000), message(2, 10000, 20000, 10000), message(3, 0)]);
    const asked: unknown[] = [];
    const messages = sdk.session.messages;
    sdk.session.messages = async (params, options) => {
      asked.push(params);
      assert.equal(options.throwOnError, true);
      assert.equal(options.signal.aborted, false);
      return messages(params, options);
    };
    const providers = sdk.provider.list;
    sdk.provider.list = async (params, options) => {
      asked.push(params);
      return providers(params, options);
    };
    const result = await readOpenCodeContext(sdk, 'collaborator-session', '/worker');
    assert.equal(result.usedTokens, 40000);
    assert.equal(result.windowTokens, 200000);
    assert.equal(result.freePercent, 80);
    assert.deepEqual(asked, [{ sessionID: 'collaborator-session', directory: '/worker' }, { directory: '/worker' }]);
  });

  test('selects by message creation time rather than response order', async () => {
    const result = await readOpenCodeContext(sdkFor([message(2, 30000), message(1, 10000)]), 's', '/w');
    assert.equal(result.usedTokens, 30000);
  });

  test('reports not-yet-available before any model call has usage', async () => {
    await assert.rejects(readOpenCodeContext(sdkFor([message(1, 0)]), 's', '/w'), /no model call has reported usage/);
  });

  test('refuses to invent a missing model limit', async () => {
    await assert.rejects(readOpenCodeContext(sdkFor([message(1, 1000)], 0), 's', '/w'), /context-window limit/);
  });

  test('propagates query failures so the host can mark a persisted fallback stale', async () => {
    const sdk = sdkFor([]);
    sdk.session.messages = async () => { throw new Error('connection lost'); };
    await assert.rejects(readOpenCodeContext(sdk, 's', '/w'), /connection lost/);
  });
});
