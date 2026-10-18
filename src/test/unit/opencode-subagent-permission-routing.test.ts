import * as assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { suite, test } from 'mocha';
import { SubagentWatch } from '../../providers/opencode/subagent-watch';

suite('OpenCode subagent permission routing', () => {
  test('approval reaches the event directory and unblocks the child through the real SDK', async () => {
    const directory = 'E:\\Other workspace\\child';
    const workspace = 'wrk_child';
    let events: ServerResponse | undefined;
    let replyBody = '';
    let replyScope: { directory: string | null; workspace: string | null } | undefined;
    const publish = (payload: unknown): void => {
      events?.write(`data: ${JSON.stringify({ directory, workspace, payload })}\n\n`);
    };
    const server = createServer((req, res) => {
      const url = new URL(req.url!, 'http://localhost');
      if (url.pathname === '/global/event') {
        events = res;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        publish({
          type: 'permission.asked',
          properties: {
            id: 'req_child', sessionID: 'child', permission: 'bash',
            patterns: ['echo approved'], metadata: {}, always: [],
          },
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/permission/req_child/reply') {
        replyScope = { directory: url.searchParams.get('directory'), workspace: url.searchParams.get('workspace') };
        req.setEncoding('utf8');
        req.on('data', (chunk: string) => { replyBody += chunk; });
        req.on('end', () => {
          const routed = replyScope?.directory === directory && replyScope.workspace === workspace;
          res.writeHead(routed ? 200 : 404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(routed ? true : { message: 'Permission request not found' }));
          if (routed) {
            publish({
              type: 'message.part.updated',
              properties: {
                sessionID: 'child',
                part: {
                  type: 'tool', callID: 'call_child', tool: 'bash',
                  state: { status: 'completed', input: { command: 'echo approved' }, output: 'approved' },
                },
              },
            });
          }
        });
        return;
      }
      res.writeHead(404).end();
    });
    const watch = new SubagentWatch();
    let timeout: NodeJS.Timeout | undefined;
    try {
      await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
      const address = server.address();
      assert.strictEqual(typeof address, 'object');
      if (!address || typeof address === 'string') { throw new Error('Expected a TCP listener'); }
      watch.setRootSessionId('root');
      watch.setParentToolCallId('child', 'task_root');
      watch.setPermissionHandler(async () => ({ allow: true }));
      watch.open(`http://127.0.0.1:${address.port}`, 'test-token');
      const result = await Promise.race([
        watch.events[Symbol.asyncIterator]().next(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`Child stayed blocked; reply scope: ${JSON.stringify(replyScope)}`)), 2000);
        }),
      ]);
      assert.strictEqual(result.value?.kind, 'tool-end');
      assert.strictEqual(result.value?.kind === 'tool-end' && result.value.ok, true);
      assert.deepStrictEqual(JSON.parse(replyBody), { reply: 'once' });
      assert.deepStrictEqual(replyScope, { directory, workspace });
    } finally {
      clearTimeout(timeout);
      watch.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => { server.close(() => resolve()); });
    }
  }).timeout(5000);
});
