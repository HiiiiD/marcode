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
