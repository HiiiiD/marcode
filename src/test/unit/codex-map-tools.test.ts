import * as assert from 'assert';
import { approvalToolCall, toToolCall, toToolOutput } from '../../providers/codex/map-tools';
import type { ThreadItem } from '../../providers/codex/wire';

suite('codex toToolCall', () => {
  test('commandExecution prefers the parsed actions over the escaped invocation', () => {
    const item = {
      type: 'commandExecution', id: 'i1',
      command: '"C:\\\\Program Files\\\\pwsh.exe" -Command "ls"',
      commandActions: [{ command: 'ls' }],
      cwd: 'E:/x',
    } as unknown as ThreadItem;
    assert.deepStrictEqual(toToolCall(item), {
      kind: 'command', label: 'Shell', command: 'ls', cwd: 'E:/x',
    });
  });

  test('commandExecution falls back to the raw invocation when nothing parsed', () => {
    const item = {
      type: 'commandExecution', id: 'i1', command: 'ls -la',
    } as unknown as ThreadItem;
    const call = toToolCall(item);
    assert.deepStrictEqual(call, { kind: 'command', label: 'Shell', command: 'ls -la' });
  });

  test('fileChange becomes one FileEdit per touched file, op mapped from kind', () => {
    const item = {
      type: 'fileChange', id: 'i2',
      changes: [
        { path: 'a.ts', kind: 'add', diff: '--- a\n+++ b\n@@\n+x' },
        { path: 'b.ts', kind: 'delete', diff: '--- a\n+++ b\n@@\n-y' },
        { path: 'c.ts', kind: 'update', diff: '--- a\n+++ b\n@@\n z' },
      ],
    } as unknown as ThreadItem;
    assert.deepStrictEqual(toToolCall(item), {
      kind: 'file-edit', label: 'Edit',
      files: [
        { path: 'a.ts', op: 'create', unifiedDiff: '--- a\n+++ b\n@@\n+x' },
        { path: 'b.ts', op: 'delete', unifiedDiff: '--- a\n+++ b\n@@\n-y' },
        { path: 'c.ts', op: 'modify', unifiedDiff: '--- a\n+++ b\n@@\n z' },
      ],
    });
  });

  test('a plugin-resolved command carries the skill it resolved to', () => {
    const item = {
      type: 'commandExecution', id: 'i1', command: 'raw', cwd: '/repo',
      pluginId: 'openai-curated-remote/superpowers', scriptPath: 'skills/using-superpowers/SKILL.md',
    } as unknown as ThreadItem;
    assert.deepStrictEqual(toToolCall(item), {
      kind: 'command', label: 'Shell', command: 'raw', cwd: '/repo',
      skill: 'using-superpowers',
    });
  });

  test('a command with no scriptPath falls back to the pluginId, and no skill at all is absent', () => {
    const withPlugin = {
      type: 'commandExecution', id: 'i1', command: 'raw', pluginId: 'my-plugin', scriptPath: null,
    } as unknown as ThreadItem;
    assert.strictEqual(
      (toToolCall(withPlugin) as { skill?: string }).skill, 'my-plugin',
    );

    const ordinary = {
      type: 'commandExecution', id: 'i1', command: 'ls', pluginId: null, scriptPath: null,
    } as unknown as ThreadItem;
    assert.strictEqual('skill' in (toToolCall(ordinary) as object), false);
  });

  test('mcpToolCall reads `tool`, not `toolName`', () => {
    const item = {
      type: 'mcpToolCall', id: 'i3', server: 'github', tool: 'create_issue',
    } as unknown as ThreadItem;
    assert.deepStrictEqual(toToolCall(item), {
      kind: 'mcp', label: 'create_issue', server: 'github', tool: 'create_issue',
    });
  });

  test('webSearch carries the query it has', () => {
    const item = { type: 'webSearch', id: 'i4', query: 'effect schema' } as unknown as ThreadItem;
    assert.deepStrictEqual(toToolCall(item), {
      kind: 'web', label: 'Web search', query: 'effect schema',
    });
  });

  test('plan carries its text', () => {
    const item = { type: 'plan', id: 'i5', text: 'do the thing' } as unknown as ThreadItem;
    assert.deepStrictEqual(toToolCall(item), {
      kind: 'plan', label: 'Plan', text: 'do the thing',
    });
  });

  test('dynamicToolCall is other, labelled with the tool name', () => {
    const item = { type: 'dynamicToolCall', id: 'i6', tool: 'weird' } as unknown as ThreadItem;
    assert.deepStrictEqual(toToolCall(item), {
      kind: 'other', label: 'weird', raw: item,
    });
  });

  test('an unmodelled item is not a tool', () => {
    const item = { type: 'agentMessage', id: 'i7' } as unknown as ThreadItem;
    assert.strictEqual(toToolCall(item), undefined);
  });

  test('subAgentActivity started is a subagent spawn', () => {
    const item = {
      type: 'subAgentActivity', id: 'i8', kind: 'started',
      agentThreadId: 'th_child', agentPath: 'reviewer',
    } as unknown as ThreadItem;
    assert.deepStrictEqual(toToolCall(item), {
      kind: 'subagent', label: 'Subagent', action: 'spawn',
      agent: 'reviewer', target: 'th_child',
    });
  });

  test('subAgentActivity interacted is a subagent message', () => {
    const item = {
      type: 'subAgentActivity', id: 'i9', kind: 'interacted',
      agentThreadId: 'th_child', agentPath: 'reviewer',
    } as unknown as ThreadItem;
    assert.deepStrictEqual(toToolCall(item), {
      kind: 'subagent', label: 'Subagent', action: 'message',
      agent: 'reviewer', target: 'th_child',
    });
  });

  test('subAgentActivity interrupted is a subagent collect', () => {
    const item = {
      type: 'subAgentActivity', id: 'i10', kind: 'interrupted',
      agentThreadId: 'th_child', agentPath: 'reviewer',
    } as unknown as ThreadItem;
    assert.deepStrictEqual(toToolCall(item), {
      kind: 'subagent', label: 'Subagent', action: 'collect',
      agent: 'reviewer', target: 'th_child',
    });
  });
});

suite('codex toToolOutput', () => {
  test('a command reports its aggregated output as text', () => {
    const item = {
      type: 'commandExecution', id: 'i1', command: 'ls', aggregatedOutput: 'a\nb',
    } as unknown as ThreadItem;
    assert.deepStrictEqual(toToolOutput(item), { kind: 'text', text: 'a\nb' });
  });

  test('a fileChange has no output — its diffs belong to the call', () => {
    const item = { type: 'fileChange', id: 'i2', changes: [] } as unknown as ThreadItem;
    assert.deepStrictEqual(toToolOutput(item), { kind: 'none' });
  });

  test('a webSearch flattens results to title/url pairs', () => {
    const item = {
      type: 'webSearch', id: 'i3',
      results: [{ title: 'T', url: 'https://x.dev' }, { nothing: true }],
    } as unknown as ThreadItem;
    assert.deepStrictEqual(toToolOutput(item), {
      kind: 'text', text: 'T\nhttps://x.dev',
    });
  });

  test('an mcpToolCall with no result at all is none', () => {
    const item = { type: 'mcpToolCall', id: 'i4', server: 'github', tool: 'list_prs' } as unknown as ThreadItem;
    assert.deepStrictEqual(toToolOutput(item), { kind: 'none' });
  });

  test('an mcpToolCall unwraps an Anthropic-style content array to text', () => {
    const item = {
      type: 'mcpToolCall', id: 'i5', server: 'github', tool: 'list_prs',
      result: [{ type: 'text', text: 'PR #1' }, { type: 'text', text: 'PR #2' }],
    } as unknown as ThreadItem;
    assert.deepStrictEqual(toToolOutput(item), { kind: 'text', text: 'PR #1\nPR #2' });
  });

  test('an mcpToolCall with any other result shape is a JSON dump', () => {
    const item = {
      type: 'mcpToolCall', id: 'i6', server: 'github', tool: 'list_prs',
      result: { count: 2 },
    } as unknown as ThreadItem;
    assert.deepStrictEqual(toToolOutput(item), { kind: 'json', value: { count: 2 } });
  });

  test('a subAgentActivity has no output — the card itself is the signal', () => {
    const item = {
      type: 'subAgentActivity', id: 'i7', kind: 'started',
      agentThreadId: 'th_child', agentPath: 'reviewer',
    } as unknown as ThreadItem;
    assert.deepStrictEqual(toToolOutput(item), { kind: 'none' });
  });
});

suite('codex approvalToolCall', () => {
  test('a command approval reads the same spelling the item will', () => {
    const call = approvalToolCall('item/commandExecution/requestApproval', {
      command: '"pwsh.exe" -Command "ls"',
      commandActions: [{ command: 'ls' }],
      cwd: 'E:/x',
      reason: 'outside the sandbox',
    });
    assert.deepStrictEqual(call, {
      kind: 'command', label: 'Shell', command: 'ls', cwd: 'E:/x',
      note: 'outside the sandbox',
    });
  });

  test('a file-change approval becomes a file-edit', () => {
    const call = approvalToolCall('item/fileChange/requestApproval', {
      changes: [{ path: 'a.ts', kind: 'update', diff: 'd' }],
    });
    assert.deepStrictEqual(call, {
      kind: 'file-edit', label: 'Edit',
      files: [{ path: 'a.ts', op: 'modify', unifiedDiff: 'd' }],
    });
  });

  test('a permissions approval is other, carrying its params', () => {
    const call = approvalToolCall('item/permissions/requestApproval', { scope: 'net' });
    assert.deepStrictEqual(call, {
      kind: 'other', label: 'Permission', raw: { scope: 'net' },
    });
  });

  test('a method that is not an approval is undefined', () => {
    assert.strictEqual(approvalToolCall('item/started', {}), undefined);
  });
});
