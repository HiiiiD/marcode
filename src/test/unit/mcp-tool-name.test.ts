import * as assert from 'assert';
import { parseToolName } from '../../host/mcp-tool-name';

suite('parseToolName', () => {
  test('splits an mcp tool name into server and bare tool', () => {
    assert.deepStrictEqual(parseToolName('mcp__github__create_pr'), {
      name: 'create_pr', mcpServer: 'github',
    });
  });

  test('leaves an ordinary tool name untouched', () => {
    assert.deepStrictEqual(parseToolName('Bash'), { name: 'Bash' });
  });

  test('keeps separators inside the tool name', () => {
    assert.deepStrictEqual(parseToolName('mcp__github__list__repos'), {
      name: 'list__repos', mcpServer: 'github',
    });
  });

  test('leaves a malformed mcp name as-is rather than guessing', () => {
    assert.deepStrictEqual(parseToolName('mcp__weird'), { name: 'mcp__weird' });
    assert.deepStrictEqual(parseToolName('mcp__'), { name: 'mcp__' });
    assert.deepStrictEqual(parseToolName('mcp____tool'), { name: 'mcp____tool' });
    assert.deepStrictEqual(parseToolName('mcp__server__'), { name: 'mcp__server__' });
  });

  test('does not treat a name merely containing mcp__ as an mcp tool', () => {
    assert.deepStrictEqual(parseToolName('run_mcp__thing'), { name: 'run_mcp__thing' });
  });
});
