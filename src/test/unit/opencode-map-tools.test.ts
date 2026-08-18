import * as assert from 'assert';
import * as frames from '../fixtures/opencode-acp-frames.json';
import { toToolCall, toToolOutput } from '../../providers/opencode/map-tools';
import type { AcpToolCall } from '../../providers/acp/map-updates';

suite('opencode toToolCall', () => {
  test('an execute call carries the command and cwd', () => {
    assert.deepStrictEqual(
      toToolCall(frames.updates.bashToolCallInProgress as unknown as AcpToolCall), {
        kind: 'command', label: 'Shell', command: 'echo hi',
        cwd: 'C:/Users/Marco/AppData/Local/Temp/opencode-acp-spike/sandbox',
      });
  });

  test('an execute call with no command yet falls back to the title', () => {
    assert.deepStrictEqual(
      toToolCall(frames.updates.bashToolCall as unknown as AcpToolCall), {
        kind: 'command', label: 'Shell', command: 'bash',
        cwd: 'C:/Users/Marco/AppData/Local/Temp/opencode-acp-spike/sandbox',
      });
  });

  test('an edit call becomes a file-edit with before/after and POSIX separators', () => {
    assert.deepStrictEqual(
      toToolCall(frames.updates.editToolCallCompleted as unknown as AcpToolCall), {
        kind: 'file-edit', label: 'Edit',
        files: [{
          path: 'C:/Users/Marco/AppData/Local/Temp/opencode-acp-spike/sandbox/notes.txt',
          op: 'create',
          edits: [{ after: 'hi' }],
        }],
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

  test('an unknown kind falls through to other, carrying its raw input', () => {
    const call = {
      toolCallId: 't', kind: 'fetch', title: 'grab it', rawInput: { url: 'https://x' },
    } as unknown as AcpToolCall;
    assert.deepStrictEqual(toToolCall(call),
      { kind: 'other', label: 'grab it', raw: { url: 'https://x' } });
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
});
