import * as assert from 'assert';
import { approvalEventOf, mapNotification } from '../../providers/codex/map-events';

suite('mapNotification', () => {
  test('thread/started carries the resume token', () => {
    assert.deepStrictEqual(
      mapNotification('thread/started', { thread: { id: 'th_1' } }),
      [{ kind: 'session', resumeToken: 'th_1' }],
    );
  });

  test('agent message deltas become text', () => {
    assert.deepStrictEqual(
      mapNotification('item/agentMessage/delta', { delta: 'hi' }),
      [{ kind: 'text', delta: 'hi' }],
    );
  });

  test('both reasoning delta shapes become thinking', () => {
    assert.deepStrictEqual(
      mapNotification('item/reasoning/textDelta', { delta: 'a' }),
      [{ kind: 'thinking', delta: 'a' }],
    );
    assert.deepStrictEqual(
      mapNotification('item/reasoning/summaryTextDelta', { delta: 'b' }),
      [{ kind: 'thinking', delta: 'b' }],
    );
  });

  test('a started command execution becomes a tool-start', () => {
    const events = mapNotification('item/started', {
      item: { type: 'commandExecution', id: 'it_1', command: 'ls -la', cwd: '/repo' },
    });
    assert.deepStrictEqual(events, [{
      kind: 'tool-start', id: 'it_1', name: 'commandExecution',
      input: { command: 'ls -la', cwd: '/repo' },
    }]);
  });

  test('a completed command execution reports success from its exit code', () => {
    const [event] = mapNotification('item/completed', {
      item: { type: 'commandExecution', id: 'it_1', command: 'ls', cwd: '/repo',
              exitCode: 0, aggregatedOutput: 'a\nb' },
    });
    assert.strictEqual(event.kind, 'tool-end');
    assert.strictEqual(event.kind === 'tool-end' && event.ok, true);
  });

  test('a nonzero exit code is a failed tool', () => {
    const [event] = mapNotification('item/completed', {
      item: { type: 'commandExecution', id: 'it_1', command: 'false', cwd: '/r', exitCode: 1 },
    });
    assert.strictEqual(event.kind === 'tool-end' && event.ok, false);
  });

  test('an agent message item completing is not a tool', () => {
    // The text already arrived as deltas; emitting a tool row for it would
    // double the assistant's turn in the transcript.
    assert.deepStrictEqual(
      mapNotification('item/completed', { item: { type: 'agentMessage', id: 'it_2', text: 'done' } }),
      [],
    );
  });

  test('turn/completed ends the turn', () => {
    assert.deepStrictEqual(
      mapNotification('turn/completed', { threadId: 't', turn: {} }),
      [{ kind: 'turn-end', reason: 'done' }],
    );
  });

  test('an error notification ends the turn with its message', () => {
    assert.deepStrictEqual(
      mapNotification('error', { error: { message: 'model overloaded' }, willRetry: false }),
      [{ kind: 'turn-end', reason: 'error', error: 'model overloaded' }],
    );
  });

  test('an error that will be retried does not end the turn', () => {
    assert.deepStrictEqual(
      mapNotification('error', { error: { message: 'transient' }, willRetry: true }),
      [],
    );
  });

  test('rate limit updates are a signal to pull, never a payload to read', () => {
    // The notification is documented as a sparse rolling update; numbers come
    // from account/rateLimits/read.
    assert.deepStrictEqual(
      mapNotification('account/rateLimits/updated', { rateLimits: { primary: { usedPercent: 40 } } }),
      [{ kind: 'usage-stale' }],
    );
  });

  test('token usage becomes an input/output usage event', () => {
    assert.deepStrictEqual(
      mapNotification('thread/tokenUsage/updated', {
        tokenUsage: { total: { inputTokens: 100, outputTokens: 20 }, modelContextWindow: 200_000 },
      }),
      [{ kind: 'usage', inputTokens: 100, outputTokens: 20 }],
    );
  });

  test('an unknown method is ignored, not thrown', () => {
    // Tolerant parsing is the mitigation for a protocol with no negotiated
    // version: a method added by a Codex upgrade must be a no-op.
    assert.deepStrictEqual(mapNotification('thread/realtime/sdp', { anything: true }), []);
  });

  test('an unknown item kind is ignored, not thrown', () => {
    assert.deepStrictEqual(
      mapNotification('item/started', { item: { type: 'imageGeneration', id: 'it_9' } }),
      [],
    );
  });
});

suite('approvalEventOf', () => {
  test('a command approval becomes a permission request', () => {
    assert.deepStrictEqual(
      approvalEventOf('item/commandExecution/requestApproval', 11,
        { itemId: 'it_1', command: 'rm -rf build', cwd: '/repo', reason: 'writes outside workspace' }),
      { kind: 'permission', id: '11', name: 'commandExecution',
        input: { command: 'rm -rf build', cwd: '/repo', reason: 'writes outside workspace' } },
    );
  });

  test('a file change approval becomes a permission request', () => {
    assert.deepStrictEqual(
      approvalEventOf('item/fileChange/requestApproval', 12, { itemId: 'it_2', grantRoot: '/repo' }),
      { kind: 'permission', id: '12', name: 'fileChange',
        input: { itemId: 'it_2', grantRoot: '/repo' } },
    );
  });

  test('an unrelated server request produces no permission', () => {
    assert.strictEqual(approvalEventOf('attestation/generate', 13, {}), undefined);
  });
});
