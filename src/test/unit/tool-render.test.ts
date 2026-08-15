import * as assert from 'assert';
import type { ToolCall } from '../../protocol/messages';
import { describeInput, describeOutput, describeTool } from '../../webview/components/tool-render';

suite('describeTool', () => {
  test('a command shows its command in mono', () => {
    const header = describeTool({ kind: 'command', label: 'Bash', command: 'yarn test' });
    assert.deepStrictEqual(
      { glyph: header.glyph, verb: header.verb, primary: header.primary, mono: header.mono },
      { glyph: 'terminal', verb: 'Bash', primary: 'yarn test', mono: true },
    );
  });

  test('an all-create edit gets the file-plus glyph, a modify gets file-pen', () => {
    const create: ToolCall = {
      kind: 'file-edit', label: 'Write',
      files: [{ path: '/a/b/c.ts', op: 'create' }],
    };
    assert.strictEqual(describeTool(create).glyph, 'file-plus');
    const modify: ToolCall = {
      kind: 'file-edit', label: 'Edit',
      files: [{ path: '/a/b/c.ts', op: 'modify' }],
    };
    assert.strictEqual(describeTool(modify).glyph, 'file-pen');
  });

  test('a multi-file edit counts files instead of naming one', () => {
    const header = describeTool({
      kind: 'file-edit', label: 'Edit',
      files: [{ path: 'a.ts', op: 'modify' }, { path: 'b.ts', op: 'modify' }],
    });
    assert.strictEqual(header.primary, '2 files');
  });

  test('search picks its glyph from mode', () => {
    assert.strictEqual(describeTool({
      kind: 'search', label: 'Grep', pattern: 'x', mode: 'content',
    }).glyph, 'search');
    assert.strictEqual(describeTool({
      kind: 'search', label: 'Glob', pattern: 'x', mode: 'files',
    }).glyph, 'folder-search');
  });

  test('a subagent message gets the send glyph, a spawn gets bot', () => {
    assert.strictEqual(describeTool({
      kind: 'subagent', label: 'SendMessage', action: 'message', summary: 'ping',
    }).glyph, 'send');
    assert.strictEqual(describeTool({
      kind: 'subagent', label: 'Agent', action: 'spawn', agent: 'Explore',
    }).glyph, 'bot');
  });

  test('an mcp call shows server and tool', () => {
    const header = describeTool({
      kind: 'mcp', label: 'create_issue', server: 'github', tool: 'create_issue',
    });
    assert.strictEqual(header.primary, 'github · create_issue');
  });

  test('a long primary carries a full value for the title attribute', () => {
    const long = 'x'.repeat(60);
    assert.strictEqual(describeTool({
      kind: 'command', label: 'Bash', command: long,
    }).full, long);
  });
});

suite('describeInput', () => {
  test('a command yields note, command and its scalar fields', () => {
    const blocks = describeInput({
      kind: 'command', label: 'Bash', command: 'ls', note: 'list',
      timeoutMs: 30000, background: true,
    });
    assert.deepStrictEqual(blocks, [
      { kind: 'note', text: 'list' },
      { kind: 'command', text: 'ls' },
      { kind: 'field', label: 'timeout', value: '30s' },
      { kind: 'field', label: 'mode', value: 'background' },
    ]);
  });

  test('a before/after edit becomes -/+ diff lines under its path', () => {
    const blocks = describeInput({
      kind: 'file-edit', label: 'Edit',
      files: [{ path: '/a.ts', op: 'modify', edits: [{ before: 'foo', after: 'bar' }] }],
    });
    assert.deepStrictEqual(blocks, [
      { kind: 'path', path: '/a.ts' },
      { kind: 'diff', lines: ['-foo', '+bar'] },
    ]);
  });

  test('a unified diff is stripped to its body lines', () => {
    const blocks = describeInput({
      kind: 'file-edit', label: 'Edit',
      files: [{
        path: '/a.ts', op: 'modify',
        unifiedDiff: '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new',
      }],
    });
    assert.deepStrictEqual(blocks, [
      { kind: 'path', path: '/a.ts' },
      { kind: 'diff', lines: ['-old', '+new'] },
    ]);
  });

  test('a header-only diff yields no empty diff block', () => {
    const blocks = describeInput({
      kind: 'file-edit', label: 'Edit',
      files: [{ path: '/a.ts', op: 'rename', unifiedDiff: '--- a/a.ts\n+++ b/b.ts\n' }],
    });
    assert.deepStrictEqual(blocks, [{ kind: 'path', path: '/a.ts' }]);
  });

  test('a read shows its path with a line hint', () => {
    assert.deepStrictEqual(describeInput({
      kind: 'file-read', label: 'Read', path: '/a.ts', range: { offset: 10, limit: 20 },
    }), [{ kind: 'path', path: '/a.ts', hint: 'lines 10–30' }]);
  });

  test('a read with an open-ended range says so', () => {
    assert.deepStrictEqual(describeInput({
      kind: 'file-read', label: 'Read', path: '/a.ts', range: { offset: 10 },
    }), [{ kind: 'path', path: '/a.ts', hint: 'lines 10–end' }]);
  });

  test('todos render as todo rows', () => {
    assert.deepStrictEqual(describeInput({
      kind: 'todos', label: 'TodoWrite',
      items: [{ status: 'completed', text: 'one' }],
    }), [{ kind: 'todos', items: [{ status: 'completed', text: 'one' }] }]);
  });

  test('a spawned subagent shows its brief last', () => {
    assert.deepStrictEqual(describeInput({
      kind: 'subagent', label: 'Agent', action: 'spawn',
      agent: 'Explore', model: 'sonnet', prompt: 'find it',
    }), [
      { kind: 'field', label: 'agent', value: 'Explore' },
      { kind: 'field', label: 'model', value: 'sonnet' },
      { kind: 'lines', text: 'find it', tone: 'output' },
    ]);
  });

  test('an empty other yields no block at all', () => {
    assert.deepStrictEqual(describeInput({ kind: 'other', label: 'X', raw: {} }), []);
  });

  test('a populated other falls back to pretty JSON', () => {
    const blocks = describeInput({ kind: 'other', label: 'X', raw: { a: 1 } });
    assert.strictEqual(blocks.length, 1);
    assert.strictEqual(blocks[0].kind, 'json');
  });
});

suite('describeOutput', () => {
  test('running renders nothing', () => {
    assert.deepStrictEqual(
      describeOutput('command', { kind: 'text', text: 'x' }, 'running'), []);
  });

  test('a file-read result renders in the code tone', () => {
    assert.deepStrictEqual(
      describeOutput('file-read', { kind: 'text', text: 'contents' }, 'ok'),
      [{ kind: 'lines', text: 'contents', tone: 'code' }]);
  });

  test('a command result renders in the output tone', () => {
    assert.deepStrictEqual(
      describeOutput('command', { kind: 'text', text: 'done' }, 'ok'),
      [{ kind: 'lines', text: 'done', tone: 'output' }]);
  });

  test('an error renders in the error tone', () => {
    assert.deepStrictEqual(
      describeOutput('command', { kind: 'text', text: 'boom' }, 'error'),
      [{ kind: 'lines', text: 'boom', tone: 'error' }]);
  });

  test('no output says so, and says it differently when it failed', () => {
    assert.deepStrictEqual(describeOutput('command', { kind: 'none' }, 'ok'),
      [{ kind: 'note', text: 'No output.' }]);
    assert.deepStrictEqual(describeOutput('command', { kind: 'none' }, 'error'),
      [{ kind: 'note', text: 'Failed with no output.' }]);
  });

  test('a json result renders as pretty JSON', () => {
    const blocks = describeOutput('mcp', { kind: 'json', value: { a: 1 } }, 'ok');
    assert.strictEqual(blocks[0].kind, 'json');
  });
});
