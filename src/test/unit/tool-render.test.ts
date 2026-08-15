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

  test('a file change renders one path and one diff block per file', () => {
    const blocks = describeOutput('fileChange', {
      changes: [
        { path: '/a.ts', kind: 'update', diff: '--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n context' },
        { path: '/b.ts', kind: 'add', diff: '--- /dev/null\n+++ b/b.ts\n@@ -0,0 +1 @@\n+added' },
      ],
    }, 'ok');
    assert.strictEqual(blocks.filter((b) => b.kind === 'path').length, 2);
    assert.strictEqual(blocks.filter((b) => b.kind === 'diff').length, 2);
  });

  test('unified diff headers and hunk markers are stripped from the body', () => {
    const blocks = describeOutput('fileChange', {
      changes: [
        { path: '/a.ts', kind: 'update', diff: '--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n context' },
      ],
    }, 'ok');
    const diffBlock = blocks.find((b) => b.kind === 'diff');
    const lines = diffBlock && diffBlock.kind === 'diff' ? diffBlock.lines : [];
    assert.strictEqual(lines.some((l) => l.startsWith('---') || l.startsWith('+++')), false);
    assert.strictEqual(lines.some((l) => l.startsWith('@@')), false);
    assert.strictEqual(lines.includes('-old'), true);
    assert.strictEqual(lines.includes('+new'), true);
  });

  test('a diff with no body lines yields no empty diff block', () => {
    const blocks = describeOutput('fileChange', {
      changes: [
        { path: '/renamed.ts', kind: 'update', diff: '--- a/old.ts\n+++ b/renamed.ts\n' },
      ],
    }, 'ok');
    assert.strictEqual(blocks.some((b) => b.kind === 'path'), true);
    assert.strictEqual(blocks.some((b) => b.kind === 'diff'), false);
  });

  test('an absent changes array does not throw and yields no diff or path blocks', () => {
    assert.deepStrictEqual(describeOutput('fileChange', {}, 'ok'), [{ kind: 'note', text: 'No file changes.' }]);
  });

  test('a deleted line that itself starts with -- survives with its own - prefix', () => {
    // Real content: `-color-primary` with the diff's own `-` glued on reads
    // as `--color-primary`, which a prefix-matching header strip would drop.
    const diff = '--- a/index.css\n+++ b/index.css\n@@ -1,2 +1,2 @@\n-  --color-primary: red;\n context';
    const blocks = describeOutput('fileChange', {
      changes: [{ path: '/index.css', kind: 'update', diff }],
    }, 'ok');
    const diffBlock = blocks.find((b) => b.kind === 'diff');
    const lines = diffBlock && diffBlock.kind === 'diff' ? diffBlock.lines : [];
    assert.strictEqual(lines.includes('-  --color-primary: red;'), true);
  });

  test('an added line that itself starts with ++ survives with its own + prefix', () => {
    const diff = '--- a/index.css\n+++ b/index.css\n@@ -1 +1,2 @@\n context\n+  ++counter: 1;';
    const blocks = describeOutput('fileChange', {
      changes: [{ path: '/index.css', kind: 'update', diff }],
    }, 'ok');
    const diffBlock = blocks.find((b) => b.kind === 'diff');
    const lines = diffBlock && diffBlock.kind === 'diff' ? diffBlock.lines : [];
    assert.strictEqual(lines.includes('+  ++counter: 1;'), true);
  });

  test('a body line starting with -- in a later hunk of a multi-hunk diff also survives', () => {
    const diff = [
      '--- a/style.css', '+++ b/style.css',
      '@@ -1,2 +1,2 @@', ' a', ' b',
      '@@ -10,2 +10,2 @@', '-  --radius-md: 4px;', '+  --radius-md: 8px;',
    ].join('\n');
    const blocks = describeOutput('fileChange', {
      changes: [{ path: '/style.css', kind: 'update', diff }],
    }, 'ok');
    const diffBlock = blocks.find((b) => b.kind === 'diff');
    const lines = diffBlock && diffBlock.kind === 'diff' ? diffBlock.lines : [];
    assert.strictEqual(lines.includes('-  --radius-md: 4px;'), true);
    assert.strictEqual(lines.includes('+  --radius-md: 8px;'), true);
    assert.strictEqual(lines.some((l) => l.startsWith('@@')), false);
  });
});

// The three tools that drive a subagent fleet. Payloads below are copied from
// real transcripts under ~/.claude/projects rather than invented: `SendMessage`
// takes `to`/`summary`/`message` (not the `agent_id`/`prompt` pair a reader
// might assume), and its result is a JSON envelope, not prose.
suite('the Agent / SendMessage / TaskOutput family', () => {
  test('a spawned agent leads with its type, not the word Agent', () => {
    const header = describeTool('Agent', {
      description: 'Review the diff', prompt: 'Read every changed file…', subagent_type: 'Explore',
    });
    assert.strictEqual(header.glyph, 'bot');
    assert.strictEqual(header.primary, 'Explore');
    assert.strictEqual(header.mono, false);
  });

  test('an untyped agent falls back to its name, then to its description', () => {
    assert.strictEqual(describeTool('Agent', { name: 'task-7', prompt: 'x' }).primary, 'task-7');
    assert.strictEqual(describeTool('Agent', { description: 'Fix it', prompt: 'x' }).primary, 'Fix it');
  });

  test('Task is the same tool as Agent under its older name', () => {
    assert.strictEqual(describeTool('Task', { subagent_type: 'Plan' }).primary, 'Plan');
  });

  test('a message to an agent leads with its summary — the id means nothing to a reader', () => {
    const header = describeTool('SendMessage', {
      to: 'aa124f004ce1e2bea', summary: 'Fix round 2: hydrate reopens closed sessions',
      message: 'Fix round 2 of 5. All four round-1 findings verified ADDRESSED…',
    });
    assert.strictEqual(header.glyph, 'send');
    assert.strictEqual(header.primary, 'Fix round 2: hydrate reopens closed sessions');
  });

  test('an unsummarized message falls back to the recipient', () => {
    assert.strictEqual(
      describeTool('SendMessage', { to: 'aa124f004ce1e2bea', message: 'go' }).primary,
      'aa124f004ce1e2bea',
    );
  });

  test('a task output leads with the id it is collecting, in the editor font', () => {
    const header = describeTool('TaskOutput', {
      task_id: 'a21af635b3b176c93', block: true, timeout: 600000,
    });
    assert.strictEqual(header.glyph, 'bot');
    assert.strictEqual(header.primary, 'a21af635b3b176c93');
    assert.strictEqual(header.mono, true);
  });

  test('an agent body carries the brief it was actually given', () => {
    assert.deepStrictEqual(describeInput('Agent', {
      description: 'Review the diff', prompt: 'Read every changed file.',
      subagent_type: 'Explore', isolation: 'worktree',
    }), [
      { kind: 'note', text: 'Review the diff' },
      { kind: 'field', label: 'agent', value: 'Explore' },
      { kind: 'field', label: 'isolation', value: 'worktree' },
      { kind: 'lines', text: 'Read every changed file.', tone: 'output' },
    ]);
  });

  test('a message body shows the recipient and the message itself', () => {
    assert.deepStrictEqual(describeInput('SendMessage', {
      to: 'aa124f004ce1e2bea', summary: 'Round 3', message: 'Fix round 3 of 5.',
    }), [
      { kind: 'field', label: 'to', value: 'aa124f004ce1e2bea' },
      { kind: 'note', text: 'Round 3' },
      { kind: 'lines', text: 'Fix round 3 of 5.', tone: 'output' },
    ]);
  });

  test('a task output body says whether it is blocking, and for how long', () => {
    assert.deepStrictEqual(describeInput('TaskOutput', {
      task_id: 'a0473e1345b5c9162', block: true, timeout: 600000,
    }), [
      { kind: 'field', label: 'task', value: 'a0473e1345b5c9162' },
      { kind: 'field', label: 'wait', value: 'until done' },
      { kind: 'field', label: 'timeout', value: '600s' },
    ]);
  });

  test('a send result is unwrapped from its JSON envelope', () => {
    const blocks = describeOutput('SendMessage', JSON.stringify({
      success: true, message: 'Message queued for delivery to aa124f004ce1e2bea.',
      pin: { id: 'aa124f004ce1e2bea', ref: 'a0b813' },
    }), 'ok');
    assert.deepStrictEqual(blocks, [
      { kind: 'note', text: 'Message queued for delivery to aa124f004ce1e2bea.' },
    ]);
  });

  test('a send result that is not the expected envelope is shown verbatim', () => {
    assert.deepStrictEqual(
      describeOutput('SendMessage', 'delivered', 'ok'),
      [{ kind: 'lines', text: 'delivered', tone: 'output' }],
    );
  });

  test('a failed send keeps the error tone rather than being unwrapped', () => {
    const blocks = describeOutput('SendMessage', JSON.stringify({ message: 'No such agent.' }), 'error');
    assert.deepStrictEqual(blocks, [{ kind: 'lines', text: '{"message":"No such agent."}', tone: 'error' }]);
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
