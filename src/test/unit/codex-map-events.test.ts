import * as assert from 'assert';
import { approvalEventOf, mapNotification } from '../../providers/codex/map-events';

suite('mapNotification', () => {
  test('thread/started carries the resume token', () => {
    assert.deepStrictEqual(
      mapNotification('thread/started', { thread: { id: 'th_1' } }),
      [{ kind: 'session', resumeToken: 'th_1' }],
    );
  });

  test('agent message deltas become text', () => {
    assert.deepStrictEqual(
      mapNotification('item/agentMessage/delta', { delta: 'hi' }),
      [{ kind: 'text', delta: 'hi' }],
    );
  });

  test('both reasoning delta shapes become thinking', () => {
    assert.deepStrictEqual(
      mapNotification('item/reasoning/textDelta', { delta: 'a' }),
      [{ kind: 'thinking', delta: 'a' }],
    );
    assert.deepStrictEqual(
      mapNotification('item/reasoning/summaryTextDelta', { delta: 'b' }),
      [{ kind: 'thinking', delta: 'b' }],
    );
  });

  test('a started command execution becomes a tool-start', () => {
    const events = mapNotification('item/started', {
      item: { type: 'commandExecution', id: 'it_1', command: 'ls -la', cwd: '/repo' },
    });
    assert.deepStrictEqual(events, [{
      kind: 'tool-start', id: 'it_1', name: 'commandExecution',
      input: { command: 'ls -la', cwd: '/repo' },
    }]);
  });

  test('a completed command execution reports success from its exit code', () => {
    const [event] = mapNotification('item/completed', {
      item: { type: 'commandExecution', id: 'it_1', command: 'ls', cwd: '/repo',
              exitCode: 0, aggregatedOutput: 'a\nb' },
    });
    assert.strictEqual(event.kind, 'tool-end');
    assert.strictEqual(event.kind === 'tool-end' && event.ok, true);
  });

  test('a nonzero exit code is a failed tool', () => {
    const [event] = mapNotification('item/completed', {
      item: { type: 'commandExecution', id: 'it_1', command: 'false', cwd: '/r', exitCode: 1 },
    });
    assert.strictEqual(event.kind === 'tool-end' && event.ok, false);
  });

  test('stderr output with a zero exit code is still success', () => {
    // Measured live on codex-cli 0.147.0: a command whose PowerShell profile
    // wrote warnings to stderr still completed with status 'completed' and
    // exitCode 0. Stderr text alone must never flip the badge.
    const [event] = mapNotification('item/completed', {
      item: {
        type: 'commandExecution', id: 'it_1', command: 'pwsh -Command x', cwd: '/r',
        status: 'completed', exitCode: 0, aggregatedOutput: 'some stderr warning\n',
      },
    });
    assert.strictEqual(event.kind === 'tool-end' && event.ok, true);
  });

  test('a declined command is a failed tool even with no exit code', () => {
    // `CommandExecutionStatus` includes 'declined' (an approval the user
    // turned down) with `exitCode: null` — the command never ran. Reading a
    // missing exit code as success here would show a declined command as if
    // it succeeded.
    const [event] = mapNotification('item/completed', {
      item: { type: 'commandExecution', id: 'it_1', command: 'rm -rf x', cwd: '/r', status: 'declined', exitCode: null },
    });
    assert.strictEqual(event.kind === 'tool-end' && event.ok, false);
  });

  test('a failed command with no exit code is still a failed tool', () => {
    // A command that never spawned (e.g. a resolution error) can report
    // status 'failed' with a null exitCode — status must not be shadowed by
    // the "missing signal = success" fallback that exists for the ordinary
    // completed-with-no-exit-code case.
    const [event] = mapNotification('item/completed', {
      item: { type: 'commandExecution', id: 'it_1', command: 'x', cwd: '/r', status: 'failed', exitCode: null },
    });
    assert.strictEqual(event.kind === 'tool-end' && event.ok, false);
  });

  // The three payloads below are verbatim from codex-cli 0.147.0, captured off
  // a real `app-server` turn on 2026-08-15. `command` is the SHELL-ESCAPED
  // invocation Codex actually spawns — backslashes doubled, the agent's own
  // command re-quoted inside it — which is what shipped to the sidebar as a
  // JSON-looking header. `commandActions` is documented upstream as the
  // "best-effort parsing … for friendly display", and it is what a reader
  // recognizes.
  const REAL_COMMAND = '"C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe" -Command '
    + '"pwsh -NoProfile -Command \\"Get-Content -Raw \'C:/missing.txt\'\\""';
  const REAL_ACTION_COMMAND = 'pwsh -NoProfile -Command "Get-Content -Raw \'C:/missing.txt\'"';

  test('a command execution renders the parsed command, not the escaped invocation', () => {
    const events = mapNotification('item/started', {
      item: {
        type: 'commandExecution', id: 'exec-1', command: REAL_COMMAND,
        cwd: 'C:\\tmp\\probe', status: 'inProgress',
        commandActions: [{ type: 'unknown', command: REAL_ACTION_COMMAND }],
        aggregatedOutput: null, exitCode: null,
      },
    });
    assert.deepStrictEqual(events, [{
      kind: 'tool-start', id: 'exec-1', name: 'commandExecution',
      input: { command: REAL_ACTION_COMMAND, cwd: 'C:\\tmp\\probe' },
    }]);
  });

  test('a plugin-resolved command carries pluginId and scriptPath through', () => {
    const events = mapNotification('item/started', {
      item: {
        type: 'commandExecution', id: 'exec-3', command: 'raw', cwd: '/repo',
        pluginId: 'openai-curated-remote/superpowers', scriptPath: 'skills/using-superpowers/SKILL.md',
      },
    });
    assert.deepStrictEqual(events, [{
      kind: 'tool-start', id: 'exec-3', name: 'commandExecution',
      input: {
        command: 'raw', cwd: '/repo',
        pluginId: 'openai-curated-remote/superpowers', scriptPath: 'skills/using-superpowers/SKILL.md',
      },
    }]);
  });

  test('an ordinary command carries no pluginId/scriptPath at all', () => {
    // Measured live: even a command whose only purpose was reading a
    // plugin's own SKILL.md via a plain `Get-Content` resolved neither field
    // — they must not appear as `null`/undefined keys, only be absent.
    const [event] = mapNotification('item/started', {
      item: { type: 'commandExecution', id: 'exec-4', command: 'ls', cwd: '/repo', pluginId: null, scriptPath: null },
    });
    assert.deepStrictEqual(
      event.kind === 'tool-start' ? event.input : undefined,
      { command: 'ls', cwd: '/repo' },
    );
  });

  test('a command with no parsed actions still shows the command it ran', () => {
    const [event] = mapNotification('item/started', {
      item: { type: 'commandExecution', id: 'exec-2', command: 'ls -la', cwd: '/repo', commandActions: [] },
    });
    assert.deepStrictEqual(
      event.kind === 'tool-start' ? event.input : undefined,
      { command: 'ls -la', cwd: '/repo' },
    );
  });

  test('a started web search carries no query, and a completed one corrects it', () => {
    // Real shape: `query` is '' at item/started and only filled at
    // item/completed, which is why the header showed a bare glyph and label.
    const [start] = mapNotification('item/started', {
      item: { type: 'webSearch', id: 'ws-1', query: '', action: null, results: null },
    });
    assert.deepStrictEqual(
      start.kind === 'tool-start' ? start.input : undefined, { query: '' },
    );

    const [end] = mapNotification('item/completed', {
      item: {
        type: 'webSearch', id: 'ws-1', query: 'node lts version',
        action: { type: 'search', query: 'node lts version', queries: null },
        results: [{ type: 'text_result', title: 'Node.js', url: 'https://nodejs.org/en', snippet: 's' }],
      },
    });
    assert.strictEqual(end.kind, 'tool-end');
    assert.deepStrictEqual(
      end.kind === 'tool-end' ? end.input : undefined, { query: 'node lts version' },
    );
  });

  test('web search results render as titles and urls, not a JSON dump', () => {
    const [end] = mapNotification('item/completed', {
      item: {
        type: 'webSearch', id: 'ws-2', query: 'node lts',
        results: [
          { type: 'text_result', title: 'Node.js', url: 'https://nodejs.org/en', snippet: 's' },
          { type: 'text_result', title: 'Releases', url: 'https://nodejs.org/rel', snippet: 's' },
        ],
      },
    });
    assert.strictEqual(
      end.kind === 'tool-end' ? end.output : undefined,
      'Node.js\nhttps://nodejs.org/en\n\nReleases\nhttps://nodejs.org/rel',
    );
  });

  test('an mcp tool call reads the tool off `tool`, the field the wire uses', () => {
    const [start] = mapNotification('item/started', {
      item: { type: 'mcpToolCall', id: 'm1', server: 'github', tool: 'list_prs', arguments: {} },
    });
    assert.deepStrictEqual(
      start.kind === 'tool-start' ? start.input : undefined,
      { server: 'github', toolName: 'list_prs' },
    );
  });

  test('a dynamic tool call reads the tool off `tool` too', () => {
    const [start] = mapNotification('item/started', {
      item: { type: 'dynamicToolCall', id: 'd1', namespace: null, tool: 'custom_tool', arguments: {} },
    });
    assert.deepStrictEqual(
      start.kind === 'tool-start' ? start.input : undefined, { toolName: 'custom_tool' },
    );
  });

  test('a completed file change carries its per-file diffs', () => {
    const [event] = mapNotification('item/completed', {
      item: {
        type: 'fileChange', id: 'it_5', status: 'completed',
        changes: [
          { path: '/repo/a.ts', kind: 'update', diff: '--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n context' },
          { path: '/repo/b.ts', kind: 'add', diff: '--- /dev/null\n+++ b/b.ts\n@@ -0,0 +1 @@\n+added' },
        ],
      },
    });
    assert.strictEqual(event.kind, 'tool-end');
    // The mapper must pass the typed array through rather than the whole item,
    // so the renderer receives something it can narrow.
    const output = event.kind === 'tool-end' ? event.output as { changes: unknown[] } : undefined;
    assert.strictEqual(output?.changes.length, 2);
  });

  test('an agent message item completing is not a tool', () => {
    // The text already arrived as deltas; emitting a tool row for it would
    // double the assistant's turn in the transcript.
    assert.deepStrictEqual(
      mapNotification('item/completed', { item: { type: 'agentMessage', id: 'it_2', text: 'done' } }),
      [],
    );
  });

  test('turn/completed ends the turn', () => {
    assert.deepStrictEqual(
      mapNotification('turn/completed', { threadId: 't', turn: {} }),
      [{ kind: 'turn-end', reason: 'done' }],
    );
  });

  test('an error notification ends the turn with its message', () => {
    assert.deepStrictEqual(
      mapNotification('error', { error: { message: 'model overloaded' }, willRetry: false }),
      [{ kind: 'turn-end', reason: 'error', error: 'model overloaded' }],
    );
  });

  test('an error that will be retried does not end the turn', () => {
    assert.deepStrictEqual(
      mapNotification('error', { error: { message: 'transient' }, willRetry: true }),
      [],
    );
  });

  test('rate limit updates are a signal to pull, never a payload to read', () => {
    // The notification is documented as a sparse rolling update; numbers come
    // from account/rateLimits/read.
    assert.deepStrictEqual(
      mapNotification('account/rateLimits/updated', { rateLimits: { primary: { usedPercent: 40 } } }),
      [{ kind: 'usage-stale' }],
    );
  });

  test('token usage becomes an input/output usage event', () => {
    assert.deepStrictEqual(
      mapNotification('thread/tokenUsage/updated', {
        tokenUsage: { total: { inputTokens: 100, outputTokens: 20 }, modelContextWindow: 200_000 },
      }),
      [{ kind: 'usage', inputTokens: 100, outputTokens: 20 }],
    );
  });

  test('an unknown method is ignored, not thrown', () => {
    // Tolerant parsing is the mitigation for a protocol with no negotiated
    // version: a method added by a Codex upgrade must be a no-op.
    assert.deepStrictEqual(mapNotification('thread/realtime/sdp', { anything: true }), []);
  });

  test('an unknown item kind is ignored, not thrown', () => {
    assert.deepStrictEqual(
      mapNotification('item/started', { item: { type: 'imageGeneration', id: 'it_9' } }),
      [],
    );
  });
});

suite('approvalEventOf', () => {
  test('a command approval becomes a permission request', () => {
    assert.deepStrictEqual(
      approvalEventOf('item/commandExecution/requestApproval', 11,
        { itemId: 'it_1', command: 'rm -rf build', cwd: '/repo', reason: 'writes outside workspace' }),
      { kind: 'permission', id: '11', name: 'commandExecution',
        input: { command: 'rm -rf build', cwd: '/repo', reason: 'writes outside workspace' } },
    );
  });

  test('a command approval shows the parsed command when one is offered', () => {
    // `CommandExecutionRequestApprovalParams.commandActions` is documented
    // "best-effort parsed command actions for friendly display" — the approval
    // card must read the same command the tool card does.
    const event = approvalEventOf('item/commandExecution/requestApproval', 14, {
      itemId: 'it_3', cwd: '/repo',
      command: '"C:\\\\Program Files\\\\Git\\\\bin\\\\bash.exe" -lc "rm -rf build"',
      commandActions: [{ type: 'unknown', command: 'rm -rf build' }],
    });
    assert.deepStrictEqual(
      event?.kind === 'permission' ? (event.input as { command: unknown }).command : undefined,
      'rm -rf build',
    );
  });

  test('a file change approval becomes a permission request', () => {
    assert.deepStrictEqual(
      approvalEventOf('item/fileChange/requestApproval', 12, { itemId: 'it_2', grantRoot: '/repo' }),
      { kind: 'permission', id: '12', name: 'fileChange',
        input: { itemId: 'it_2', grantRoot: '/repo' } },
    );
  });

  test('an unrelated server request produces no permission', () => {
    assert.strictEqual(approvalEventOf('attestation/generate', 13, {}), undefined);
  });
});
