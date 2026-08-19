import * as assert from 'assert';
import { composePrompt, findPayload } from '../../host/session-refs';
import type { TranscriptItem } from '../../protocol/messages';

function assistant(id: string, text: string): TranscriptItem {
  return { id, ts: 1, role: 'assistant', text };
}

function plan(id: string, text: string, state: 'running' | 'ok' | 'error' = 'ok'): TranscriptItem {
  return {
    id, ts: 1, role: 'tool', toolId: `t-${id}`,
    tool: { kind: 'plan', label: 'ExitPlanMode', text },
    state,
  };
}

function fileEdit(
  id: string, paths: string[], state: 'running' | 'ok' | 'error' = 'ok',
): TranscriptItem {
  return {
    id, ts: 1, role: 'tool', toolId: `t-${id}`,
    tool: {
      kind: 'file-edit', label: 'Edit',
      files: paths.map((path) => ({ path, op: 'modify' as const })),
    },
    state,
  };
}

function command(id: string, cmd: string, state: 'running' | 'ok' | 'error' = 'ok'): TranscriptItem {
  return {
    id, ts: 1, role: 'tool', toolId: `t-${id}`,
    tool: { kind: 'command', label: 'Bash', command: cmd },
    state,
  };
}

suite('session refs', () => {
  test('message builds a recap of files touched, commands run, plan and closing note', () => {
    const items = [
      fileEdit('t1', ['src/a.ts']),
      command('t2', 'yarn lint'),
      plan('t3', 'ship it'),
      assistant('a1', 'done'),
    ];
    assert.strictEqual(
      findPayload(items, 'message'),
      'Touched: src/a.ts\nRan: yarn lint\nPlan: ship it\ndone',
    );
  });

  test('message omits a line whose bucket is empty', () => {
    const items = [fileEdit('t1', ['src/a.ts'])];
    assert.strictEqual(findPayload(items, 'message'), 'Touched: src/a.ts');
  });

  test('message dedupes files and commands, keeping first-seen order', () => {
    const items = [
      fileEdit('t1', ['src/a.ts']),
      command('t2', 'yarn lint'),
      fileEdit('t3', ['src/b.ts', 'src/a.ts']),
      command('t4', 'yarn lint'),
    ];
    assert.strictEqual(
      findPayload(items, 'message'),
      'Touched: src/a.ts, src/b.ts\nRan: yarn lint',
    );
  });

  test('message caps the touched-files line and counts the rest', () => {
    const items = Array.from({ length: 8 }, (_, i) => fileEdit(`t${i}`, [`src/f${i}.ts`]));
    assert.strictEqual(
      findPayload(items, 'message'),
      'Touched: src/f0.ts, src/f1.ts, src/f2.ts, src/f3.ts, src/f4.ts, src/f5.ts (+2 more)',
    );
  });

  test('message uses only the last plan, not every plan seen', () => {
    const items = [plan('p1', 'old plan'), plan('p2', 'new plan')];
    assert.strictEqual(findPayload(items, 'message'), 'Plan: new plan');
  });

  test('message skips tool calls that did not settle ok', () => {
    const items = [fileEdit('t1', ['src/a.ts'], 'error'), command('t2', 'yarn lint', 'running')];
    assert.strictEqual(findPayload(items, 'message'), undefined);
  });

  test('message closing note skips the item that is still streaming', () => {
    const items = [assistant('a1', 'settled'), assistant('a2', 'half-writt')];
    assert.strictEqual(findPayload(items, 'message', 'a2'), 'settled');
  });

  test('message ignores an empty closing note', () => {
    const items = [assistant('a1', 'real'), assistant('a2', '   ')];
    assert.strictEqual(findPayload(items, 'message'), 'real');
  });

  test('message returns undefined when there is nothing to report', () => {
    assert.strictEqual(findPayload([], 'message'), undefined);
  });

  test('plan takes the most recent settled plan call, across turns', () => {
    const items = [
      plan('p1', 'old plan'),
      { id: 'u1', ts: 2, role: 'user', text: 'go on' } as TranscriptItem,
      plan('p2', 'new plan'),
      assistant('a1', 'done'),
    ];
    assert.strictEqual(findPayload(items, 'plan'), 'new plan');
  });

  test('plan ignores an unsettled plan call', () => {
    const items = [plan('p1', 'settled'), plan('p2', 'in flight', 'running')];
    assert.strictEqual(findPayload(items, 'plan'), 'settled');
  });

  /**
   * Without the guard an empty plan resolves to `''`, which composes an empty
   * fenced block and renders as a disclosure chip with nothing behind it —
   * instead of falling back to the previous plan, or being reported missing.
   */
  test('plan ignores an empty plan and falls back to the previous one', () => {
    const items = [plan('p1', 'real plan'), plan('p2', '   \n ')];
    assert.strictEqual(findPayload(items, 'plan'), 'real plan');
  });

  test('plan with nothing but an empty plan is missing, not empty', () => {
    assert.strictEqual(findPayload([plan('p1', '')], 'plan'), undefined);
  });

  test('plan ignores tool calls that are not plans', () => {
    const items: TranscriptItem[] = [{
      id: 't1', ts: 1, role: 'tool', toolId: 'x',
      tool: { kind: 'command', label: 'Bash', command: 'ls' },
      state: 'ok',
    }];
    assert.strictEqual(findPayload(items, 'plan'), undefined);
  });

  test('composePrompt appends fenced blocks after the prose', () => {
    const out = composePrompt('Implement @agent-2 plan here.', [
      { title: 'agent-2', kind: 'plan', text: 'step one' },
    ]);
    assert.strictEqual(
      out,
      'Implement @agent-2 plan here.\n\n'
      + '--- plan from agent-2 ---\n'
      + 'step one\n'
      + '--- end plan from agent-2 ---',
    );
  });

  test('composePrompt with no blocks returns the prose unchanged', () => {
    assert.strictEqual(composePrompt('hello', []), 'hello');
  });
});
