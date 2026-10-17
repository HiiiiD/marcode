import * as assert from 'assert';
import { CodexRun, type CodexConnection } from '../../providers/codex/codex-run';
import { elicitationApprovalOf } from '../../providers/codex/elicitation';
import type { AgentEvent } from '../../providers/types';

const consent = {
  threadId: 'th_1', turnId: 'tu_1', serverName: 'marcode_self_control', mode: 'form',
  message: 'Allow the marcode_self_control MCP server to run tool "marcode__send_message"?',
  requestedSchema: { type: 'object', properties: {} },
};

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function fixture(threadId = 'th_1') {
  let receive: Parameters<CodexConnection['onServerRequest']>[0] = () => {};
  let notify: Parameters<CodexConnection['onNotification']>[0] = () => {};
  const replies: Array<{ id: string | number; result: unknown }> = [];
  const connection: CodexConnection = {
    async request<T>(method: string): Promise<T> {
      return (method === 'thread/start' ? { thread: { id: threadId } } : {}) as T;
    },
    respond(id, result) { replies.push({ id, result }); },
    onServerRequest(cb) { receive = cb; },
    onNotification(cb) { notify = cb; },
    onClose() {},
  };
  const run = new CodexRun(connection, {
    cwd: '/repo', sessionId: 'test-session', permissionMode: 'default',
  });
  const events: AgentEvent[] = [];
  void (async () => { for await (const event of run.events) { events.push(event); } })();
  run.send('hello');
  await tick();
  return {
    run, events, replies,
    receive: (id: string | number, params: unknown = consent) => {
      receive('mcpServer/elicitation/request', id, params);
    },
    notify: (method: string, params: unknown) => notify(method, params),
  };
}

suite('Codex MCP elicitation', () => {
  test('empty-form consent exposes the server and prompt as a permission', () => {
    const event = elicitationApprovalOf(48, consent);
    assert.strictEqual(event?.id, '48');
    assert.strictEqual(event?.meta?.description, consent.message);
    assert.strictEqual(event?.tool.kind, 'other');
    if (event?.tool.kind === 'other') {
      assert.deepStrictEqual(event.tool.fields, [{ label: 'server', value: 'marcode_self_control' }]);
    }
  });

  for (const allow of [true, false]) {
    test(`${allow ? 'Allow accepts' : 'Deny declines'} the parked consent exactly once`, async () => {
      const { run, receive, events, replies } = await fixture();
      receive(48);
      await tick();
      assert.strictEqual(events.some((event) => event.kind === 'permission' && event.id === '48'), true);
      assert.strictEqual(replies.length, 0);
      run.respondToTool('48', { allow });
      run.respondToTool('48', { allow: !allow });
      assert.deepStrictEqual(replies, [{
        id: 48, result: { action: allow ? 'accept' : 'decline', content: allow ? {} : null, _meta: null },
      }]);
      await run.dispose();
    });
  }

  for (const action of ['interrupt', 'dispose'] as const) {
    test(`${action} declines parked consent and cancels its card`, async () => {
      const { run, receive, events, replies } = await fixture();
      receive('consent-1');
      await tick();
      await run[action]();
      await tick();
      assert.deepStrictEqual(replies, [{
        id: 'consent-1', result: { action: 'decline', content: null, _meta: null },
      }]);
      assert.strictEqual(events.some((event) => event.kind === 'request-cancelled'
        && event.id === 'consent-1'), true);
      run.respondToTool('consent-1', { allow: true });
      assert.strictEqual(replies.length, 1);
      if (action === 'interrupt') { await run.dispose(); }
    });
  }

  test('a request for another thread is left to its owning run', async () => {
    const { run, receive, events, replies } = await fixture('th_other');
    receive(48);
    await tick();
    assert.strictEqual(events.some((event) => event.kind === 'permission'), false);
    assert.strictEqual(replies.length, 0);
    await run.dispose();
  });

  test('a child-thread consent is attached to the parent subagent card', async () => {
    const { run, receive, notify, events, replies } = await fixture();
    notify('item/started', {
      threadId: 'th_1', item: {
        type: 'subAgentActivity', id: 'spawn-1', kind: 'started',
        agentThreadId: 'th_child', agentPath: 'worker',
      },
    });
    receive(48, { ...consent, threadId: 'th_child' });
    await tick();
    const permission = events.find((event) => event.kind === 'permission');
    assert.strictEqual(permission?.parentId, 'spawn-1');
    run.respondToTool('48', { allow: true });
    assert.deepStrictEqual(replies, [{ id: 48, result: { action: 'accept', content: {}, _meta: null } }]);
    await run.dispose();
  });

  const unsupported = [
    null,
    { ...consent, mode: 'url', url: 'https://example.com' },
    { ...consent, requestedSchema: { type: 'object', properties: { name: { type: 'string' } } } },
    { ...consent, requestedSchema: { type: 'object', properties: {}, required: ['name'] } },
    { ...consent, requestedSchema: { type: 'object', properties: [] } },
    { ...consent, requestedSchema: null },
    { ...consent, message: 42 },
    { ...consent, serverName: '' },
  ];
  for (const [index, params] of unsupported.entries()) {
    test(`unsupported or malformed elicitation ${index + 1} is answered without a permission card`, async () => {
      const { run, receive, events, replies } = await fixture();
      receive(48, params);
      await tick();
      assert.strictEqual(events.some((event) => event.kind === 'permission'), false);
      assert.deepStrictEqual(replies, [{ id: 48, result: { action: 'decline', content: null, _meta: null } }]);
      assert.strictEqual(events.some((event) => event.kind === 'tool-end' && !event.ok), true);
      await run.dispose();
    });
  }
});
