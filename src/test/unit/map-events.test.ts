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

  test('an error result with no errors/terminal_reason falls back to subtype', () => {
    const events = mapEvent({
      type: 'result', subtype: 'error_during_execution', stop_reason: null,
    } as never);
    assert.strictEqual(events.at(-1)?.kind, 'turn-end');
    assert.deepStrictEqual(
      events.at(-1),
      { kind: 'turn-end', reason: 'error', error: 'error_during_execution' },
    );
  });

  test('an error result prefers the real errors[] text over subtype/terminal_reason', () => {
    const events = mapEvent({
      type: 'result',
      subtype: 'error_during_execution',
      errors: ['Invalid API key'],
      terminal_reason: 'api_error',
    } as never);
    assert.deepStrictEqual(
      events.at(-1),
      { kind: 'turn-end', reason: 'error', error: 'Invalid API key' },
    );
  });

  test('an error result with no errors[] falls back to terminal_reason', () => {
    const events = mapEvent({
      type: 'result', subtype: 'error_during_execution', terminal_reason: 'prompt_too_long',
    } as never);
    assert.deepStrictEqual(
      events.at(-1),
      { kind: 'turn-end', reason: 'error', error: 'prompt_too_long' },
    );
  });

  test('an aborted_streaming terminal_reason maps to turn-end interrupted, not error', () => {
    const events = mapEvent({
      type: 'result', subtype: 'error_during_execution', terminal_reason: 'aborted_streaming',
    } as never);
    assert.deepStrictEqual(events, [{ kind: 'turn-end', reason: 'interrupted' }]);
  });

  test('an aborted_tools terminal_reason maps to turn-end interrupted, not error', () => {
    const events = mapEvent({
      type: 'result', subtype: 'error_during_execution', terminal_reason: 'aborted_tools',
    } as never);
    assert.deepStrictEqual(events, [{ kind: 'turn-end', reason: 'interrupted' }]);
  });

  test('unrecognised messages produce no events', () => {
    assert.deepStrictEqual(mapEvent({ type: 'stream_event' } as never), []);
  });

  test('a subagent tool_use carries its parent tool id', () => {
    const events = mapEvent({
      type: 'assistant',
      parent_tool_use_id: 'task1',
      message: { content: [
        { type: 'tool_use', id: 'c1', name: 'Read', input: { path: 'a.ts' } },
      ] },
    } as never);
    assert.deepStrictEqual(events, [
      { kind: 'tool-start', id: 'c1', name: 'Read', input: { path: 'a.ts' }, parentId: 'task1' },
    ]);
  });

  test('subagent text and thinking are dropped, tool activity is kept', () => {
    const events = mapEvent({
      type: 'assistant',
      parent_tool_use_id: 'task1',
      message: { content: [
        { type: 'text', text: 'let me look' },
        { type: 'thinking', thinking: 'hmm', signature: 'x' },
        { type: 'tool_use', id: 'c1', name: 'Grep', input: {} },
      ] },
    } as never);
    assert.deepStrictEqual(events, [
      { kind: 'tool-start', id: 'c1', name: 'Grep', input: {}, parentId: 'task1' },
    ]);
  });

  test('top-level text and thinking are still emitted', () => {
    const events = mapEvent({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { content: [
        { type: 'text', text: 'hello' },
        { type: 'thinking', thinking: 'hmm', signature: 'x' },
      ] },
    } as never);
    assert.deepStrictEqual(events, [
      { kind: 'text', delta: 'hello' },
      { kind: 'thinking', delta: 'hmm' },
    ]);
  });

  test('a subagent tool_result carries its parent tool id', () => {
    const events = mapEvent({
      type: 'user',
      parent_tool_use_id: 'task1',
      message: { content: [
        { type: 'tool_result', tool_use_id: 'c1', content: 'ok' },
      ] },
    } as never);
    assert.deepStrictEqual(events, [
      { kind: 'tool-end', id: 'c1', ok: true, output: 'ok', parentId: 'task1' },
    ]);
  });

  test('a top-level tool_result has no parentId key at all', () => {
    const [event] = mapEvent({
      type: 'user',
      parent_tool_use_id: null,
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    } as never);
    assert.strictEqual('parentId' in (event as object), false);
  });

  test('the init message yields both a session and an mcp-servers event', () => {
    const events = mapEvent({
      type: 'system',
      subtype: 'init',
      session_id: 'sess-1',
      mcp_servers: [
        { name: 'github', status: 'connected' },
        { name: 'stripe', status: 'failed' },
      ],
    } as never);
    assert.deepStrictEqual(events, [
      { kind: 'session', resumeToken: 'sess-1' },
      { kind: 'mcp-servers', servers: [
        { name: 'github', state: 'connected' },
        { name: 'stripe', state: 'failed' },
      ] },
    ]);
  });

  test('an unrecognized server status degrades to pending rather than being dropped', () => {
    const events = mapEvent({
      type: 'system', subtype: 'init', session_id: 's',
      mcp_servers: [{ name: 'weird', status: 'reticulating' }],
    } as never);
    assert.deepStrictEqual(events[1], {
      kind: 'mcp-servers', servers: [{ name: 'weird', state: 'pending' }],
    });
  });

  test('an init message with no mcp servers emits no mcp-servers event', () => {
    const events = mapEvent({ type: 'system', subtype: 'init', session_id: 's' } as never);
    assert.deepStrictEqual(events, [{ kind: 'session', resumeToken: 's' }]);
  });
});
