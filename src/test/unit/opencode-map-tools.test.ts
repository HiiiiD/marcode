import * as assert from 'assert';
import * as frames from '../fixtures/opencode-acp-frames.json';
import { toToolCall, toToolOutput } from '../../providers/opencode/map-tools';
import type { AcpToolCall } from '../../providers/acp/map-updates';

suite('opencode toToolCall', () => {
  test('an execute call carries the command and cwd', () => {
    assert.deepStrictEqual(
      toToolCall(frames.updates.bashToolCallInProgress as unknown as AcpToolCall), {
        kind: 'command', label: 'Shell', command: 'echo hi',
        cwd: 'C:/Users/dev/AppData/Local/Temp/opencode-acp-spike/sandbox',
      });
  });

  test('an execute call with no command yet falls back to the title', () => {
    assert.deepStrictEqual(
      toToolCall(frames.updates.bashToolCall as unknown as AcpToolCall), {
        kind: 'command', label: 'Shell', command: 'bash',
        cwd: 'C:/Users/dev/AppData/Local/Temp/opencode-acp-spike/sandbox',
      });
  });

  test('an edit call becomes a file-edit with before/after and POSIX separators', () => {
    assert.deepStrictEqual(
      toToolCall(frames.updates.editToolCallCompleted as unknown as AcpToolCall), {
        kind: 'file-edit', label: 'Edit',
        files: [{
          path: 'C:/Users/dev/AppData/Local/Temp/opencode-acp-spike/sandbox/notes.txt',
          op: 'create',
          edits: [{ after: 'hi' }],
        }],
      });
  });

  test('a write with no diff block still becomes a file-edit, from locations/rawInput', () => {
    assert.deepStrictEqual(
      toToolCall(frames.updates.writeToolCallCreate as unknown as AcpToolCall), {
        kind: 'file-edit', label: 'Edit',
        files: [{
          path: 'E:/Efebia/hiiiid-code/scratch/spike-note.txt',
          op: 'create',
          edits: [{ after: 'hello\n' }],
        }],
      });
  });

  test('a write with no diff block over an existing file is a modify, with no fabricated diff', () => {
    assert.deepStrictEqual(
      toToolCall(frames.updates.writeToolCallModify as unknown as AcpToolCall), {
        kind: 'file-edit', label: 'Edit',
        files: [{ path: 'E:/Efebia/hiiiid-code/scratch/spike-note.txt', op: 'modify' }],
      });
  });

  test('an edit over existing text is a modify, not a create', () => {
    const call = {
      toolCallId: 't', kind: 'edit', title: 'a.ts',
      content: [{ type: 'diff', path: '/w/a.ts', oldText: 'before', newText: 'after' }],
    } as unknown as AcpToolCall;
    assert.deepStrictEqual(toToolCall(call), {
      kind: 'file-edit', label: 'Edit',
      files: [{ path: '/w/a.ts', op: 'modify', edits: [{ before: 'before', after: 'after' }] }],
    });
  });

  test('a read call becomes file-read from its location', () => {
    const call = {
      toolCallId: 't', kind: 'read', title: 'read', locations: [{ path: '/w/a.ts' }],
    } as unknown as AcpToolCall;
    assert.deepStrictEqual(toToolCall(call),
      { kind: 'file-read', label: 'Read', path: '/w/a.ts' });
  });

  test('a read call falls back to rawInput.filePath before its location arrives', () => {
    assert.deepStrictEqual(
      toToolCall(frames.updates.readToolCallInProgress as unknown as AcpToolCall), {
        kind: 'file-read', label: 'Read',
        path: 'C:/Users/dev/AppData/Local/Temp/oc-read-spike/notes.txt',
      });
  });

  test('a read call with no path yet is still labelled Read, not the vendor title', () => {
    assert.deepStrictEqual(
      toToolCall(frames.updates.readToolCall as unknown as AcpToolCall),
      { kind: 'other', label: 'Read', raw: {} });
  });

  test('a glob call becomes a files search from its pattern and path', () => {
    assert.deepStrictEqual(
      toToolCall(frames.updates.globToolCallInProgress as unknown as AcpToolCall), {
        kind: 'search', label: 'Search', pattern: '*.md', mode: 'files',
        scope: 'E:/Efebia/hiiiid-code/.claude/commands',
      });
  });

  test('a grep-titled search call is a content search, not a files search', () => {
    const call = {
      toolCallId: 't', kind: 'search', title: 'grep', rawInput: { pattern: 'TODO' },
    } as unknown as AcpToolCall;
    assert.deepStrictEqual(toToolCall(call),
      { kind: 'search', label: 'Search', pattern: 'TODO', mode: 'content' });
  });

  test('a search call with no pattern yet falls through to other, not a hidden empty pattern', () => {
    const call = { toolCallId: 't', kind: 'search', title: 'glob', rawInput: {} } as unknown as AcpToolCall;
    assert.deepStrictEqual(toToolCall(call), { kind: 'other', label: 'Search', raw: {} });
  });

  test('an unknown kind falls through to other, carrying its raw input', () => {
    const call = {
      toolCallId: 't', kind: 'fetch', title: 'grab it', rawInput: { url: 'https://x' },
    } as unknown as AcpToolCall;
    assert.deepStrictEqual(toToolCall(call),
      { kind: 'other', label: 'grab it', raw: { url: 'https://x' } });
  });

  // Observed live: opencode sends the self-control call as kind 'other'
  // with title `${mcpServerName}_${toolId}` and no separate marker for the
  // join, unlike Claude's self-delimiting `mcp__server__tool`.
  test('a self-control call is recognised from its title, not its kind', () => {
    const call = {
      toolCallId: 't', kind: 'other', title: 'marcode_self_control_marcode__list_sessions',
      rawInput: {},
    } as unknown as AcpToolCall;
    assert.deepStrictEqual(toToolCall(call), {
      kind: 'mcp', label: 'marcode__list_sessions',
      server: 'marcode_self_control', tool: 'marcode__list_sessions',
    });
  });

  test('a self-control call carries its input when non-empty', () => {
    const call = {
      toolCallId: 't', kind: 'other', title: 'marcode_self_control_marcode__send_message',
      rawInput: { to: 'claude-n', text: 'hi' },
    } as unknown as AcpToolCall;
    assert.deepStrictEqual(toToolCall(call), {
      kind: 'mcp', label: 'marcode__send_message',
      server: 'marcode_self_control', tool: 'marcode__send_message',
      input: { to: 'claude-n', text: 'hi' },
    });
  });

  // Observed live (opencode 1.18.30): the native `skill` tool always titles
  // itself `Loaded skill: <name>`, kind 'other', rawInput `{ name }`.
  test('a skill invocation is recognised from its title, not its kind', () => {
    const call = {
      toolCallId: 't', kind: 'other', title: 'Loaded skill: pr-summary',
      rawInput: { name: 'pr-summary' },
    } as unknown as AcpToolCall;
    assert.deepStrictEqual(toToolCall(call),
      { kind: 'command', label: 'Skill', command: '', skill: 'pr-summary' });
  });

  test('a skill invocation falls back to the title suffix when rawInput lacks name', () => {
    const call = {
      toolCallId: 't', kind: 'other', title: 'Loaded skill: pr-summary', rawInput: {},
    } as unknown as AcpToolCall;
    assert.deepStrictEqual(toToolCall(call),
      { kind: 'command', label: 'Skill', command: '', skill: 'pr-summary' });
  });

  // Observed live (opencode 1.18.30): the native `todowrite` tool titles
  // itself `${n} todos` (n = non-completed count) and kind 'other', but the
  // signal used here is the param shape (`rawInput.todos`), not that title —
  // a fully-completed list still reads "0 todos" and would misclassify.
  test('a todowrite call is recognised from its param shape, not its kind or title', () => {
    const call = {
      toolCallId: 't', kind: 'other', title: '2 todos',
      rawInput: {
        todos: [
          { content: 'Inspect commits and diff against origin/master', status: 'in_progress', priority: 'high' },
          { content: 'Compose raw markdown PR summary', status: 'pending', priority: 'high' },
        ],
      },
    } as unknown as AcpToolCall;
    assert.deepStrictEqual(toToolCall(call), {
      kind: 'todos', label: 'Todos',
      items: [
        { status: 'in_progress', text: 'Inspect commits and diff against origin/master' },
        { status: 'pending', text: 'Compose raw markdown PR summary' },
      ],
    });
  });

  test('a fully-completed todowrite call is still todos, not misread from its "0 todos" title', () => {
    const call = {
      toolCallId: 't', kind: 'other', title: '0 todos',
      rawInput: { todos: [{ content: 'Ship it', status: 'completed', priority: 'high' }] },
    } as unknown as AcpToolCall;
    assert.deepStrictEqual(toToolCall(call),
      { kind: 'todos', label: 'Todos', items: [{ status: 'completed', text: 'Ship it' }] });
  });

  test('a third-party MCP call with an unrecognised tool id is not misclassified', () => {
    const call = {
      toolCallId: 't', kind: 'other', title: 'github_list_repos', rawInput: {},
    } as unknown as AcpToolCall;
    assert.deepStrictEqual(toToolCall(call), { kind: 'other', label: 'github_list_repos', raw: {} });
  });
});

suite('opencode toToolOutput', () => {
  test('text content becomes text output', () => {
    assert.deepStrictEqual(
      toToolOutput(frames.updates.bashToolCallCompleted as unknown as AcpToolCall),
      { kind: 'text', text: 'hi\r\n' });
  });

  test('an edit reports none — its diff belongs to the call', () => {
    assert.deepStrictEqual(
      toToolOutput(frames.updates.editToolCallCompleted as unknown as AcpToolCall),
      { kind: 'none' });
  });

  test('a call with no content at all reports none', () => {
    assert.deepStrictEqual(toToolOutput({ toolCallId: 't' }), { kind: 'none' });
  });

  test('a todowrite call reports none — its list belongs to the call, not the output', () => {
    const call = {
      toolCallId: 't', rawInput: { todos: [{ content: 'Ship it', status: 'completed' }] },
      content: [{ type: 'content', content: { type: 'text', text: '[{"content":"Ship it"}]' } }],
    } as unknown as AcpToolCall;
    assert.deepStrictEqual(toToolOutput(call), { kind: 'none' });
  });
});
