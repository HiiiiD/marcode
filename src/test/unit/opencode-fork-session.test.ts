import * as assert from 'assert';
import { postForkSession } from '../../providers/opencode/fork-session';

suite('postForkSession', () => {
  test('posts to the fork endpoint with basic auth and returns the new session id', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: 'ses_new' }), { status: 200 });
    }) as unknown as typeof fetch;

    const id = await postForkSession('http://127.0.0.1:1', 'tok', 'ses_old', fetchFn);

    assert.strictEqual(id, 'ses_new');
    assert.strictEqual(calls[0].url, 'http://127.0.0.1:1/session/ses_old/fork');
    assert.strictEqual(calls[0].init.method, 'POST');
    assert.strictEqual(
      (calls[0].init.headers as Record<string, string>).Authorization,
      `Basic ${Buffer.from('opencode:tok').toString('base64')}`,
    );
  });

  test('a non-2xx answer is false', async () => {
    const fetchFn = (async () => new Response('no', { status: 500 })) as unknown as typeof fetch;
    assert.strictEqual(await postForkSession('http://x', 't', 's', fetchFn), false);
  });

  test('a body without an id is false', async () => {
    const fetchFn = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    assert.strictEqual(await postForkSession('http://x', 't', 's', fetchFn), false);
  });

  test('a network failure is false', async () => {
    const fetchFn = (async () => { throw new Error('down'); }) as unknown as typeof fetch;
    assert.strictEqual(await postForkSession('http://x', 't', 's', fetchFn), false);
  });
});
