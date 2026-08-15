import * as assert from 'assert';
import {
  clampLines, describeInput, describeOutput, describeTool, diffLines, outputText, shortPath,
} from '../../webview/components/tool-render';

suite('describeTool header', () => {
  test('a shell call leads with the command, in the editor font', () => {
    const header = describeTool('Bash', { command: 'yarn test:unit', description: 'Run tests' });
    assert.strictEqual(header.glyph, 'terminal');
    assert.strictEqual(header.verb, 'Bash');
    assert.strictEqual(header.primary, 'yarn test:unit');
    assert.strictEqual(header.mono, true);
  });

  test('PowerShell is the same tool as Bash to the eye', () => {
    assert.strictEqual(describeTool('PowerShell', { command: 'Get-ChildItem' }).glyph, 'terminal');
  });

  test('a file call leads with a path shortened to what 300px can hold', () => {
    const header = describeTool('Read', { file_path: 'e:/Efebia/hiiiid-code/src/webview/store.tsx' });
    assert.strictEqual(header.glyph, 'file-text');
    assert.strictEqual(header.primary, '…/webview/store.tsx');
  });

  test('Edit and Write are told apart by their glyph, not their label', () => {
    assert.strictEqual(describeTool('Edit', { file_path: '/a/b.ts' }).glyph, 'file-pen');
    assert.strictEqual(describeTool('Write', { file_path: '/a/b.ts' }).glyph, 'file-plus');
  });

  test('a search leads with the pattern', () => {
    assert.strictEqual(describeTool('Grep', { pattern: "role: 'tool'" }).primary, "role: 'tool'");
  });

  test('a fetch leads with the host, since the full URL never fits', () => {
    assert.strictEqual(
      describeTool('WebFetch', { url: 'https://example.com/a/very/long/path?q=1' }).primary,
      'example.com',
    );
  });

  test('a non-URL url is shown verbatim rather than throwing', () => {
    assert.strictEqual(describeTool('WebFetch', { url: 'not a url' }).primary, 'not a url');
  });

  test('a todo write leads with the item now in progress', () => {
    const header = describeTool('TodoWrite', {
      todos: [
        { content: 'Ship it', status: 'pending' },
        { content: 'Wire the card', activeForm: 'Wiring the card', status: 'in_progress' },
      ],
    });
    assert.strictEqual(header.primary, 'Wiring the card');
  });

  test('an unknown tool with one string argument still shows it', () => {
    const header = describeTool('create_pr', { title: 'Polish tool cards' });
    assert.strictEqual(header.glyph, 'wrench');
    assert.strictEqual(header.primary, 'Polish tool cards');
  });

  test('an unknown tool with a compound argument shows nothing rather than JSON in the header', () => {
    assert.strictEqual(describeTool('create_pr', { title: 'x', body: 'y' }).primary, '');
  });

  test('a header longer than the truncation budget carries the full value for a title', () => {
    const command = 'yarn test:unit --grep "the transcript renders every item role"';
    assert.strictEqual(describeTool('Bash', { command }).full, command);
    assert.strictEqual(describeTool('Bash', { command: 'ls' }).full, undefined);
  });

  test('a garbage input never throws — tool arguments are model-generated', () => {
    assert.strictEqual(describeTool('Bash', null).primary, '');
    assert.strictEqual(describeTool('Read', 'not an object').primary, '');
    assert.strictEqual(describeTool('Grep', [1, 2, 3]).primary, '');
  });
});

suite('describeInput blocks', () => {
  test('a shell call becomes a note, a command and its non-default settings', () => {
    const blocks = describeInput('Bash', {
      command: 'yarn build', description: 'Build it', run_in_background: true, timeout: 600000,
    });
    assert.deepStrictEqual(blocks, [
      { kind: 'note', text: 'Build it' },
      { kind: 'command', text: 'yarn build' },
      { kind: 'field', label: 'timeout', value: '600s' },
      { kind: 'field', label: 'mode', value: 'background' },
    ]);
  });

  test('an edit becomes a path plus a diff, and the path is not a diff line', () => {
    const blocks = describeInput('Edit', {
      file_path: '/a/b.ts', old_string: 'one\ntwo', new_string: 'three',
    });
    assert.deepStrictEqual(blocks, [
      { kind: 'path', path: '/a/b.ts' },
      { kind: 'diff', lines: ['-one', '-two', '+three'] },
    ]);
  });

  test('a write is an all-additions diff', () => {
    const blocks = describeInput('Write', { file_path: '/a/b.ts', content: 'hello' });
    assert.deepStrictEqual(blocks[1], { kind: 'diff', lines: ['+hello'] });
  });

  test('a ranged read says which lines it took', () => {
    assert.deepStrictEqual(
      describeInput('Read', { file_path: '/a/b.ts', offset: 200, limit: 60 }),
      [{ kind: 'path', path: '/a/b.ts', hint: 'lines 200–260' }],
    );
  });

  test('an open-ended read says so rather than inventing an end line', () => {
    assert.deepStrictEqual(
      describeInput('Read', { file_path: '/a/b.ts', offset: 200 }),
      [{ kind: 'path', path: '/a/b.ts', hint: 'lines 200–end' }],
    );
  });

  test('a grep keeps its pattern, its haystack and its filters apart', () => {
    assert.deepStrictEqual(describeInput('Grep', {
      pattern: 'useStore', path: 'src/webview', glob: '*.tsx', output_mode: 'content',
    }), [
      { kind: 'command', text: 'useStore' },
      { kind: 'path', path: 'src/webview' },
      { kind: 'field', label: 'glob', value: '*.tsx' },
      { kind: 'field', label: 'output mode', value: 'content' },
    ]);
  });

  test('todos keep their status, and an unknown status reads as pending', () => {
    const blocks = describeInput('TodoWrite', {
      todos: [
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'in_progress' },
        { content: 'c', status: 'nonsense' },
        { content: '', status: 'pending' },
      ],
    });
    assert.deepStrictEqual(blocks, [{
      kind: 'todos',
      items: [
        { status: 'completed', text: 'a' },
        { status: 'in_progress', text: 'b' },
        { status: 'pending', text: 'c' },
      ],
    }]);
  });

  test('an unrecognized tool falls back to pretty JSON, as the card always did', () => {
    const blocks = describeInput('create_pr', { title: 'x', body: 'y' });
    assert.strictEqual(blocks.length, 1);
    assert.strictEqual(blocks[0].kind, 'json');
  });

  test('an empty input produces no blocks rather than an empty JSON husk', () => {
    assert.deepStrictEqual(describeInput('create_pr', {}), []);
    assert.deepStrictEqual(describeInput('create_pr', undefined), []);
  });
});

suite('outputText', () => {
  test('passes a plain string through', () => {
    assert.strictEqual(outputText('done'), 'done');
  });

  test('joins the content-block array the Anthropic wire shape uses', () => {
    assert.strictEqual(
      outputText([{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }]),
      'one\ntwo',
    );
  });

  test('reads a stdout/stderr pair as one stream', () => {
    assert.strictEqual(outputText({ stdout: 'out', stderr: 'err' }), 'out\nerr');
  });

  test('an absent result is empty, not the string "undefined"', () => {
    assert.strictEqual(outputText(undefined), '');
    assert.strictEqual(outputText(null), '');
  });

  test('an unrecognized shape degrades to JSON instead of "[object Object]"', () => {
    assert.strictEqual(outputText({ ok: true }), '{\n  "ok": true\n}');
  });

  test('a circular result does not throw during render', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    assert.strictEqual(outputText(circular), '<unserializable>');
  });
});

suite('clampLines', () => {
  test('short output is not clamped — the divider would cost more than it saves', () => {
    const result = clampLines('a\nb\nc');
    assert.deepStrictEqual(result, { head: ['a', 'b', 'c'], tail: [], hidden: 0 });
  });

  test('long output keeps its opening and its verdict, and counts what it dropped', () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
    const result = clampLines(text);
    assert.strictEqual(result.head.length, 12);
    assert.strictEqual(result.tail.length, 8);
    assert.strictEqual(result.head[0], 'line 0');
    assert.strictEqual(result.tail[7], 'line 99');
    assert.strictEqual(result.hidden, 80);
    assert.strictEqual(result.head.length + result.tail.length + result.hidden, 100);
  });

  test('trailing blank lines do not count as content', () => {
    assert.deepStrictEqual(clampLines('a\nb\n\n\n').head, ['a', 'b']);
  });
});

suite('describeOutput', () => {
  test('a running call shows no result section at all', () => {
    assert.deepStrictEqual(describeOutput('Bash', undefined, 'running'), []);
  });

  test('a silent success says so — an empty pane reads as a bug', () => {
    assert.deepStrictEqual(describeOutput('Bash', '', 'ok'), [{ kind: 'note', text: 'No output.' }]);
  });

  test('a silent failure is named as a failure', () => {
    assert.deepStrictEqual(
      describeOutput('Bash', '   ', 'error'),
      [{ kind: 'note', text: 'Failed with no output.' }],
    );
  });

  test('a failure is toned as an error whatever the tool was', () => {
    assert.deepStrictEqual(
      describeOutput('Read', 'ENOENT', 'error'),
      [{ kind: 'lines', text: 'ENOENT', tone: 'error' }],
    );
  });
});

suite('describeTool: codex', () => {
  test('a command execution leads with the command, not its JSON', () => {
    const header = describeTool('commandExecution', { command: 'yarn test', cwd: '/repo' });
    assert.strictEqual(header.glyph, 'terminal');
    assert.strictEqual(header.primary, 'yarn test');
    assert.strictEqual(header.mono, true);
  });

  test('an mcp tool call names the server and the tool', () => {
    const header = describeTool('mcpToolCall', { server: 'github', toolName: 'list_prs' });
    assert.strictEqual(header.primary.includes('github'), true);
    assert.strictEqual(header.primary.includes('list_prs'), true);
  });

  test('a file change leads with the changed path', () => {
    const header = describeTool('fileChange', { changes: [{ path: '/a/b.ts' }] });
    assert.strictEqual(header.glyph, 'file-pen');
    assert.strictEqual(header.primary, '/a/b.ts');
  });

  test('a dynamic tool call leads with the tool name', () => {
    assert.strictEqual(describeTool('dynamicToolCall', { toolName: 'custom_tool' }).primary, 'custom_tool');
  });

  test('a plan leads with its own label', () => {
    const header = describeTool('plan', { text: 'Ship the feature' });
    assert.strictEqual(header.glyph, 'list-todo');
    assert.strictEqual(header.primary, 'Ship the feature');
  });

  test('a codex web search reuses the same header as the Claude tool', () => {
    assert.strictEqual(describeTool('webSearch', { query: 'vscode api' }).primary, 'vscode api');
  });
});

suite('describeInput blocks: codex', () => {
  test('a command execution becomes a command and its working directory', () => {
    assert.deepStrictEqual(describeInput('commandExecution', { command: 'ls', cwd: '/repo' }), [
      { kind: 'command', text: 'ls' },
      { kind: 'path', path: '/repo' },
    ]);
  });

  test('an mcp tool call names its server and tool as fields', () => {
    assert.deepStrictEqual(describeInput('mcpToolCall', { server: 'github', toolName: 'list_prs' }), [
      { kind: 'field', label: 'server', value: 'github' },
      { kind: 'field', label: 'tool', value: 'list_prs' },
    ]);
  });
});

suite('describeOutput: codex', () => {
  test('command output renders as an output-toned lines block', () => {
    const blocks = describeOutput('commandExecution', 'a\nb', 'ok');
    assert.strictEqual(blocks.some((b) => b.kind === 'lines' && b.tone === 'output'), true);
  });
});

suite('shortPath and diffLines', () => {
  test('a path of two or fewer segments is left alone', () => {
    assert.strictEqual(shortPath('/tmp/a.txt'), '/tmp/a.txt');
  });

  test('windows separators shorten the same way posix ones do', () => {
    assert.strictEqual(shortPath('e:\\Efebia\\hiiiid-code\\src\\store.tsx'), '…/src/store.tsx');
  });

  test('an input with no text on either side is not a diff', () => {
    assert.strictEqual(diffLines({ file_path: '/a/b.ts' }), undefined);
  });
});
