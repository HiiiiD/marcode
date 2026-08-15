// Projects our transcript into a seed message for a provider thread that has
// no history of this conversation — a fresh tree, or a different vendor.
//
// Reads canonical `ToolCall`s rather than provider vocabulary, which is what
// makes a seed portable: a Codex-produced transcript summarized from raw wire
// types would hand Claude the words `commandExecution` and `fileChange`.
//
// Lossy by construction. Tool outputs are dropped — they are the bulk of the
// bytes and the agent can re-read files itself. Where a conclusion depended on
// an output we dropped, the agent re-runs the command.
//
// No `vscode` import: unit-tested outside the extension host.

import type { ToolCall, TranscriptItem } from '../protocol/messages';

const PREAMBLE = [
  'The following is a record of work that has already happened in this',
  'conversation, before it moved to this directory. It is context, not a task.',
  'Do not redo any of it. Continue from where it leaves off.',
].join(' ');

const OMITTED = '[Earlier turns omitted to fit context.]';

/** Default budget in characters. Roughly 6k tokens. */
const DEFAULT_BUDGET = 24_000;

function describe(tool: ToolCall): string {
  switch (tool.kind) {
    case 'command': return `ran: ${tool.command}`;
    case 'file-edit': return `edited: ${tool.files.map((f) => `${f.path} (${f.op})`).join(', ')}`;
    case 'file-read': return `read: ${tool.path}`;
    case 'search': return `searched for ${tool.pattern}${tool.scope ? ` in ${tool.scope}` : ''}`;
    case 'web': return `web: ${tool.url ?? tool.query ?? tool.label}`;
    case 'todos': return `updated todos (${tool.items.length} items)`;
    case 'plan': return 'wrote a plan';
    case 'subagent': return `subagent ${tool.action}${tool.agent ? `: ${tool.agent}` : ''}`;
    case 'mcp': return `called ${tool.server}/${tool.tool}`;
    default: return `used ${tool.label}`;
  }
}

function lineFor(item: TranscriptItem): string | undefined {
  switch (item.role) {
    case 'user': return `USER: ${item.text}`;
    case 'assistant': return item.text.trim() ? `ASSISTANT: ${item.text}` : undefined;
    case 'tool': return `TOOL (${item.state}): ${describe(item.tool)}`;
    // A permission is an interaction with the panel, not conversation content,
    // and an error describes a run that no longer exists.
    default: return undefined;
  }
}

export function buildSeed(items: TranscriptItem[], budgetChars = DEFAULT_BUDGET): string {
  const lines = items.map(lineFor).filter((l): l is string => l !== undefined);
  if (lines.length === 0) { return ''; }

  const header = `${PREAMBLE}\n\n`;
  const kept: string[] = [];
  let used = header.length;

  // Newest first, because the end of a conversation is what the next turn
  // continues from. Reversed back before joining.
  for (let i = lines.length - 1; i >= 0; i--) {
    const cost = lines[i].length + 1;
    if (used + cost > budgetChars) { break; }
    kept.unshift(lines[i]);
    used += cost;
  }

  if (kept.length === lines.length) { return `${header}${kept.join('\n')}`; }

  // The notice costs bytes the loop above did not reserve, so pay for it by
  // dropping further oldest lines. Trimming the string instead would cut the
  // tail — the newest turns, which are exactly the ones worth keeping.
  let withNotice = `${header}${OMITTED}\n${kept.join('\n')}`;
  while (withNotice.length > budgetChars && kept.length > 0) {
    kept.shift();
    withNotice = `${header}${OMITTED}\n${kept.join('\n')}`;
  }
  // A single oversized line can still overrun; the budget is a hard ceiling.
  return withNotice.length <= budgetChars
    ? withNotice
    : withNotice.slice(0, budgetChars);
}
