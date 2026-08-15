// Recognizes `git worktree add` in a canonical command call and returns the
// path it creates. Deliberately narrow: scripts, aliases and non-git tools are
// not chased. A missed detection costs nothing that is not already lost; a
// wrong one would relocate a session into a directory nobody asked for, so
// anything unparseable returns undefined.
//
// No `vscode` import: this is unit-tested outside the extension host.

import type { ToolCall } from '../providers/canonical/tool-call';

/** Splits on whitespace, keeping quoted runs together and stripping the quotes. */
function tokenize(segment: string): string[] {
  const out: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(segment)) !== null) {
    out.push(match[1] ?? match[2] ?? match[3]);
  }
  return out;
}

/** Flags that take a value, so the value is never mistaken for the path. */
const VALUED = new Set(['-b', '-B', '--reason', '--lock-reason']);

export function detectWorktreeAdd(tool: ToolCall, ok: boolean): string | undefined {
  if (!ok || tool.kind !== 'command') { return undefined; }

  for (const segment of tool.command.split(/&&|\|\||;/)) {
    const words = tokenize(segment);
    const at = words.findIndex((w, i) =>
      w === 'worktree' && words[i - 1]?.endsWith('git') && words[i + 1] === 'add');
    if (at === -1) { continue; }

    const rest = words.slice(at + 2);
    for (let i = 0; i < rest.length; i++) {
      const word = rest[i];
      if (VALUED.has(word)) { i++; continue; }
      if (word.startsWith('-')) { continue; }
      return word;
    }
  }
  return undefined;
}
