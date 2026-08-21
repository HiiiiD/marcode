import * as assert from 'assert';
import { toToolCall, toToolOutput } from '../../providers/claude/map-tools';

suite('claude toToolCall', () => {
  test('Bash becomes a command, keeping the provider name as the label', () => {
    const call = toToolCall('Bash', {
      command: 'yarn test', description: 'run tests', timeout: 30000,
      run_in_background: true,
    });
    assert.deepStrictEqual(call, {
      kind: 'command', label: 'Bash', command: 'yarn test',
      note: 'run tests', timeoutMs: 30000, background: true,
    });
  });

  test('Edit becomes a modify with a before/after pair', () => {
    const call = toToolCall('Edit', {
      file_path: 'E:/x/src/app.ts', old_string: 'foo', new_string: 'bar',
      replace_all: true,
    });
    assert.deepStrictEqual(call, {
      kind: 'file-edit', label: 'Edit',
      files: [{
        path: 'E:/x/src/app.ts', op: 'modify',
        edits: [{ before: 'foo', after: 'bar' }], replaceAll: true,
      }],
    });
  });

  test('Write becomes a create carrying only the new content', () => {
    const call = toToolCall('Write', { file_path: '/tmp/a.txt', content: 'hello' });
    assert.deepStrictEqual(call, {
      kind: 'file-edit', label: 'Write',
      files: [{ path: '/tmp/a.txt', op: 'create', edits: [{ after: 'hello' }] }],
    });
  });

  test('Read carries its range', () => {
    const call = toToolCall('Read', { file_path: '/a.ts', offset: 10, limit: 20 });
    assert.deepStrictEqual(call, {
      kind: 'file-read', label: 'Read', path: '/a.ts',
      range: { offset: 10, limit: 20 },
    });
  });

  test('Grep and Glob differ only by mode', () => {
    const grep = toToolCall('Grep', { pattern: 'foo', path: 'src', glob: '*.ts' });
    assert.deepStrictEqual(grep, {
      kind: 'search', label: 'Grep', pattern: 'foo', mode: 'content',
      scope: 'src', filters: [{ label: 'glob', value: '*.ts' }],
    });
    const glob = toToolCall('Glob', { pattern: '**/*.ts' });
    assert.deepStrictEqual(glob, {
      kind: 'search', label: 'Glob', pattern: '**/*.ts', mode: 'files',
    });
  });

  test('WebFetch carries url and prompt', () => {
    const call = toToolCall('WebFetch', { url: 'https://x.dev/a', prompt: 'summarize' });
    assert.deepStrictEqual(call, {
      kind: 'web', label: 'WebFetch', url: 'https://x.dev/a', note: 'summarize',
    });
  });

  test('TodoWrite normalizes statuses and drops empty rows', () => {
    const call = toToolCall('TodoWrite', {
      todos: [
        { content: 'one', status: 'completed' },
        { content: 'two', status: 'weird' },
        { status: 'pending' },
      ],
    });
    assert.deepStrictEqual(call, {
      kind: 'todos', label: 'TodoWrite',
      items: [
        { status: 'completed', text: 'one' },
        { status: 'pending', text: 'two' },
      ],
    });
  });

  test('Agent spawns, SendMessage messages, TaskOutput collects', () => {
    assert.strictEqual(toToolCall('Agent', {}).kind, 'subagent');
    const spawn = toToolCall('Agent', {
      subagent_type: 'Explore', model: 'sonnet', prompt: 'find it',
    });
    assert.deepStrictEqual(spawn, {
      kind: 'subagent', label: 'Agent', action: 'spawn',
      agent: 'Explore', model: 'sonnet', prompt: 'find it',
    });
    const message = toToolCall('SendMessage', { to: 'agent-1', summary: 'ping' });
    assert.deepStrictEqual(message, {
      kind: 'subagent', label: 'SendMessage', action: 'message',
      target: 'agent-1', summary: 'ping',
    });
    const collect = toToolCall('TaskOutput', { task_id: 'task-9' });
    assert.deepStrictEqual(collect, {
      kind: 'subagent', label: 'TaskOutput', action: 'collect', target: 'task-9',
    });
  });

  test('Skill carries the invoked skill name and its args', () => {
    const call = toToolCall('Skill', { skill: 'superpowers:brainstorming', args: 'feature design' });
    assert.deepStrictEqual(call, {
      kind: 'command', label: 'Skill', command: 'feature design',
      skill: 'superpowers:brainstorming',
    });
    const bare = toToolCall('Skill', { skill: 'code-review' });
    assert.deepStrictEqual(bare, {
      kind: 'command', label: 'Skill', command: '', skill: 'code-review',
    });
  });

  test('an mcp__ name becomes an mcp call, carrying no raw arguments', () => {
    const call = toToolCall('mcp__github__create_issue', { title: 'bug' });
    assert.deepStrictEqual(call, {
      kind: 'mcp', label: 'create_issue', server: 'github', tool: 'create_issue',
    });
    assert.strictEqual('args' in call, false);
  });

  test('an unknown tool falls through to other with its raw input', () => {
    const call = toToolCall('Bananas', { a: 1 });
    assert.deepStrictEqual(call, { kind: 'other', label: 'Bananas', raw: { a: 1 } });
  });

  test('a malformed input never throws', () => {
    assert.strictEqual(toToolCall('Bash', null).kind, 'command');
    assert.strictEqual(toToolCall('Edit', 'nonsense').kind, 'file-edit');
    assert.strictEqual(toToolCall('TodoWrite', { todos: 'no' }).kind, 'todos');
    assert.strictEqual(toToolCall('Skill', null).kind, 'command');
  });
});

suite('claude toToolOutput', () => {
  test('a bare string is text', () => {
    assert.deepStrictEqual(toToolOutput('done'), { kind: 'text', text: 'done' });
  });

  test('content blocks join their text', () => {
    assert.deepStrictEqual(
      toToolOutput([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]),
      { kind: 'text', text: 'a\nb' },
    );
  });

  test('a stdout/stderr object joins both streams', () => {
    assert.deepStrictEqual(toToolOutput({ stdout: 'out', stderr: 'err' }),
      { kind: 'text', text: 'out\nerr' });
  });

  test('an unrecognized object stays json', () => {
    assert.deepStrictEqual(toToolOutput({ a: 1 }), { kind: 'json', value: { a: 1 } });
  });

  test('null and empty string are none', () => {
    assert.deepStrictEqual(toToolOutput(null), { kind: 'none' });
    assert.deepStrictEqual(toToolOutput(''), { kind: 'none' });
  });

  test('a SendMessage-style envelope unwraps to its message', () => {
    const content = JSON.stringify({ success: true, message: 'Agent agent-1 resumed from transcript' });
    assert.deepStrictEqual(toToolOutput(content), {
      kind: 'text', text: 'Agent agent-1 resumed from transcript',
    });
  });

  test('a success envelope with a non-string message is left as escaped JSON text', () => {
    const content = JSON.stringify({ success: true, message: { nested: true } });
    assert.deepStrictEqual(toToolOutput(content), { kind: 'text', text: content });
  });

  test('a JSON object missing "success" is left as escaped JSON text', () => {
    const content = JSON.stringify({ message: 'no success key' });
    assert.deepStrictEqual(toToolOutput(content), { kind: 'text', text: content });
  });

  test('an unrelated JSON string (an array) is left exactly as-is', () => {
    const content = JSON.stringify([1, 2, 3]);
    assert.deepStrictEqual(toToolOutput(content), { kind: 'text', text: content });
  });

  test('a non-JSON string never throws and passes through unchanged', () => {
    assert.deepStrictEqual(toToolOutput('not json {'), { kind: 'text', text: 'not json {' });
  });
});
