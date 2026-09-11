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

/**
 * Accumulates into an array the test can also assert is still EMPTY — which
 * `collect` cannot do, since it awaits an event that may never come. The
 * buffering tests below turn on exactly that distinction.
 */
function drain(events: AsyncIterable<AgentEvent>): AgentEvent[] {
  const out: AgentEvent[] = [];
  void (async () => { for await (const e of events) { out.push(e); } })();
  return out;
}

/** Long enough for the fake SDK's whole scripted stream to be consumed. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) { await new Promise((resolve) => setTimeout(resolve, 5)); }
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
      // Namespaced by session: `callID` is only unique within its own session.
      assert.strictEqual(event.id, 'child_1:call_1');
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
    assert.strictEqual(event.kind === 'tool-start' && event.id, 'child_1:call_1');
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
    let handlerCalled: { id: string; parentId: string | undefined } | undefined;
    watch.setPermissionHandler(async (id, _tool, _meta, parentId) => {
      handlerCalled = { id, parentId };
      return { allow: true };
    });
    // No event ever arrives on watch.events for a permission ask — that
    // belongs to whatever run.handleAuxiliaryPermission (the real handler,
    // once Task 5 wires it) pushes onto its OWN channel. watch.events only
    // ever carries tool-call activity. Poll for the reply instead.
    for (let i = 0; i < 50 && replies.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.deepStrictEqual(replies, [{ requestID: 'req_1', reply: 'once', directory: undefined }]);
    assert.deepStrictEqual(handlerCalled, { id: 'child_1:req_1', parentId: 'task_root' });
  });

  /**
   * The order production can actually reach, and the one the three tests
   * above cannot: `setParentToolCallId` is driven by `onSubagentSpawned`,
   * which cannot fire until the parent's own `task` tool call reaches its
   * COMPLETED frame — the sole point ACP's wire ever names a child session.
   * Every event a subagent emits while it is still running therefore arrives
   * with no nesting target known. Buffered, not dropped, is the whole fix.
   */
  test('a child discovered by session.created alone buffers its events until nesting is known', async () => {
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
    const seen = drain(watch.events);
    await settle();
    assert.strictEqual(seen.length, 0);
    // `onSubagentSpawned` finally firing, at the parent task call's completion.
    watch.setParentToolCallId('child_1', 'task_root');
    await settle();
    assert.strictEqual(seen.length, 1);
    const event = seen[0];
    assert.strictEqual(event.kind, 'tool-start');
    if (event.kind === 'tool-start') {
      assert.strictEqual(event.parentId, 'task_root');
      assert.strictEqual(event.id, 'child_1:call_1');
    }
    watch.close();
  });

  /**
   * A subagent that spawns its own subagent. The grandchild exists long before
   * anything knows where the CHILD nests, so its buffered events can only be
   * settled by resolving up the ancestor chain — a direct child-id lookup
   * would leave them parked forever. Both nest under the same top-level card.
   */
  test('a grandchild session nests under its nearest ancestor once that ancestor is known', async () => {
    const { sdk } = fakeSdk([
      { type: 'session.created', properties: { sessionID: 'child_1', info: { id: 'child_1', parentID: 'root' } } },
      { type: 'session.created', properties: { sessionID: 'grand_1', info: { id: 'grand_1', parentID: 'child_1' } } },
      {
        type: 'message.part.updated',
        properties: {
          sessionID: 'grand_1',
          part: { type: 'tool', callID: 'call_g', tool: 'bash', state: { status: 'pending', input: {}, raw: '' } },
        },
      },
    ]);
    const watch = new SubagentWatch({ connect: async () => sdk });
    watch.open('http://x', 't');
    watch.setRootSessionId('root');
    const seen = drain(watch.events);
    await settle();
    assert.strictEqual(seen.length, 0);
    // Only the CHILD's nesting target is ever learned — the grandchild's
    // `task` call belongs to the child's transcript, not this run's.
    watch.setParentToolCallId('child_1', 'task_root');
    await settle();
    assert.strictEqual(seen.length, 1);
    const event = seen[0];
    assert.strictEqual(event.kind === 'tool-start' && event.parentId, 'task_root');
    assert.strictEqual(event.kind === 'tool-start' && event.id, 'grand_1:call_g');
    watch.close();
  });

  /**
   * `setRootSessionId` enrolls the root in `watched` so its children can be
   * recognised by parentage — it must not also route the root's own activity
   * through this relay. The root already reaches the transcript down ACP's
   * normal path, so a second copy would double every card, and a second
   * permission card can never be answered (only one id is parked).
   */
  test("the root session's own permission ask is never relayed", async () => {
    const { sdk, replies } = fakeSdk([
      {
        type: 'permission.asked',
        properties: { id: 'req_root', sessionID: 'root', permission: 'bash', patterns: [], metadata: {}, always: [] },
      },
    ]);
    const watch = new SubagentWatch({ connect: async () => sdk });
    watch.open('http://x', 't');
    watch.setRootSessionId('root');
    let handlerCalls = 0;
    watch.setPermissionHandler(async () => { handlerCalls++; return { allow: true }; });
    await settle();
    assert.strictEqual(handlerCalls, 0);
    assert.strictEqual(replies.length, 0);
    watch.close();
  });

  test("the root session's own tool parts are never republished", async () => {
    const { sdk } = fakeSdk([
      {
        type: 'message.part.updated',
        properties: {
          sessionID: 'root',
          part: { type: 'tool', callID: 'call_root', tool: 'bash', state: { status: 'pending', input: {}, raw: '' } },
        },
      },
    ]);
    const watch = new SubagentWatch({ connect: async () => sdk });
    watch.open('http://x', 't');
    watch.setRootSessionId('root');
    const seen = drain(watch.events);
    await settle();
    assert.strictEqual(seen.length, 0);
    // Not merely un-nested-and-buffered: dropped at the gate. Learning a
    // nesting id for the root would flush anything `handlePart` had parked
    // for it, so a still-empty stream after this is what proves the part was
    // never taken in at all.
    watch.setParentToolCallId('root', 'task_x');
    await settle();
    assert.strictEqual(seen.length, 0);
    watch.close();
  });
});
