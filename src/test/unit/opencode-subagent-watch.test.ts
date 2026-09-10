import * as assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { SubagentWatch, type SubagentSdk } from '../../providers/opencode/subagent-watch';
import type { AgentEvent } from '../../providers/types';

/** A scripted `SubagentSdk` — feeds a fixed event list, records `permission.reply` calls. */
function fakeSdk(payloads: unknown[]): { sdk: SubagentSdk; replies: unknown[] } {
  const replies: unknown[] = [];
  async function* stream(): AsyncGenerator<{ payload?: unknown }> {
    for (const payload of payloads) { yield { payload }; }
  }
  return {
    replies,
    sdk: {
      globalEvent: async () => ({ stream: stream() }),
      permissionReply: async (params: unknown) => { replies.push(params); },
    },
  };
}

async function collect(events: AsyncIterable<AgentEvent>, count: number): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) { out.push(e); if (out.length >= count) { break; } }
  return out;
}

suite('SubagentWatch', () => {
  test('a tool part on a watched child session becomes a nested tool-start', async () => {
    const { sdk } = fakeSdk([
      { type: 'session.created', properties: { sessionID: 'child_1', info: { id: 'child_1', parentID: 'root' } } },
      {
        type: 'message.part.updated',
        properties: {
          sessionID: 'child_1',
          part: { type: 'tool', callID: 'call_1', tool: 'bash', state: { status: 'pending', input: { command: 'ls' }, raw: '' } },
        },
      },
    ]);
    const watch = new SubagentWatch({ connect: async () => sdk });
    watch.open('http://x', 't');
    watch.setRootSessionId('root');
    // 'task_root' is the parent tool-start id this run's own task card used —
    // supplied here because Task 4 wires it via setParentToolCallId, added below.
    watch.setParentToolCallId('child_1', 'task_root');
    const [event] = await collect(watch.events, 1);
    assert.strictEqual(event.kind, 'tool-start');
    if (event.kind === 'tool-start') {
      assert.strictEqual(event.parentId, 'task_root');
      assert.strictEqual(event.id, 'call_1');
    }
  });

  test('a session.created whose parent is not watched is ignored', async () => {
    const { sdk } = fakeSdk([
      { type: 'session.created', properties: { sessionID: 'stray', info: { id: 'stray', parentID: 'someone-elses-session' } } },
      {
        type: 'message.part.updated',
        properties: {
          sessionID: 'stray',
          part: { type: 'tool', callID: 'call_x', tool: 'bash', state: { status: 'pending', input: {}, raw: '' } },
        },
      },
      { type: 'session.created', properties: { sessionID: 'child_1', info: { id: 'child_1', parentID: 'root' } } },
      {
        type: 'message.part.updated',
        properties: {
          sessionID: 'child_1',
          part: { type: 'tool', callID: 'call_1', tool: 'bash', state: { status: 'pending', input: {}, raw: '' } },
        },
      },
    ]);
    const watch = new SubagentWatch({ connect: async () => sdk });
    watch.open('http://x', 't');
    watch.setRootSessionId('root');
    watch.setParentToolCallId('child_1', 'task_root');
    const [event] = await collect(watch.events, 1);
    // Only the watched child's call ever reaches the stream — 'call_x' never does.
    assert.strictEqual(event.kind === 'tool-start' && event.id, 'call_1');
  });

  test('a permission ask on a watched child is relayed and replied', async () => {
    const { sdk, replies } = fakeSdk([
      { type: 'session.created', properties: { sessionID: 'child_1', info: { id: 'child_1', parentID: 'root' } } },
      {
        type: 'permission.asked',
        properties: { id: 'req_1', sessionID: 'child_1', permission: 'bash', patterns: [], metadata: {}, always: [] },
      },
    ]);
    const watch = new SubagentWatch({ connect: async () => sdk });
    watch.open('http://x', 't');
    watch.setRootSessionId('root');
    watch.setParentToolCallId('child_1', 'task_root');
    watch.setPermissionHandler(async () => ({ allow: true }));
    await collect(watch.events, 1); // the 'permission' AgentEvent itself
    // Give the async reply a turn to run.
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepStrictEqual(replies, [{ requestID: 'req_1', reply: 'once', directory: undefined }]);
  });
});
