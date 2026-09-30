import * as assert from 'assert';
import { dormantProvider } from '../../host/dormant-provider';
import { FakeProvider } from '../../providers/fake/fake-provider';

suite('dormantProvider', () => {
  test('it keeps the wrapped provider\'s identity and catalog', () => {
    const fake = new FakeProvider(() => []);
    const dormant = dormantProvider(fake);
    assert.strictEqual(dormant.id, fake.id);
    assert.deepStrictEqual(dormant.listModels(), fake.listModels());
  });

  test('start() spawns nothing on the wrapped provider', () => {
    const fake = new FakeProvider(() => []);
    dormantProvider(fake).start({ cwd: '/w', model: 'fake-large', permissionMode: 'default', sessionId: 's' });
    assert.strictEqual(fake.lastStart, undefined);
  });

  test('the run ignores sends and its event stream ends only when disposed', async () => {
    const run = dormantProvider(new FakeProvider(() => [])).start({
      cwd: '/w', model: 'fake-large', permissionMode: 'default', sessionId: 's',
    });
    run.send('hello');
    run.respondToTool('t', { behavior: 'deny' } as never);
    let ended = false;
    const drain = (async () => { for await (const _ of run.events) { /* none */ } ended = true; })();
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(ended, false);
    await run.dispose();
    await drain;
    assert.strictEqual(ended, true);
  });
});
