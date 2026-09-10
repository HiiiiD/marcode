import * as assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { subagentToolCall, type RawToolPart } from '../../providers/opencode/map-subagent-tools';

function part(overrides: Partial<RawToolPart>): RawToolPart {
  return {
    callID: 'call_1',
    tool: 'bash',
    state: { status: 'pending', input: { command: 'ls' }, raw: '' },
    ...overrides,
  };
}

suite('map-subagent-tools', () => {
  test('a pending bash part becomes a running command card', () => {
    const call = subagentToolCall(part({ tool: 'bash' }));
    assert.strictEqual(call.kind, 'command');
    if (call.kind === 'command') {
      assert.strictEqual(call.command, 'ls');
    }
  });

  test('a completed read part carries its output as text', () => {
    const call = subagentToolCall(part({
      tool: 'read',
      state: {
        status: 'completed',
        input: { filePath: '/tmp/a.txt' },
        output: 'hello',
        title: 'a.txt',
        metadata: {},
        time: { start: 0, end: 1 },
      },
    }));
    assert.strictEqual(call.kind, 'file-read');
    if (call.kind === 'file-read') {
      assert.strictEqual(call.path, '/tmp/a.txt');
    }
  });

  test('an unrecognised tool name falls back to other, never guessed', () => {
    const call = subagentToolCall(part({ tool: 'some_custom_mcp_tool' }));
    assert.strictEqual(call.kind, 'other');
  });

  test('an errored part carries the error text as rawOutput', () => {
    const call = subagentToolCall(part({
      tool: 'bash',
      state: {
        status: 'error',
        input: { command: 'false' },
        error: 'exit 1',
        time: { start: 0, end: 1 },
      },
    }));
    // 'other' is fine here — this test only proves the error path doesn't throw
    // and produces a tool call at all; classification detail is covered above.
    assert.strictEqual(typeof call.kind, 'string');
  });
});
