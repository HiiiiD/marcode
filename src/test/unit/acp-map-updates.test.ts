import * as assert from 'assert';
import * as frames from '../fixtures/opencode-acp-frames.json';
import { toAgentEvents, toContextBreakdown, type ToolMapper } from '../../providers/acp/map-updates';

// A stand-in vendor mapper: map-updates must stay vendor-neutral, so the test
// proves it delegates rather than classifying anything itself.
const tools: ToolMapper = {
  call: (c) => ({ kind: 'other', label: c.title ?? 'call', raw: c.rawInput }),
  output: () => ({ kind: 'none' }),
};

suite('acp toAgentEvents', () => {
  test('an agent message chunk becomes a text delta', () => {
    assert.deepStrictEqual(toAgentEvents(frames.updates.agentMessageChunk, tools),
      [{ kind: 'text', delta: 'Done' }]);
  });

  test('an agent thought chunk becomes a thinking delta', () => {
    assert.deepStrictEqual(toAgentEvents(frames.updates.agentThoughtChunk, tools),
      [{ kind: 'thinking', delta: 'I should write the file' }]);
  });

  test('a user message chunk is dropped — it only appears during load replay', () => {
    assert.deepStrictEqual(toAgentEvents(frames.updates.userMessageChunk, tools), []);
  });

  test('tool_call becomes tool-start', () => {
    const events = toAgentEvents(frames.updates.bashToolCall, tools);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].kind, 'tool-start');
    assert.strictEqual((events[0] as { id: string }).id, 'call_149d4cd4e9d34517851b27d4');
  });

  test('an in_progress update emits nothing', () => {
    assert.deepStrictEqual(toAgentEvents(frames.updates.bashToolCallInProgress, tools), []);
  });

  test('a completed update becomes tool-end and re-sends the tool', () => {
    const events = toAgentEvents(frames.updates.bashToolCallCompleted, tools);
    assert.strictEqual(events.length, 1);
    const end = events[0] as { kind: string; id: string; ok: boolean; tool?: unknown };
    assert.strictEqual(end.kind, 'tool-end');
    assert.strictEqual(end.ok, true);
    // The command only ever arrives on the update — a tool-end without `tool`
    // would leave the card showing a shell call with no command forever.
    assert.strictEqual(end.tool !== undefined, true);
  });

  test('a failed update reports ok: false', () => {
    const events = toAgentEvents(
      { ...frames.updates.bashToolCallCompleted, status: 'failed' }, tools);
    assert.strictEqual((events[0] as { ok: boolean }).ok, false);
  });

  test('available_commands_update becomes a full invocables replacement', () => {
    assert.deepStrictEqual(toAgentEvents(frames.updates.availableCommands, tools), [{
      kind: 'invocables',
      entries: [
        { name: 'customize-opencode',
          description: "Use ONLY when the user is editing opencode's own configuration" },
        { name: 'init', description: 'Create or update AGENTS.md' },
      ],
    }]);
  });

  test('usage_update emits no event — it feeds contextBreakdown instead', () => {
    assert.deepStrictEqual(toAgentEvents(frames.updates.usageUpdate, tools), []);
  });

  test('an unknown variant is ignored rather than throwing', () => {
    assert.deepStrictEqual(toAgentEvents({ sessionUpdate: 'session_info_update' }, tools), []);
  });
});

suite('acp toContextBreakdown', () => {
  test('reports conversation and free as percentages of the window', () => {
    assert.deepStrictEqual(toContextBreakdown({ used: 50000, size: 200000 }), {
      systemPercent: 0, memoryPercent: 0, conversationPercent: 25, freePercent: 75,
      memoryFiles: [], usedTokens: 50000, windowTokens: 200000,
    });
  });

  test('the four percentages still sum to 100 when the division is not exact', () => {
    const b = toContextBreakdown({ used: 8896, size: 200000 });
    assert.strictEqual(
      b.systemPercent + b.memoryPercent + b.conversationPercent + b.freePercent, 100);
  });

  test('a used figure above the window clamps rather than reporting negative free space', () => {
    const b = toContextBreakdown({ used: 250000, size: 200000 });
    assert.strictEqual(b.conversationPercent, 100);
    assert.strictEqual(b.freePercent, 0);
  });
});
