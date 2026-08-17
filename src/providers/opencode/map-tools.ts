import type { FileEdit, ToolCall, ToolOutput } from '../types';
import type { AcpToolCall, ToolMapper } from '../acp/map-updates';

/** Absolute paths reach the transcript with POSIX separators — the spelling
 *  `claim-paths.ts` expects when it attributes a fleet-diff row. */
const posix = (p: string): string => p.replace(/\\/g, '/');

interface DiffBlock { type: 'diff'; path: string; oldText?: string | null; newText?: string | null }
interface ContentBlock { type: 'content'; content?: { type?: string; text?: string } }

const diffs = (c: AcpToolCall): DiffBlock[] =>
  (c.content ?? []).filter((b): b is DiffBlock => (b as DiffBlock)?.type === 'diff');

export function toToolCall(c: AcpToolCall): ToolCall {
  const raw = (c.rawInput ?? {}) as { command?: string; cwd?: string };
  switch (c.kind) {
    case 'execute': {
      // `tool_call` arrives with no command and only `cwd`; the command lands
      // on the following `tool_call_update`. The title is the best stand-in
      // until it does.
      const command = raw.command ?? c.title ?? 'shell';
      return raw.cwd
        ? { kind: 'command', label: 'Shell', command, cwd: posix(raw.cwd) }
        : { kind: 'command', label: 'Shell', command };
    }
    case 'edit': {
      const files: FileEdit[] = diffs(c).map((d) => ({
        path: posix(d.path),
        op: d.oldText ? 'modify' : 'create',
        edits: [d.oldText ? { before: d.oldText, after: d.newText ?? '' }
                          : { after: d.newText ?? '' }],
      }));
      return { kind: 'file-edit', label: 'Edit', files };
    }
    case 'read': {
      const path = c.locations?.[0]?.path;
      if (path) { return { kind: 'file-read', label: 'Read', path: posix(path) }; }
      break;
    }
    default:
      break;
  }
  // No substring classification on the tool name. An unrecognised kind is
  // rendered as itself rather than guessed into the wrong card.
  return { kind: 'other', label: c.title ?? c.kind ?? 'Tool', raw: c.rawInput };
}

export function toToolOutput(c: AcpToolCall): ToolOutput {
  if (c.kind === 'edit') { return { kind: 'none' }; }
  const text = (c.content ?? [])
    .filter((b): b is ContentBlock => (b as ContentBlock)?.type === 'content')
    .map((b) => b.content?.text ?? '')
    .join('');
  return text ? { kind: 'text', text } : { kind: 'none' };
}

export const openCodeTools: ToolMapper = { call: toToolCall, output: toToolOutput };
