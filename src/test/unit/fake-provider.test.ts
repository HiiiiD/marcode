import * as assert from 'assert';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { AgentEvent } from '../../providers/types';

async function drain(run: { events: AsyncIterable<AgentEvent> }, count: number) {
  const out: AgentEvent[] = [];
  for await (const ev of run.events) {
    out.push(ev);
    if (out.length === count) { break; }
  }
  return out;
}

suite('FakeProvider', () => {
  test('emits the scripted events for a sent message', async () => {
    const provider = new FakeProvider(() => [
      { kind: 'text', delta: 'hi' },
      { kind: 'turn-end', reason: 'done' },
    ]);
    const run = provider.start({ cwd: '/tmp', permissionMode: 'default' });
    run.send('hello');

    const events = await drain(run, 3);
    assert.deepStrictEqual(events[0], { kind: 'session', resumeToken: 'fake-session-1' });
    assert.deepStrictEqual(events[1], { kind: 'text', delta: 'hi' });
    assert.deepStrictEqual(events[2], { kind: 'turn-end', reason: 'done' });
    await run.dispose();
  });

  test('respondToTool resolves a pending permission', async () => {
    const provider = new FakeProvider(() => [
      { kind: 'permission', id: 'p1', name: 'Bash', input: { command: 'ls' } },
    ]);
    const run = provider.start({ cwd: '/tmp', permissionMode: 'default' });
    run.send('run ls');
    await drain(run, 2);

    run.respondToTool('p1', { allow: true });
    assert.deepStrictEqual(provider.decisions.get('p1'), { allow: true });
    await run.dispose();
  });

  test('setPermissionMode records the mode, mirroring how decisions records tool decisions', async () => {
    const provider = new FakeProvider(() => []);
    const run = provider.start({ cwd: '/tmp', permissionMode: 'default' });

    run.setPermissionMode('bypass');
    run.setPermissionMode('plan');

    assert.deepStrictEqual(provider.permissionModes, ['bypass', 'plan']);
    await run.dispose();
  });

  test('interrupt emits turn-end with reason interrupted', async () => {
    const provider = new FakeProvider(() => [{ kind: 'text', delta: 'working' }]);
    const run = provider.start({ cwd: '/tmp', permissionMode: 'default' });
    run.send('go');
    await drain(run, 2);

    await run.interrupt();
    const [ev] = await drain(run, 1);
    assert.deepStrictEqual(ev, { kind: 'turn-end', reason: 'interrupted' });
    await run.dispose();
  });

  test('a run can emit events outside of send()', async () => {
    const provider = new FakeProvider(() => []);
    provider.start({ cwd: '/tmp', permissionMode: 'default' });
    const run = provider.runs[0];

    run.emit({ kind: 'invocables', entries: [{ name: 'init' }] });
    const first = await run.events[Symbol.asyncIterator]().next();

    assert.deepStrictEqual(first.value, { kind: 'invocables', entries: [{ name: 'init' }] });
  });

  test('listInvocables answers with the scripted catalog and logs its cwd', async () => {
    const provider = new FakeProvider(() => []);
    provider.invocables = [{ name: 'brainstorming', description: 'Design first' }];

    const out = await provider.listInvocables('/repo');

    assert.deepStrictEqual(out, [{ name: 'brainstorming', description: 'Design first' }]);
    assert.deepStrictEqual(provider.listInvocablesCalls, ['/repo']);
  });

  test('listInvocables rejects when scripted with an error', async () => {
    const provider = new FakeProvider(() => []);
    provider.invocables = new Error('no catalog');

    await assert.rejects(() => provider.listInvocables('/repo'), /no catalog/);
  });
  
  test('scripted windows arrive as usage-window events before any send', async () => {
    const provider = new FakeProvider(undefined, {
      windows: [{ id: 'five-hour', label: 'Session (5h)', usedPercent: 62 }],
    });
    const run = provider.start({ cwd: '/w', permissionMode: 'default' });
    const it = run.events[Symbol.asyncIterator]();
    assert.deepStrictEqual((await it.next()).value, {
      kind: 'usage-window',
      window: { id: 'five-hour', label: 'Session (5h)', usedPercent: 62 },
    });
    await run.dispose();
  });

  test('an unscripted fake emits no usage-window events', async () => {
    const provider = new FakeProvider();
    const run = provider.start({ cwd: '/w', permissionMode: 'default' });
    const events: AgentEvent[] = [];
    void (async () => { for await (const e of run.events) { events.push(e); } })();
    await run.dispose();
    assert.ok(!events.some((e) => e.kind === 'usage-window'));
  });
});
