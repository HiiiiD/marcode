import * as assert from 'assert';
import * as frames from '../fixtures/opencode-acp-frames.json';
import {
  ToolCallLog, toAgentEvents, toContextBreakdown,
  type AcpToolCall, type ToolMapper,
} from '../../providers/acp/map-updates';

// A stand-in vendor mapper: map-updates must stay vendor-neutral, so the test
// proves it delegates rather than classifying anything itself.
const tools: ToolMapper = {
  call: (c) => ({ kind: 'other', label: c.title ?? 'call', raw: c.rawInput }),
  output: () => ({ kind: 'none' }),
};

suite('acp toAgentEvents', () => {
  test('an agent message chunk becomes a text delta', () => {
    assert.deepStrictEqual(toAgentEvents(frames.updates.agentMessageChunk, tools, new ToolCallLog()),
      [{ kind: 'text', delta: 'Done' }]);
  });

  test('an agent thought chunk becomes a thinking delta', () => {
    assert.deepStrictEqual(toAgentEvents(frames.updates.agentThoughtChunk, tools, new ToolCallLog()),
      [{ kind: 'thinking', delta: 'I should write the file' }]);
  });

  test('a user message chunk is dropped — it only appears during load replay', () => {
    assert.deepStrictEqual(toAgentEvents(frames.updates.userMessageChunk, tools, new ToolCallLog()), []);
  });

  test('tool_call becomes tool-start', () => {
    const events = toAgentEvents(frames.updates.bashToolCall, tools, new ToolCallLog());
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].kind, 'tool-start');
    assert.strictEqual((events[0] as { id: string }).id, 'call_149d4cd4e9d34517851b27d4');
  });

  test('an in_progress update emits nothing', () => {
    assert.deepStrictEqual(toAgentEvents(frames.updates.bashToolCallInProgress, tools, new ToolCallLog()), []);
  });

  test('a completed update becomes tool-end and re-sends the tool', () => {
    const events = toAgentEvents(frames.updates.bashToolCallCompleted, tools, new ToolCallLog());
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
      { ...frames.updates.bashToolCallCompleted, status: 'failed' }, tools, new ToolCallLog());
    assert.strictEqual((events[0] as { ok: boolean }).ok, false);
  });

  test('available_commands_update becomes a full invocables replacement', () => {
    assert.deepStrictEqual(toAgentEvents(frames.updates.availableCommands, tools, new ToolCallLog()), [{
      kind: 'invocables',
      entries: [
        { name: 'customize-opencode',
          description: "Use ONLY when the user is editing opencode's own configuration" },
        { name: 'init', description: 'Create or update AGENTS.md' },
      ],
    }]);
  });

  test('usage_update emits no event — it feeds contextBreakdown instead', () => {
    assert.deepStrictEqual(toAgentEvents(frames.updates.usageUpdate, tools, new ToolCallLog()), []);
  });

  test('an unknown variant is ignored rather than throwing', () => {
    assert.deepStrictEqual(toAgentEvents({ sessionUpdate: 'session_info_update' }, tools, new ToolCallLog()), []);
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

suite('acp ToolCallLog', () => {
  // Real capture, opencode 1.18.18: the completed frame of a `read` drops
  // `kind` and `locations` and rewrites `title` to the file path. Mapping it
  // on its own turns a Read card into an `other` card labelled with a
  // filename — an ACP update is a delta over the call, not a whole call.
  const seen: AcpToolCall[] = [];
  const recorder: ToolMapper = {
    call: (c) => { seen.push(c); return { kind: 'other', label: c.title ?? '', raw: c.rawInput }; },
    output: () => ({ kind: 'none' }),
  };

  test('a completed update inherits the kind and locations of the frames before it', () => {
    seen.length = 0;
    const log = new ToolCallLog();
    toAgentEvents(frames.updates.readToolCall, recorder, log);
    toAgentEvents(frames.updates.readToolCallInProgress, recorder, log);
    toAgentEvents(frames.updates.readToolCallCompleted, recorder, log);
    const last = seen[seen.length - 1];
    assert.strictEqual(last.kind, 'read');
    assert.strictEqual(last.locations?.[0]?.path,
      'C:\\Users\\Marco\\AppData\\Local\\Temp\\oc-read-spike\\notes.txt');
  });

  test('an in_progress update is merged even though it emits nothing', () => {
    seen.length = 0;
    const log = new ToolCallLog();
    toAgentEvents(frames.updates.bashToolCall, recorder, log);
    toAgentEvents(frames.updates.bashToolCallInProgress, recorder, log);
    toAgentEvents(frames.updates.bashToolCallCompleted, recorder, log);
    const last = seen[seen.length - 1];
    assert.strictEqual(last.kind, 'execute');
    assert.strictEqual((last.rawInput as { command?: string }).command, 'echo hi');
  });

  test('a later frame still wins where it says something', () => {
    seen.length = 0;
    const log = new ToolCallLog();
    toAgentEvents(frames.updates.readToolCall, recorder, log);
    toAgentEvents(frames.updates.readToolCallCompleted, recorder, log);
    assert.strictEqual(seen[seen.length - 1].status, 'completed');
  });

  test('one call never inherits from another', () => {
    seen.length = 0;
    const log = new ToolCallLog();
    toAgentEvents(frames.updates.bashToolCall, recorder, log);
    toAgentEvents({ ...frames.updates.readToolCallCompleted, toolCallId: 'other' }, recorder, log);
    assert.strictEqual(seen[seen.length - 1].kind, undefined);
  });
});
