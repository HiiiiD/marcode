import * as assert from 'assert';
import type { AgentEvent } from '../../providers/types';
import { makeSession } from './agent-session.test';

async function settle() {
  for (let i = 0; i < 10; i++) { await new Promise((r) => setImmediate(r)); }
}

const ls = { kind: 'command', label: 'Bash', command: 'ls' } as const;

function scripted(tool: object = ls) {
  let n = 0;
  return () => [{ kind: 'permission', id: `r${++n}`, tool } as AgentEvent];
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
});
