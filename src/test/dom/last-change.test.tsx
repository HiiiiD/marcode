import * as assert from 'assert';
import { renderHook } from '@testing-library/react';
import { activitySignature, useLastChange } from '../../webview/lib/last-change';
import { tool } from '../fixtures/protocol';

suite('useLastChange', () => {
  const realNow = Date.now;
  let clock = 1_000;
  setup(() => { clock = 1_000; Date.now = () => clock; });
  teardown(() => { Date.now = realNow; });

  test('holds the first-seen time while the signature is unchanged, moves it when it changes', () => {
    const { result, rerender } = renderHook(({ sig }) => useLastChange(sig), { initialProps: { sig: 'a' } });
    assert.strictEqual(result.current, 1_000);

    clock = 50_000;
    rerender({ sig: 'a' });
    assert.strictEqual(result.current, 1_000);

    rerender({ sig: 'b' });
    assert.strictEqual(result.current, 50_000);
  });

  test('the signature moves with streamed text and with a worker child settling', () => {
    const base = { id: 'a1', ts: 1, role: 'assistant' as const, text: 'abc' };
    assert.notStrictEqual(activitySignature(base), activitySignature({ ...base, text: 'abcd' }));

    const parent = tool({ id: 't1', state: 'running', children: [tool({ id: 'c1', state: 'running' })] });
    const settled = tool({ id: 't1', state: 'running', children: [tool({ id: 'c1', state: 'ok' })] });
    assert.notStrictEqual(activitySignature(parent), activitySignature(settled));
  });
});
