import * as assert from 'assert';
import { mapEvent } from '../../providers/claude/map-events';

suite('mapEvent', () => {
  test('system init yields a session event carrying the session id', () => {
    const events = mapEvent({
      type: 'system', subtype: 'init', session_id: 'abc123',
    } as never);
    assert.deepStrictEqual(events, [{ kind: 'session', resumeToken: 'abc123' }]);
  });

  test('non-init system messages produce no events, even with a session id', () => {
    const events = mapEvent({
      type: 'system', subtype: 'status', session_id: 'abc123', status: 'requesting',
    } as never);
    assert.deepStrictEqual(events, []);
  });

  test('assistant text blocks become text events', () => {
    const events = mapEvent({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello' }] },
    } as never);
    assert.deepStrictEqual(events, [{ kind: 'text', delta: 'Hello' }]);
  });

  test('assistant thinking blocks become thinking events', () => {
    const events = mapEvent({
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: 'pondering', signature: 'sig' }] },
    } as never);
    assert.deepStrictEqual(events, [{ kind: 'thinking', delta: 'pondering' }]);
  });

  test('assistant tool_use blocks become tool-start events', () => {
    const events = mapEvent({
      type: 'assistant',
      message: { content: [
        { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'a.ts' } },
      ] },
    } as never);
    assert.deepStrictEqual(events, [
      { kind: 'tool-start', id: 'toolu_1', name: 'Read', input: { file_path: 'a.ts' } },
    ]);
  });

  test('user tool_result blocks become tool-end events', () => {
    const events = mapEvent({
      type: 'user',
      message: { content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok', is_error: false },
      ] },
    } as never);
    assert.deepStrictEqual(events, [
      { kind: 'tool-end', id: 'toolu_1', ok: true, output: 'ok' },
    ]);
  });

  test('user tool_result blocks with is_error map to ok: false', () => {
    const events = mapEvent({
      type: 'user',
      message: { content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'boom', is_error: true },
      ] },
    } as never);
    assert.deepStrictEqual(events, [
      { kind: 'tool-end', id: 'toolu_1', ok: false, output: 'boom' },
    ]);
  });

  test('a successful result yields usage and turn-end', () => {
    const events = mapEvent({
      type: 'result', subtype: 'success',
      usage: { input_tokens: 10, output_tokens: 20 },
    } as never);
    assert.deepStrictEqual(events, [
      { kind: 'usage', inputTokens: 10, outputTokens: 20 },
      { kind: 'turn-end', reason: 'done' },
    ]);
  });

  test('an error result yields turn-end with a message built from subtype', () => {
    const events = mapEvent({
      type: 'result', subtype: 'error_during_execution', stop_reason: null,
    } as never);
    assert.strictEqual(events.at(-1)?.kind, 'turn-end');
    assert.deepStrictEqual(
      events.at(-1),
      { kind: 'turn-end', reason: 'error', error: 'error_during_execution' },
    );
  });

  test('unrecognised messages produce no events', () => {
    assert.deepStrictEqual(mapEvent({ type: 'stream_event' } as never), []);
  });
});
