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

suite('session refs', () => {
  test('message takes the most recent assistant item', () => {
    const items = [assistant('a1', 'first'), assistant('a2', 'second')];
    assert.strictEqual(findPayload(items, 'message'), 'second');
  });

  test('message skips the item that is still streaming', () => {
    const items = [assistant('a1', 'settled'), assistant('a2', 'half-writt')];
    assert.strictEqual(findPayload(items, 'message', 'a2'), 'settled');
  });

  test('message ignores an empty assistant item', () => {
    const items = [assistant('a1', 'real'), assistant('a2', '   ')];
    assert.strictEqual(findPayload(items, 'message'), 'real');
  });

  test('message returns undefined when there is none', () => {
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
