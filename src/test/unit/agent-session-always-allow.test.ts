import * as assert from 'assert';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { AgentEvent, AgentRun, StartOptions } from '../../providers/types';
import { makeSession } from './agent-session.test';

async function settle() {
  for (let i = 0; i < 10; i++) { await new Promise((r) => setImmediate(r)); }
}

const ls = { kind: 'command', label: 'Bash', command: 'ls' } as const;

function scripted(tool: object = ls) {
  let n = 0;
  return () => [{ kind: 'permission', id: `r${++n}`, tool } as AgentEvent];
}

class ThrowOn extends FakeProvider {
  constructor(script: () => AgentEvent[], private readonly failId: string) { super(script); }
  start(opts: StartOptions): AgentRun {
    const run = super.start(opts);
    const real = run.respondToTool.bind(run);
    run.respondToTool = (id, decision) => {
      if (id === this.failId) { throw new Error('boom'); }
      real(id, decision);
    };
    return run;
  }
}

type PermItem = { state: string; reason?: string; alwaysRule?: { label: string } };

suite('AgentSession always-allow', () => {
  test('a pending request carries alwaysRule when a rule is derivable', async () => {
    const { session } = await makeSession(scripted());
    session.send('go'); await settle();
    const item = (await session.snapshot()).items.find((i) => i.role === 'permission') as PermItem;
    assert.deepStrictEqual(item.alwaysRule, { label: 'Always allow `ls`' });
    await session.dispose();
  });

  test('a plan request carries no alwaysRule', async () => {
    const { session } = await makeSession(scripted({ kind: 'plan', label: 'Plan', text: 'x' }));
    session.send('go'); await settle();
    const item = (await session.snapshot()).items.find((i) => i.role === 'permission');
    assert.strictEqual('alwaysRule' in (item as object), false);
    await session.dispose();
  });

  test('always stores the rule and the next matching request is auto-allowed', async () => {
    const { session, provider } = await makeSession(scripted());
    session.send('one'); await settle();
    session.respondToPermission('r1', { allow: true }, true); await settle();
    session.send('two'); await settle();
    assert.deepStrictEqual(provider.decisions.get('r2'), { allow: true });
    assert.notStrictEqual(session.state.status, 'awaiting-approval');
    const snap = await session.snapshot();
    const items = snap.items.filter((i) => i.role === 'permission') as PermItem[];
    assert.strictEqual(items[1].state, 'allowed');
    assert.strictEqual(items[1].reason, 'Auto-allowed: Always allow `ls`');
    assert.strictEqual(snap.pending.length, 0);
    await session.dispose();
  });

  test('a different command is not matched by the rule', async () => {
    const cmds = ['ls', 'pwd'];
    let n = 0;
    const { session } = await makeSession(() => [{
      kind: 'permission', id: `r${++n}`,
      tool: { kind: 'command', label: 'Bash', command: cmds[n - 1] },
    }]);
    session.send('one'); await settle();
    session.respondToPermission('r1', { allow: true }, true); await settle();
    session.send('two'); await settle();
    assert.strictEqual(session.state.status, 'awaiting-approval');
    await session.dispose();
  });

  test('always on a deny or an unknown id stores nothing', async () => {
    const { session } = await makeSession(scripted());
    session.send('one'); await settle();
    session.respondToPermission('nope', { allow: true }, true);
    session.respondToPermission('r1', { allow: false, reason: 'x' }, true); await settle();
    session.send('two'); await settle();
    assert.strictEqual(session.state.status, 'awaiting-approval');
    await session.dispose();
  });

  test('always on an ineligible request stores nothing and does not throw', async () => {
    const { session } = await makeSession(scripted({ kind: 'plan', label: 'Plan', text: 'x' }));
    session.send('one'); await settle();
    session.respondToPermission('r1', { allow: true }, true); await settle();
    session.send('two'); await settle();
    assert.strictEqual(session.state.status, 'awaiting-approval');
    await session.dispose();
  });

  test('rules are per session', async () => {
    const a = await makeSession(scripted());
    const b = await makeSession(scripted());
    a.session.send('x'); await settle();
    a.session.respondToPermission('r1', { allow: true }, true); await settle();
    b.session.send('x'); await settle();
    assert.strictEqual(b.session.state.status, 'awaiting-approval');
    await a.session.dispose(); await b.session.dispose();
  });

  test('a rule is not stored when the provider rejects the decision that granted it', async () => {
    let n = 0;
    const provider = new ThrowOn(() => [{ kind: 'permission', id: `r${++n}`, tool: ls }], 'r1');
    const { session } = await makeSession(undefined, provider);
    session.send('one'); await settle();
    session.respondToPermission('r1', { allow: true }, true); await settle();
    session.send('two'); await settle();
    assert.strictEqual(provider.sent.length, 2, 'the second turn must actually reach the provider');
    assert.strictEqual(provider.decisions.has('r2'), false);
    await session.dispose();
  });

  test('an auto-answer the provider rejects settles the item as denied', async () => {
    let n = 0;
    const provider = new ThrowOn(() => [{ kind: 'permission', id: `r${++n}`, tool: ls }], 'r2');
    const { session } = await makeSession(undefined, provider);
    session.send('one'); await settle();
    session.respondToPermission('r1', { allow: true }, true); await settle();
    session.send('two'); await settle();
    assert.strictEqual(session.state.status, 'error');
    const items = (await session.snapshot()).items.filter((i) => i.role === 'permission') as PermItem[];
    assert.strictEqual(items[1].state, 'denied');
    await session.dispose();
  });

  test('a subagent request is auto-allowed by the session rule and stays nested', async () => {
    let n = 0;
    const { session, provider } = await makeSession(() => {
      n++;
      return [
        { kind: 'tool-start', id: `t${n}`, tool: { kind: 'subagent', label: 'Task', action: 'spawn' } },
        { kind: 'permission', id: `r${n}`, tool: ls, parentId: `t${n}` },
      ];
    });
    session.send('one'); await settle();
    session.respondToPermission('r1', { allow: true }, true); await settle();
    session.send('two'); await settle();
    assert.deepStrictEqual(provider.decisions.get('r2'), { allow: true });
    const parent = (await session.snapshot()).items.find(
      (i) => i.role === 'tool' && i.id !== undefined && (i as { children?: unknown[] }).children?.some(
        (c) => (c as { requestId?: string }).requestId === 'r2',
      ),
    ) as { children: PermItem[] } | undefined;
    assert.strictEqual(parent?.children.find((c) => (c as { requestId?: string }).requestId === 'r2')?.state, 'allowed');
    await session.dispose();
  });

  test('an edit inside the session cwd carries a rule; one outside does not', async () => {
    const edit = (path: string) => ({ kind: 'file-edit', label: 'Edit', files: [{ path, op: 'modify' }] });
    const inside = await makeSession(scripted(edit('/tmp/a.ts')));
    inside.session.send('go'); await settle();
    const yes = (await inside.session.snapshot()).items.find((i) => i.role === 'permission') as PermItem;
    assert.deepStrictEqual(yes.alwaysRule, { label: 'Always allow file edits' });
    const outside = await makeSession(scripted(edit('/etc/x')));
    outside.session.send('go'); await settle();
    const no = (await outside.session.snapshot()).items.find((i) => i.role === 'permission') as PermItem;
    assert.strictEqual(no.alwaysRule, undefined);
    await inside.session.dispose(); await outside.session.dispose();
  });
});
