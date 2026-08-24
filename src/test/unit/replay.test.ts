import * as assert from 'assert';
import { buildSeed } from '../../host/replay';
import type { TranscriptItem } from '../../protocol/messages';

function user(id: string, text: string): TranscriptItem {
  return { id, ts: 1, role: 'user', text };
}
function assistant(id: string, text: string): TranscriptItem {
  return { id, ts: 2, role: 'assistant', text };
}
function bash(id: string, command: string): TranscriptItem {
  return {
    id, ts: 3, role: 'tool', toolId: `x-${id}`, state: 'ok',
    tool: { kind: 'command', label: 'Bash', command },
    output: { kind: 'text', text: 'a'.repeat(5000) },
  };
}

suite('buildSeed', () => {
  test('returns empty string for an empty transcript', () => {
    assert.strictEqual(buildSeed([]), '');
  });

  test('frames the seed as narration, not instruction', () => {
    const seed = buildSeed([user('u1', 'add a login form')]);
    assert.strictEqual(seed.includes('already happened'), true);
    assert.strictEqual(seed.includes('Do not redo'), true);
  });

  test('keeps user messages verbatim', () => {
    assert.strictEqual(buildSeed([user('u1', 'add a login form')]).includes('add a login form'), true);
  });

  test('keeps assistant text', () => {
    assert.strictEqual(buildSeed([assistant('a1', 'I added it')]).includes('I added it'), true);
  });

  test('summarizes a tool call without its output', () => {
    const seed = buildSeed([bash('t1', 'yarn test')]);
    assert.strictEqual(seed.includes('yarn test'), true);
    assert.strictEqual(seed.includes('aaaa'), false);
  });

  test('names files touched by an edit', () => {
    const edit: TranscriptItem = {
      id: 't2', ts: 3, role: 'tool', toolId: 'x2', state: 'ok',
      tool: {
        kind: 'file-edit', label: 'Edit',
        files: [{ path: '/repo/src/a.ts', op: 'modify' }],
      },
    };
    assert.strictEqual(buildSeed([edit]).includes('/repo/src/a.ts'), true);
  });

  test('preserves order', () => {
    const seed = buildSeed([user('u1', 'FIRST'), assistant('a1', 'SECOND')]);
    assert.strictEqual(seed.indexOf('FIRST') < seed.indexOf('SECOND'), true);
  });

  test('drops the oldest lines to fit the budget, keeping the newest', () => {
    const many = Array.from({ length: 50 }, (_, i) => user(`u${i}`, `message-${i}`));
    const seed = buildSeed(many, 400);
    assert.strictEqual(seed.length <= 400, true);
    assert.strictEqual(seed.includes('message-49'), true);
    assert.strictEqual(seed.includes('message-0'), false);
  });

  test('says so when it dropped earlier turns', () => {
    const many = Array.from({ length: 50 }, (_, i) => user(`u${i}`, `message-${i}`));
    assert.strictEqual(buildSeed(many, 400).includes('Earlier turns omitted'), true);
  });

  test('never exceeds the budget even when one line alone is oversized', () => {
    const seed = buildSeed([user('u1', 'x'.repeat(10_000))], 300);
    assert.strictEqual(seed.length <= 300, true);
  });

  test('states the new directory explicitly when given one', () => {
    const seed = buildSeed([user('u1', 'add a login form')], undefined, '/repo/worktrees/feat-x');
    assert.strictEqual(seed.includes('/repo/worktrees/feat-x'), true);
  });

  test('skips permission and error items', () => {
    const items: TranscriptItem[] = [
      { id: 'p1', ts: 4, role: 'permission', requestId: 'r1', state: 'allowed',
        tool: { kind: 'command', label: 'Bash', command: 'rm -rf /tmp/x' } },
      { id: 'e1', ts: 5, role: 'error', message: 'provider exploded' },
      user('u1', 'keep me'),
    ];
    const seed = buildSeed(items);
    assert.strictEqual(seed.includes('rm -rf'), false);
    assert.strictEqual(seed.includes('provider exploded'), false);
    assert.strictEqual(seed.includes('keep me'), true);
  });
});
