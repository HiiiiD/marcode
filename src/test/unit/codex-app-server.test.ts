import * as assert from 'assert';
import { PassThrough } from 'node:stream';
import { AppServer } from '../../providers/codex/app-server';

/** A stub child: no binary, no auth, no network. */
function stub() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const written: string[] = [];
  stdin.on('data', (chunk: Buffer) => { written.push(chunk.toString()); });
  let killed = false;
  const server = new AppServer({ stdin, stdout, kill: () => { killed = true; } });
  const send = (msg: unknown) => { stdout.write(`${JSON.stringify(msg)}\n`); };
  const sent = () => written.join('').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { server, send, sent, killed: () => killed };
}

suite('AppServer', () => {
  test('correlates a response to its request', async () => {
    const { server, send, sent } = stub();
    const pending = server.request<{ ok: boolean }>('initialize', { a: 1 });
    const [frame] = sent();
    assert.strictEqual(frame.method, 'initialize');
    send({ id: frame.id, result: { ok: true } });
    assert.deepStrictEqual(await pending, { ok: true });
  });

  test('two in-flight requests resolve independently and out of order', async () => {
    const { server, send, sent } = stub();
    const first = server.request<string>('model/list', {});
    const second = server.request<string>('account/read', {});
    const [a, b] = sent();
    send({ id: b.id, result: 'second' });
    send({ id: a.id, result: 'first' });
    assert.deepStrictEqual(await Promise.all([first, second]), ['first', 'second']);
  });

  test('an error response rejects with the server message', async () => {
    const { server, send, sent } = stub();
    const pending = server.request('thread/start', {});
    send({ id: sent()[0].id, error: { code: -32000, message: 'not signed in' } });
    await assert.rejects(pending, /not signed in/);
  });

  test('a notification reaches the notification sink', () => {
    const { server, send } = stub();
    const seen: string[] = [];
    server.onNotification((method) => { seen.push(method); });
    send({ method: 'turn/started', params: { threadId: 't1' } });
    assert.deepStrictEqual(seen, ['turn/started']);
  });

  test('a server request reaches the request sink and can be answered', () => {
    const { server, send, sent } = stub();
    server.onServerRequest((method, id) => {
      if (method === 'item/commandExecution/requestApproval') { server.respond(id, { decision: 'approved' }); }
    });
    send({ id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: 't1' } });
    const reply = sent().at(-1);
    assert.strictEqual(reply.id, 7);
    assert.deepStrictEqual(reply.result, { decision: 'approved' });
  });

  test('a frame split across chunks is still parsed', () => {
    const { server, send: _send } = stub();
    // Not send(): this deliberately writes a partial line first.
    const seen: string[] = [];
    server.onNotification((method) => { seen.push(method); });
    server.ingest('{"method":"turn/star');
    server.ingest('ted","params":{}}\n');
    assert.deepStrictEqual(seen, ['turn/started']);
  });

  test('a malformed line is skipped, not fatal', () => {
    const { server, send } = stub();
    const seen: string[] = [];
    server.onNotification((method) => { seen.push(method); });
    server.ingest('not json\n');
    send({ method: 'turn/completed', params: {} });
    assert.deepStrictEqual(seen, ['turn/completed']);
  });

  test('closing rejects every in-flight request', async () => {
    const { server } = stub();
    const pending = server.request('model/list', {});
    server.close('app-server exited');
    // Errors are state: the caller turns this into a session error item
    // rather than an unhandled rejection.
    await assert.rejects(pending, /app-server exited/);
  });

  test('close notifies once even if called twice', () => {
    const { server } = stub();
    let closes = 0;
    server.onClose(() => { closes += 1; });
    server.close('first');
    server.close('second');
    assert.strictEqual(closes, 1);
  });
});
