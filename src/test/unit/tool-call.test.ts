import * as assert from 'assert';
import { parseMcpName, toTodoStatus } from '../../providers/canonical/tool-call';

suite('parseMcpName', () => {
  test('splits server and tool', () => {
    assert.deepStrictEqual(parseMcpName('mcp__github__create_issue'),
      { server: 'github', tool: 'create_issue' });
  });

  test('keeps separators inside the tool name', () => {
    assert.deepStrictEqual(parseMcpName('mcp__github__list__repos'),
      { server: 'github', tool: 'list__repos' });
  });

  test('is undefined for a name without the prefix', () => {
    assert.strictEqual(parseMcpName('Bash'), undefined);
  });

  test('is undefined for a prefix with no server', () => {
    assert.strictEqual(parseMcpName('mcp____tool'), undefined);
  });

  test('is undefined for a prefix with no tool', () => {
    assert.strictEqual(parseMcpName('mcp__github__'), undefined);
  });
});

suite('toTodoStatus', () => {
  test('passes through the two non-default states', () => {
    assert.strictEqual(toTodoStatus('completed'), 'completed');
    assert.strictEqual(toTodoStatus('in_progress'), 'in_progress');
  });

  test('degrades anything else to pending', () => {
    assert.strictEqual(toTodoStatus('nonsense'), 'pending');
    assert.strictEqual(toTodoStatus(undefined), 'pending');
    assert.strictEqual(toTodoStatus(7), 'pending');
  });
});
